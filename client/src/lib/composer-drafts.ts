import { useSyncExternalStore } from "react";

/**
 * A draft per channel. Switch channels and what you had typed is waiting
 * when you come back, the way Discord, Slack and Google Chat keep it, with
 * a pencil on the channel row while something is there.
 *
 * Text only: attachments are uploads with a lifetime of their own and are
 * not kept. One `localStorage` key PER ACCOUNT (`setDraftsAccount`), keyed
 * inside by channel id, so a shared browser profile never shows one
 * person's half-typed sentence to the next. Capped at `MAX_DRAFTS` and
 * `MAX_AGE_MS` so a year of unfinished messages does not pile up.
 *
 * Two tabs share the store, so a write is a merge rather than a
 * replacement: storage is re-read, this channel's row is set on top, and
 * the `storage` event refreshes the other tab. The in-memory copy is only
 * ever trusted after a successful read, and a failed write stays dirty so
 * the next one tries again instead of reporting the draft as saved.
 *
 * The composer is remounted per channel (`key={channel.id}` in App); it
 * reads its draft once on mount and writes it, coalesced, as it changes.
 * Rows ask `useHasDraft(channelId)`, a boolean snapshot, so typing in one
 * channel re-renders nothing until the set of channels with a draft moves.
 */

export interface ComposerDraft {
  body: string;
  updatedAt: number;
}

type DraftMap = Record<string, ComposerDraft>;

const KEY_PREFIX = "pqp:composer-drafts:";
const MAX_DRAFTS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let accountId: string | null = null;
let cache: DraftMap | null = null;
/** Sorted ids of the channels with a draft; a new array only when membership changes. */
let idsSnapshot: readonly string[] = [];
/** The last write did not reach storage; the next one must try again. */
let dirty = false;
const listeners = new Set<() => void>();
let storageListenerBound = false;

function storageKey(): string | null {
  return accountId ? `${KEY_PREFIX}${accountId}` : null;
}

function isDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== "object") {
    return false;
  }
  const draft = value as Record<string, unknown>;
  return typeof draft.body === "string" && typeof draft.updatedAt === "number";
}

function prune(map: DraftMap, now: number): DraftMap {
  const entries = Object.entries(map)
    .filter(([, draft]) => draft.body.trim() !== "" && now - draft.updatedAt <= MAX_AGE_MS)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_DRAFTS);
  return Object.fromEntries(entries);
}

/** Read storage. Null when it could not be read, which is not the same as empty. */
function readStorage(now: number): DraftMap | null {
  const key = storageKey();
  if (!key) {
    return {};
  }
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const map: DraftMap = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, draft] of Object.entries(parsed as Record<string, unknown>)) {
        if (isDraft(draft)) {
          map[id] = draft;
        }
      }
    }
    return prune(map, now);
  } catch {
    return null;
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function setCache(map: DraftMap) {
  cache = map;
  const ids = Object.keys(map).sort();
  if (!sameIds(ids, idsSnapshot)) {
    idsSnapshot = ids;
    for (const listener of listeners) {
      listener();
    }
  }
}

function load(now = Date.now()): DraftMap {
  if (cache) {
    return cache;
  }
  const read = readStorage(now);
  if (read === null) {
    // Unreadable right now: answer empty but do not remember it, so a
    // later read tries storage again instead of overwriting it with {}.
    return {};
  }
  setCache(read);
  return read;
}

function bindStorageListener() {
  if (storageListenerBound || typeof window === "undefined") {
    return;
  }
  storageListenerBound = true;
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === storageKey()) {
      cache = null;
      load();
    }
  });
}

/**
 * Which account the store belongs to. Null (signed out) reads as empty and
 * writes nothing. Switching accounts drops the in-memory copy; the previous
 * person's drafts stay in their own key for their next sign-in.
 */
export function setDraftsAccount(userId: string | null): void {
  if (userId === accountId) {
    return;
  }
  accountId = userId;
  cache = null;
  dirty = false;
  bindStorageListener();
  if (userId) {
    load();
  } else {
    setCache({});
  }
}

export function readDraft(channelId: string): string {
  return load()[channelId]?.body ?? "";
}

/** An empty or whitespace-only body clears the draft. */
export function writeDraft(channelId: string, body: string, now = Date.now()): void {
  const key = storageKey();
  if (!key) {
    return;
  }
  const current = load(now);
  const empty = body.trim() === "";
  if (!dirty) {
    if (empty && !(channelId in current)) {
      return;
    }
    if (!empty && current[channelId]?.body === body) {
      return;
    }
  }
  // Merge on top of what is in storage now, not on top of this tab's copy:
  // another tab may have written a different channel since we last read.
  const base = readStorage(now) ?? current;
  const next = { ...base };
  if (empty) {
    delete next[channelId];
  } else {
    next[channelId] = { body, updatedAt: now };
  }
  const pruned = prune(next, now);
  try {
    if (Object.keys(pruned).length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(pruned));
    }
    dirty = false;
  } catch {
    // Storage full or blocked. Keep the composer's copy in memory so the
    // pencil and the restore inside this tab still work, and try again on
    // the next write.
    dirty = true;
  }
  setCache(pruned);
}

export function clearDraft(channelId: string): void {
  writeDraft(channelId, "");
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getIdsSnapshot(): readonly string[] {
  load();
  return idsSnapshot;
}

/** Ids of every channel with a draft. */
export function useDraftChannelIds(): readonly string[] {
  return useSyncExternalStore(subscribeDrafts, getIdsSnapshot, getIdsSnapshot);
}

/** Whether this one channel has a draft; a row re-renders only when its own answer changes. */
export function useHasDraft(channelId: string): boolean {
  return useSyncExternalStore(
    subscribeDrafts,
    () => getIdsSnapshot().includes(channelId),
    () => false,
  );
}

/** Whether the last write reached storage; for tests and the connection check. */
export function draftsAreDirty(): boolean {
  return dirty;
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetComposerDraftsForTests(): void {
  accountId = null;
  cache = null;
  idsSnapshot = [];
  dirty = false;
  listeners.clear();
}
