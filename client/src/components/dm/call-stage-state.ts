/**
 * The call stage's decisions, as pure functions.
 *
 * Everything here answers a stage or bookkeeping question without touching the
 * DOM, so the rules the stage lives by — whether it is worth expanding at all,
 * where the self-preview snaps, how long the call has run — can be pinned in a
 * Node test instead of only being observable through a browser.
 *
 * Who is large and who is a chip is the other half, and it lives in
 * `components/voice/stage-layout.ts`.
 */

/**
 * Whether the stage has a picture worth owning the room: a camera (ours or
 * someone else's) or a screen share. Voice-only occupancy is not a picture.
 */
export function hasWatchableVideo(input: {
  localCameraOn: boolean;
  remoteHasCamera: boolean;
  screenShareCount: number;
}): boolean {
  return (
    input.localCameraOn ||
    input.remoteHasCamera ||
    input.screenShareCount > 0
  );
}

/**
 * The expanded stage is for watching something, or for an outgoing ring.
 * Voice-only occupancy stays a slim bar. Collapsing is a user choice
 * remembered for the session.
 */
export function shouldShowExpandedStage(
  hasVideo: boolean,
  userCollapsed: boolean,
  ringing = false,
): boolean {
  return (hasVideo || ringing) && !userCollapsed;
}

/** Prefix so a camera solo does not collide with that peer's screen share. */
export function cameraSoloId(personKey: string): string {
  return `camera:${personKey}`;
}

export function isCameraSoloId(soloId: string | null): boolean {
  return soloId !== null && soloId.startsWith("camera:");
}

export function personKeyFromCameraSoloId(soloId: string): string | null {
  return soloId.startsWith("camera:") ? soloId.slice("camera:".length) : null;
}

/** "0:07", "12:41", "1:05:09" — a call timer, never a timestamp. */
export function formatCallDuration(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(seconds)}`
    : `${minutes}:${two(seconds)}`;
}

export type PipCorner = "tl" | "tr" | "bl" | "br";

/**
 * Where a dragged self-preview should snap when released: whichever corner is
 * nearest to where the pointer let go, measured inside the stage's box.
 */
export function nearestCorner(
  x: number,
  y: number,
  width: number,
  height: number,
): PipCorner {
  const left = x < width / 2;
  const top = y < height / 2;
  if (top) {
    return left ? "tl" : "tr";
  }
  return left ? "bl" : "br";
}

/**
 * Whether the stage starts collapsed for a conversation — remembered for the
 * session, per conversation, so mid-call readers who tucked the call away once
 * are not asked to do it again every render or navigation.
 *
 * A module-level map rather than localStorage on purpose: "I want to read chat
 * during THIS call" is a session-length preference, not an account setting.
 */
const collapsedByConversation = new Map<string, boolean>();

export function isStageCollapsed(conversationId: string): boolean {
  return collapsedByConversation.get(conversationId) ?? false;
}

export function rememberStageCollapsed(
  conversationId: string,
  collapsed: boolean,
): void {
  collapsedByConversation.set(conversationId, collapsed);
}

/**
 * The pinned stage tile, session-scoped per channel the same way collapse is.
 *
 * The value is a tile id (`stage-layout.ts`), so a share and a camera can both
 * be pinned and the pin survives that person turning the other one on. Null is
 * the default: the grid treats every publisher equally until somebody says
 * otherwise.
 */
const pinnedByChannel = new Map<string, string | null>();

export function stagePinnedKey(channelId: string): string | null {
  return pinnedByChannel.get(channelId) ?? null;
}

export function rememberStagePinnedKey(
  channelId: string,
  key: string | null,
): void {
  pinnedByChannel.set(channelId, key);
}

/**
 * When this call started, keyed by the join (`channelId:peerId`) rather than by
 * the conversation: the server mints a fresh peer id per join, so a rejoined
 * call restarts its clock while collapse/expand and navigation — which remount
 * the component but not the call — keep it.
 */
const startedAt = new Map<string, number>();

export function callStartKey(channelId: string, peerId: string): string {
  return `${channelId}:${peerId}`;
}

export function markCallStarted(key: string, now: number): number {
  const existing = startedAt.get(key);
  if (existing !== undefined) {
    return existing;
  }
  // One live call per client: anything else in the map is a finished call's
  // stale entry. Dropping them here keeps the map from growing for the session.
  startedAt.clear();
  startedAt.set(key, now);
  return now;
}

export function callStartedAt(key: string): number | null {
  return startedAt.get(key) ?? null;
}
