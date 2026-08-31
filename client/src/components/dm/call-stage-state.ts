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

/**
 * Layout once the stage is actually showing a picture.
 *
 * Camera count, not headcount: five people with one camera is a spotlight,
 * not a grid of avatars. Grid is an explicit choice, and only with two
 * cameras to share the stage between.
 */
export function resolvedStageLayout(input: {
  remoteCount: number;
  hasScreenShare: boolean;
  cameraCount: number;
  preferGrid: boolean;
}): StageLayout {
  if (input.hasScreenShare) {
    return "screen";
  }
  if (input.remoteCount === 0) {
    return "ring";
  }
  if (input.preferGrid && input.cameraCount >= 2) {
    return "grid";
  }
  if (input.cameraCount >= 1) {
    return "spotlight";
  }
  return stageLayout(input.remoteCount, false);
}

/**
 * Who fills the spotlight: a pin the user chose, else someone speaking on
 * camera, else the first remote camera, else anyone with a camera, else the
 * first remote person.
 */
export function pickSpotlightKey(
  people: readonly {
    key: string;
    /** Camera picture when they send one; null is an avatar. */
    stream: unknown;
    speaking: boolean;
    isSelf: boolean;
  }[],
  pinnedKey: string | null,
): string | null {
  if (pinnedKey && people.some((person) => person.key === pinnedKey)) {
    return pinnedKey;
  }
  const speakingCam = people.find(
    (person) => person.speaking && person.stream !== null && !person.isSelf,
  );
  if (speakingCam) {
    return speakingCam.key;
  }
  const remoteCam = people.find(
    (person) => person.stream !== null && !person.isSelf,
  );
  if (remoteCam) {
    return remoteCam.key;
  }
  const anyCam = people.find((person) => person.stream !== null);
  if (anyCam) {
    return anyCam.key;
  }
  return people.find((person) => !person.isSelf)?.key ?? people[0]?.key ?? null;
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
 * Grid vs spotlight, session-scoped per channel the same way collapse is.
 * Default is spotlight: the picture owns the room, the rest sit on a strip.
 */
const preferGridByChannel = new Map<string, boolean>();

export function isStageGrid(channelId: string): boolean {
  return preferGridByChannel.get(channelId) ?? false;
}

export function rememberStageGrid(channelId: string, grid: boolean): void {
  preferGridByChannel.set(channelId, grid);
}

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
