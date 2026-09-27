/**
 * The timing rules of the `/ws` transport, as pure functions: when to ping,
 * when a silent socket is dead, and how long to wait before the next connect.
 *
 * WHY THIS FILE EXISTS. On 2026-09-27 a user in a three-person call rated it
 * one star, "travando e perda de conexão constante". His socket dropped four
 * times and each time he was out of the call's signalling for 70 to 80
 * seconds while nobody else in the room dropped at all. Every part of that
 * minute was a timer in `realtime.ts`:
 *
 * - a dead link was declared only after two unanswered pings 20 s apart, so a
 *   half-open socket (Wi-Fi roam, a NAT rebinding, the server already gone)
 *   sat there for 40 to 60 s before anything happened;
 * - a close with 1006, which is exactly what a network blip produces, got the
 *   0.5-4 s deploy spread meant for a herd, and every retry after that grew
 *   to a 30 s full-jitter cap, so the attempt after the network came back
 *   could be half a minute away;
 * - a connect attempt started while the network was down had no timeout of
 *   its own, so a SYN into a black hole waited out the operating system's
 *   connect timeout (75 s on macOS) before the next attempt could even start.
 *
 * The rules below keep the deploy herd protection where a deploy is what
 * happened (1001 / 1012, CLAUDE.md pitfall 11) and make everything that looks
 * like THIS tab's network cost seconds.
 *
 * Pure and framework free, like `reconnect-jitter.ts`: the transport must not
 * pull React in, and every decision here is tested without a socket.
 */
import { drainJitterMs } from "./reconnect-jitter";

// ---------------------------------------------------------------------------
// Keepalive
// ---------------------------------------------------------------------------

/**
 * `fast` while this tab holds a voice seat, `normal` otherwise.
 *
 * Two profiles because the pings are not free on the server: the per-address
 * socket bucket (`RATE_LIMIT_SOCKET_*`, `server/src/ws/index.ts`) is keyed on
 * whatever address the API sees, and through Cloudflare that can be an edge
 * address shared by many viewers. A ping every ~3 s from every idle chat tab
 * of a 500-viewer watch party is traffic nobody needs; from the handful of
 * people in a call it is the difference between a blip and a minute.
 */
export type KeepaliveMode = "fast" | "normal";

export interface KeepaliveProfile {
  /** Ping when nothing at all has arrived for this long. */
  idleMs: number;
  /** While a ping is unanswered, send another this often. */
  retryMs: number;
  /**
   * Dead when the OLDEST unanswered ping is this old and at least `strikes`
   * pings have gone unanswered. Two strikes, never one: a single slow round
   * trip (a phone changing cell, the server busy for a moment) must not cost
   * a live socket. That rule was learned on the server side the hard way
   * (`MAX_MISSED_PONGS` in `server/src/ws/index.ts`) and applies here too.
   */
  deadlineMs: number;
  strikes: number;
}

export const KEEPALIVE_PROFILES: Record<KeepaliveMode, KeepaliveProfile> = {
  // Worst case with a 1 s tick: silence noticed at ~4 s, second ping at ~7 s,
  // declared dead at ~10 s after the last byte arrived.
  fast: { idleMs: 3_000, retryMs: 3_000, deadlineMs: 6_000, strikes: 2 },
  // Still twice as quick as the old 40-60 s, at a fifth of the fast rate.
  normal: { idleMs: 15_000, retryMs: 5_000, deadlineMs: 10_000, strikes: 2 },
};

/** How often the transport evaluates `keepaliveAction`. */
export const KEEPALIVE_TICK_MS = 1_000;

/**
 * A probe is one ping with a short deadline, sent when something outside the
 * socket says the network just changed: the browser's `online` event, the tab
 * coming back to the foreground, the media connection reconnecting. The old
 * socket survives a short blip on the same address, and is dead after a
 * change of address; the probe tells the two apart in a few seconds instead
 * of waiting out the idle schedule.
 */
export const PROBE_TIMEOUT_MS = 3_500;

