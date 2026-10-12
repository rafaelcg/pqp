/**
 * THE CHANNEL LIST, AS ONE SET OF RULES FOR EVERY CLIENT.
 *
 * A server's sidebar is categories and the channels inside them, plus the
 * channels that sit in no category ("loose"), which render above the first
 * category with no header. With the `mixed_channel_list` flag on (and the
 * server migrated, `GET /api/servers/:id/channel-layout`), every type mixes in
 * one order per parent: loose channels in one sequence, each category's
 * children in one sequence, categories in their own.
 *
 * With it off, loose channels keep the old split: text and forums first, then
 * voice rooms, then watch party rooms, each by position. The server's numbering
 * is one sequence either way (`channel_top_level_unify_2026_10`), so the old
 * split reads the same order every client always showed.
 *
 * These are pure functions over plain rows, and the cases in
 * `packages/shared/fixtures/channel-layout-cases.json` pin them. The iOS and
 * Android ports run the same file, so three clients cannot drift apart again
 * (they did: Android drew a category's text half before its voice half).
 */

/** The fields the layout reads. A full `Channel` satisfies it. */
export interface LayoutChannel {
  id: string;
  type: string;
  parentId: string | null;
  position: number;
}

export interface SidebarCategory<T extends LayoutChannel = LayoutChannel> {
  category: T;
  children: T[];
}

export interface SidebarLayout<T extends LayoutChannel = LayoutChannel> {
  /** Channels in no category, above the first category, no header. */
  loose: T[];
  categories: SidebarCategory<T>[];
}

export interface BuildSidebarLayoutOptions {
  /** One mixed order for loose channels (flag on), or the old type split. */
  mixed: boolean;
  /**
   * Drop `watch_party` rows. The web hides them while the watch party feature
   * is on (a party is the block at the top, never a row).
   */
  hideWatchParty?: boolean;
}

/** Where a channel lands: a parent (null = loose) and an index in it. */
export interface LayoutTarget {
  parentId: string | null;
  index: number;
}

/** `PUT /api/servers/:id/channel-layout` body, see `channelLayoutSchema`. */
export interface ChannelLayoutPayload {
  baseVersion: number;
  categoryIds: string[];
  groups: Array<{ parentId: string | null; channelIds: string[] }>;
}

/** Old split order for loose channels: text and forums, voice, watch party. */
export function legacyTypeRank(type: string): number {
  if (type === "text" || type === "forum") {
    return 0;
  }
  if (type === "voice") {
    return 1;
  }
  return 2;
}

