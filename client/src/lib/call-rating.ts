import type { CallTransport, MediaQualitySummary } from "@pqp/shared";

/**
 * When to ask how a call went, as pure functions.
 *
 * WHY THIS IS NOT IN THE HOOK. The rules below decide whether a person gets
 * interrupted, which makes them the part worth testing, and the client suite
 * has no DOM to render a hook into. Same shape as `lib/acquisition.ts`:
 * everything takes its clock and its storage as arguments, the React wrapper
 * supplies the real ones, and the tests supply their own.
 *
 * THREE GATES, and none of them is about the rating itself:
 *
 * - The call has to have lasted a minute. Below that the person is rating
 *   whether they meant to click, not whether the call worked.
 * - Somebody else has to have been there. A call of one has no quality.
 * - Not more than once every six hours. An evening of five short calls is one
 *   question, and the sixth answer would not say anything the first five did
 *   not.
 */

export const MIN_DURATION_SECONDS = 60;
export const COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface RatableCall {
  durationSeconds: number;
  /** The most people who were in the room at once, not the count at the end. */
  peerCount: number;
  transport: CallTransport;
  hadScreenShare: boolean;
  channelId: string | null;
  /**
   * What the media actually did, sampled while the call was live and frozen
   * here at the end -- same reasoning as every other field on this type, and
   * why it is not read off `sampleVoiceStats()` at this point: the
   * connections are already gone. Attached by `useCallRating`, which is the
   * caller with access to the running accumulator; `finishCall` itself knows
   * nothing about media quality and leaves this undefined. Undefined (not
   * null) when the caller has nothing to attach, so a test exercising only
   * the timing rules never has to fake a quality reading.
   */
  mediaQuality?: MediaQualitySummary;
}

/** What is accumulated while a call runs, because none of it survives the end. */
export interface CallProgress {
  startedAt: number;
  maxPeers: number;
  hadScreenShare: boolean;
  transport: CallTransport;
  channelId: string | null;
}

/** The slice of voice state this cares about, named so a test need not fake the rest. */
export interface CallSnapshot {
  peerCount: number;
  usingSfu: boolean;
  screenSharing: boolean;
  channelId: string | null;
}

export function startCall(snapshot: CallSnapshot, now: number): CallProgress {
  return {
    startedAt: now,
    maxPeers: snapshot.peerCount,
    hadScreenShare: snapshot.screenSharing,
    transport: snapshot.usingSfu ? "livekit" : "mesh",
    channelId: snapshot.channelId,
  };
}

/**
 * Fold one moment of a live call into what is known about it.
 *
 * Peers are a high-water mark because people leave before somebody hangs up,
 * and describing a call of five as a call of one would misreport the thing
 * being rated. The screen-share flag is sticky for the same reason. Transport
 * is re-read rather than trusted from the join, because a room can be promoted
 * to the SFU while somebody is sitting in it.
 */
export function advanceCall(
  progress: CallProgress,
  snapshot: CallSnapshot,
): CallProgress {
  return {
    ...progress,
    maxPeers: Math.max(progress.maxPeers, snapshot.peerCount),
    hadScreenShare: progress.hadScreenShare || snapshot.screenSharing,
    transport: snapshot.usingSfu ? "livekit" : "mesh",
  };
}

/**
 * The call is over: ask, or stay quiet.
 *
 * Null means "do not interrupt", and the caller must not treat it as an error.
 */
export function finishCall(
  progress: CallProgress,
  now: number,
  lastAskedAt: number,
): RatableCall | null {
  const durationSeconds = Math.round((now - progress.startedAt) / 1000);
  if (durationSeconds < MIN_DURATION_SECONDS) {
    return null;
  }
  if (progress.maxPeers === 0) {
    return null;
  }
  if (now - lastAskedAt < COOLDOWN_MS) {
    return null;
  }
  return {
    durationSeconds,
    peerCount: progress.maxPeers,
    transport: progress.transport,
    hadScreenShare: progress.hadScreenShare,
    channelId: progress.channelId,
  };
}

/**
 * The JSON `POST /api/voice/ratings` receives, as a pure function so the shape
 * the product actually sends can be pinned by a test.
 *
 * TWO RULES, AND THEY DIFFER ON PURPOSE. The note is a low-score thing: above
 * `LOW_SCORE_MAX` the card never asks for one, and the server drops one
 * anyway. The media reading is NOT: it goes with every score, a 5 as much as a
 * 1, because a bad call can only be explained by comparing it with a good one.
 * It used to go only at 3 or below (and the server threw a good call's away
 * too), so over eight weeks 726 ratings of 4 or 5 carried none. It is bounded
 * numbers and booleans (`mediaQualitySchema`): no peer id, no address, no
 * device name.
 */
export const LOW_SCORE_MAX = 3;

export function buildRatingBody(
  call: RatableCall,
  score: number,
  note: string,
): Record<string, unknown> {
  const trimmed = note.trim();
  return {
    rating: score,
    note: score <= LOW_SCORE_MAX && trimmed ? trimmed : undefined,
    durationSeconds: call.durationSeconds,
    peerCount: call.peerCount,
    transport: call.transport,
    hadScreenShare: call.hadScreenShare,
    channelId: call.channelId ?? undefined,
    mediaQuality: call.mediaQuality,
  };
}
