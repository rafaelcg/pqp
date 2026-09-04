/**
 * The socket that comes back.
 *
 * ── THE BUG THIS FILE EXISTS FOR ────────────────────────────────────────────
 *
 * On 2026-08-23 the bot logged `bot.ready` and `bot.start` at 17:33:32Z and
 * then nothing, for hours, in a 114-member community. Every external signal
 * said healthy: the Fly machine was `started`, the lifecycle log trail ended on
 * a start, `/health` on the API was green. In the app, `manual [bot]` sat in
 * the QG member list under OFFLINE, because `server/src/ws/status.ts` defines
 * `online` as "there is a live socket" and there was no live socket. It had
 * connected at boot, the socket had dropped, and:
 *
 *   - `pqp-client.js` had no reconnect, on purpose (see its comment);
 *   - `socket.onerror = () => {}` swallowed the reason;
 *   - the process never exited, so `[[restart]] policy = "always"` never fired.
 *
 * Three deliberate decisions that are each correct for the ambient cast and
 * that compose, for this bot, into permanent silent deafness. The cast has a
 * next scene; this bot's whole job is to be reachable between mentions, so its
 * socket is not a per-scene resource, it is the service.
 *
 * ── WHY THE POLICY IS HERE AND NOT IN pqp-client.js ─────────────────────────
 *
 * Because it is a policy, and the two consumers want opposite ones. Pushing
 * `reconnect: true` into `PqpSocket` would put the cast's "go quiet" behaviour
 * one wrong default away at all times, and would mean the comment explaining
 * why a persona should stay dropped now lives in a class that also knows how to
 * bring it back. What `PqpSocket` gained instead is the ability to be OBSERVED:
 * `onClose`, an error path that no longer swallows, `isOpen`. Every line of
 * "come back" logic is in this file, which nothing in `tools/ambient` imports.
 *
 * ── WHAT IT DOES, FOLLOWING client/src/lib/realtime.ts ──────────────────────
 *
 * Same shape as the web client's transport, because that one has already been
 * through this (pitfall #9 in CLAUDE.md) and the differences are all
 * subtractions the bot does not need:
 *
 *   - exponential backoff with jitter, capped;
 *   - a FRESH TOKEN PER ATTEMPT, resolved through a provider rather than
 *     captured once at boot;
 *   - an application-level ping/pong keepalive, with a tolerance of a couple of
 *     missed pongs, that also detects the half-open socket whose close event
 *     never arrives;
 *   - handlers registered on the WRAPPER, so a reconnect re-subscribes the
 *     caller without the caller knowing a reconnect happened.
 *
 * Dropped from the web client's version: the offline send queue (an answer is
 * worth posting late but not worth posting after a thirty-second gap in a
 * conversation), the status enum (nobody is watching a banner), and
 * `visibilitychange` / `online` (there is no browser here).
 *
 * ── EVERY TRANSITION IS LOGGED, AND THAT IS HALF THE FIX ────────────────────
 *
 * Silence is what made the outage invisible. A reconnect that worked quietly
 * would leave the next occurrence just as unexplainable, so a close, every
 * attempt, every failure and every recovery gets a line, and `heartbeat.js`
 * prints the resulting state on a timer whether anything happened or not.
 */
import { PqpSocket } from "../../ambient/src/pqp-client.js";

/**
 * Keepalive cadence, copied from `realtime.ts` and for the same reason: hosted
 * proxies drop idle WebSockets, and this connection is idle by design for hours
 * at a time. A bot that only ever writes when somebody mentions it is the
 * single most reap-prone client on the deploy.
 */
export const PING_INTERVAL_MS = 20_000;
/** One slow round trip must not drop a healthy link; two in a row is a dead one. */
export const MAX_MISSED_PONGS = 2;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * A socket for one channel that reconnects until told to stop.
 *
 * Drop-in for the subset of `PqpSocket` the bot actually calls — `onFrame`,
 * `typing`, `send`, `close` — plus `state()` for the heartbeat.
 */
export class ResilientSocket {
  #inner = null;
  #frameHandlers = new Set();
  #stopped = false;
  #connecting = false;
  #reconnectTimer = null;
  #pingTimer = null;
  #awaitingPong = false;
  #missedPongs = 0;
  #attempt = 0;

