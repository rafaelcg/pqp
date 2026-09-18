import { isWatchPartyChannelType, type Channel } from "@pqp/shared";

/**
 * Local Start here picks on Overview.
 *
 * Cards, not chat. Staff pick up to four destinations so a first open is not
 * a blank pane. Persistence is localStorage until the API grows a column.
 * A missing key means "use the name heuristics"; an empty array is an
 * explicit clear.
 */

export const OVERVIEW_START_HERE_MAX = 4;
export const OVERVIEW_START_HERE_STORAGE_PREFIX = "pqp:overview-start-here:";

export type OverviewStartHereChannel = Pick<
  Channel,
  "id" | "name" | "type" | "topic" | "isPrivate" | "imageUrl" | "position"
>;

export type OverviewStartHereHint =
  | "avisos"
  | "ajuda"
  | "geral"
  | "voice"
  | "watchParty";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

const PREFERRED_TEXT: ReadonlyArray<{
  hint: Exclude<OverviewStartHereHint, "voice" | "watchParty">;
  match: RegExp;
}> = [
  { hint: "avisos", match: /^(avisos|anuncios|announcements?)$/ },
  { hint: "ajuda", match: /^(ajuda|help|support)$/ },
  { hint: "geral", match: /^(geral|general)$/ },
];

function browserStorage(): StorageLike {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function overviewStartHereStorageKey(serverId: string): string {
  return `${OVERVIEW_START_HERE_STORAGE_PREFIX}${serverId}`;
}

export function foldChannelName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isOverviewStartHereChannel(
  channel: Pick<Channel, "type">,
): boolean {
  return (
    channel.type === "text" ||
    channel.type === "voice" ||
    isWatchPartyChannelType(channel.type)
  );
}

export function overviewStartHereHint(
  channel: Pick<OverviewStartHereChannel, "name" | "type">,
): OverviewStartHereHint | null {
  const folded = foldChannelName(channel.name);
  for (const row of PREFERRED_TEXT) {
    if (row.match.test(folded)) {
      return row.hint;
    }
  }
  if (channel.type === "voice") {
    return "voice";
  }
  if (isWatchPartyChannelType(channel.type)) {
    return "watchParty";
  }
  return null;
}

export function loadOverviewStartHereIds(
  serverId: string,
  storage: StorageLike = browserStorage(),
): string[] | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(overviewStartHereStorageKey(serverId));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

export function saveOverviewStartHereIds(
  serverId: string,
  ids: readonly string[],
  storage: StorageLike = browserStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      overviewStartHereStorageKey(serverId),
      JSON.stringify([...ids]),
    );
  } catch {
    // Privacy mode: the in-memory pick still holds for this visit.
  }
}

export function pickDefaultOverviewStartHereChannels<
  T extends OverviewStartHereChannel,
>(channels: readonly T[]): T[] {
  const publicOnes = channels.filter(
    (channel) => isOverviewStartHereChannel(channel) && !channel.isPrivate,
  );
  const picked: T[] = [];
  const seen = new Set<string>();

  function take(channel: T | undefined): void {
    if (
      !channel ||
      seen.has(channel.id) ||
      picked.length >= OVERVIEW_START_HERE_MAX
    ) {
      return;
    }
    seen.add(channel.id);
    picked.push(channel);
  }

  for (const row of PREFERRED_TEXT) {
    take(
      publicOnes.find(
        (channel) =>
          channel.type === "text" &&
          row.match.test(foldChannelName(channel.name)),
      ),
    );
  }
  take(
    publicOnes.find(
      (channel) =>
        channel.type === "voice" &&
        /^(lobby|voz|voice)$/.test(foldChannelName(channel.name)),
    ),
  );

  return picked;
}

export function resolveOverviewStartHereChannels<
  T extends OverviewStartHereChannel,
>(channels: readonly T[], storedIds: readonly string[] | null): T[] {
  const eligible = channels.filter(isOverviewStartHereChannel);
  if (storedIds) {
    const byId = new Map(eligible.map((channel) => [channel.id, channel]));
    return storedIds
      .map((id) => byId.get(id))
      .filter((channel): channel is T => Boolean(channel))
      .slice(0, OVERVIEW_START_HERE_MAX);
  }
  return pickDefaultOverviewStartHereChannels(channels);
}

export function toggleOverviewStartHereId<T extends OverviewStartHereChannel>(
  channels: readonly T[],
  storedIds: readonly string[] | null,
  channelId: string,
): string[] {
  const current = resolveOverviewStartHereChannels(channels, storedIds).map(
    (channel) => channel.id,
  );
  if (current.includes(channelId)) {
    return current.filter((id) => id !== channelId);
  }
  if (current.length >= OVERVIEW_START_HERE_MAX) {
    return current;
  }
  if (
    !channels.some(
      (channel) =>
        channel.id === channelId && isOverviewStartHereChannel(channel),
    )
  ) {
    return current;
  }
  return [...current, channelId];
}
