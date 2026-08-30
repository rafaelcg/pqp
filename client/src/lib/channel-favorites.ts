import type { Channel } from "@pqp/shared";
import { FAVORITE_CHANNELS_PER_SERVER_MAX } from "@pqp/shared";

export type FavoriteChannelsMap = Record<string, string[]>;

export { FAVORITE_CHANNELS_PER_SERVER_MAX };

/**
 * Collapse key for the Favorites block. Categories are keyed by their own
 * channel id; this block is not a channel, so it needs a namespaced id that
 * cannot collide with a UUID.
 */
export function favoritesCollapseKey(serverId: string): string {
  return `favorites:${serverId}`;
}

export function favoritesForServer(
  map: FavoriteChannelsMap | undefined,
  serverId: string,
): string[] {
  return map?.[serverId] ?? [];
}

/**
 * Replace one server's list and return a new map. Empty lists drop the key so
 * the blob does not accumulate servers the user unfavourited everything in.
 *
 * The whole map must be written back on every change: jsonb `||` is a shallow
 * merge, so a patch of `{ [thisServer]: ids }` would wipe every other server.
 */
export function writeFavoritesForServer(
  map: FavoriteChannelsMap | undefined,
  serverId: string,
  ids: string[],
): FavoriteChannelsMap {
  const next: FavoriteChannelsMap = { ...(map ?? {}) };
  if (ids.length === 0) {
    delete next[serverId];
    return next;
  }
  next[serverId] = ids;
  return next;
}

/**
 * Stored order, minus ids that are gone, inaccessible, or categories.
 * Unknown ids are skipped rather than rewritten: a paint must not persist a
 * cleaned list, or a lagging `/api/channels` would wipe a favourite the user
 * still has.
 */
export function visibleFavoriteChannels(
  channels: readonly Channel[],
  ids: readonly string[],
): Channel[] {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const seen = new Set<string>();
  const visible: Channel[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const channel = byId.get(id);
    if (!channel || channel.type === "category") {
      continue;
    }
    visible.push(channel);
  }
  return visible;
}

export function isFavoriteChannel(
  ids: readonly string[],
  channelId: string,
): boolean {
  return ids.includes(channelId);
}

/**
 * Insert `channel` before `insertBeforeId`, or append. Already-favourited
 * ids move. Categories are refused. A new id past the cap is ignored rather
 * than bumping the oldest — starring is a choice, not a queue.
 */
export function addFavorite(
  ids: readonly string[],
  channel: Pick<Channel, "id" | "type">,
  insertBeforeId?: string,
): string[] {
  if (channel.type === "category") {
    return [...ids];
  }
  const without = ids.filter((id) => id !== channel.id);
  const isNew = without.length === ids.length;
  if (isNew && without.length >= FAVORITE_CHANNELS_PER_SERVER_MAX) {
    return [...ids];
  }
  if (!insertBeforeId) {
    return [...without, channel.id];
  }
  const insertAt = without.indexOf(insertBeforeId);
  if (insertAt === -1) {
    return [...without, channel.id];
  }
  return [...without.slice(0, insertAt), channel.id, ...without.slice(insertAt)];
}

export function removeFavorite(
  ids: readonly string[],
  channelId: string,
): string[] {
  return ids.filter((id) => id !== channelId);
}

/**
 * Swap with the neighbouring *visible* favourite. Ghost ids (deleted, a
 * category, not in this server's list) stay where they are in storage.
 */
export function moveFavorite(
  ids: readonly string[],
  channelId: string,
  direction: -1 | 1,
  visibleIds: readonly string[],
): string[] {
  const visibleIndex = visibleIds.indexOf(channelId);
  const otherId = visibleIds[visibleIndex + direction];
  if (visibleIndex === -1 || !otherId) {
    return [...ids];
  }
  const from = ids.indexOf(channelId);
  const to = ids.indexOf(otherId);
  if (from === -1 || to === -1) {
    return [...ids];
  }
  const next = ids.slice();
  next[from] = otherId;
  next[to] = channelId;
  return next;
}
