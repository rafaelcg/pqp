import { isSlowConnection, type ConnectionLike } from "@/lib/hls-slow-start";

/**
 * `party_fast_start`: the client half of a faster first frame for a viewer
 * who opens a watch party. Runtime flag (`server/src/lib/flags.ts`), off by
 * default, answered per server on `GET /api/live-hls/config` as `fastStart`.
 *
 * (Not here, on purpose: a lower first rung. hls.js already opens a multi-rung
 * ladder on its lowest level to test the bandwidth, measured in
 * `tools/party-first-frame-bench`, and an LL master carries one rung.)
 *
 * Nothing here touches what the server packages. Every piece is about what
 * the BROWSER does while it waits, and each one is a no-op with the flag off:
 *
 *  1. The hls.js chunk is fetched as soon as a party channel is on screen,
 *     instead of at the moment the playlist URL is in hand.
 *  2. The 1.1 MB bubbles film is not downloaded during the first seconds of
 *     the wait. It shared the link with the init segment and the first media
 *     segment, which on a phone is the slowest thing in the whole path.
 *  3. The holding screen says what it is waiting for (and for how long)
 *     instead of "the stream stalled, reconnecting" on a stream that has
 *     not started yet, and drops the two lines with a censored swear.
 *
 * The flag reaches the player through this module rather than a prop: the
 * player is mounted from five places and none of them knows the server's
 * config. `App.tsx` writes the selected server's answer here and the player
 * reads it once per attach.
 */

let active = false;

/** Written by the app shell whenever the selected server's config changes. */
export function setPartyFastStart(on: boolean): void {
  active = on;
}

export function partyFastStartActive(): boolean {
  return active;
}

// ------------------------------------------------------------- engine chunk

let enginePreload: Promise<unknown> | null = null;

/**
 * Start fetching the hls.js chunk now. Idempotent, and a failed preload is
 * forgotten so the player's own `import("hls.js")` still gets its own try.
 * Never throws: a preload is a hint.
 */
export function preloadHlsEngine(): void {
  if (enginePreload) {
    return;
  }
  enginePreload = import("hls.js").catch(() => {
    enginePreload = null;
  });
}

/** Test seam. */
export function resetPartyFastStartForTests(): void {
  active = false;
  enginePreload = null;
}

// ---------------------------------------------------------------- the film

/**
 * How long the holding screen shows only its poster (36 KB) before the
 * looping film (1.1 MB) is allowed to start downloading. Long enough that a
 * healthy start never pays for it, short enough that a slow one still gets
 * some life on screen.
 */
export const BUBBLES_FILM_DEFER_MS = 8_000;

/** Whether the film may be fetched at all: never on a link the browser calls slow. */
export function bubblesFilmAllowed(
  connection: ConnectionLike | null | undefined,
): boolean {
  return !isSlowConnection(connection);
}

/** The two lines with a censored swear, dropped from the first screen. */
const SWEARING_LINES = new Set([
  "voice.watchParty.startingSoon.line4",
  "voice.watchParty.startingSoon.line5",
]);

export function startingSoonLineKeys<T extends string>(
  all: readonly T[],
  fastStart: boolean,
): readonly T[] {
  return fastStart ? all.filter((key) => !SWEARING_LINES.has(key)) : all;
}

// ------------------------------------------------------------ the wait, told

/** Where the first attach is, as far as this browser can tell. */
export type StartupStage = "connecting" | "media";

/** Seconds of waiting after which the caption starts counting out loud. */
export const STARTUP_ELAPSED_AFTER_SECONDS = 5;

export interface StartupCaption {
  key:
    | "voice.hls.startup.connecting"
    | "voice.hls.startup.media"
    | "voice.hls.startup.slow";
  seconds?: number;
}

/**
 * The truthful line for the holding screen while the very first frame has not
 * arrived. `connecting` is everything up to the playlist parsing (player
 * chunk, playlist, first level); `media` is the first init and segment.
 */
export function startupCaption(
  stage: StartupStage,
  elapsedSeconds: number,
): StartupCaption {
  if (elapsedSeconds >= STARTUP_ELAPSED_AFTER_SECONDS) {
    return { key: "voice.hls.startup.slow", seconds: Math.floor(elapsedSeconds) };
  }
  return {
    key:
      stage === "media"
        ? "voice.hls.startup.media"
        : "voice.hls.startup.connecting",
  };
}
