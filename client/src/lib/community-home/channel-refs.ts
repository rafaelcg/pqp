import { channelRef, splitChannelRefs } from "@pqp/shared";

/**
 * `#channel` inside a Baú post.
 *
 * Stored form is `<#channelId>` (see `@pqp/shared`), shown as `#name`. Three
 * jobs live here and all of them are pure so the composer, the card and the
 * tests share one answer:
 *
 *   * RENDER: cut a body into text, channel links and "unavailable" markers.
 *   * COMPOSE: find the `#query` under the caret, filter the channels, insert.
 *   * ROUND TRIP: the composer's textarea holds `#name` (readable); the API
 *     holds `<#id>` (stable across renames). `toStoredBody` / `toDisplayBody`
 *     convert between them.
 *
 * Privacy: the stored body holds only an id. Names come from the channels the
 * viewer already has (`channels` is the list the sidebar shows them), so an id
 * that is not in it is drawn as a neutral placeholder, never as a name.
 */

export interface ChannelLike {
  id: string;
  name: string;
  type: string;
  topic?: string | null;
}

export type ChannelPart =
  | { type: "text"; value: string }
  | { type: "channel"; id: string; name: string }
  | { type: "unavailable"; id: string };

/** Categories are folders, not places to send somebody. */
export function referenceableChannels<T extends ChannelLike>(
  channels: readonly T[],
): T[] {
  return channels.filter((channel) => channel.type !== "category");
}

/** Same rule as `createChannelSchema`: letters, digits, `-` and `_`. */
const NAME_CHARS = "A-Za-z0-9_-";
const MAX_QUERY_LENGTH = 100;
/** Long lists are a scroll, not a picker. */
const MAX_SUGGESTIONS = 8;

function uniqueByName<T extends ChannelLike>(channels: readonly T[]) {
  const byName = new Map<string, T | null>();
  for (const channel of referenceableChannels(channels)) {
    const key = channel.name.toLowerCase();
    // null marks "more than one": ambiguous names are never guessed.
    byName.set(key, byName.has(key) ? null : channel);
  }
  return byName;
}

/**
 * `#name` at the start of a word. No lookbehind (older Safari): the character
 * before is captured instead, and `page#anchor`, `<#id>` and `&#39;` are all
 * ruled out by what that character is.
 */
const PLAIN_HASH = new RegExp(`(^|[^\\w<#&/])#([${NAME_CHARS}]+)`, "g");

/** Splits plain text on `#name` where exactly one channel has that name. */
function splitPlainHashes(
  text: string,
  byName: Map<string, ChannelLike | null>,
): ChannelPart[] {
  const parts: ChannelPart[] = [];
  let last = 0;
  for (const match of text.matchAll(PLAIN_HASH)) {
    const channel = byName.get(match[2]!.toLowerCase());
    if (!channel) {
      continue;
    }
    const index = (match.index ?? 0) + match[1]!.length;
    if (index > last) {
      parts.push({ type: "text", value: text.slice(last, index) });
    }
    parts.push({ type: "channel", id: channel.id, name: channel.name });
    last = (match.index ?? 0) + match[0].length;
  }
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

/**
 * The pieces of a body to draw. `<#id>` becomes a channel when the viewer can
 * see it and an `unavailable` marker when not (private, deleted, another
 * server). Old posts that say `#geral` in plain words become a channel too
 * when exactly one visible channel is called that.
 */
export function parseChannelParts(
  text: string,
  channels: readonly ChannelLike[],
): ChannelPart[] {
  if (!text) {
    return [];
  }
  const visible = new Map(
    referenceableChannels(channels).map((channel) => [channel.id, channel]),
  );
  const byName = uniqueByName(channels);
  const out: ChannelPart[] = [];
  for (const part of splitChannelRefs(text)) {
    if (part.type === "channel") {
      const channel = visible.get(part.id);
      out.push(
        channel
          ? { type: "channel", id: channel.id, name: channel.name }
          : { type: "unavailable", id: part.id },
      );
    } else if (byName.size === 0) {
      out.push(part);
    } else {
      out.push(...splitPlainHashes(part.value, byName));
    }
  }
  return out;
}

// ------------------------------------------------------------------ composer

export interface ChannelQuery {
  /** Index of the `#`. */
  start: number;
  /** Index just past the token: the caret. */
  end: number;
  /** What has been typed after the `#`, possibly empty. */
  query: string;
}

/**
 * The `#token` the caret is inside, or null. The `#` has to start a word, so
 * `page#anchor` and `<#id>` are left alone.
 */
export function findChannelQuery(
  value: string,
  caret: number,
): ChannelQuery | null {
  const end = Math.max(0, Math.min(caret, value.length));
  for (let index = end; index > 0; index -= 1) {
    if (end - index > MAX_QUERY_LENGTH) {
      return null;
    }
    const char = value[index - 1]!;
    if (char === "#") {
      const preceding = index > 1 ? value[index - 2]! : null;
      if (preceding !== null && !/\s/.test(preceding)) {
        return null;
      }
      return { start: index - 1, end, query: value.slice(index, end) };
    }
    if (!new RegExp(`[${NAME_CHARS}]`).test(char)) {
      return null;
    }
  }
  return null;
}

/** Channels matching the query, prefix matches first, then position order. */
export function filterChannels<T extends ChannelLike & { position?: number }>(
  channels: readonly T[],
  query: string,
  limit = MAX_SUGGESTIONS,
): T[] {
  const needle = query.toLowerCase();
  const scored: Array<{ channel: T; rank: number; order: number }> = [];
  referenceableChannels(channels).forEach((channel, order) => {
    const name = channel.name.toLowerCase();
    if (!needle) {
      scored.push({ channel, rank: 0, order });
    } else if (name.startsWith(needle)) {
      scored.push({ channel, rank: 0, order });
    } else if (name.includes(needle)) {
      scored.push({ channel, rank: 1, order });
    }
  });
  return scored
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.channel);
}

