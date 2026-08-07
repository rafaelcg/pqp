/**
 * The call stage's decisions, as pure functions.
 *
 * Everything here answers a layout or bookkeeping question without touching the
 * DOM, so the rules the stage lives by — which arrangement a call gets, where
 * the self-preview snaps, how long the call has run — can be pinned in a Node
 * test instead of only being observable through a browser.
 */

export type StageLayout =
  /** Screen share on: the screen is the stage, people become thumbnails. */
  | "screen"
  /** 1:1 — the remote person IS the stage, self floats as a corner preview. */
  | "spotlight"
  /** Group call: a grid that shares the stage evenly. */
  | "grid"
  /** We are alone (ringing out / everyone left): one large pulsing identity. */
  | "ring";

/**
 * Which arrangement the stage draws. The screen share always wins — video of a
 * face is glanceable at thumbnail size, a shared screen is not.
 */
export function stageLayout(
  remoteCount: number,
  hasScreenShare: boolean,
): StageLayout {
  if (hasScreenShare) {
    return "screen";
  }
  if (remoteCount === 0) {
    return "ring";
  }
  return remoteCount === 1 ? "spotlight" : "grid";
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
