/**
 * Asking a platform for element fullscreen and finding out whether it happened.
 *
 * WHY THIS EXISTS. `requestFullscreen()` is specified to return a promise that
 * resolves when the element goes fullscreen and rejects when the request is
 * refused, and in a browser it does exactly that. Inside an Electron shell it
 * can do neither. Chromium hands the request to the embedder as a `fullscreen`
 * permission, and an embedder that answers "no" leaves the promise **pending
 * forever**: no resolve, no reject, no `fullscreenerror`, no `fullscreenchange`.
 * Every `catch` and every event listener the client has is dead code on that
 * path, which is why the fullscreen buttons worked on the web and did nothing
 * at all on the desktop app.
 *
 * The shell is fixed (`electron/main.js` now allows the permission), but a
 * shell fix only reaches people through a tagged desktop release, and the
 * packaged app loads the *hosted* client — so this half of the fix reaches
 * every already-installed build the moment the web deploys.
 *
 * The answer therefore cannot come from the promise alone. Race it against a
 * short grace period and then ask the document what is actually fullscreen,
 * which is the one source that cannot lie. A caller that gets `false` back
 * still owes the user a filled viewport, and both call sites give them one by
 * falling back to the in-page `expand` mode: the same CSS path an iPhone has
 * taken since PR #48, which fills the window without handing anything to a
 * native player.
 */

/**
 * How long to wait for a platform that answers neither way.
 *
 * Chromium confirms in single-digit milliseconds — even macOS's animated
 * window transition fires `fullscreenchange` up front, before the animation —
 * so this is far longer than any real transition needs. It is only ever paid
 * on a platform that is never going to answer, and it is short enough that a
 * dead button reads as "it fell back" rather than "it hung".
 */
export const ELEMENT_FULLSCREEN_GRACE_MS = 1200;

export interface ElementFullscreenAttempt {
  /**
   * Fires the platform request. May resolve, may reject, may never settle —
   * that last one is the whole point.
   */
  request: () => Promise<void>;
  /** Is the target element the document's fullscreen element right now? */
  isActive: () => boolean;
  /** Called with the rejection when the platform refuses out loud. */
  onRefusal?: (error: unknown) => void;
  graceMs?: number;
  /** Injected by the tests; production uses `setTimeout`. */
  wait?: (ms: number) => Promise<void>;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when the element really is fullscreen, false when the platform refused
 * — whether it said so or simply never answered.
 *
 * The happy path costs nothing: a resolved request is checked immediately and
 * only a platform that stays silent waits out the grace period.
 */
export async function attemptElementFullscreen({
  request,
  isActive,
  onRefusal,
  graceMs = ELEMENT_FULLSCREEN_GRACE_MS,
  wait = defaultWait,
}: ElementFullscreenAttempt): Promise<boolean> {
  const answered = request().then(
    () => undefined,
    (error: unknown) => {
      // Attached here rather than left to a caller's `.catch` so a refusal can
      // never surface as an unhandled rejection while we are still waiting.
      onRefusal?.(error);
    },
  );
  await Promise.race([answered, wait(graceMs)]);
  return isActive();
}
