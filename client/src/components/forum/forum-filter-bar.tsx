import type { ForumSort, ForumStatusFilter, ForumTag } from "@pqp/shared";
import {
  ArrowDownUp,
  ChevronDown,
  LayoutGrid,
  Rows3,
  StretchHorizontal,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { ForumTagIcon } from "@/components/forum/forum-tag-icon";
import { Menu } from "@/components/ui/menu";
import { RadioGroup, useRovingRadio } from "@/components/ui/radio-group";
import { Tooltip } from "@/components/ui/tooltip";
import type { ForumFilters } from "@/lib/forum-list";
import type { ForumLayout } from "@/lib/forum-prefs";
import {
  forumTagIconComponent,
  forumTagLabel,
  useForumTagLabel,
} from "@/lib/forum-tag-icons";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Cards, Rows, SquaresFour } from "@phosphor-icons/react";
import { IconSwap } from "@/components/ui/icon";

/**
 * What narrows the list, on one line read left to right: status, My posts,
 * then the forum's first tags in the order staff set, the rest under "More".
 * Tags are AND: each one picked narrows further. An active filter is drawn
 * inverted with an X, so "why is my list short" always has a visible answer.
 *
 * The order (sort) and the layout switch sit on the search row above, in the
 * pane; they change how the list is drawn, not what is in it.
 *
 * On a phone the same controls ride one horizontal strip (UX §2.9 #56), status
 * as two toggles (All is neither on), active chips first, fading out at the
 * edge so the strip says it scrolls.
 */

interface ForumFilterBarProps {
  filters: ForumFilters;
  tags: readonly ForumTag[];
  onChange: (next: Partial<ForumFilters>) => void;
  /**
   * Tag chips drawn inline before the rest fold into "More"; the pane sizes
   * it from its width. 0 is the list beside an open post: one "Tags" menu.
   */
  inlineTags: number;
  /**
   * A phone: one scrolling strip. `leading` (the order) comes first in the
   * strip and in the wide row, where the pane passes it only beside an open
   * post, since the search row has no room for the sort menu there.
   */
  strip?: boolean;
  leading?: ReactNode;
}

/** The filled control every filter uses; inverted while it is on. */
export function filterControlClass(on: boolean, className?: string): string {
  return cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-[13px] font-medium transition-[background-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset motion-reduce:transition-none max-sm:h-10 max-sm:rounded-full max-sm:px-3.5 max-sm:text-sm max-sm:hit-44",
    on
      ? "bg-text font-semibold text-surface-0"
      : "bg-surface-1 text-text-secondary hover:bg-surface-2 hover:text-text",
    // Pills under the redesign; at rest on the segmented track's tint.
    "redesign:rounded-full redesign:px-3",
    !on && "redesign:bg-[color:var(--segmented-bg)] redesign:hover:bg-[color:var(--segmented-thumb)]",
    className,
  );
}

export function FilterChip({
  pressed,
  onClick,
  children,
  removeLabel,
  className,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  /** Shown on an active chip: the X that takes this filter off. */
  removeLabel?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={pressed && removeLabel ? removeLabel : undefined}
      onClick={onClick}
      className={filterControlClass(pressed, className)}
    >
      {children}
      {pressed && removeLabel && <X className="h-3.5 w-3.5 shrink-0" aria-hidden />}
    </button>
  );
}

function TagChipContent({ tag }: { tag: ForumTag }) {
  const tagLabel = useForumTagLabel();
  return (
    <>
      <ForumTagIcon tag={tag} className="h-3.5 w-3.5" />
      <span className="max-w-[9rem] truncate">{tagLabel(tag)}</span>
    </>
  );
}

