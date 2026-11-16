import { useCallback, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Tabs: a row of buttons that switch what one panel shows.
 *
 * Four shapes, one keyboard model. Only the selected tab sits in the tab
 * order; the arrows (both axes), Home and End move and select, skipping a
 * disabled tab. Each tab names the panel it controls when `panelId` is
 * given.
 *
 * | Variant     | Size | Where                                            |
 * |-------------|------|--------------------------------------------------|
 * | `underline` | `md` | a page's sections (a bot's overview)              |
 * | `segmented` | `md` | two to four views of one thing (a role)           |
 * | `segmented` | `xs` | the same inside a popover (a profile's about)     |
 * | `pill`      | `md` | a header's lists (friends)                        |
 * | `pill`      | `xs` | a compact pane header, with counts (call split)   |
 * | `filled`    | `sm` | a status filter (reports)                         |
 *
 * With the toggle off each shape draws exactly what its call sites drew
 * before, spelled with role names (`surface-1` for the old `ink-2`). None of
 * them sits inside `.on-media-scope`; a tab row placed there would need the
 * scope's `on-media` roles passed in through `className`. Under
 * the redesign every shape reads `--tabs-*` tokens, and `segmented` is the
 * same pill track and raised thumb as RadioGroup's (`--segmented-*`).
 *
 * Tabs switch a panel. One of a few values in a form is a `RadioGroup`; a
 * settings dialog's side list is `SectionRail`.
 */
export type TabsVariant = "underline" | "segmented" | "pill" | "filled";
export type TabsSize = "xs" | "sm" | "md";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Drawn after the label as a small badge when above zero. */
  count?: number;
  disabled?: boolean;
  /** `data-*` attributes for this tab, for tests and hooks. */
  data?: Record<`data-${string}`, string>;
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onValueChange: (next: T) => void;
  /** The tablist's accessible name. */
  label?: string;
  variant?: TabsVariant;
  size?: TabsSize;
  /** The id of the panel the tabs control, for `aria-controls`. */
  panelId?: string;
  /** Classes for the tablist: layout, margins, overflow. */
  className?: string;
  /** Classes added to every tab: layout only (`@2xl:py-1`). */
  tabClassName?: string;
}

interface Look {
  list: string;
  /** Focus ring. Only the shape that drew one before draws it with the toggle off. */
  focus: string;
  tab: string;
  on: string;
  off: string;
}

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
const FOCUS_REDESIGN =
  "redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-focus-ring";