export interface KeepaliveState {
  /** Epoch ms of the last frame of ANY kind that arrived on this socket. */
  lastInboundAt: number;
  /** Epoch ms of the last ping this transport sent, null for none yet. */
  lastPingAt: number | null;
  /** Epoch ms of the oldest ping not yet followed by any inbound frame. */
  firstUnansweredAt: number | null;
  /** Pings sent since the last inbound frame. */
  unanswered: number;
  /** Set by a probe: dead if nothing arrives by then. */
  probeDeadlineAt: number | null;
}

export function freshKeepaliveState(now: number): KeepaliveState {
  return {
    lastInboundAt: now,
    lastPingAt: null,
    firstUnansweredAt: null,
    unanswered: 0,
    probeDeadlineAt: null,
  };
}

/** Any inbound frame proves the link, not only a pong. */
export function noteInbound(state: KeepaliveState, now: number): void {
  state.lastInboundAt = now;
  state.firstUnansweredAt = null;
  state.unanswered = 0;
  state.probeDeadlineAt = null;
}

export function notePingSent(state: KeepaliveState, now: number): void {
  state.lastPingAt = now;
  if (state.firstUnansweredAt === null) {
    state.firstUnansweredAt = now;
  }
  state.unanswered += 1;
}

/**
 * A timer that was throttled (a hidden tab) or a laptop that slept makes
 * "the ping has been unanswered for a minute" meaningless: the ping may
 * never have left, or the answer is sitting in the event queue behind this
 * tick. Forget the in-flight count; the caller probes instead.
 */
export function resetInFlight(state: KeepaliveState): void {
  state.firstUnansweredAt = null;
  state.unanswered = 0;
  state.probeDeadlineAt = null;
}

/** One ping, and dead if nothing at all arrives within `PROBE_TIMEOUT_MS`. */
export function noteProbeSent(state: KeepaliveState, now: number): void {
  notePingSent(state, now);
  if (state.probeDeadlineAt === null) {
    state.probeDeadlineAt = now + PROBE_TIMEOUT_MS;
  }
}

/**
 * After evidence that the network is back, how long a socket with pings still
 * unanswered gets before it is written off. A socket that survived the blip
 * (same address, TCP retransmitted) answers within a round trip or two; one
 * that did not (a new address) never will, and every second spent hoping is a
 * second the call's signalling is away. Guessing wrong on a survivor costs a
 * reconnect and a resume, well under a second.
 */
export const UP_GRACE_MS = 1_500;

/**
 * The network just came back (media reconnected, the browser said `online`).
 * With nothing in flight the socket has not missed anything and nothing
 * changes. With pings in flight, shorten their deadline to `UP_GRACE_MS`.
 */
export function noteNetworkUp(state: KeepaliveState, now: number): void {
  if (state.firstUnansweredAt === null) {
    return;
  }
  const deadline = now + UP_GRACE_MS;
  state.probeDeadlineAt =
    state.probeDeadlineAt === null
      ? deadline
      : Math.min(state.probeDeadlineAt, deadline);
}

export type KeepaliveAction = "ping" | "dead" | "wait";

export function keepaliveAction(
  state: KeepaliveState,
  now: number,
  mode: KeepaliveMode,
): KeepaliveAction {
  const profile = KEEPALIVE_PROFILES[mode];
  if (state.probeDeadlineAt !== null && now >= state.probeDeadlineAt) {
    return "dead";
  }
  if (state.firstUnansweredAt !== null) {
    if (
      state.unanswered >= profile.strikes &&
      now - state.firstUnansweredAt >= profile.deadlineMs
    ) {
      return "dead";
    }
    if (state.lastPingAt === null || now - state.lastPingAt >= profile.retryMs) {
      return "ping";
    }
    return "wait";
  }
  const lastActivity = Math.max(state.lastInboundAt, state.lastPingAt ?? 0);
  return now - lastActivity >= profile.idleMs ? "ping" : "wait";
}

// ---------------------------------------------------------------------------
// Connect attempt timeouts
// ---------------------------------------------------------------------------

