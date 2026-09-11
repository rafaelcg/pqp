import { useSyncExternalStore } from "react";

/**
 * A draft per channel. Switch channels and what you had typed is waiting
 * when you come back, the way Discord, Slack and Google Chat keep it, with
 * a pencil on the channel row while something is there.
 *
 * Text only: attachments are uploads with a lifetime of their own and are
 * not kept. One store for every channel and conversation, keyed by channel
 * id, in `localStorage` so it survives a reload. Capped at `MAX_DRAFTS` and
 * `MAX_AGE_MS` so a year of half-typed messages does not pile up.
 *
 * The composer is remounted per channel (`key={channel.id}` in App), so it
 * reads its draft once on mount and writes on every change; the rows read
 * the set of channel ids through `useDraftChannelIds`.
 */

export interface ComposerDraft {
  body: string;
  updatedAt: number;
}

type DraftMap = Record<string, ComposerDraft>;

const STORAGE_KEY = "pqp:composer-drafts";
const MAX_DRAFTS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let cache: DraftMap | null = null;
/** Sorted ids, one array per change, so `useSyncExternalStore` sees a stable snapshot. */
let idsSnapshot: readonly string[] = [];
const listeners = new Set<() => void>();

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

function load(now = Date.now()): DraftMap {
  if (cache) {
    return cache;
  }
  let map: DraftMap = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, draft] of Object.entries(parsed as Record<string, unknown>)) {
        if (isDraft(draft)) {
          map[id] = draft;
        }
      }
    }
  } catch {
    map = {};
  }
  cache = prune(map, now);
  idsSnapshot = Object.keys(cache).sort();
  return cache;
}

function persist(map: DraftMap) {
  cache = map;
  idsSnapshot = Object.keys(map).sort();
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // Storage full or blocked: the draft still lives in the composer.
  }
  for (const listener of listeners) {
    listener();
  }
}

export function readDraft(channelId: string): string {
  return load()[channelId]?.body ?? "";
}

/** An empty or whitespace-only body clears the draft. */
export function writeDraft(channelId: string, body: string, now = Date.now()): void {
  const current = load(now);
  if (body.trim() === "") {
    if (!(channelId in current)) {
      return;
    }
    const next = { ...current };
    delete next[channelId];
    persist(next);
    return;
  }
  if (current[channelId]?.body === body) {
    return;
  }
  persist(prune({ ...current, [channelId]: { body, updatedAt: now } }, now));
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

/** Ids of every channel with a draft, for the pencil on the rows. */
export function useDraftChannelIds(): readonly string[] {
  return useSyncExternalStore(subscribeDrafts, getIdsSnapshot, getIdsSnapshot);
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetComposerDraftsForTests(): void {
  cache = null;
  idsSnapshot = [];
  listeners.clear();
}
