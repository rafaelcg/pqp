/**
 * The push-to-talk release-delay setting: how long the mic stays open after
 * the physical key/button comes up, on the desktop shell's native hook
 * (`electron/lib/native-ptt-hook.js`, `electron/lib/release-delay.js`).
 *
 * These constants are duplicated from `electron/lib/release-delay.js`
 * rather than imported: the client and the Electron main process are
 * separate packages with separate build targets (one bundled by Vite for a
 * browser, one run directly by Node inside Electron), and neither is set up
 * to import the other's source. Kept in sync by inspection, both sides are
 * small, stable, and the range (0-2000 ms, default 20) is documented in the
 * task this shipped against and in both files' own comments.
 */

export const DEFAULT_RELEASE_DELAY_MS = 20;
export const MIN_RELEASE_DELAY_MS = 0;
export const MAX_RELEASE_DELAY_MS = 2000;

/**
 * Clamp a release-delay setting to the slider's range. Anything else (a
 * hand-edited `localStorage` blob, a future rollback of a widened range)
 * falls back to the default rather than carrying a negative or runaway
 * value into the desktop bridge.
 */
export function clampReleaseDelayMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RELEASE_DELAY_MS;
  }
  return Math.min(
    MAX_RELEASE_DELAY_MS,
    Math.max(MIN_RELEASE_DELAY_MS, Math.round(value)),
  );
}
