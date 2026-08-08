import {
  COMMUNITY_CATEGORIES,
  type CommunityCategory,
  type CommunitySummary,
} from "@pqp/shared";
import type { MessageKey } from "@/lib/i18n";

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
  active: boolean;
}

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
      active: active === null,
    },
    ...COMMUNITY_CATEGORIES.map((slug) => ({
      id: slug as CategoryFilter,
      labelKey: `communities.category.${slug}` as MessageKey,
      active: active === slug,
    })),
  ];
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

/** Singular gets its own key — Portuguese does not tolerate "1 membros". */
export function memberCountKey(count: number): MessageKey {
  return (count === 1 ? "communities.members.one" : "communities.members") as MessageKey;
}
