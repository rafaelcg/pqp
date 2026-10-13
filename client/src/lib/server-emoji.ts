import {
  CUSTOM_EMOJI_TOKEN_PATTERN,
  MESSAGE_MAX_LENGTH,
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
  /**
   * Bumped by every write this tab makes. A read that started before a write
   * answers with the list from before it, so its answer is dropped.
   */
  writes: number;
  /** The last read failed and nothing is cached. */
  failed: boolean;
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
    entry = { list: null, inflight: null, lastMissRefreshAt: 0, writes: 0, failed: false };
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
  const writesAtStart = entry.writes;
  entry.inflight = fetchServerEmoji(serverId)
    .then((list) => {
      if (entry.writes !== writesAtStart) {
        return;
      }
      entry.list = list;
      entry.failed = false;
      emit();
    })
    .catch(() => {
      // A failed read leaves whatever was there; tokens fall back to `:name:`.
      if (!entry.list) {
        entry.failed = true;
        emit();
      }
    })
    .finally(() => {
      entry.inflight = null;
    });
  return entry.inflight;
}

/** Replace the cached list outright. A write this tab made uses `updateServerEmojiList`. */
export function setServerEmojiList(serverId: string, list: ServerEmojiList): void {
  const entry = entryFor(serverId);
  entry.list = list;
  entry.failed = false;
  emit();
}

/**
 * Apply a write this tab made to the LATEST cached list, never to a copy a
 * component held when the request started: two renames in flight must both
 * land.
 */
export function updateServerEmojiList(
  serverId: string,
  change: (emoji: ServerEmoji[]) => ServerEmoji[],
): void {
  const entry = entryFor(serverId);
  entry.writes += 1;
  if (!entry.list) {
    // Nothing cached to change. Read again once any read in flight, which
    // started before this write and is dropped, has finished.
    void (entry.inflight ?? Promise.resolve()).then(() => loadServerEmoji(serverId, true));
    return;
  }
  entry.list = {
    ...entry.list,
    emoji: change([...entry.list.emoji]).sort((a, b) => a.name.localeCompare(b.name)),
  };
  emit();
}

/** True when the list could not be read and nothing is cached. */
export function serverEmojiLoadFailed(serverId: string): boolean {
  return entries.get(serverId)?.failed ?? false;
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

/**
 * An emoji's picture failed to load: somebody deleted it since this tab read
 * the list. Drop the id so every render falls back to `:name:`. If a message
 * still names it, the unknown-id path above reads the list again (at most
 * every 30 s) and brings it back if it still exists.
 */
export function forgetServerEmoji(serverId: string, emojiId: string): void {
  const entry = entries.get(serverId);
  if (!entry?.list || !entry.list.emoji.some((e) => e.id === emojiId)) {
    return;
  }
  entry.list = { ...entry.list, emoji: entry.list.emoji.filter((e) => e.id !== emojiId) };
  emit();
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
 * the server does not have stays exactly as typed. When two entries share a
 * name, the later one wins.
 *
 * A token is about 39 characters longer than the name, and the composer
 * counts what was typed. So expansion stops at `maxLength`: a name past that
 * point stays `:name:` text rather than the send being refused as too long.
 */
export function expandCustomEmoji(
  body: string,
  emoji: ReadonlyArray<Pick<ServerEmoji, "id" | "name">> | null | undefined,
  maxLength: number = MESSAGE_MAX_LENGTH,
): string {
  if (!emoji || emoji.length === 0) {
    return body;
  }
  const byName = new Map(emoji.map((e) => [e.name, e.id]));
  let room = maxLength - body.length;
  return mapOutsideCode(body, (text) =>
    text.replace(/(?<!<):([a-z0-9_]{2,32}):/g, (match, name: string) => {
      const id = byName.get(name);
      if (!id) {
        return match;
      }
      const token = customEmojiToken(name, id);
      if (token.length - match.length > room) {
        return match;
      }
      room -= token.length - match.length;
      return token;
    }),
  );
}

/** The other direction, for an edit box: a person edits `:pog:`, never a uuid. */
export function collapseCustomEmojiTokens(body: string): string {
  return mapOutsideCode(body, (text) =>
    text.replace(new RegExp(CUSTOM_EMOJI_TOKEN_PATTERN), ":$1:"),
  );
}

/**
 * The `name` and `id` of every token in a body, outside code. An edit expands
 * with these on top of the server's list, so a token keeps its emoji after a
 * rename, and before the list has loaded.
 */
export function customEmojiTokensIn(body: string): Array<Pick<ServerEmoji, "id" | "name">> {
  const found: Array<Pick<ServerEmoji, "id" | "name">> = [];
  mapOutsideCode(body, (text) => {
    for (const match of text.matchAll(new RegExp(CUSTOM_EMOJI_TOKEN_PATTERN))) {
      found.push({ name: match[1]!, id: match[2]! });
    }
    return text;
  });
  return found;
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
