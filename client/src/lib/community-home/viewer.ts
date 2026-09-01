/**
 * Explicit viewer states for the Community Home mock.
 *
 * Billing does not exist. VIP cargo (`system_key=vip`, permissions 0n) is the
 * cosmetic stand-in for "paying member". This switch lets Raf flip owner /
 * free / VIP without assigning cargos or inventing Stripe.
 *
 *   localStorage.setItem("pqp:community-home-viewer", "free"|"vip"|"owner"|"auto")
 *   ?homeViewer=free|vip|owner|auto
 */

export const COMMUNITY_HOME_VIEWER_STORAGE_KEY = "pqp:community-home-viewer";
export const COMMUNITY_HOME_VIEWER_QUERY_PARAM = "homeViewer";

export type CommunityHomeViewerMode = "auto" | "owner" | "free" | "vip";
export type CommunityHomeViewerRole = "owner" | "free" | "vip";

const MODES = new Set<CommunityHomeViewerMode>([
  "auto",
  "owner",
  "free",
  "vip",
]);

type StorageLike = Pick<Storage, "getItem" | "setItem"> | null;

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

function parseMode(raw: string | null | undefined): CommunityHomeViewerMode | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase() as CommunityHomeViewerMode;
  return MODES.has(normalized) ? normalized : null;
}

export function loadCommunityHomeViewerMode(
  search: string = typeof window !== "undefined" ? window.location.search : "",
  storage: StorageLike = browserStorage(),
): CommunityHomeViewerMode {
  try {
    const params = new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search,
    );
    const fromQuery = parseMode(params.get(COMMUNITY_HOME_VIEWER_QUERY_PARAM));
    if (fromQuery) {
      try {
        storage?.setItem(COMMUNITY_HOME_VIEWER_STORAGE_KEY, fromQuery);
      } catch {
        // ignore
      }
      return fromQuery;
    }
  } catch {
    // fall through
  }
  try {
    const fromStorage = parseMode(
      storage?.getItem(COMMUNITY_HOME_VIEWER_STORAGE_KEY),
    );
    if (fromStorage) {
      return fromStorage;
    }
  } catch {
    // fall through
  }
  return "auto";
}

export function saveCommunityHomeViewerMode(
  mode: CommunityHomeViewerMode,
  storage: StorageLike = browserStorage(),
): void {
  try {
    storage?.setItem(COMMUNITY_HOME_VIEWER_STORAGE_KEY, mode);
  } catch {
    // Session-only flip still works via React state at the call site.
  }
}

/**
 * Resolve the effective viewer role for lock / compose decisions.
 *
 * `auto` follows real membership: owner compatibility rank first, then VIP
 * cargo, else free. Explicit modes ignore membership so a demo can show the
 * locked teaser on an owner account.
 */
export function resolveCommunityHomeViewer(input: {
  mode: CommunityHomeViewerMode;
  isOwner: boolean;
  isVip: boolean;
}): CommunityHomeViewerRole {
  if (input.mode === "owner" || input.mode === "free" || input.mode === "vip") {
    return input.mode;
  }
  if (input.isOwner) {
    return "owner";
  }
  if (input.isVip) {
    return "vip";
  }
  return "free";
}
