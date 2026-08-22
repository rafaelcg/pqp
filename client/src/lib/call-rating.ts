import type { CallTransport } from "@pqp/shared";

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
