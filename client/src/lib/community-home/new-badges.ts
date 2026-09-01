export const COMMUNITY_HOME_SETTINGS_SEEN_KEY =
  "pqp:community-home-settings-seen";

export function communityHomeRowSeenKey(serverId: string): string {
  return `pqp:community-home-row-seen:${serverId}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

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

function isNew(key: string, storage: StorageLike): boolean {
  if (!storage) {
    return false;
  }
  try {
    return storage.getItem(key) !== "1";
  } catch {
    return false;
  }
}

function markSeen(key: string, storage: StorageLike): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(key, "1");
  } catch {
    // Discovery badges are best-effort when storage is unavailable.
  }
}

export function isCommunityHomeSettingsNew(
  storage: StorageLike = browserStorage(),
): boolean {
  return isNew(COMMUNITY_HOME_SETTINGS_SEEN_KEY, storage);
}

export function markCommunityHomeSettingsSeen(
  storage: StorageLike = browserStorage(),
): void {
  markSeen(COMMUNITY_HOME_SETTINGS_SEEN_KEY, storage);
}

export function isCommunityHomeRowNew(
  serverId: string,
  storage: StorageLike = browserStorage(),
): boolean {
  return isNew(communityHomeRowSeenKey(serverId), storage);
}

export function markCommunityHomeRowSeen(
  serverId: string,
  storage: StorageLike = browserStorage(),
): void {
  markSeen(communityHomeRowSeenKey(serverId), storage);
}

/** A successful enable is a fresh discovery, even after an earlier opt-in. */
export function markCommunityHomeRowNew(
  serverId: string,
  storage: StorageLike = browserStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(communityHomeRowSeenKey(serverId));
  } catch {
    // Discovery badges are best-effort when storage is unavailable.
  }
}
