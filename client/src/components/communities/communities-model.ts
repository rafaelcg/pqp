import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_LANGUAGES,
  type CommunityCategory,
  type CommunityLanguage,
  type CommunitySummary,
} from "@pqp/shared";
import type { MessageKey } from "@/lib/i18n";
import type { Locale } from "@/lib/locale";

/**
 * The pure half of the Communities directory: everything the view decides that
 * does not need React, a network, or a DOM.
 *
 * Split out for the same reason `friends-model.ts` is — these are the rules
 * that are worth asserting directly (which chip is active, what a card's button
 * says, what an empty grid should tell you), and a rule you can only test by
 * mounting a component is a rule that gets tested once and then never again.
 */

/** `null` is the "Tudo" chip: no category filter at all. */
export type CategoryFilter = CommunityCategory | null;

export interface CategoryChip {
  id: CategoryFilter;
  labelKey: MessageKey;
  /** One glyph, drawn before the label. See `CATEGORY_EMOJI`. */
  emoji: string;
  active: boolean;
}

/**
 * One emoji per category, plus the sweep chip.
 *
 * WHY EMOJI RATHER THAN ICONS. A ten-chip row of lucide glyphs is ten strokes
 * of the same weight in the same colour, which scans as texture rather than as
 * ten different things — and half the categories here (humor, corre, futebol)
 * have no icon in any set that reads as those words to a Brazilian. Emoji are
 * already in the font stack, cost nothing, carry colour the palette does not
 * have to spend, and are the register this directory is written in.
 *
 * TYPED AS A TOTAL RECORD on purpose: adding a slug to `COMMUNITY_CATEGORIES`
 * without adding its glyph here is a compile error, which is the same
 * guarantee the derived label keys give. They are `aria-hidden` everywhere they
 * are drawn — the label beside them is the accessible name, and "🎮 Games"
 * announced in full is worse than "Games".
 */
export const CATEGORY_EMOJI: Record<CommunityCategory, string> = {
  games: "🎮",
  musica: "🎧",
  futebol: "⚽",
  estudos: "📚",
  anime: "🌸",
  tech: "💻",
  humor: "😂",
  "series-filmes": "🍿",
  corre: "💸",
  geral: "🌎",
};

/** The "everything" chip's glyph, which has no slug to hang off. */
export const ALL_CATEGORIES_EMOJI = "✨";

/**
 * The chip row: "all", then every category in its declared order.
 *
 * ORDER IS THE SHARED CONSTANT'S ORDER, never sorted alphabetically here. The
 * slugs are ordered by expected Brazilian pull (games, música, futebol… with
 * `geral` last as the catch-all), and re-sorting them by their translated label
 * would give the row a different order in every language for no reason.
 *
 * The label keys are derived rather than listed, which is what makes it
 * impossible to add a category and forget its chip — a slug with no
 * `communities.category.<slug>` key fails the catalogue's own key check at
 * compile time.
 */
export function categoryChips(active: CategoryFilter): CategoryChip[] {
  return [
    {
      id: null,
      labelKey: "communities.category.all" as MessageKey,
      emoji: ALL_CATEGORIES_EMOJI,
      active: active === null,
    },
    ...COMMUNITY_CATEGORIES.map((slug) => ({
      id: slug as CategoryFilter,
      labelKey: `communities.category.${slug}` as MessageKey,
      emoji: CATEGORY_EMOJI[slug],
      active: active === slug,
    })),
  ];
}

/** `null` is the "todos" segment: no language filter at all. */
export type LanguageFilter = CommunityLanguage | null;

export interface LanguageSegment {
  id: LanguageFilter;
  labelKey: MessageKey;
  active: boolean;
}

/**
 * The language segment: "PT | EN | todos", in that order.
 *
 * A SEGMENTED CONTROL RATHER THAN THREE MORE CHIPS. The chip row already runs
 * to eleven items and scrolls horizontally on a phone; adding language chips to
 * it would put two different questions ("what is this about", "can I read it")
 * in one undifferentiated queue, and the second question would land off-screen
 * behind the first. A separate control of three fixed options reads as what it
 * is: a narrowing of whatever the chips already chose.
 *
 * "todos" IS LAST, not first, and that is the opposite of the chip row's
 * ordering on purpose. The chips default to "Tudo" because browsing a directory
 * with no subject in mind is the normal way in; language does not work that way
 * — the useful default is your own language, and "all" is the deliberate step
 * out of it. Putting the escape hatch at the end is what makes the two live
 * defaults sit where the eye starts.
 */
export function languageSegments(active: LanguageFilter): LanguageSegment[] {
  return [
    ...COMMUNITY_LANGUAGES.map((code) => ({
      id: code as LanguageFilter,
      labelKey: `communities.language.${code}` as MessageKey,
      active: active === code,
    })),
    {
      id: null,
      labelKey: "communities.language.all" as MessageKey,
      active: active === null,
    },
  ];
}

/**
 * Which language the directory opens on.
 *
 * A BRAZILIAN OPENS ON PORTUGUESE; EVERYONE ELSE OPENS ON EVERYTHING. The
 * asymmetry is deliberate and it is not a value judgement about the languages —
 * it follows from what each default costs when it is wrong. A pt-BR reader
 * shown the whole directory gets a grid with rooms they cannot participate in
 * mixed into the ones they can, which is the cold-start problem made worse by
 * a feature. An English reader defaulted to `en` would see ONE room and
 * conclude the product is empty, because that is very nearly true today.
 *
 * Derived from the app's own locale rather than read from `navigator` again:
 * `lib/locale.ts` is the single thing that answers "what language is this", and
 * a second, subtly different notion of it here is how the directory ends up
 * disagreeing with the interface it is drawn in.
 */