/** Keyed `variant:size`. A combination missing here falls back to `md`. */
const LOOKS: Record<string, Look> = {
  "underline:md": {
    list: "flex gap-1 border-b border-[color:var(--tabs-rule,var(--color-border))]",
    focus: FOCUS,
    // Under the redesign the focus ring is a rounded box inset from the rule.
    tab: "-mb-px border-b-2 px-3 pb-2.5 pt-1 text-sm font-semibold transition-colors duration-[var(--duration-fast)] redesign:rounded-t-[var(--radius-control)] redesign:focus-visible:ring-inset",
    on: "border-accent text-text",
    off: "border-transparent text-[color:var(--tabs-off-text,var(--color-text-tertiary))] hover:text-text",
  },
  "segmented:md": {
    list: "grid auto-cols-fr grid-flow-col gap-1 redesign:gap-0.5 rounded-[var(--segmented-radius,0.75rem)] bg-[color:var(--segmented-bg,color-mix(in_oklab,var(--color-surface-2)_60%,transparent))] p-[var(--segmented-pad,0.25rem)]",
    focus: `${FOCUS_REDESIGN} redesign:focus-visible:ring-offset-[length:var(--segmented-ring-offset)] redesign:focus-visible:ring-offset-transparent`,
    // RadioGroup's metrics under the redesign: the cell is the control
    // height minus the track's pad, so the track sits on the ladder.
    tab: "min-w-0 redesign:truncate rounded-[var(--segmented-radius,0.5rem)] px-3 py-1.5 text-sm transition-colors duration-[var(--duration-fast)] redesign:h-[var(--segmented-h)] redesign:py-0",
    on: "bg-[color:var(--segmented-thumb,var(--color-surface-1))] font-medium text-text shadow-[var(--segmented-thumb-shadow,0_1px_3px_0_rgb(0_0_0/0.1),0_1px_2px_-1px_rgb(0_0_0/0.1))]",
    off: "text-[color:var(--segmented-text,var(--color-text-tertiary))] hover:text-text",
  },
  "segmented:xs": {
    list: "grid auto-cols-fr grid-flow-col gap-0.5 rounded-[var(--segmented-radius,0.5rem)] bg-[color:var(--segmented-bg,color-mix(in_oklab,var(--color-surface-2)_60%,transparent))] p-0.5 redesign:p-[var(--segmented-pad)]",
    focus: `${FOCUS_REDESIGN} redesign:focus-visible:ring-offset-[length:var(--segmented-ring-offset)] redesign:focus-visible:ring-offset-transparent`,
    // Under the redesign: 12px, regular until selected, as RadioGroup's cells.
    tab: "min-w-0 truncate rounded-[var(--segmented-radius,0.375rem)] px-1.5 py-1 text-[11px] font-medium transition-colors redesign:h-[var(--segmented-h-sm)] redesign:py-0 redesign:text-xs redesign:font-normal",
    on: "bg-[color:var(--segmented-thumb,var(--color-surface-1))] text-text shadow-[var(--segmented-thumb-shadow,0_0_transparent)] redesign:font-medium",
    off: "text-[color:var(--segmented-text,var(--color-text-tertiary))] hover:text-text",
  },
  "pill:md": {
    list: "flex items-center gap-1",
    focus: FOCUS_REDESIGN,
    tab: "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--tabs-pill-radius,0.375rem)] px-2.5 py-1.5 text-sm redesign:transition-colors redesign:duration-[var(--duration-fast)]",
    // Selected differs from hovered by weight too, not only by the fill.
    on: "bg-[color:var(--tabs-pill-on,var(--color-surface-2))] text-text redesign:font-medium",
    off: "text-[color:var(--tabs-off-text,var(--color-text-tertiary))] hover:bg-[color:var(--tabs-pill-hover,color-mix(in_oklab,var(--color-surface-2)_70%,transparent))] hover:text-text",
  },
  "pill:xs": {
    list: "flex shrink-0 items-center gap-0.5",
    focus: FOCUS_REDESIGN,
    // As `pill:md` under the redesign: regular until selected, then medium.
    tab: "rounded-[var(--tabs-pill-radius,var(--radius-control))] px-2 py-0.5 font-semibold transition-colors redesign:font-normal",
    on: "bg-[color:var(--tabs-pill-on,var(--color-surface-2))] text-text redesign:font-medium",
    off: "text-[color:var(--tabs-off-text,var(--color-text-tertiary))] hover:bg-[color:var(--tabs-pill-hover,var(--color-surface-2))] hover:text-text",
  },
  "filled:sm": {
    list: "flex flex-wrap gap-1.5",
    focus: FOCUS_REDESIGN,
    tab: "rounded-[var(--tabs-pill-radius,0.375rem)] px-2.5 py-1 text-xs font-medium transition-colors",
    on: "bg-accent text-surface-0 redesign:text-on-accent",
    off: "bg-[color:var(--tabs-filled-off,var(--color-surface-2))] text-[color:var(--tabs-off-text,var(--color-text-tertiary))] hover:text-text redesign:hover:bg-[color:var(--tabs-filled-hover)]",
  },
};

function lookFor(variant: TabsVariant, size: TabsSize): Look {
  return LOOKS[`${variant}:${size}`] ?? LOOKS[`${variant}:md`] ?? LOOKS[`${variant}:sm`]!;
}

export function Tabs<T extends string>({
  items,
  value,
  onValueChange,
  label,
  variant = "underline",
  size = "md",
  panelId,
  className,
  tabClassName,
}: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const look = lookFor(variant, size);
  const enabled = items.filter((item) => !item.disabled);
  // The tab stop: the selected tab, or the first enabled one when the
  // selected tab is disabled or absent, so the list is never unreachable.
  const stop = enabled.some((item) => item.id === value) ? value : enabled[0]?.id;

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const from = enabled.findIndex(
        (item) => item.id === (event.target as HTMLElement).dataset.tabId,
      );
      if (from < 0 || enabled.length === 0) return;
      let to: number;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          to = (from + 1) % enabled.length;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          to = (from - 1 + enabled.length) % enabled.length;
          break;
        case "Home":
          to = 0;
          break;
        case "End":
          to = enabled.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const next = enabled[to]!.id;
      onValueChange(next);
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(next)}"]`)
        ?.focus();
    },
    [enabled, onValueChange],
  );

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(look.list, className)}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            disabled={item.disabled}
            tabIndex={item.id === stop ? 0 : -1}
            data-tab-id={item.id}
            {...item.data}
            onClick={() => {
              if (!selected) onValueChange(item.id);
            }}
            className={cn(
              look.tab,
              look.focus,
              selected ? look.on : look.off,
              item.disabled && "cursor-not-allowed opacity-[var(--tabs-disabled-opacity,0.4)] redesign:pointer-events-none",
              tabClassName,
            )}
          >
            {item.label}
            {item.count !== undefined && item.count > 0 ? (
              <span className="ml-1 rounded-full bg-[color:var(--tabs-count-bg,color-mix(in_oklab,var(--color-accent)_20%,transparent))] px-1.5 text-[length:var(--tabs-count-size,10px)] text-[color:var(--tabs-count-text,var(--color-accent))] redesign:inline-block redesign:h-4 redesign:min-w-4 redesign:px-1 redesign:text-center redesign:leading-4 redesign:tabular-nums">
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
