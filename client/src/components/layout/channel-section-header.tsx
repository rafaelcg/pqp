import { ChevronDown } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
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
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={controlsId}
        className={cn("flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left", SECTION_FOCUS_RING)}
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-3 w-3 shrink-0 motion-safe:transition-transform motion-safe:duration-[var(--duration-fast)]",
            collapsed && "-rotate-90",
          )}
        />
        <span className={cn("truncate", uppercase ? "uppercase" : "normal-case tracking-normal")}>
          {label}
        </span>
        {collapsed && childCount > 0 && (
          <span
            data-section-summary=""
            className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-[10px] font-medium normal-case tracking-normal text-text-tertiary"
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
      {actions}
    </div>
  );
}
