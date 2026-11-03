import type { MessageSearchFilters } from "@/lib/api";

/*
 * The header search's filters as chips (the text channels canvas, "Painéis",
 * 1. Buscar). A chip is state, not text: typing `de:bi` offers the people
 * whose name starts that way, and picking one replaces the token with a chip
 * that holds the person's id. Nothing here touches the DOM.
 */

export type SearchChipKind = "de" | "em" | "tem" | "antes" | "depois" | "menciona";

export const SEARCH_CHIP_KINDS: readonly SearchChipKind[] = [
  "de",
  "em",
  "tem",
  "antes",
  "depois",
  "menciona",
];

export type SearchChip =
  | { kind: "de" | "menciona"; id: string; label: string }
  | { kind: "em"; id: string; label: string }
  | { kind: "tem"; value: "link" | "image" | "file"; label: string }
  | { kind: "antes" | "depois"; day: string; label: string };

/** What each kind is called in the person's language (`from` in English). */
export type SearchChipPrefixes = Partial<Record<SearchChipKind, string>>;

/**
 * The token being typed at the end of the field, `de:bi` → `{ kind: "de",
 * partial: "bi" }`. The Portuguese names always work; `prefixes` adds the
 * person's own language.
 */
export function trailingChipToken(
  text: string,
  prefixes: SearchChipPrefixes = {},
): { kind: SearchChipKind; partial: string; start: number } | null {
  const match = /(?:^|\s)([\p{L}]+):(\S*)$/iu.exec(text);
  if (!match) {
    return null;
  }
  const word = match[1]!.toLowerCase();
  const kind =
    SEARCH_CHIP_KINDS.find((k) => k === word) ??
    SEARCH_CHIP_KINDS.find((k) => prefixes[k]?.toLowerCase() === word);
  if (!kind) {
    return null;
  }
  const start = text.length - match[0].trimStart().length;
  return { kind, partial: match[2] ?? "", start };
}

/** The words of the search, with any half-typed filter token left out. */
export function searchWords(text: string, prefixes: SearchChipPrefixes = {}): string {
  const token = trailingChipToken(text, prefixes);
  return (token ? text.slice(0, token.start) : text).trim();
}

/** One chip per kind: a second `de:` replaces the first. */
export function addChip(chips: readonly SearchChip[], chip: SearchChip): SearchChip[] {
  return [...chips.filter((c) => c.kind !== chip.kind), chip];
}

/** What the chips ask the API for. `em:` wins over the scope's channel. */
export function chipFilters(
  chips: readonly SearchChip[],
  scopeChannelId: string | null,
): MessageSearchFilters {
  const filters: MessageSearchFilters = {};
  if (scopeChannelId) {
    filters.channelId = scopeChannelId;
  }
  for (const chip of chips) {
    if (chip.kind === "de") filters.authorId = chip.id;
    else if (chip.kind === "menciona") filters.mentionsId = chip.id;
    else if (chip.kind === "em") filters.channelId = chip.id;
    else if (chip.kind === "tem") filters.has = chip.value;
    else if (chip.kind === "antes") filters.until = chip.day;
    else if (chip.kind === "depois") filters.since = chip.day;
  }
  return filters;
}

/** Accents and case folded, for matching a name as it is typed. */
export function foldName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Up to `limit` candidates whose name or handle starts with what was typed, then contains it. */
export function matchByName<T>(
  items: readonly T[],
  partial: string,
  names: (item: T) => (string | null | undefined)[],
  limit = 5,
): T[] {
  const needle = foldName(partial.replace(/^[@#]/, ""));
  if (!needle) {
    return items.slice(0, limit);
  }
  const starts: T[] = [];
  const contains: T[] = [];
  for (const item of items) {
    const folded = names(item).filter(Boolean).map((n) => foldName(n!));
    if (folded.some((n) => n.startsWith(needle))) starts.push(item);
    else if (folded.some((n) => n.includes(needle))) contains.push(item);
  }
  return [...starts, ...contains].slice(0, limit);
}
