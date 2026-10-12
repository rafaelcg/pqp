import type { ForumSort, ForumStatusFilter, ForumTag } from "@pqp/shared";
import { ArrowDownUp, ChevronDown, Tag as TagIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { Menu } from "@/components/ui/menu";
import { RadioGroup } from "@/components/ui/radio-group";
import type { ForumFilters } from "@/lib/forum-list";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Everything that narrows the list, on one line read left to right (UX §2.2
 * #9): sort, status, Meus posts, then the forum's tags in the order staff set.
 * Tags are AND: each one picked narrows further. An active filter is a filled
 * chip with an X, so "why is my list short" always has a visible answer.
 *
 * On a phone the same controls ride one horizontal strip (UX §2.9 #56), status
 * as two toggles (Todos is neither on), active chips first.
 */

interface ForumFilterBarProps {
  filters: ForumFilters;
  tags: readonly ForumTag[];
  onChange: (next: Partial<ForumFilters>) => void;
  /**
   * Tag chips drawn inline on a wide screen before the rest fold into "+N";
   * the pane sizes it from its width. 0 is the compact list beside an open
   * post: one "Tags" menu instead of chips.
   */
  inlineTags: number;
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
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-[background-color,border-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset max-sm:h-9 max-sm:px-3",
        pressed
          ? "border-transparent bg-accent-soft text-on-accent-soft"
          : "border-border text-text-secondary hover:bg-surface-2 hover:text-text",
        className,
      )}
    >
      {children}
      {pressed && removeLabel && <X className="h-3 w-3 shrink-0" aria-hidden />}
    </button>
  );
}

function TagChipContent({ tag }: { tag: ForumTag }) {
  return (
    <>
      {tag.emoji && <span aria-hidden>{tag.emoji}</span>}
      <span className="max-w-[9rem] truncate">{tag.name}</span>
    </>
  );
}

export function ForumFilterBar({
  filters,
  tags,
  onChange,
  inlineTags,
}: ForumFilterBarProps) {
  const { t } = useTranslation();
  const selected = new Set(filters.tagIds);

  function toggleTag(tagId: string) {
    const next = selected.has(tagId)
      ? filters.tagIds.filter((one) => one !== tagId)
      : [...filters.tagIds, tagId];
    onChange({ tagIds: next });
  }

  const sortLabel =
    filters.sort === "activity" ? t("forum.sort.activity") : t("forum.sort.created");
  const sortShort =
    filters.sort === "activity" ? t("forum.sort.activityShort") : t("forum.sort.created");
  const sortItems = (["activity", "created"] as ForumSort[]).map((sort) => ({
    id: `sort-${sort}`,
    label: sort === "activity" ? t("forum.sort.activity") : t("forum.sort.created"),
    checked: filters.sort === sort,
    onSelect: () => onChange({ sort }),
  }));

  // Wide screen: the staff order, with every active tag kept inline even when
  // it sits past the fold, so a filter is never hidden inside "+N".
  const inline =
    inlineTags === 0
      ? []
      : tags.filter((tag, index) => index < inlineTags || selected.has(tag.id));
  const folded = tags.filter((tag) => !inline.includes(tag));
  // Phone: one strip, active chips first.
  const phoneTags = [
    ...tags.filter((tag) => selected.has(tag.id)),
    ...tags.filter((tag) => !selected.has(tag.id)),
  ];

  const statusValue: "all" | ForumStatusFilter = filters.status ?? "all";

  return (
    <div
      // One line that scrolls sideways when it runs out of room, rather than
      // wrapping into a second row that moves the list down.
      className="-my-1 flex min-w-0 items-center gap-1.5 overflow-x-auto py-1 [scrollbar-width:none] max-sm:-mx-4 max-sm:px-4 [&::-webkit-scrollbar]:hidden"
      role="toolbar"
      aria-label={t("forum.filter.label")}
    >
      <Menu items={sortItems} align="start">
        <button
          type="button"
          aria-label={`${t("forum.sort.label")}: ${sortLabel}`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-9 max-sm:px-3"
        >
          <ArrowDownUp className="h-3.5 w-3.5" aria-hidden />
          {inlineTags === 0 ? (
            <span>{sortShort}</span>
          ) : (
            <>
              <span className="hidden lg:inline">{sortLabel}</span>
              <span className="lg:hidden">{sortShort}</span>
            </>
          )}
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
        </button>
      </Menu>

      <div className="shrink-0 max-sm:hidden">
        <RadioGroup
          variant="segmented"
          size="sm"
          fit="content"
          label={t("forum.filter.status")}
          value={statusValue}
          onValueChange={(value) =>
            onChange({ status: value === "all" ? null : value })
          }
          options={[
            { value: "all", label: t("forum.filter.all") },
            { value: "open", label: t("forum.filter.open") },
            { value: "resolved", label: t("forum.filter.resolved") },
          ]}
        />
      </div>
      {/* Phone: two toggles; Todos is neither on. */}
      <div className="flex shrink-0 gap-1.5 sm:hidden">
        {(["open", "resolved"] as ForumStatusFilter[]).map((status) => (
          <FilterChip
            key={status}
            pressed={filters.status === status}
            removeLabel={t("forum.filter.removeTag", {
              name:
                status === "open"
                  ? t("forum.filter.open")
                  : t("forum.filter.resolved"),
            })}
            onClick={() =>
              onChange({ status: filters.status === status ? null : status })
            }
          >
            {status === "open" ? t("forum.filter.open") : t("forum.filter.resolved")}
          </FilterChip>
        ))}
      </div>

      <FilterChip
        pressed={filters.mine}
        removeLabel={t("forum.filter.removeTag", { name: t("forum.filter.mine") })}
        onClick={() => onChange({ mine: !filters.mine })}
      >
        {t("forum.filter.mine")}
      </FilterChip>

      {tags.length > 0 && inlineTags > 0 && (
        <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border max-sm:block" />
      )}

      {/* Wide screens: the staff order, folding into +N. */}
      <div className="flex min-w-0 items-center gap-1.5 max-sm:hidden">
        {inline.map((tag) => (
          <FilterChip
            key={tag.id}
            pressed={selected.has(tag.id)}
            removeLabel={t("forum.filter.removeTag", { name: tag.name })}
            onClick={() => toggleTag(tag.id)}
          >
            <TagChipContent tag={tag} />
          </FilterChip>
        ))}
        {folded.length > 0 && (
          <Menu
            align="end"
            items={folded.map((tag) => ({
              id: `tag-${tag.id}`,
              label: tag.emoji ? `${tag.emoji} ${tag.name}` : tag.name,
              checked: selected.has(tag.id),
              onSelect: () => toggleTag(tag.id),
            }))}
          >
            {inline.length === 0 ? (
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  filters.tagIds.length > 0
                    ? "border-transparent bg-accent-soft text-on-accent-soft"
                    : "border-border text-text-secondary hover:bg-surface-2 hover:text-text",
                )}
              >
                <TagIcon className="h-3.5 w-3.5" aria-hidden />
                {t("forum.filter.tags")}
                {filters.tagIds.length > 0 && (
                  <span className="tabular-nums">{filters.tagIds.length}</span>
                )}
                <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                aria-label={t("forum.filter.moreTagsLabel")}
                className="inline-flex h-7 shrink-0 items-center rounded-full border border-border px-2.5 text-xs font-medium tabular-nums text-text-secondary transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                {t("forum.filter.moreTags", { count: folded.length })}
              </button>
            )}
          </Menu>
        )}
      </div>
      {/* Phone: every tag in the strip, active ones first. */}
      <div className="flex shrink-0 items-center gap-1.5 sm:hidden">
        {phoneTags.map((tag) => (
          <FilterChip
            key={tag.id}
            pressed={selected.has(tag.id)}
            removeLabel={t("forum.filter.removeTag", { name: tag.name })}
            onClick={() => toggleTag(tag.id)}
          >
            <TagChipContent tag={tag} />
          </FilterChip>
        ))}
      </div>
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
      .map((tag) => (tag.emoji ? `${tag.emoji} ${tag.name}` : tag.name)),
    filters.status === "open"
      ? t("forum.filter.open")
      : filters.status === "resolved"
        ? t("forum.filter.resolved")
        : null,
    filters.mine ? t("forum.filter.mine") : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" + ");
}