function byPosition(a: LayoutChannel, b: LayoutChannel): number {
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byTypeThenPosition(a: LayoutChannel, b: LayoutChannel): number {
  const rank = legacyTypeRank(a.type) - legacyTypeRank(b.type);
  return rank !== 0 ? rank : byPosition(a, b);
}

/**
 * The sidebar, from a server's channel list as the API returns it. Threads
 * are dropped (they nest under their parent row elsewhere). A channel whose
 * category is not in the list is treated as loose, so nothing ever vanishes.
 */
export function buildSidebarLayout<T extends LayoutChannel>(
  channels: readonly T[],
  options: BuildSidebarLayoutOptions,
): SidebarLayout<T> {
  const rows = channels.filter(
    (channel) =>
      channel.type !== "thread" &&
      !(options.hideWatchParty && channel.type === "watch_party"),
  );
  const categories = rows
    .filter((channel) => channel.type === "category")
    .sort(byPosition);
  const categoryIds = new Set(categories.map((category) => category.id));
  const children = new Map<string, T[]>();
  const loose: T[] = [];
  for (const channel of rows) {
    if (channel.type === "category") {
      continue;
    }
    if (channel.parentId && categoryIds.has(channel.parentId)) {
      const list = children.get(channel.parentId) ?? [];
      list.push(channel);
      children.set(channel.parentId, list);
    } else {
      loose.push(channel);
    }
  }
  loose.sort(options.mixed ? byPosition : byTypeThenPosition);
  return {
    loose,
    categories: categories.map((category) => ({
      category,
      children: (children.get(category.id) ?? []).sort(byPosition),
    })),
  };
}

function cloneLayout<T extends LayoutChannel>(layout: SidebarLayout<T>): SidebarLayout<T> {
  return {
    loose: [...layout.loose],
    categories: layout.categories.map((entry) => ({
      category: entry.category,
      children: [...entry.children],
    })),
  };
}

/** Where a channel or category sits now, or null when it is not in the layout. */
export function locateInLayout(
  layout: SidebarLayout,
  id: string,
): { parentId: string | null; index: number; total: number; isCategory: boolean } | null {
  const categoryIndex = layout.categories.findIndex((entry) => entry.category.id === id);
  if (categoryIndex !== -1) {
    return {
      parentId: null,
      index: categoryIndex,
      total: layout.categories.length,
      isCategory: true,
    };
  }
  const looseIndex = layout.loose.findIndex((channel) => channel.id === id);
  if (looseIndex !== -1) {
    return { parentId: null, index: looseIndex, total: layout.loose.length, isCategory: false };
  }
  for (const entry of layout.categories) {
    const index = entry.children.findIndex((channel) => channel.id === id);
    if (index !== -1) {
      return {
        parentId: entry.category.id,
        index,
        total: entry.children.length,
        isCategory: false,
      };
    }
  }
  return null;
}

/**
 * Move one channel to `target.index` of `target.parentId` (null = loose), or
 * one category to `target.index` among categories (its `parentId` must be
 * null: categories never nest). The index is read in the destination list
 * with the moved row already taken out, and clamped, so a drop past the end
 * is "the end". Anything impossible (an unknown id or parent, a category into
 * a category) returns null and changes nothing.
 */
export function moveInLayout<T extends LayoutChannel>(
  layout: SidebarLayout<T>,
  id: string,
  target: LayoutTarget,
): SidebarLayout<T> | null {
  const from = locateInLayout(layout, id);
  if (!from) {
    return null;
  }
  const next = cloneLayout(layout);
  if (from.isCategory) {
    if (target.parentId !== null) {
      return null;
    }
    const [moved] = next.categories.splice(from.index, 1);
    const index = clamp(target.index, next.categories.length);
    next.categories.splice(index, 0, moved!);
    return next;
  }
  const destination =
    target.parentId === null
      ? next.loose
      : next.categories.find((entry) => entry.category.id === target.parentId)?.children;
  if (!destination) {
    return null;
  }
  const source =
    from.parentId === null
      ? next.loose
      : next.categories.find((entry) => entry.category.id === from.parentId)!.children;
  const [moved] = source.splice(from.index, 1);
  const index = clamp(target.index, destination.length);
  destination.splice(index, 0, moved!);
  return next;
}

function clamp(index: number, length: number): number {
  if (!Number.isFinite(index)) {
    return length;
  }
  return Math.max(0, Math.min(Math.trunc(index), length));
}

/**
 * One step up (-1) or down (+1), crossing category borders, so a keyboard or
 * a phone's accessibility action reaches every slot a drag can:
 *
 * - a channel at the top of a category moving up lands at the END of the
 *   previous category, or at the end of the loose area above the first one;
 * - a channel at the bottom of a category moving down lands at the START of
 *   the next category (empty or not); the last loose channel moving down
 *   lands at the start of the first category;
 * - a category swaps with its neighbour.
 *
 * Null when there is nowhere to go (the first slot moving up, the last moving
 * down).
 */
export function stepInLayout<T extends LayoutChannel>(
  layout: SidebarLayout<T>,
  id: string,
  direction: -1 | 1,
): { layout: SidebarLayout<T>; target: LayoutTarget } | null {
  const from = locateInLayout(layout, id);
  if (!from) {
    return null;
  }
  let target: LayoutTarget | null = null;
  if (from.isCategory) {
    const index = from.index + direction;
    if (index >= 0 && index < from.total) {
      target = { parentId: null, index };
    }
  } else {
    const index = from.index + direction;
    if (index >= 0 && index < from.total) {
      target = { parentId: from.parentId, index };
    } else {
      // Off the edge of this group: the neighbouring group, by order of
      // appearance (loose, then every category).
      const groups: Array<string | null> = [
        null,
        ...layout.categories.map((entry) => entry.category.id),
      ];
      const groupIndex = groups.indexOf(from.parentId);
      const neighbour = groups[groupIndex + direction];
      if (neighbour !== undefined) {
        if (direction === -1) {
          const length =
            neighbour === null
              ? layout.loose.length
              : layout.categories.find((entry) => entry.category.id === neighbour)!
                  .children.length;
          target = { parentId: neighbour, index: length };
        } else {
          target = { parentId: neighbour, index: 0 };
        }
      }
    }
  }
  if (!target) {
    return null;
  }
  const next = moveInLayout(layout, id, target);
  return next ? { layout: next, target } : null;
}

/** The full order the server stores, as the PUT body. */
export function layoutToPayload(
  layout: SidebarLayout,
  baseVersion: number,
): ChannelLayoutPayload {
  return {
    baseVersion,
    categoryIds: layout.categories.map((entry) => entry.category.id),
    groups: [
      { parentId: null, channelIds: layout.loose.map((channel) => channel.id) },
      ...layout.categories.map((entry) => ({
        parentId: entry.category.id,
        channelIds: entry.children.map((channel) => channel.id),
      })),
    ],
  };
}

/**
 * Rewrite `parentId` and `position` on every row the layout holds, so a list
 * can be updated optimistically and rebuilt to the same layout. Rows the
 * layout does not hold (threads, hidden watch party rooms) come back as they
 * were.
 */
export function applyLayoutToChannels<T extends LayoutChannel>(
  channels: readonly T[],
  layout: SidebarLayout,
): T[] {
  const placed = new Map<string, { parentId: string | null; position: number }>();
  layout.categories.forEach((entry, index) => {
    placed.set(entry.category.id, { parentId: null, position: index });
    entry.children.forEach((channel, childIndex) => {
      placed.set(channel.id, { parentId: entry.category.id, position: childIndex });
    });
  });
  layout.loose.forEach((channel, index) => {
    placed.set(channel.id, { parentId: null, position: index });
  });
  return channels.map((channel) => {
    const place = placed.get(channel.id);
    return place ? { ...channel, ...place } : channel;
  });
}

/**
 * Channel ids in the order a person reads the sidebar: loose first, then each
 * category's children. A collapsed category contributes only the ids in
 * `keepVisible` (the selected channel, the room you are in), the same rows it
 * keeps on screen.
 */
export function navigableIds(
  layout: SidebarLayout,
  options: { collapsedCategoryIds?: ReadonlySet<string>; keepVisible?: ReadonlySet<string> } = {},
): string[] {
  const out = layout.loose.map((channel) => channel.id);
  for (const entry of layout.categories) {
    const collapsed = options.collapsedCategoryIds?.has(entry.category.id) ?? false;
    for (const channel of entry.children) {
      if (!collapsed || options.keepVisible?.has(channel.id)) {
        out.push(channel.id);
      }
    }
  }
  return out;
}

/**
 * The name of the one category a new server (or a migrated one) starts with.
 * "Canais" rather than "Geral": the seeded text channel is `general`, and
 * "Geral > #general" says the same word twice.
 */
export function defaultCategoryName(locale: string | null | undefined): string {
  if (locale === "en") {
    return "Channels";
  }
  if (locale === "es") {
    return "Canales";
  }
  return "Canais";
}

/** Used instead when a category with the default name already exists. */
export function fallbackCategoryName(locale: string | null | undefined): string {
  if (locale === "en" || locale === "es") {
    return "General";
  }
  return "Geral";
}
