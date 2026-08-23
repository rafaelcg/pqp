import {
  connectionProviderFromPath,
  connectionProviderSchema,
  type ConnectionProvider,
} from "@pqp/shared";
import { ApiError } from "./api";

/**
 * Steam / Battle.net / Twitch bounce back to
 * `/app/connections/callback/:provider?…`. The query string is the proof
 * (OpenID assertion or OAuth code). Two things can delete it before the SPA
 * POSTs it: a selection change rewriting the URL to a channel, and Clerk
 * dropping the search when it round-trips a signed-out tab.
 *
 * sessionStorage is same-tab, which is the hop we actually do
 * (`window.location.assign`). localStorage would keep a used assertion around
 * for the next visit.
 */

const STORAGE_KEY = "pqp.connection.callback";
const ERROR_KEY = "pqp.connection.error";

type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface StashedConnectionCallback {
  provider: ConnectionProvider;
  params: Record<string, string>;
}

function paramsFromSearch(search: string): Record<string, string> {
  const params: Record<string, string> = {};
  const raw = search.startsWith("?") ? search.slice(1) : search;
  new URLSearchParams(raw).forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

function readStorage(
  storage: WritableStorage | null,
  key: string,
): string | null {
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function stashConnectionCallback(
  pathname: string,
  search: string,
  storage: WritableStorage | null,
): void {
  const provider = connectionProviderFromPath(pathname);
  if (!provider || !storage) {
    return;
  }
  const params = paramsFromSearch(search);
  if (Object.keys(params).length === 0) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ provider, params }));
  } catch {
    // Private mode, quota. The overlay still has location.search on this
    // paint; a later URL rewrite is what this stash exists to survive.
  }
}

export function peekConnectionCallback(
  storage: WritableStorage | null,
): boolean {
  return readStorage(storage, STORAGE_KEY) !== null;
}

export function takeConnectionCallback(
  storage: WritableStorage | null,
): StashedConnectionCallback | null {
  const raw = readStorage(storage, STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Still try to parse what we read.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as { provider?: unknown; params?: unknown };
    const provider = connectionProviderSchema.safeParse(record.provider);
    if (!provider.success || !record.params || typeof record.params !== "object") {
      return null;
    }
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      record.params as Record<string, unknown>,
    )) {
      if (typeof key === "string" && typeof value === "string") {
        params[key] = value;
      }
    }
    return { provider: provider.data, params };
  } catch {
    return null;
  }
}

export function stashConnectionCallbackFromWindow(
  pathname: string,
  search: string,
): void {
  try {
    stashConnectionCallback(pathname, search, sessionStorage);
  } catch {
    // sessionStorage missing or throwing. Overlay still has this paint's search.
  }
}

export function hasStashedConnectionCallback(): boolean {
  try {
    return peekConnectionCallback(sessionStorage);
  } catch {
    return false;
  }
}

export function takeConnectionCallbackFromWindow(): StashedConnectionCallback | null {
  try {
    return takeConnectionCallback(sessionStorage);
  } catch {
    return null;
  }
}

export function callbackParamsFromLocation(search: string): Record<string, string> {
  return paramsFromSearch(search);
}

/** Prefer the API's own reason (409 already linked, cancelled) over a generic fallback. */
export function messageFromCompleteFailure(
  caught: unknown,
  fallback: string,
): string {
  if (caught instanceof ApiError) {
    const message = caught.message.trim();
    if (message.length > 0) {
      return message;
    }
  }
  return fallback;
}

export function stashConnectionError(
  message: string,
  storage: WritableStorage | null,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(ERROR_KEY, message);
  } catch {
    // Private mode, quota.
  }
}

export function takeConnectionError(
  storage: WritableStorage | null,
): string | null {
  const raw = readStorage(storage, ERROR_KEY);
  if (!raw) {
    return null;
  }
  try {
    storage?.removeItem(ERROR_KEY);
  } catch {
    // Still return what we read.
  }
  return raw;
}

export function stashConnectionErrorFromWindow(message: string): void {
  try {
    stashConnectionError(message, sessionStorage);
  } catch {
    // sessionStorage missing or throwing.
  }
}

export function takeConnectionErrorFromWindow(): string | null {
  try {
    return takeConnectionError(sessionStorage);
  } catch {
    return null;
  }
}
