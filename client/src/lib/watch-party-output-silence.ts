/**
 * Sustained digital silence in the mixed stream's OUTPUT, and the rule for
 * turning `ScreenMix.outputLevelDb`'s readings into a warning worth
 * interrupting a broadcast for.
 *
 * THE GAP THIS CLOSES (2026-09-12 postmortem, B2). `streamAudioState` in
 * `watch-party-transmission.tsx` answers "does the transcode have an audio
 * track at all", from `LiveHlsStream.hasAudio` — a fact the SERVER states
 * once, from session metadata. It cannot see a track that publishes and then
 * goes quiet: the panel read "the window's + your mic" for three separate
 * stretches on 2026-09-12 while -91 dB actually left the machine. Only a live
 * meter on the same bus the egress subscribes to can catch that, which is
 * what `ScreenMix.outputLevelDb` is for; this module is the timer around it.
 *
 * A STREAK, NOT ONE READING. The bus dips into true silence for the odd gap
 * in ordinary speech or a film's own quiet beat; warning on the first sample
 * would be wallpaper before the opening credits finish. Ten seconds sustained
 * is long enough that nothing short of an actually silent stream produces it.
 *
 * `null` (no analyser, or nothing sampled yet) resets the streak rather than
 * holding it: an unmeasurable stream is not a known-silent one, and a browser
 * that merely lacks `AnalyserNode` must not be warned about.
 *
 * Pure and exported so the rule is testable as a rule, with no timers and no
 * DOM — the same shape as `use-share-uplink-strain.ts`'s `nextStrainStreak`.
 */

/** At or below this, the bus reads as carrying nothing. */
export const OUTPUT_SILENCE_FLOOR_DBFS = -80;
/** How long the floor has to hold before it is worth saying out loud. */
export const OUTPUT_SILENCE_WARN_MS = 10_000;

export interface OutputSilenceState {
  /** `Date.now()` the level first read at or below the floor, or null. */
  readonly silentSince: number | null;
}

export const INITIAL_OUTPUT_SILENCE_STATE: OutputSilenceState = {
  silentSince: null,
};

/** One reading in, the next state out. */
export function nextOutputSilenceState(
  state: OutputSilenceState,
  levelDb: number | null,
  now: number,
): OutputSilenceState {
  const silentNow = levelDb !== null && levelDb <= OUTPUT_SILENCE_FLOOR_DBFS;
  if (!silentNow) {
    return state.silentSince === null ? state : INITIAL_OUTPUT_SILENCE_STATE;
  }
  return state.silentSince === null ? { silentSince: now } : state;
}

/** Whether the streak has gone on long enough to be worth saying. */
export function isOutputSilenceWarning(
  state: OutputSilenceState,
  now: number,
): boolean {
  return (
    state.silentSince !== null &&
    now - state.silentSince >= OUTPUT_SILENCE_WARN_MS
  );
}