/**
 * From `new WebSocket` to `open`: TCP, TLS through Cloudflare and the upgrade.
 * Normally well under a second, a couple on bad mobile data. Without a bound
 * an attempt made while the network was down waits out the OS connect
 * timeout, and the next attempt, the one that would have worked, waits
 * behind it.
 */
export const OPEN_TIMEOUT_MS = 6_000;

/**
 * From `open` to `ready`. Longer than the server's own `AUTH_TIMEOUT_MS`
 * (10 s), so a slow auth under load is closed by the server with its own
 * code first; this only fires for a socket that went silent mid-handshake.
 */
export const READY_TIMEOUT_MS = 12_000;

/**
 * The token provider (Clerk's `getToken`) is awaited before every connect.
 * Offline, or with a half-working network, a refresh can hang far longer
 * than the blip that caused it. Past this the attempt is treated as a
 * network failure and retried, never as a sign-out.
 */
export const TOKEN_TIMEOUT_MS = 5_000;

/**
 * An attempt still CONNECTING when evidence arrives that the network is back
 * (the `online` event, media reconnecting) was very likely started on the
 * network that went away. Older than this, it is abandoned and redone.
 */
export const STALE_CONNECT_MS = 1_500;

// ---------------------------------------------------------------------------
// Reconnect delay
// ---------------------------------------------------------------------------

/**
 * Why the socket went away, as far as the delay is concerned.
 *
 * - `drain`: the server said so (1001 going away, 1012 service restart). Every
 *   open tab on that process got the same close at the same moment; spread
 *   the first attempt across `drainJitterMs()` (pitfall 11, postmortem C7).
 * - `network`: this tab's link. An abnormal close (1005 / 1006), a keepalive
 *   or probe that timed out, a connect attempt that never opened, a send on
 *   a closed socket, a token fetch that hung. Retry at once, then quickly.
 * - `refused`: the server answered and said no (4401 auth, 4429 rate limit),
 *   or closed on purpose (1000, 1008, 1011, anything else). Retrying faster
 *   cannot help and a rate limit must not be hammered: the old schedule.
 */
export type ReconnectCause = "drain" | "network" | "refused";

export function reconnectCauseForClose(code: number): ReconnectCause {
  if (code === 1001 || code === 1012) {
    return "drain";
  }
  if (code === 1005 || code === 1006) {
    return "network";
  }
  return "refused";
}

/** First retry after a network loss lands in [0, this]. */
export const NETWORK_FIRST_RETRY_MAX_MS = 250;
/** For this long after the loss, network retries stay under the fast cap. */
export const FAST_RECONNECT_WINDOW_MS = 60_000;
export const FAST_RECONNECT_CAP_MS = 5_000;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_BACKOFF_FACTOR = 2;
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * The delay before reconnect attempt `attempt` (0-based, counting attempts
 * since the last `ready`). Full jitter throughout: a delay drawn uniformly
 * from [0, cap], so tabs that lost the link together never retry together.
 *
 * `sinceLossMs` is how long ago the connection was lost. A network outage
 * gets a minute of retries no further than `FAST_RECONNECT_CAP_MS` apart, so
 * when the network returns the next attempt is at most a few seconds away;
 * an outage longer than that is not a blip, and the schedule grows to the
 * old 30 s cap so a machine that is really offline stops spinning.
 */
export function reconnectDelayMs(
  attempt: number,
  cause: ReconnectCause = "refused",
  sinceLossMs = 0,
): number {
  if (attempt === 0 && cause === "drain") {
    return drainJitterMs();
  }
  if (cause === "network") {
    if (attempt === 0) {
      return Math.random() * NETWORK_FIRST_RETRY_MAX_MS;
    }
    if (sinceLossMs < FAST_RECONNECT_WINDOW_MS) {
      const cap = Math.min(
        FAST_RECONNECT_CAP_MS,
        RECONNECT_BASE_DELAY_MS * RECONNECT_BACKOFF_FACTOR ** (attempt - 1),
      );
      return Math.random() * cap;
    }
  }
  const cap = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * RECONNECT_BACKOFF_FACTOR ** attempt,
  );
  return Math.random() * cap;
}
