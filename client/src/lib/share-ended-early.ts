/**
 * `share.endedEarly`: one event when a screen share ENDS within ten seconds of
 * going out, so "it opens and closes" says why without log archaeology.
 *
 * WHAT LEAVES THE PAGE. Six closed-enum fields and nothing else: `reason`,
 * `surface`, `audio`, `platform`, `transport`, `elapsedBucket`. Never a user,
 * channel or server id, never a window or tab title, never the label of the
 * capture source, never an error message. Every field is passed through a
 * whitelist in `buildShareEndedEarly`, so a free string handed in by mistake
 * (a track label, `err.message`) collapses to `unknown` instead of travelling.
 * Errors are mapped to the enum by `reasonFromCaptureError`, which reads the
 * error's NAME (and, for one case, tests the message for a word) and forwards
 * neither.
 *
 * WHERE IT GOES. Grafana Faro through `reportFaroEvent`, the same seam as
 * `voice.micRecovery`: with no `VITE_FARO_URL` (every self-host, local dev)
 * that is a no-op, so a self-hoster's users are never reported to us (AGPL
 * posture, `client/src/lib/faro.ts`). Also one `console.warn` line with the
 * same fields, local to the browser, so a person can copy it from the console.
 *
 * RATE LIMIT. One Faro event per minute per page. The console line is not
 * limited: it sends nothing anywhere, and the second try is the one a person
 * is most likely to be copying from.
 *
 * Nothing here changes share behaviour. The callers say why a share ended; this
 * only records it.
 */

import { reportFaroEvent } from "./faro";

/** A share that ends within this long of going out is "early". */
export const EARLY_END_WINDOW_MS = 10_000;

/** At most one Faro event per page in this many milliseconds. */
export const SHARE_ENDED_EARLY_MIN_INTERVAL_MS = 60_000;

export const SHARE_END_REASONS = [
  "refused-by-server",
  "track-ended",
  "capture-failed",
  "permission-denied",
  "user-stopped",
  "republish-failed",
  "room-left",
  "transport-changed",
  "unknown",
] as const;
export type ShareEndReason = (typeof SHARE_END_REASONS)[number];

export const SHARE_SURFACES = ["screen", "window", "tab", "unknown"] as const;
export type ShareSurface = (typeof SHARE_SURFACES)[number];

export const SHARE_AUDIO_STATES = ["with", "without", "failed"] as const;
export type ShareAudio = (typeof SHARE_AUDIO_STATES)[number];

export const SHARE_PLATFORMS = ["web", "desktop"] as const;
export type SharePlatform = (typeof SHARE_PLATFORMS)[number];

export const SHARE_TRANSPORTS = ["mesh", "sfu"] as const;
export type ShareTransport = (typeof SHARE_TRANSPORTS)[number];

export const ELAPSED_BUCKETS = ["lt2s", "2to5s", "5to10s"] as const;
export type ElapsedBucket = (typeof ELAPSED_BUCKETS)[number];

export interface ShareEndedEarlyPayload {
  reason: ShareEndReason;
  surface: ShareSurface;
  audio: ShareAudio;
  platform: SharePlatform;
  transport: ShareTransport;
  elapsedBucket: ElapsedBucket;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * The browser's `displaySurface` setting as the enum. `monitor` is a whole
 * screen, `window` a window, `browser` a tab. Anything else, absent or not a
 * string (Electron has shipped tracks without one) is `unknown`.
 */
export function shareSurface(raw: unknown): ShareSurface {
  switch (raw) {
    case "monitor":
      return "screen";
    case "window":
      return "window";
    case "browser":
      return "tab";
    default:
      return "unknown";
  }
}

/** The bucket for how long the share lived, or null at ten seconds and beyond. */
export function elapsedBucket(ms: number): ElapsedBucket | null {
  if (!Number.isFinite(ms) || ms >= EARLY_END_WINDOW_MS) {
    return null;
  }
  if (ms < 2_000) {
    return "lt2s";
  }
  return ms < 5_000 ? "2to5s" : "5to10s";
}

/** The room's transport as this event names it. `livekit` is the SFU. */
export function shareTransport(roomTransport: string | null | undefined): ShareTransport {
  return roomTransport === "livekit" ? "sfu" : "mesh";
}

/**
 * Why a `getDisplayMedia` call failed, as the enum, or null when it is not a
 * share ending at all: a person closing the picker is `NotAllowedError` with no
 * further word, and reporting every cancel would bury the signal. Chromium words
 * the operating system refusing (macOS screen recording switched off) as
 * "Permission denied by system"; that one word is the only part of the message
 * looked at, and the message itself is never forwarded.
 */
export function reasonFromCaptureError(err: unknown): ShareEndReason | null {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError") {
    const message = err instanceof Error ? err.message : "";
    return /system/i.test(message) ? "permission-denied" : null;
  }
  return "capture-failed";
}

export interface ShareEndedEarlyInput {
  startedAt: number;
  endedAt: number;
  reason: unknown;
  surface?: unknown;
  audio?: unknown;
  platform?: unknown;
  transport?: unknown;
}

/**
 * The event, or null when the share lived ten seconds or more (or the clock is
 * unusable). Every field is re-validated here against its enum.
 */
export function buildShareEndedEarly(input: ShareEndedEarlyInput): ShareEndedEarlyPayload | null {
  const bucket = elapsedBucket(Math.max(0, input.endedAt - input.startedAt));
  if (bucket === null) {
    return null;
  }
  return {
    reason: oneOf(SHARE_END_REASONS, input.reason, "unknown"),
    surface: oneOf(SHARE_SURFACES, input.surface, "unknown"),
    audio: oneOf(SHARE_AUDIO_STATES, input.audio, "without"),
    platform: oneOf(SHARE_PLATFORMS, input.platform, "web"),
    transport: oneOf(SHARE_TRANSPORTS, input.transport, "mesh"),
    elapsedBucket: bucket,
  };
}

export interface ShareEndedEarlyDeps {
  now?: () => number;
  /** Where the hosted-only event goes. Defaults to Faro, a no-op without a URL. */
  send?: (name: string, attributes: Record<string, string>) => void;
  warn?: (message: string, fields: ShareEndedEarlyPayload) => void;
}

/**
 * A reporter with its own rate-limit clock. The page uses one, below; a test
 * makes its own so it starts with a clean minute.
 */
export function createShareEndedEarlyReporter(deps: ShareEndedEarlyDeps = {}) {
  const now = deps.now ?? Date.now;
  const send = deps.send ?? reportFaroEvent;
  const warn =
    deps.warn ?? ((message, fields) => console.warn(message, fields));
  let lastSentAt: number | null = null;

  /** Returns true when the event went to telemetry (not rate limited). */
  return function report(payload: ShareEndedEarlyPayload | null): boolean {
    if (!payload) {
      return false;
    }
    try {
      warn("[pqp] screen share ended early", payload);
    } catch {
      // The console is never allowed to break a share ending.
    }
    const at = now();
    if (lastSentAt !== null && at - lastSentAt < SHARE_ENDED_EARLY_MIN_INTERVAL_MS) {
      return false;
    }
    lastSentAt = at;
    try {
      send("share.endedEarly", { ...payload });
    } catch {
      // Telemetry never breaks the app.
    }
    return true;
  };
}

/** The page's reporter: one minute of limit shared by every share in this tab. */
export const reportShareEndedEarly = createShareEndedEarlyReporter();
