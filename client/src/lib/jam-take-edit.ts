/**
 * The optional edits between stopping and posting: trim the start and the end,
 * nudge the whole take earlier or later, change its volume. Posting needs none
 * of them (the engine already placed the take), so every function here starts
 * from "as recorded" and says whether anything moved.
 *
 * All in milliseconds, in the engine's own terms (`docs/JAM_ENGINE.md`): a trim
 * hides a head or a tail of the recorded buffer and never moves the audio; a
 * nudge moves all of it.
 */

export interface TakeTiming {
  offsetMs: number;
  /** The head the engine hid (the count-in): a trim never reveals it again. */
  trimStartMs: number;
  trimEndMs: number;
  durationMs: number;
}

export interface TakeEdits {
  trimStartMs: number;
  trimEndMs: number;
  nudgeMs: number;
  gain: number;
}

/** Shortest stretch of a take that may stay audible. */
export const MIN_AUDIBLE_MS = 500;
/** How far a nudge may go either way. */
export const NUDGE_LIMIT_MS = 500;

export function asRecorded(take: TakeTiming): TakeEdits {
  return { trimStartMs: take.trimStartMs, trimEndMs: take.trimEndMs, nudgeMs: 0, gain: 1 };
}

export function audibleMs(take: Pick<TakeTiming, "durationMs">, edits: Pick<TakeEdits, "trimStartMs" | "trimEndMs">): number {
  return Math.max(0, take.durationMs - edits.trimStartMs - edits.trimEndMs);
}

/** Move the start trim, keeping it past the recorded head and leaving something to hear. */
export function withTrimStart(take: TakeTiming, edits: TakeEdits, trimStartMs: number): TakeEdits {
  const most = take.durationMs - edits.trimEndMs - MIN_AUDIBLE_MS;
  return { ...edits, trimStartMs: Math.round(Math.min(Math.max(trimStartMs, take.trimStartMs), Math.max(take.trimStartMs, most))) };
}

/** Move the end trim (ms hidden at the tail), leaving something to hear. */
export function withTrimEnd(take: TakeTiming, edits: TakeEdits, trimEndMs: number): TakeEdits {
  const most = take.durationMs - edits.trimStartMs - MIN_AUDIBLE_MS;
  return { ...edits, trimEndMs: Math.round(Math.min(Math.max(trimEndMs, 0), Math.max(0, most))) };
}

export function withNudge(edits: TakeEdits, nudgeMs: number): TakeEdits {
  return { ...edits, nudgeMs: Math.round(Math.min(Math.max(nudgeMs, -NUDGE_LIMIT_MS), NUDGE_LIMIT_MS)) };
}

export function withGain(edits: TakeEdits, gain: number): TakeEdits {
  return { ...edits, gain: Math.min(Math.max(gain, 0), 2) };
}

/** What the engine and the server get: the take's own numbers with the edits laid on. */
export function placed(take: TakeTiming, edits: TakeEdits) {
  return {
    offsetMs: take.offsetMs + edits.nudgeMs,
    trimStartMs: edits.trimStartMs,
    trimEndMs: edits.trimEndMs,
    gain: edits.gain,
  };
}

export function isEdited(take: TakeTiming, edits: TakeEdits): boolean {
  const original = asRecorded(take);
  return (
    edits.trimStartMs !== original.trimStartMs ||
    edits.trimEndMs !== original.trimEndMs ||
    edits.nudgeMs !== 0 ||
    edits.gain !== 1
  );
}
