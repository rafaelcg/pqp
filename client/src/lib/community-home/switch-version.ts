import type { Server } from "@pqp/shared";

/**
 * The owner's Baú switch as a member's app learns it: the value and its
 * `servers.community_home_version`. It arrives three ways: the
 * `community-home-update` frame, the reconnect re-read of
 * `GET /api/servers/:id/home/config`, and a settings write's own response.
 */
export interface CommunityHomeSwitchState {
  enabled: boolean;
  version: number;
}

type SwitchRow = Pick<
  Server,
  "id" | "communityHomeEnabled" | "communityHomeVersion"
>;

/**
 * Write the switch onto `serverId`'s row only when `state` is newer than the
 * value the row holds. The server bumps the version under the row lock, so
 * the highest version is the latest write: an older frame that arrives last,
 * or the same frame twice, leaves the row alone. A row with no version is
 * version 0 (a boot read from an API that predates it). Returns the same
 * array when nothing changed, so a React state setter skips the render.
 */
export function applyCommunityHomeSwitch<T extends SwitchRow>(
  rows: T[],
  serverId: string,
  state: CommunityHomeSwitchState,
): T[] {
  const index = rows.findIndex((row) => row.id === serverId);
  if (index === -1) {
    return rows;
  }
  const row = rows[index]!;
  if (state.version <= (row.communityHomeVersion ?? 0)) {
    return rows;
  }
  const next = rows.slice();
  next[index] = {
    ...row,
    communityHomeEnabled: state.enabled,
    communityHomeVersion: state.version,
  };
  return next;
}

/**
 * Write a fresh read of `GET /api/servers/:id/home/config` onto the row. With
 * a version it goes through the same guard as a frame. Without one (an API
 * instance that predates the version, mid rolling deploy) the answer is the
 * value persisted when it was read, so it is applied and the row keeps its
 * version, but only if no versioned update reached the row while the read was
 * in flight: `issuedAtVersion` is the row's version when the read was sent,
 * and a row that has moved past it holds something newer than this answer.
 * Callers apply only the newest read they issued, so an older answer that
 * arrives last never lands here.
 */
export function applyCommunityHomeRead<T extends SwitchRow>(
  rows: T[],
  serverId: string,
  read: { enabled: boolean; version?: number },
  issuedAtVersion: number,
): T[] {
  if (read.version !== undefined) {
    return applyCommunityHomeSwitch(rows, serverId, {
      enabled: read.enabled,
      version: read.version,
    });
  }
  const index = rows.findIndex((row) => row.id === serverId);
  if (index === -1) {
    return rows;
  }
  const row = rows[index]!;
  if (
    (row.communityHomeVersion ?? 0) !== issuedAtVersion ||
    row.communityHomeEnabled === read.enabled
  ) {
    return rows;
  }
  const next = rows.slice();
  next[index] = { ...row, communityHomeEnabled: read.enabled };
  return next;
}

/**
 * Merge a settings write's `server` into the viewer's row. The write returns
 * the server row, not this viewer's membership, so role and the profile
 * opt-out stay as they were. The Baú switch keeps whichever copy has the
 * higher version: a slow rename response can otherwise carry an older switch
 * value over a newer one that a frame already delivered.
 */
export function mergeServerUpdate<T extends Server>(
  current: T,
  incoming: Server,
): T {
  const merged: T = {
    ...current,
    ...incoming,
    role: current.role,
    showOnProfile: current.showOnProfile,
  };
  if ((current.communityHomeVersion ?? 0) > (incoming.communityHomeVersion ?? 0)) {
    merged.communityHomeEnabled = current.communityHomeEnabled;
    merged.communityHomeVersion = current.communityHomeVersion;
  }
  return merged;
}
