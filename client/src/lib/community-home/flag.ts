/**
 * Community Home experiment flag.
 *
 * OWN FLAG, deliberately separate from `COMMUNITIES_ENABLED`. That one is a
 * legal-category switch (STF Art. 19); this one is a client-only UI mock so Raf
 * can feel a Patreon-like home inside the real chrome. Default OFF. Production
 * Pages builds must leave `VITE_COMMUNITY_HOME_ENABLED` unset.
 *
 * Enable locally (any one is enough):
 *   1. `VITE_COMMUNITY_HOME_ENABLED=true` in `client/.env`, then restart Vite
 *   2. `localStorage.setItem("pqp:community-home", "1")` then reload
 *   3. `?communityHome=1` on the URL (also sticky-writes localStorage)
 *
 * No server env, no config endpoint, no Fly restart.
 */

export const COMMUNITY_HOME_STORAGE_KEY = "pqp:community-home";
export const COMMUNITY_HOME_QUERY_PARAM = "communityHome";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

function readStorageFlag(storage: StorageLike): boolean {
  if (!storage) {
    return false;
  }
  try {
    return storage.getItem(COMMUNITY_HOME_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStorageFlag(storage: StorageLike, on: boolean): void {
  if (!storage) {
    return;
  }
  try {
    if (on) {
      storage.setItem(COMMUNITY_HOME_STORAGE_KEY, "1");
    } else {
      storage.removeItem(COMMUNITY_HOME_STORAGE_KEY);
    }
  } catch {
    // Privacy mode: session still works via the Vite env / query param.
  }
}

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

function queryWantsHome(search: string): boolean | null {
  try {
    const params = new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search,
    );
    const raw = params.get(COMMUNITY_HOME_QUERY_PARAM);
    if (raw === null) {
      return null;
    }
    if (raw === "0" || raw === "false" || raw === "off") {
      return false;
    }
    return raw === "1" || raw === "true" || raw === "on" || raw === "";
  } catch {
    return null;
  }
}

/**
 * Whether the Community Home experiment is on for this tab.
 *
 * FAIL CLOSED. Unset env, denied storage, and a missing query all mean off —
 * the app must look identical to today until somebody opts in.
 */
export function isCommunityHomeEnabled(
  env: string | undefined = typeof import.meta !== "undefined"
    ? (import.meta.env?.VITE_COMMUNITY_HOME_ENABLED as string | undefined)
    : undefined,
  search: string = typeof window !== "undefined" ? window.location.search : "",
  storage: StorageLike = browserStorage(),
): boolean {
  const fromQuery = queryWantsHome(search);
  if (fromQuery === true) {
    writeStorageFlag(storage, true);
    return true;
  }
  if (fromQuery === false) {
    writeStorageFlag(storage, false);
    return false;
  }
  if (env === "true") {
    return true;
  }
  return readStorageFlag(storage);
}

/** Test / debug: force the localStorage latch on or off. */
export function setCommunityHomeEnabled(
  on: boolean,
  storage: StorageLike = browserStorage(),
): void {
  writeStorageFlag(storage, on);
}