  /**
   * @param {object} options
   * @param {string} options.wsUrl
   * @param {string} options.label            `#ajuda`, used in every log line
   * @param {string} options.channelId        re-joined after every reconnect
   * @param {() => Promise<string>|string} options.tokenProvider
   * @param {(event: string, fields?: object) => void} options.log
   */
  constructor({
    wsUrl,
    label,
    channelId,
    tokenProvider,
    log,
    WebSocketImpl,
    pingIntervalMs = PING_INTERVAL_MS,
    baseDelayMs = RECONNECT_BASE_DELAY_MS,
    maxDelayMs = RECONNECT_MAX_DELAY_MS,
    maxMissedPongs = MAX_MISSED_PONGS,
    jitter = () => Math.random() * 500,
  }) {
    this.wsUrl = wsUrl;
    this.label = label;
    this.channelId = channelId;
    this.tokenProvider = tokenProvider;
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.pingIntervalMs = pingIntervalMs;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxMissedPongs = maxMissedPongs;
    this.jitter = jitter;

    /** Everything the heartbeat prints, and everything a post-mortem needs. */
    this.stats = {
      connects: 0,
      reconnects: 0,
      closes: 0,
      failedAttempts: 0,
      lastReadyAt: 0,
      lastFrameAt: 0,
      /** When the current outage began; 0 while connected. */
      downSince: 0,
    };
  }

  /**
   * The first connect, and the only one that is allowed to throw.
   *
   * Deliberately not retried: a bot that cannot connect at boot has a bad
   * token, a renamed channel or a wrong URL, and those do not heal on their
   * own. Failing loudly at start makes it a deploy failure that Fly restarts
   * and the monitor sees. Only an ESTABLISHED socket that dies is worth
   * chasing, because that one usually is a network event.
   */
  async start() {
    await this.#open();
  }

  async #open() {
    this.#connecting = true;
    try {
      const token = await this.tokenProvider();
      const socket = new PqpSocket({
        wsUrl: this.wsUrl,
        token,
        label: this.label,
        WebSocketImpl: this.WebSocketImpl,
      });
      // Registered BEFORE connect: the server can broadcast between `ready` and
      // the next line of this function, and a message the bot never saw is
      // indistinguishable from one it ignored.
      socket.onFrame((frame) => this.#onFrame(frame));
      socket.onClose((event) => this.#onLoss(socket, event));
      await socket.connect();
      socket.joinChannel(this.channelId);
      this.#inner = socket;
      this.#attempt = 0;
      this.stats.connects += 1;
      this.stats.lastReadyAt = Date.now();
      const downMs = this.stats.downSince ? Date.now() - this.stats.downSince : 0;
      this.stats.downSince = 0;
      if (this.stats.connects > 1) {
        this.stats.reconnects += 1;
        this.log("socket.reconnected", {
          channel: this.label,
          downForS: Math.round(downMs / 1000),
          reconnects: this.stats.reconnects,
        });
      }
      this.#startKeepalive(socket);
    } finally {
      this.#connecting = false;
    }
  }

  #onFrame(frame) {
    this.stats.lastFrameAt = Date.now();
    if (frame.type === "pong") {
      this.#awaitingPong = false;
      this.#missedPongs = 0;
      return;
    }
    for (const handler of this.#frameHandlers) {
      handler(frame);
    }
  }

