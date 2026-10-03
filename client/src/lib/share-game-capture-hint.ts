import { getDesktop, type PqpDesktop } from "./desktop";
import { isAutomatedBrowser, isHintSeen, rememberHint, type HintStorage } from "./hints";

/**
 * The presenter's card for a share whose picture died, almost always a game in
 * exclusive fullscreen (docs/DESKTOP.md §"Sharing a game: Fullscreen vs
 * Fullscreen Windowed"). This file is the rules; the sampling is
 * `share-picture-watch.ts` and the card is
 * `components/voice/share-game-capture-notice.tsx`.
 *
 * BEHIND `share_game_capture_hint` (runtime flag, per server, default off,
 * `GET /api/share/config`), and never on pixels alone: the shell has to
 * confirm that Windows sees a Direct3D app in exclusive fullscreen
 * (`confirmExclusiveFullscreen`), or nothing is shown.
 *
 * WHERE IT RUNS: the Windows desktop app only. That is where the report came
 * from and where the cause lives (a game that takes the display away from the
 * desktop compositor is a Windows behaviour). A browser share on Windows has
 * the same capturer and the same failure, but the browser draws its own
 * "sharing" UI, and a card that talks about game settings to somebody sharing
 * a tab would be noise; widening it is one line here once the desktop numbers
 * say it is worth it.
 *
 * "NÃO MOSTRAR DE NOVO" is remembered in the one hint store (`lib/hints.ts`),
 * which also keeps the card away from Playwright and, unless asked, from
 * localhost persistence. Silenced, the watch does not even start: no clone,
 * no reader, no cost.
 */

export type ShareCaptureHintKind = "black" | "stalled" | "ended";

export interface ShareCaptureHint {
  kind: ShareCaptureHintKind;
  /** When it was raised (`Date.now()`); a new hint is a new card even after a close. */
  at: number;
}

export const SHARE_GAME_CAPTURE_HINT_KEY = "pqp:share-game-capture-hint-off";

/** A capture that ends on its own this soon after it started is reported. */
export const SHARE_EARLY_END_MS = 60_000;

export function isShareGameCaptureHintSilenced(
  storage?: Pick<Storage, "getItem"> | null,
  persist?: boolean,
): boolean {
  return isHintSeen(SHARE_GAME_CAPTURE_HINT_KEY, storage, persist);
}

export function silenceShareGameCaptureHint(
  storage?: Pick<Storage, "setItem"> | null,
  persist?: boolean,
): void {
  rememberHint(SHARE_GAME_CAPTURE_HINT_KEY, storage as HintStorage, persist);
}

export interface ShareWatchContext {
  /** `getDesktop()?.platform`, undefined in a browser. */
  desktopPlatform: string | undefined;
  silenced: boolean;
  automated?: boolean;
}

/** Whether a share should be sampled at all. */
export function shouldWatchSharePicture(context: ShareWatchContext): boolean {
  return (
    context.desktopPlatform === "win32" &&
    !context.silenced &&
    !(context.automated ?? isAutomatedBrowser())
  );
}

/**
 * A capture whose track ended by itself (not our `stop()`, which fires no
 * `ended`) within the first minute. Later than that it is far more likely the
 * shared window closing at the end of a session than a game taking the
 * display.
 */
export function earlyEndIsHint(startedAt: number, endedAt: number): boolean {
  return endedAt - startedAt >= 0 && endedAt - startedAt < SHARE_EARLY_END_MS;
}

/**
 * The desktop shell's `SHQueryUserNotificationState` answer: true only for
 * `QUNS_RUNNING_D3D_FULL_SCREEN`. Null when this shell cannot ask (older than
 * the capability, not Windows) or the question failed; null never shows a card.
 */
export async function confirmExclusiveFullscreen(
  desktop: Pick<PqpDesktop, "fullscreenAppState"> | undefined = getDesktop(),
): Promise<boolean | null> {
  if (!desktop?.fullscreenAppState) {
    return null;
  }
  try {
    const answer = await desktop.fullscreenAppState();
    return typeof answer?.exclusiveFullscreen === "boolean" ? answer.exclusiveFullscreen : null;
  } catch {
    return null;
  }
}

/**
 * Show the card? Pure, so "closed means this hint, silenced means every hint"
 * is a test. A close remembers the hint's `at`, so the NEXT dead share (a new
 * `at`) shows again unless the person chose "não mostrar de novo".
 */
export function shouldShowShareCaptureNotice(input: {
  hint: ShareCaptureHint | null;
  closedAt: number | null;
  silenced: boolean;
}): boolean {
  return input.hint !== null && !input.silenced && input.closedAt !== input.hint.at;
}