export interface ChannelInsertion {
  value: string;
  /** Where the caret belongs afterwards. */
  caret: number;
}

/**
 * Replace the active `#token` with the channel. A name that more than one
 * channel shares goes in as the raw `<#id>` token, because `#name` could not
 * say which one was meant when it is converted back.
 */
export function applyChannel(
  value: string,
  active: ChannelQuery,
  channel: ChannelLike,
  channels: readonly ChannelLike[],
): ChannelInsertion {
  const ambiguous = uniqueByName(channels).get(channel.name.toLowerCase()) === null;
  const token = ambiguous ? channelRef(channel.id) : `#${channel.name}`;
  // The caret may sit inside the token (`#ge|neral`): the whole token is
  // replaced, not just the half before the caret.
  let end = active.end;
  while (end < value.length && new RegExp(`[${NAME_CHARS}]`).test(value[end]!)) {
    end += 1;
  }
  // One space after it, unless the text already goes on with one.
  const gap = /\s/.test(value[end] ?? "") ? "" : " ";
  return {
    value: value.slice(0, active.start) + token + gap + value.slice(end),
    caret: active.start + token.length + 1,
  };
}

/** Stored `<#id>` → readable `#name`, where the name is unique and visible. */
export function toDisplayBody(
  stored: string,
  channels: readonly ChannelLike[],
): string {
  const visible = new Map(
    referenceableChannels(channels).map((channel) => [channel.id, channel]),
  );
  const byName = uniqueByName(channels);
  return splitChannelRefs(stored)
    .map((part) => {
      if (part.type === "text") {
        return part.value;
      }
      const channel = visible.get(part.id);
      if (!channel || byName.get(channel.name.toLowerCase()) === null) {
        return channelRef(part.id);
      }
      return `#${channel.name}`;
    })
    .join("");
}

/** Readable `#name` → stored `<#id>` for every name that matches one channel. */
export function toStoredBody(
  display: string,
  channels: readonly ChannelLike[],
): string {
  const byName = uniqueByName(channels);
  if (byName.size === 0) {
    return display;
  }
  return splitChannelRefs(display)
    .map((part) => {
      if (part.type === "channel") {
        return channelRef(part.id);
      }
      return splitPlainHashes(part.value, byName)
        .map((piece) =>
          piece.type === "channel" ? channelRef(piece.id) : piece.type === "text" ? piece.value : "",
        )
        .join("");
    })
    .join("");
}