  /**
   * An established socket died. Idempotent per inner socket, and reached from
   * both the close event and the missed-pong timeout.
   */
  #onLoss(socket, event) {
    if (socket !== this.#inner) {
      return; // A stale socket from a previous generation; already replaced.
    }
    this.#inner = null;
    this.#stopKeepalive();
    this.stats.closes += 1;
    this.stats.downSince = Date.now();
    // THE LINE THAT WAS MISSING. Before this existed, the entire outage was a
    // log file that simply stopped, with no event marking the moment.
    this.log("socket.closed", {
      channel: this.label,
      code: event?.code,
      reason: event?.reason || undefined,
      closes: this.stats.closes,
    });
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer || this.#connecting) {
      return;
    }
    const delay =
      Math.min(this.baseDelayMs * 2 ** this.#attempt, this.maxDelayMs) + this.jitter();
    this.#attempt += 1;
    this.log("socket.reconnect", {
      channel: this.label,
      attempt: this.#attempt,
      inMs: Math.round(delay),
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#stopped) {
        return;
      }
      this.#open().catch((error) => {
        this.stats.failedAttempts += 1;
        this.log("socket.reconnect.failed", {
          channel: this.label,
          attempt: this.#attempt,
          error: String(error?.message ?? error),
        });
        this.#scheduleReconnect();
      });
    }, delay);
    // A pending reconnect must never be the reason the process stays alive.
    this.#reconnectTimer.unref?.();
  }

  /**
   * Application-level ping, not the protocol one.
   *
   * The server answers `{type:"ping"}` with `{type:"pong"}` (ws/index.ts) and
   * separately sends protocol pings of its own that Node's WebSocket answers
   * transparently. That transparent answer is exactly the problem: it keeps the
   * SERVER's view of the link alive without this process ever learning whether
   * its own writes still go anywhere. Sending our own gives us both the
   * outbound traffic that stops a proxy reaping an idle connection and a
   * positive liveness signal we can time out on.
   */
  #startKeepalive(socket) {
    this.#stopKeepalive();
    this.#awaitingPong = false;
    this.#missedPongs = 0;
    this.#pingTimer = setInterval(() => {
      if (socket !== this.#inner || !socket.isOpen()) {
        return;
      }
      if (this.#awaitingPong) {
        this.#missedPongs += 1;
        if (this.#missedPongs >= this.maxMissedPongs) {
          // Half-open: the socket believes it is fine and no close event is
          // coming. This is the shape that outlives every naive liveness check.
          this.log("socket.stale", {
            channel: this.label,
            missedPongs: this.#missedPongs,
          });
          this.#onLoss(socket, { code: 4000, reason: "missed pongs" });
          try {
            socket.close();
          } catch {
            // already gone
          }
          return;
        }
      }
      this.#awaitingPong = true;
      try {
        socket.sendFrame({ type: "ping" });
      } catch (error) {
        this.#onLoss(socket, { code: 1006, reason: String(error?.message ?? error) });
      }
    }, this.pingIntervalMs);
    this.#pingTimer.unref?.();
  }

  #stopKeepalive() {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    this.#awaitingPong = false;
    this.#missedPongs = 0;
  }

  /**
   * Handlers live on the wrapper, not on the socket, which is the whole reason
   * a reconnect is invisible to the caller: the inner socket is replaced and
   * the subscription survives it.
   */
  onFrame(handler) {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }

  isOpen() {
    return Boolean(this.#inner?.isOpen());
  }

  typing() {
    if (!this.#inner) {
      throw new Error(`${this.label}: socket is down (reconnecting)`);
    }
    this.#inner.typing();
  }

  /**
   * Send, or refuse. No queue, deliberately: the caller is posting a reply to a
   * message somebody sent seconds ago, and an answer that surfaces after a
   * thirty-second reconnect gap lands in a conversation that has moved on. The
   * caller logs the drop; the escalation ledger already records the question.
   */
  send(body) {
    if (!this.#inner) {
      throw new Error(`${this.label}: socket is down (reconnecting)`);
    }
    this.#inner.send(body);
  }

  /**
   * Send as a reply to a specific message, or refuse (same policy as `send`).
   *
   * `PqpSocket.send` has no reply parameter because the cast never replies to
   * anything in particular; the bot does, when it answers a newcomer's hello,
   * because a bare "opa, chegou!" three messages below the "oi" reads as noise
   * and the same line threaded under the "oi" reads as a reply. `replyToId` is
   * the field `message-create` already accepts (`@pqp/shared` chat.ts).
   */
  reply(body, replyToId) {
    if (!this.#inner) {
      throw new Error(`${this.label}: socket is down (reconnecting)`);
    }
    this.#inner.sendFrame({
      type: "message-create",
      channelId: this.channelId,
      body,
      replyToId,
    });
  }

  /** What the heartbeat prints. */
  state() {
    return {
      channel: this.label,
      open: this.isOpen(),
      reconnects: this.stats.reconnects,
      closes: this.stats.closes,
      downSince: this.stats.downSince,
      lastFrameAt: this.stats.lastFrameAt,
      lastReadyAt: this.stats.lastReadyAt,
    };
  }

  close() {
    this.#stopped = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#stopKeepalive();
    this.#inner?.close();
    this.#inner = null;
  }
}
