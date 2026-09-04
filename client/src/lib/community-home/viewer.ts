/**
 * The staff-only "preview as" inspector for Baú.
 *
 * Posts are real now — visibility is enforced on the API (`post.locked`,
 * `post.body`/`post.media` nulled for a viewer who cannot unlock). A plain
 * member never sees this switch at all; it exists so staff (who can always
 * unlock members-only posts) can check what the locked teaser looks like
 * without logging in as somebody else.
 *
 *   localStorage.setItem("pqp:community-home-viewer", "owner"|"members"|"auto")
 *   ?homeViewer=owner|members|auto
 *
 * VIP is out of the chrome this pass — there is no VIP tab to click — but the
 * role type keeps it because `auto` still has to resolve a real VIP viewer
 * correctly for `post.locked` to make sense to them.
 */

export const COMMUNITY_HOME_VIEWER_STORAGE_KEY = "pqp:community-home-viewer";
export const COMMUNITY_HOME_VIEWER_QUERY_PARAM = "homeViewer";

/** What the staff inspector switch offers. No `vip` entry in this chrome. */
export type CommunityHomeViewerMode = "auto" | "owner" | "members";
/** What a post's lock is actually computed against. */
export type CommunityHomeViewerRole = "owner" | "members" | "vip";

const MODES = new Set<CommunityHomeViewerMode>(["auto", "owner", "members"]);

/** `free` was the mock's name for this role; old bookmarks/localStorage may
 * still carry it. */
function normalizeLegacyMode(raw: string): string {
  return raw === "free" ? "members" : raw;
}

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

function parseMode(
  raw: string | null | undefined,
): CommunityHomeViewerMode | null {
  if (!raw) {
    return null;
  }
  const normalized = normalizeLegacyMode(
    raw.trim().toLowerCase(),
  ) as CommunityHomeViewerMode;
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
 * Resolve the effective viewer role for the inspector.
 *
 * `auto` follows real membership: owner first, then VIP cargo, else member.
 * Explicit modes (`owner` / `members`) ignore membership so staff can check
 * either side of the lock on their own account.
 */
export function resolveCommunityHomeViewer(input: {
  mode: CommunityHomeViewerMode;
  isOwner: boolean;
  isVip: boolean;
}): CommunityHomeViewerRole {
  if (input.mode === "owner" || input.mode === "members") {
    return input.mode;
  }
  if (input.isOwner) {
    return "owner";
  }
  if (input.isVip) {
    return "vip";
  }
  return "members";
}
