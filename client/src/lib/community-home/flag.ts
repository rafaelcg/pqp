/**
 * Whether Baú (Community Home) is on for this tab.
 *
 * THE SERVER DECIDES. `GET /api/community-home/config` answers with the
 * instance flags (`COMMUNITY_HOME_ENABLED`, `COMMUNITY_HOME_VIP_ENABLED`),
 * and the client follows that answer the way it follows the attachments and
 * communities configs. There is no `VITE_` flag any more: two switches for
 * one feature is how a surface ends up half-on, with a row in the sidebar
 * that 404s when clicked.
 *
 * THE ONE LOCAL OVERRIDE. With the dev auth bypass on (local + e2e only,
 * ignored when `NODE_ENV=production` on the API), `?communityHome=1|0` on
 * `/app` forces the answer for that tab and latches it in localStorage. That
 * is what lets one Playwright run prove both the flag-on and the flag-off
 * chrome against a single API process, and lets a local run flip the row
 * without restarting the server. Outside the bypass the query is ignored.
 *
 * FAIL CLOSED. No config, denied storage, and a missing query all mean off.
 */

import type { CommunityHomeConfig } from "@pqp/shared";

export const COMMUNITY_HOME_STORAGE_KEY = "pqp:community-home";
export const COMMUNITY_HOME_QUERY_PARAM = "communityHome";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

function readStorageFlag(storage: StorageLike): boolean | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(COMMUNITY_HOME_STORAGE_KEY);
    if (raw === "1") {
      return true;
    }
    if (raw === "0") {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStorageFlag(storage: StorageLike, on: boolean): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(COMMUNITY_HOME_STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Privacy mode: the query still wins for this navigation.
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

export interface CommunityHomeFlagInput {
  /** The API's answer, or null while it has not arrived / failed. */
  config: Pick<CommunityHomeConfig, "enabled"> | null;
  /**
   * Whether the local override (query + localStorage latch) is honoured.
   * Callers pass `isDevAuthBypassEnabled()`; tests pass what they mean.
   */
  allowLocalOverride: boolean;
  search?: string;
  storage?: StorageLike;
}

export function isCommunityHomeEnabled({
  config,
  allowLocalOverride,
  search = typeof window !== "undefined" ? window.location.search : "",
  storage = browserStorage(),
}: CommunityHomeFlagInput): boolean {
  if (allowLocalOverride) {
    const fromQuery = queryWantsHome(search);
    if (fromQuery !== null) {
      writeStorageFlag(storage, fromQuery);
      return fromQuery;
    }
    const latched = readStorageFlag(storage);
    if (latched !== null) {
      return latched;
    }
  }
  return config?.enabled === true;
}

/** Test / local QA: force the latch on or off, or clear it with `null`. */
export function setCommunityHomeEnabled(
  on: boolean | null,
  storage: StorageLike = browserStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    if (on === null) {
      storage.removeItem(COMMUNITY_HOME_STORAGE_KEY);
    } else {
      writeStorageFlag(storage, on);
    }
  } catch {
    // ignore
  }
}
