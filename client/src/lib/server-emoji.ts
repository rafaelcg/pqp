import {
  CUSTOM_EMOJI_TOKEN_PATTERN,
  customEmojiToken,
  type ServerEmoji,
  type ServerEmojiList,
} from "@pqp/shared";
import { useEffect, useSyncExternalStore } from "react";
import { fetchServerEmoji } from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";

/**
 * A server's custom emoji, shared by every surface that shows or inserts them.
 *
 * One fetch per server per tab, kept until something says it changed: the
 * settings section after its own writes, or a message carrying an emoji id this
 * tab has never seen (somebody added one since). The second path is what keeps
 * other members current without a socket frame.
 */

interface Entry {
  list: ServerEmojiList | null;
  inflight: Promise<void> | null;
  lastMissRefreshAt: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

const MISS_REFRESH_INTERVAL_MS = 30_000;

function emit() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function entryFor(serverId: string): Entry {
  let entry = entries.get(serverId);
  if (!entry) {
    entry = { list: null, inflight: null, lastMissRefreshAt: 0 };
    entries.set(serverId, entry);
  }
  return entry;
}

export function loadServerEmoji(serverId: string, force = false): Promise<void> {
  const entry = entryFor(serverId);
  if (entry.inflight) {
    return entry.inflight;
  }
  if (entry.list && !force) {
    return Promise.resolve();
  }
  entry.inflight = fetchServerEmoji(serverId)
    .then((list) => {
      entry.list = list;
      emit();
    })
    .catch(() => {
      // A failed read leaves whatever was there; tokens fall back to `:name:`.
    })
    .finally(() => {
      entry.inflight = null;
    });
  return entry.inflight;
}

/** Replace the cached list after a write this tab made. */
export function setServerEmojiList(serverId: string, list: ServerEmojiList): void {
  entryFor(serverId).list = list;
  emit();
}

/** A message named an emoji id this tab does not know: refetch, at most every 30 s. */
export function noteUnknownServerEmoji(serverId: string): void {
  const entry = entryFor(serverId);
  const now = Date.now();
  if (entry.inflight || now - entry.lastMissRefreshAt < MISS_REFRESH_INTERVAL_MS) {
    return;
  }
  entry.lastMissRefreshAt = now;
  void loadServerEmoji(serverId, true);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCachedServerEmoji(serverId: string): ServerEmojiList | null {
  return entries.get(serverId)?.list ?? null;
}

/** The server's list, loading it on first use. Null while loading or in a DM. */
export function useServerEmoji(serverId: string | null | undefined): ServerEmojiList | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (serverId) {
      void loadServerEmoji(serverId);
    }
  }, [serverId]);
  return serverId ? getCachedServerEmoji(serverId) : null;
}

export function serverEmojiImageUrl(emoji: Pick<ServerEmoji, "url">): string | null {
  return resolveUploadedImageUrl(emoji.url);
}

/** Split off fenced and inline code so nothing inside it is rewritten. */
const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`)/;

function mapOutsideCode(body: string, rewrite: (text: string) => string): string {
  return body
    .split(CODE_SEGMENT)
    .map((part, index) => (index % 2 === 1 ? part : rewrite(part)))
    .join("");
}

/**
 * `:pog:` to `<:pog:id>` for every name this server has, outside code. A name
 * the server does not have stays exactly as typed.
 */
export function expandCustomEmoji(
  body: string,
  emoji: ReadonlyArray<Pick<ServerEmoji, "id" | "name">> | null | undefined,
): string {
  if (!emoji || emoji.length === 0) {
    return body;
  }
  const byName = new Map(emoji.map((e) => [e.name, e.id]));
  return mapOutsideCode(body, (text) =>
    text.replace(/(?<!<):([a-z0-9_]{2,32}):/g, (match, name: string) => {
      const id = byName.get(name);
      return id ? customEmojiToken(name, id) : match;
    }),
  );
}

/** The other direction, for an edit box: a person edits `:pog:`, never a uuid. */
export function collapseCustomEmojiTokens(body: string): string {
  return body.replace(new RegExp(CUSTOM_EMOJI_TOKEN_PATTERN), ":$1:");
}

/**
 * Custom emoji for the `:` autocomplete: names that start with the query
 * first, then names that contain it, each group alphabetical.
 */
export function filterCustomEmoji(
  query: string,
  emoji: readonly ServerEmoji[] | null | undefined,
  limit = 8,
): ServerEmoji[] {
  if (!emoji || emoji.length === 0) {
    return [];
  }
  const needle = query.toLowerCase();
  const ranked: Array<{ entry: ServerEmoji; rank: number }> = [];
  for (const entry of emoji) {
    const rank = !needle || entry.name.startsWith(needle) ? 0 : entry.name.includes(needle) ? 1 : -1;
    if (rank >= 0) {
      ranked.push({ entry, rank });
    }
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map((item) => item.entry);
}