/** "Recent activity ▾": the list's order, a menu of two. */
export function ForumSortMenu({
  sort,
  onChange,
  short = false,
  className,
}: {
  sort: ForumSort;
  onChange: (sort: ForumSort) => void;
  /** Beside an open post or on a phone: "Activity" instead of "Recent activity". */
  short?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = sort === "activity" ? t("forum.sort.activity") : t("forum.sort.created");
  const shortLabel = sort === "activity" ? t("forum.sort.activityShort") : t("forum.sort.created");
  return (
    <Menu
      align="start"
      items={(["activity", "created"] as ForumSort[]).map((one) => ({
        id: `sort-${one}`,
        label: one === "activity" ? t("forum.sort.activity") : t("forum.sort.created"),
        checked: sort === one,
        onSelect: () => onChange(one),
      }))}
    >
      <button
        type="button"
        aria-label={`${t("forum.sort.label")}: ${label}`}
        className={cn(filterControlClass(false), "text-text", className)}
      >
        <ArrowDownUp className="h-3.5 w-3.5" aria-hidden />
        {short ? shortLabel : label}
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
      </button>
    </Menu>
  );
}

/** Cards, compact rows or a gallery: how this reader draws this forum. */
export function ForumLayoutSwitch({
  layout,
  onChange,
}: {
  layout: ForumLayout;
  onChange: (layout: ForumLayout) => void;
}) {
  const { t } = useTranslation();
  const options: { value: ForumLayout; label: string; icon: typeof Rows3; glyph: typeof Rows }[] = [
    { value: "card", label: t("forum.layout.card"), icon: StretchHorizontal, glyph: Cards },
    { value: "compact", label: t("forum.layout.compact"), icon: Rows3, glyph: Rows },
    { value: "gallery", label: t("forum.layout.gallery"), icon: LayoutGrid, glyph: SquaresFour },
  ];
  // One tab stop for the group, arrows to move and pick, like every radio group.
  const { onKeyDown, tabIndexFor } = useRovingRadio(
    options.map((option) => option.value),
    layout,
    onChange,
  );
  return (
    <div
      role="radiogroup"
      aria-label={t("forum.layout.label")}
      onKeyDown={onKeyDown}
      className="inline-flex h-10 shrink-0 items-center gap-0.5 rounded-[var(--radius-card)] bg-surface-1 p-1 redesign:h-[var(--control-md)] redesign:rounded-[var(--segmented-radius)] redesign:bg-[color:var(--segmented-bg)] redesign:p-[var(--segmented-pad)]"
      data-forum-layout-switch=""
    >
      {options.map(({ value, label, icon: Icon, glyph }) => (
        <Tooltip key={value} label={label}>
          <button
            type="button"
            role="radio"
            aria-checked={layout === value}
            aria-label={label}
            tabIndex={tabIndexFor(value)}
            onClick={() => onChange(value)}
            className={cn(
              "grid h-8 w-8 place-items-center rounded-[var(--radius-control)] transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
              layout === value
                ? "bg-surface-3 text-text"
                : "text-text-secondary hover:text-text",
              "redesign:h-[var(--segmented-h)] redesign:w-[calc(var(--segmented-h)+0.5rem)] redesign:rounded-[var(--segmented-radius)]",
              layout === value
                ? "redesign:bg-[color:var(--segmented-thumb)] redesign:shadow-[var(--segmented-thumb-shadow)]"
                : "redesign:text-[color:var(--segmented-text)]",
            )}
          >
            <IconSwap off={Icon} on={glyph} offClassName="h-4 w-4" />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function ForumFilterBar({
  filters,
  tags,
  onChange,
  inlineTags,
  strip = false,
  leading,
}: ForumFilterBarProps) {
  const { t } = useTranslation();
  const tagLabel = useForumTagLabel();
  const selected = new Set(filters.tagIds);

  function toggleTag(tagId: string) {
    const next = selected.has(tagId)
      ? filters.tagIds.filter((one) => one !== tagId)
      : [...filters.tagIds, tagId];
    onChange({ tagIds: next });
  }

  const statusValue: "all" | ForumStatusFilter = filters.status ?? "all";
  const mineChip = (
    <FilterChip
      pressed={filters.mine}
      removeLabel={t("forum.filter.removeTag", { name: t("forum.filter.mine") })}
      onClick={() => onChange({ mine: !filters.mine })}
    >
      {t("forum.filter.mine")}
    </FilterChip>
  );

  if (strip) {
    // Phone: one strip, active chips first.
    const phoneTags = [
      ...tags.filter((tag) => selected.has(tag.id)),
      ...tags.filter((tag) => !selected.has(tag.id)),
    ];
    return (
      <div
        className="-mx-4 flex min-w-0 items-center gap-2 overflow-x-auto px-4 py-1.5 [mask-image:linear-gradient(to_right,black_85%,transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="toolbar"
        aria-label={t("forum.filter.label")}
      >
        {leading}
        {(["open", "resolved"] as ForumStatusFilter[]).map((status) => (
          <FilterChip
            key={status}
            pressed={filters.status === status}
            removeLabel={t("forum.filter.removeTag", {
              name: status === "open" ? t("forum.filter.open") : t("forum.filter.resolved"),
            })}
            onClick={() => onChange({ status: filters.status === status ? null : status })}
          >
            {status === "open" ? t("forum.filter.open") : t("forum.filter.resolved")}
          </FilterChip>
        ))}
        {mineChip}
        {phoneTags.map((tag) => (
          <FilterChip
            key={tag.id}
            pressed={selected.has(tag.id)}
            removeLabel={t("forum.filter.removeTag", { name: tagLabel(tag) })}
            onClick={() => toggleTag(tag.id)}
          >
            <TagChipContent tag={tag} />
          </FilterChip>
        ))}
      </div>
    );
  }

  // Wide screen: the staff order, with every active tag kept inline even when
  // it sits past the fold, so a filter is never hidden inside "More".
  // The count is a budget: an active tag past the fold takes the place of
  // one before it, so the row never grows into a second line.
  const activePastFold = tags.filter(
    (tag, index) => index >= inlineTags && selected.has(tag.id),
  ).length;
  const inline =
    inlineTags === 0
      ? []
      : tags.filter(
          (tag, index) =>
            index < Math.max(0, inlineTags - activePastFold) || selected.has(tag.id),
        );
  const folded = tags.filter((tag) => !inline.includes(tag));
  const foldedActive = folded.filter((tag) => selected.has(tag.id)).length;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      role="toolbar"
      aria-label={t("forum.filter.label")}
    >
      {leading}
      <div className="shrink-0">
        <RadioGroup
          variant="segmented"
          size="sm"
          fit="content"
          label={t("forum.filter.status")}
          value={statusValue}
          onValueChange={(value) => onChange({ status: value === "all" ? null : value })}
          options={[
            { value: "all", label: t("forum.filter.all") },
            { value: "open", label: t("forum.filter.open") },
            { value: "resolved", label: t("forum.filter.resolved") },
          ]}
        />
      </div>
      {mineChip}
      {tags.length > 0 && (
        // Under the redesign the rule only stands before tag pills, never alone at a line's end.
        <span aria-hidden className={cn("mx-1 h-5 w-px shrink-0 bg-border", inline.length === 0 && "redesign:hidden")} />
      )}
      {inline.map((tag) => (
        <FilterChip
          key={tag.id}
          pressed={selected.has(tag.id)}
          removeLabel={t("forum.filter.removeTag", { name: tagLabel(tag) })}
          onClick={() => toggleTag(tag.id)}
        >
          <TagChipContent tag={tag} />
        </FilterChip>
      ))}
      {folded.length > 0 && (
        <Menu
          align="start"
          items={folded.map((tag) => ({
            id: `tag-${tag.id}`,
            // A menu row draws its own icon; with none, the emoji an old row
            // carries goes in front of the name as it always did.
            label: forumTagIconComponent(tag)
              ? tagLabel(tag)
              : tag.emoji
                ? `${tag.emoji} ${tagLabel(tag)}`
                : tagLabel(tag),
            icon: forumTagIconComponent(tag) ?? undefined,
            checked: selected.has(tag.id),
            onSelect: () => toggleTag(tag.id),
          }))}
        >
          <button
            type="button"
            aria-label={
              inline.length === 0 ? t("forum.filter.tags") : t("forum.filter.moreTagsLabel")
            }
            className={filterControlClass(inline.length === 0 && filters.tagIds.length > 0)}
          >
            {inline.length === 0
              ? t("forum.filter.tags")
              : t("forum.filter.moreTags", { count: folded.length })}
            {(inline.length === 0 ? filters.tagIds.length : foldedActive) > 0 && (
              <span className="tabular-nums">
                {inline.length === 0 ? filters.tagIds.length : foldedActive}
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
          </button>
        </Menu>
      )}
    </div>
  );
}

/** "Bug + Front + Resolvidos": the active filters, for the empty state. */
export function describeActiveFilters(
  filters: ForumFilters,
  tags: readonly ForumTag[],
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const parts = [
    ...filters.tagIds
      .map((tagId) => tags.find((tag) => tag.id === tagId))
      .filter((tag): tag is ForumTag => Boolean(tag))
      .map((tag) => forumTagLabel(tag, t)),
    filters.status === "open"
      ? t("forum.filter.open")
      : filters.status === "resolved"
        ? t("forum.filter.resolved")
        : null,
    filters.mine ? t("forum.filter.mine") : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" + ");
}
