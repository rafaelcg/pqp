/**
 * Whether watch party channels are on for this build.
 *
 * A BUILD-TIME FLAG. `VITE_WATCH_PARTY_CHANNELS=true` turns on the "Watch
 * party" section in the sidebar, its create button and the live row. With it
 * off, a `watch_party` channel that already exists still renders and joins as
 * a plain voice channel, so production shows nothing new until the flag is
 * flipped and the web build redeployed.
 *
 * THE ONE LOCAL OVERRIDE. With the dev auth bypass on (local + e2e only,
 * ignored when `NODE_ENV=production` on the API), `?watchParty=1|0` on `/app`
 * forces the answer for that tab and latches it in localStorage, the way
 * `?communityHome=` does in `community-home/flag.ts`. That lets one Playwright
 * run prove both the flag-on and the flag-off chrome against a single build,
 * and lets a local run flip the section without restarting Vite. Outside the
 * bypass the query is ignored.
 *
 * FAIL CLOSED. No env, denied storage, and a missing query all mean off.
 */

import { isDevAuthBypassEnabled } from "@/lib/dev-auth";

export const WATCH_PARTY_CHANNELS_STORAGE_KEY = "pqp:watch-party-channels";
export const WATCH_PARTY_CHANNELS_QUERY_PARAM = "watchParty";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

function readStorageFlag(storage: StorageLike): boolean | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(WATCH_PARTY_CHANNELS_STORAGE_KEY);
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
    storage.setItem(WATCH_PARTY_CHANNELS_STORAGE_KEY, on ? "1" : "0");
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

function queryWantsWatchParty(search: string): boolean | null {
  try {
    const params = new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search,
    );
    const raw = params.get(WATCH_PARTY_CHANNELS_QUERY_PARAM);
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

export interface WatchPartyChannelsFlagInput {
  /** The build's `VITE_WATCH_PARTY_CHANNELS` value, or undefined when unset. */
  env: string | undefined;
  /**
   * Whether the local override (query + localStorage latch) is honoured.
   * `isWatchPartyChannelsEnabled()` passes `isDevAuthBypassEnabled()`; tests
   * pass what they mean.
   */
  allowLocalOverride: boolean;
  search?: string;
  storage?: StorageLike;
}

export function resolveWatchPartyChannelsFlag({
  env,
  allowLocalOverride,
  search = typeof window !== "undefined" ? window.location.search : "",
  storage = browserStorage(),
}: WatchPartyChannelsFlagInput): boolean {
  if (allowLocalOverride) {
    const fromQuery = queryWantsWatchParty(search);
    if (fromQuery !== null) {
      writeStorageFlag(storage, fromQuery);
      return fromQuery;
    }
    const latched = readStorageFlag(storage);
    if (latched !== null) {
      return latched;
    }
  }
  return env === "true";
}

/** What the app asks. Reads the build env plus the dev-bypass override. */
export function isWatchPartyChannelsEnabled(): boolean {
  return resolveWatchPartyChannelsFlag({
    env: import.meta.env.VITE_WATCH_PARTY_CHANNELS,
    allowLocalOverride: isDevAuthBypassEnabled(),
  });
}

/** Test / local QA: force the latch on or off, or clear it with `null`. */
export function setWatchPartyChannelsEnabled(
  on: boolean | null,
  storage: StorageLike = browserStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    if (on === null) {
      storage.removeItem(WATCH_PARTY_CHANNELS_STORAGE_KEY);
    } else {
      writeStorageFlag(storage, on);
    }
  } catch {
    // ignore
  }
}
