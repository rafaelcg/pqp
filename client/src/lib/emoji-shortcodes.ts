const SHORTCODES: Record<string, string> = {
  smile: "😄",
  grinning: "😀",
  joy: "😂",
  rofl: "🤣",
  blush: "😊",
  heart_eyes: "😍",
  wink: "😉",
  thinking: "🤔",
  thumbs_up: "👍",
  thumbsup: "👍",
  "+1": "👍",
  thumbs_down: "👎",
  "-1": "👎",
  clap: "👏",
  wave: "👋",
  fire: "🔥",
  100: "💯",
  tada: "🎉",
  party: "🎉",
  heart: "❤️",
  hearts: "💕",
  eyes: "👀",
  cry: "😢",
  sob: "😭",
  angry: "😠",
  scream: "😱",
  skull: "💀",
  rocket: "🚀",
  check: "✅",
  x: "❌",
  warning: "⚠️",
  star: "⭐",
  sparkles: "✨",
  ok_hand: "👌",
  pray: "🙏",
  muscle: "💪",
  coffee: "☕",
  pizza: "🍕",
};

/** Names in the map: letters, digits, underscore, plus, hyphen. */
const SHORTCODE_TOKEN_CHAR = /[A-Za-z0-9_+-]/;
const MAX_QUERY_LENGTH = 32;
const MAX_SUGGESTIONS = 8;

export function expandEmojiShortcodes(input: string): string {
  return input.replace(/:([a-z0-9_+-]+):/gi, (match, name: string) => {
    const emoji = SHORTCODES[name.toLowerCase()];
    return emoji ?? match;
  });
}

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"] as const;

export interface EmojiQuery {
  /** Index of the opening `:`. */
  start: number;
  /** Index just past the token — the caret. */
  end: number;
  /** What has been typed after the `:`, possibly empty. */
  query: string;
}

export interface EmojiShortcode {
  name: string;
  emoji: string;
}

/**
 * The active `:token` at `caret`, or null when the caret is not inside one.
 * The `:` must start a word, matching how `@mention` works. A closing colon
 * (`:fire:` with the caret after it) is not a new token.
 */
export function findEmojiQuery(value: string, caret: number): EmojiQuery | null {
  const end = Math.max(0, Math.min(caret, value.length));
  if (end > 1 && value[end - 1] === ":" && SHORTCODE_TOKEN_CHAR.test(value[end - 2]!)) {
    return null;
  }

  for (let index = end; index > 0; index -= 1) {
    if (end - index > MAX_QUERY_LENGTH) {
      return null;
    }
    const char = value[index - 1]!;
    if (char === ":") {
      const preceding = index > 1 ? value[index - 2]! : null;
      if (preceding !== null && !/\s/.test(preceding)) {
        return null;
      }
      return { start: index - 1, end, query: value.slice(index, end) };
    }
    if (!SHORTCODE_TOKEN_CHAR.test(char)) {
      return null;
    }
  }

  return null;
}

export function filterEmojiShortcodes(
  query: string,
  limit = MAX_SUGGESTIONS,
): EmojiShortcode[] {
  const needle = query.toLowerCase();
  const scored: Array<{ entry: EmojiShortcode; rank: number }> = [];
  const seen = new Set<string>();

  for (const [name, emoji] of Object.entries(SHORTCODES)) {
    if (seen.has(emoji) && !needle) {
      continue;
    }
    const lower = name.toLowerCase();
    let rank: number | null = null;
    if (!needle) {
      rank = 0;
    } else if (lower.startsWith(needle)) {
      rank = 0;
    } else if (lower.includes(needle)) {
      rank = 1;
    }
    if (rank === null) {
      continue;
    }
    if (seen.has(emoji)) {
      continue;
    }
    seen.add(emoji);
    scored.push({ entry: { name, emoji }, rank });
  }

  return scored
    .sort((a, b) => {
      const byRank = a.rank - b.rank;
      if (byRank !== 0) {
        return byRank;
      }
      return a.entry.name.localeCompare(b.entry.name);
    })
    .slice(0, limit)
    .map((item) => item.entry);
}

export interface EmojiInsertion {
  value: string;
  caret: number;
}

/** Replace the active `:token` with the glyph, keeping the rest of the draft. */
export function applyEmojiShortcode(
  value: string,
  active: EmojiQuery,
  emoji: string,
): EmojiInsertion {
  const inserted = `${emoji} `;
  return {
    value: value.slice(0, active.start) + inserted + value.slice(active.end),
    caret: active.start + inserted.length,
  };
}

/**
 * If the caret sits just after a known `:name:`, swap it for the glyph.
 * Used while typing so a completed shortcode does not sit around until send.
 */
export function expandClosedShortcodeAtCaret(
  value: string,
  caret: number,
): EmojiInsertion | null {
  const before = value.slice(0, caret);
  const match = before.match(/:([a-z0-9_+-]+):$/i);
  if (!match) {
    return null;
  }
  const emoji = SHORTCODES[match[1]!.toLowerCase()];
  if (!emoji) {
    return null;
  }
  const start = caret - match[0].length;
  if (start > 0 && !/\s/.test(value[start - 1]!)) {
    return null;
  }
  return {
    value: value.slice(0, start) + emoji + value.slice(caret),
    caret: start + emoji.length,
  };
}
