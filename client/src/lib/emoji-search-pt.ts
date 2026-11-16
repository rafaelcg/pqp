/**
 * Portuguese search for the emoji picker.
 *
 * emoji-mart searches the English names and keywords of `@emoji-mart/data`
 * and ships no Portuguese data: its `i18n/pt.json` only holds the picker's
 * own labels. So "gato", "coração" and "rir" found nothing in a pt-BR picker.
 *
 * The Portuguese labels and tags come from `emojibase-data` (CLDR), loaded on
 * demand so only a pt-BR session pays for them. They are added to the SAME
 * search string emoji-mart already matches on, which keeps its ranking, its
 * multi-word queries and its "type a bit of a word" prefix match.
 *
 * Each word goes in twice, with and without accents, because emoji-mart only
 * lowercases the query: "coracao" has to find "coração" and so does "coração".
 */

/** The slice of an emoji-mart emoji this file reads and writes. */
export interface SearchableEmoji {
  id: string;
  keywords?: string[];
  /** Built once by emoji-mart at its first init: `,token,token,...`. */
  search?: string;
  skins: ReadonlyArray<{ native?: string } | null>;
}

/** The slice of an emojibase entry this file reads. */
export interface PortugueseEmoji {
  label: string;
  tags?: readonly string[];
  unicode: string;
}

/** Words that would match half the set as a prefix and say nothing. */
const FILLER = new Set([
  "a", "as", "o", "os", "um", "uma", "e", "de", "da", "do", "das", "dos",
  "em", "no", "na", "nos", "nas", "com", "por", "para", "que",
]);

export function foldAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Variation selector 16 is present in one data set and absent in the other. */
function nativeKey(native: string): string {
  return native.replace(/️/g, "");
}

/** Lowercase words of a label or tag, each with its accent-free twin. */
export function portugueseTokens(entry: PortugueseEmoji): string[] {
  const tokens = new Set<string>();
  for (const phrase of [entry.label, ...(entry.tags ?? [])]) {
    for (const word of phrase.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word.length < 2 || FILLER.has(word)) {
        continue;
      }
      tokens.add(word);
      tokens.add(foldAccents(word));
    }
  }
  return [...tokens];
}

/** Unicode character (without VS16) → Portuguese search words. */
export function buildPortugueseIndex(
  entries: readonly PortugueseEmoji[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const entry of entries) {
    const tokens = portugueseTokens(entry);
    if (tokens.length > 0) {
      index.set(nativeKey(entry.unicode), tokens);
    }
  }
  return index;
}

/**
 * Adds the Portuguese words to the emoji, whether emoji-mart has already
 * built its search string (a picker was opened earlier in this tab) or not
 * (it will, from `keywords`, at its first init). Returns how many emoji gained
 * a word.
 */
export function addPortugueseKeywords(
  emojis: Readonly<Record<string, SearchableEmoji>>,
  index: ReadonlyMap<string, readonly string[]>,
): number {
  let touched = 0;
  for (const emoji of Object.values(emojis)) {
    const native = emoji.skins[0]?.native;
    const tokens = native ? index.get(nativeKey(native)) : undefined;
    if (!tokens) {
      continue;
    }
    if (typeof emoji.search === "string") {
      const have = new Set(emoji.search.split(","));
      const fresh = tokens.filter((token) => !have.has(token));
      if (fresh.length === 0) {
        continue;
      }
      emoji.search += `,${fresh.join(",")}`;
    } else {
      const have = new Set(emoji.keywords ?? []);
      const fresh = tokens.filter((token) => !have.has(token));
      if (fresh.length === 0) {
        continue;
      }
      emoji.keywords = [...(emoji.keywords ?? []), ...fresh];
    }
    touched += 1;
  }
  return touched;
}

const applied = new WeakMap<object, Promise<void>>();

/**
 * Loads the Portuguese data and merges it into emoji-mart's data object, once
 * per object. Never rejects: a failed load leaves English search, which is
 * what the picker did before.
 */
export function ensurePortugueseSearch(
  emojis: Record<string, SearchableEmoji>,
): Promise<void> {
  const known = applied.get(emojis);
  if (known) {
    return known;
  }
  const pending = import("emojibase-data/pt/compact.json")
    .then((module) => {
      const entries = module.default as readonly PortugueseEmoji[];
      addPortugueseKeywords(emojis, buildPortugueseIndex(entries));
    })
    .catch(() => {
      applied.delete(emojis);
    });
  applied.set(emojis, pending);
  return pending;
}

/**
 * Style for emoji-mart's shadow root. With no match it renders an EMPTY
 * `div.padding-small` under the results heading and nothing else, and its
 * "no results" text lives in the preview bar, which this app hides. The text
 * is drawn into that empty div.
 */
export function emptySearchStyle(text: string): string {
  return `.category > div > .padding-small:empty::after {
  content: ${JSON.stringify(text)};
  display: block;
  padding: 24px 8px;
  text-align: center;
  font-size: 13px;
  color: rgb(var(--rgb-color));
  opacity: 0.7;
}`;
}
