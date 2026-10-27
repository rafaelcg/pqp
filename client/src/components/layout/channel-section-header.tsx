import { CaretDown } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import { Icon, type IconKind } from "@/components/ui/icon";
import { SECTION_LABEL_REDESIGN } from "@/components/ui/section-header";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The fold control for a section of the classic channel list (Pinados,
 * Texto, Voz, and each category). Same look and rules as the mixed list's
 * `MixedCategoryHeader`, so both layouts read alike: role tokens only, motion
 * under `motion-safe:` only, and a folded section says how many channels it
 * holds plus a dot when one of them is unread.
 *
 * `actions` sit outside the toggle button: a button inside a button is
 * invalid HTML and a screen reader would read the "+" as part of the name.
 */
export const SECTION_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring";

/*
 * Under the redesign every header in the channel list (this one, the mixed
 * list's `MixedCategoryHeader`, the "Categorias" label) is the same thing:
 * the section label's face (sentence case, semibold, secondary text, no
 * tracking) on a pill row that brightens its text on hover, a bold caret,
 * and round actions.
 */
export const CATEGORY_ROW_REDESIGN =
  "redesign:min-h-8 redesign:gap-1.5 redesign:rounded-full redesign:px-2 redesign:text-text-secondary redesign:hover:text-text";

/** The name: the section label's face, in the row's colour. */
export const CATEGORY_LABEL_REDESIGN = cn(
  SECTION_LABEL_REDESIGN,
  "redesign:mb-0 redesign:truncate redesign:text-inherit",
);

/** "3 canais" on a folded section, and its unread dot. */
export const CATEGORY_SUMMARY_REDESIGN =
  "redesign:text-[11px] redesign:tabular-nums redesign:text-text-tertiary";

/**
 * A header a dragged channel would drop into: the mixed list's "into" fill,
 * so every list says it the same way. Under the redesign only; the base keeps
 * the ring it always drew.
 */
export const CATEGORY_DROP_INTO_REDESIGN =
  "redesign:bg-accent-soft redesign:text-on-accent-soft redesign:ring-1 redesign:ring-inset redesign:ring-accent redesign:hover:bg-accent-soft redesign:hover:text-on-accent-soft";

/** "+", the lock, the new category: a round 24px button. */
export const CATEGORY_ACTION_REDESIGN =
  "redesign:flex redesign:h-6 redesign:w-6 redesign:items-center redesign:justify-center redesign:rounded-full redesign:p-0 redesign:text-text-tertiary redesign:hover:bg-row-hover redesign:hover:text-text redesign:data-[state=open]:bg-row-hover redesign:data-[state=open]:text-text redesign:focus-visible:ring-accent redesign:focus-visible:ring-offset-0";

/** The fold caret: Lucide with the toggle off, Phosphor bold under the redesign. */
export function SectionCaret({ collapsed }: { collapsed: boolean }) {
  const turn = cn(
    "shrink-0 motion-safe:transition-transform motion-safe:duration-[var(--duration-fast)]",
    collapsed && "-rotate-90",
  );
  return (
    <>
      <ChevronDown aria-hidden="true" className={cn("h-3 w-3", turn, "redesign:hidden")} />
      <Icon
        icon={CaretDown}
        kind="symbol"
        // The label's colour, a step quieter: it brightens on hover and turns
        // lime on a drop target with the words beside it.
        className={cn("hidden h-3 w-3 opacity-80 redesign:block", turn)}
      />
    </>
  );
}

/** A header action's glyph: the Lucide one off, 14px Phosphor under the redesign. */
export function SectionActionGlyph({
  off: Off,
  on,
  kind = "object",
  offClassName = "h-3.5 w-3.5",
  onClassName = "h-3.5 w-3.5",
}: {
  off: LucideIcon;
  on: PhosphorIcon;
  kind?: IconKind;
  offClassName?: string;
  onClassName?: string;
}) {
  return (
    <>
      <Off aria-hidden="true" className={cn(offClassName, "redesign:hidden")} />
      <Icon icon={on} kind={kind} className={cn("hidden redesign:block", onClassName)} />
    </>
  );
}

export function ChannelSectionHeader({
  label,
  collapsed,
  onToggle,
  controlsId,
  childCount,
  hasUnread,
  uppercase = true,
  actions,
  isDragOver = false,
  dropFill = false,
  onDragOver,
  onDrop,
  className,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  /** The id of the element the header folds, for `aria-controls`. */
  controlsId?: string;
  childCount: number;
  hasUnread: boolean;
  /**
   * On the span, not the row: a browser resets `text-transform` on a button.
   * Category names keep the case their owner typed.
   */
  uppercase?: boolean;
  actions?: ReactNode;
  isDragOver?: boolean;
  /**
   * The drop fill and "Soltar em" under the redesign, with no base ring: for
   * a header whose wrapper already draws the ring with the toggle off.
   */
  dropFill?: boolean;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-section-header=""
      data-collapsed={collapsed ? "" : undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "group/section flex min-h-6 items-center gap-1 rounded-[var(--radius-control)] px-2 text-[11px] font-semibold tracking-[0.12em] text-text-tertiary",
        "motion-safe:transition-colors motion-safe:duration-[var(--duration-fast)] hover:text-text-secondary",
        isDragOver && "ring-1 ring-inset ring-accent",
        className,
        CATEGORY_ROW_REDESIGN,
        (isDragOver || dropFill) && CATEGORY_DROP_INTO_REDESIGN,
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={controlsId}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left",
          SECTION_FOCUS_RING,
          "redesign:gap-1.5 redesign:rounded-full redesign:focus-visible:ring-accent",
        )}
      >
        <SectionCaret collapsed={collapsed} />
        <span
          className={cn(
            "truncate",
            uppercase ? "uppercase" : "normal-case tracking-normal",
            CATEGORY_LABEL_REDESIGN,
          )}
        >
          {label}
        </span>
        {collapsed && childCount > 0 && (
          <span
            data-section-summary=""
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1 pl-1 text-[10px] font-medium normal-case tracking-normal text-text-tertiary",
              CATEGORY_SUMMARY_REDESIGN,
            )}
          >
            {t("chrome.categoryChannelCount", { count: childCount })}
            {hasUnread && (
              <>
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-text" />
                <span className="sr-only">{t("chrome.unreadSr")}</span>
              </>
            )}
          </span>
        )}
      </button>
      {(isDragOver || dropFill) && (
        <span
          data-category-drop-label=""
          className="hidden shrink-0 text-[11px] font-semibold normal-case tracking-normal redesign:inline"
        >
          {t("chrome.dropOnCategory", { name: label })}
        </span>
      )}
      {actions}
    </div>
  );
}