export function defaultLanguageFilter(locale: Locale): LanguageFilter {
  return locale === "pt-BR" ? "pt" : null;
}

/**
 * What a card's primary button does.
 *
 * `joined` comes from the server, per viewer, so this never has to guess from
 * a client-side server list that may not have loaded yet.
 */
export function cardAction(
  community: Pick<CommunitySummary, "joined">,
): "join" | "open" {
  return community.joined ? "open" : "join";
}

/**
 * The monogram a community with no icon falls back to.
 *
 * Servers have no image field yet, so this is every card today. Takes the first
 * character of the first two words — "Eu odeio acordar cedo" reads as "EO",
 * which is more distinguishable in a grid than a single letter and is how the
 * server rail already draws a serverless avatar.
 *
 * Uses `Array.from` rather than indexing, because a name that starts with an
 * emoji (which many of these will) is a surrogate pair, and `name[0]` on one of
 * those is half a character and renders as a replacement glyph.
 */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  const initials = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("");
  return initials.toUpperCase();
}

/**
 * Which sentence an empty grid shows.
 *
 * The distinction is worth the branch: a search that found nothing has a real
 * explanation the user can act on — a brand-new community is only reachable by
 * search until somebody else joins, so "type the exact name" is genuine advice
 * rather than a shrug. Browsing that found nothing has no such story, and
 * pretending it does would send people typing names that do not exist.
 */
export function emptyStateKeys(query: string): {
  title: MessageKey;
  body: MessageKey;
  hint: MessageKey | null;
} {
  return {
    title: "communities.empty.title" as MessageKey,
    body: "communities.empty.body" as MessageKey,
    hint: query.trim() ? ("communities.empty.searchHint" as MessageKey) : null,
  };
}

/**
 * Merge a freshly-loaded page into what is already on screen.
 *
 * DEDUPED BY ID, because the directory's order key is `member_count` and that
 * moves under the reader: somebody joining a community between "show more"
 * clicks shifts it up a page, and an offset-paginated second request would hand
 * back a row the first one already delivered. Without this the grid grows
 * duplicate cards, and React logs a duplicate-key warning that is the only
 * symptom anybody would notice.
 *
 * Last write wins on a collision so the fresher `joined` / `memberCount` is the
 * one kept.
 */
export function mergePages(
  existing: readonly CommunitySummary[],
  incoming: readonly CommunitySummary[],
): CommunitySummary[] {
  const byId = new Map<string, CommunitySummary>();
  for (const one of existing) {
    byId.set(one.id, one);
  }
  for (const one of incoming) {
    byId.set(one.id, one);
  }
  // Insertion order, which is the server's order for the first page and appends
  // for every page after — the Map preserves it, so nothing is re-sorted here
  // and the client never disagrees with the server about ranking.
  return [...byId.values()];
}

/**
 * Reflect a successful join into the grid without refetching.
 *
 * The count is bumped locally because the card is about to say "Abrir" and a
 * number that did not move alongside it reads as a stale page. It is corrected
 * by the next real load; nothing is authorised by it.
 */
export function applyJoin(
  communities: readonly CommunitySummary[],
  serverId: string,
): CommunitySummary[] {
  return communities.map((one) =>
    one.id === serverId && !one.joined
      ? { ...one, joined: true, memberCount: one.memberCount + 1 }
      : one,
  );
}

/**
 * The member count as it is printed on a card.
 *
 * COMPACT, AND LOCALE-CORRECT, because the alternative is worse in both
 * directions: "12873" is a number nobody parses at a glance in a grid, and a
 * hand-rolled "12.8k" is wrong in Portuguese, where the separator is a comma
 * and the word is "mil" — `1,2 mil`, not `1.2K`. `Intl.NumberFormat` already
 * knows all of that and costs no bytes, which is the same argument the
 * catalogue makes for not shipping an i18n library.
 *
 * Below a thousand nothing is abbreviated in any locale, so the common case —
 * a directory of small rooms — reads as the exact number it is.
 *
 * The formatter is rebuilt per call rather than memoised: this runs once per
 * card per render, `Intl` caches its own internals, and a module-level cache
 * keyed by locale would be a second source of truth for which language is on.
 */
export function formatMemberCount(count: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  }).format(count);
}

/**
 * A stable hue for a community that has no image yet.
 *
 * Cards need to be distinguishable from across a grid before any of them is
 * read, and today there is nothing per-community to look at but a monogram.
 * Hashing the id into a hue gives every card its own tint that does not move
 * between loads, between pages, or between devices — and when real banner and
 * icon fields land (they are coming), this becomes the fallback for the ones
 * that never set an image rather than something to delete.
 *
 * Deliberately a hue only. Chroma and lightness stay fixed in the component so
 * the tints sit at one depth and none of them can outshout the accent or fail
 * contrast against the text on top.
 */
export function communityHue(id: string): number {
  let hash = 0;
  for (const char of id) {
    // A classic 31-multiplier string hash; the mask keeps it inside 32 bits
    // rather than drifting into float territory on a long id.
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) & 0xffffffff;
  }
  return Math.abs(hash) % 360;
}
