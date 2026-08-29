import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";

export interface AutocompleteOption {
  id: string;
  /** Leading, fixed-emphasis label — a command name or a handle. */
  primary: ReactNode;
  /** Trailing description, dimmed. */
  secondary?: ReactNode;
  /** Optional leading avatar / icon slot. */
  leading?: ReactNode;
  /**
   * Accessible name, for when the visible text is not the whole story. A grid
   * cell shows a die and `1d20`; the row it replaced read "20-sided die", and
   * that sentence is worth keeping for a screen reader and a tooltip even
   * though printing it is what made the menu too tall to use.
   */
  label?: string;
}

type Placement = "above" | "below" | "inline";

interface AutocompleteMenuProps {
  id?: string;
  /** Accessible name for the listbox. */
  label: string;
  /** Small caps heading above the options. */
  heading: string;
  emptyLabel: string;
  options: AutocompleteOption[];
  selectedIndex: number;
  /**
   * Which side of its anchor the menu opens on. Defaults to `"above"` because
   * the composer sits at the bottom of the window, where a menu opening
   * downwards would open off-screen; a search field at the top of a dialog is
   * the mirror image of that and needs `"below"`.
   *
   * `"inline"` takes the menu out of the overlay business entirely and lets it
   * occupy real space under the field. Floating over an ancestor that scrolls
   * or clips — a dialog body, say — does not work: the menu is drawn *inside*
   * that clip, so it is cut off at the container's edge and reads as rendering
   * behind the panel rather than in it.
   */
  placement?: Placement;
  /**
   * `"list"` is one full-width row per option: a command and its description,
   * a handle and a display name, text that has to be read.
   *
   * `"grid"` is for options that are already a picture — the dice presets are
   * eight small drawings of a die plus its notation. As rows they were ~410px
   * of menu, which no cap and no placement can make comfortable; as a grid
   * they are two rows of four and every one of them is simply on screen.
   */
  layout?: "list" | "grid";
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}

const PLACEMENT_CLASS = {
  above: "absolute left-0 right-0 z-20 bottom-full mb-2",
  below: "absolute left-0 right-0 z-20 top-full mt-2",
  inline: "relative z-20 mt-2",
} as const;

/**
 * Cells per row in a grid menu. Exported because the composer owns the keyboard
 * and cannot move the selection by a row without knowing how wide a row is.
 * Eight dice divide into it exactly, which is the point.
 */
export const AUTOCOMPLETE_GRID_COLUMNS = 4;

/** Clear of whatever would otherwise clip the menu, rather than flush against it. */
const MENU_EDGE_GAP_PX = 8;
/** Below this there is no menu worth drawing, so stop shrinking and scroll. */
const MIN_MENU_HEIGHT_PX = 88;
const LIST_MAX_HEIGHT_PX = 256;
const GRID_MAX_HEIGHT_PX = 320;

// `useLayoutEffect` warns when there is no DOM, and the unit suite renders
// these components through `react-dom/server` in a node environment.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * How tall this menu may grow before something above it eats the top.
 *
 * `max-h-64` was a guess and the dice menu is what proved it wrong. The app
 * shell is `overflow-hidden`, so a floating menu is drawn *inside* that clip:
 * in a short pane — chat beside a voice call — even 256px reached past the top
 * of the pane and was cut off there. What the user saw was the bottom of a menu
 * and no way to tell the rest existed, because overlay scrollbars only appear
 * once you are already scrolling. Measuring the real room between the anchored
 * edge and the nearest clipping ancestor is the only cap that cannot be wrong
 * on a viewport nobody tested.
 */
function useRoomToGrow(
  ref: RefObject<HTMLDivElement | null>,
  placement: Placement,
  cap: number,
  optionCount: number,
): number {
  const [room, setRoom] = useState(cap);

  useIsomorphicLayoutEffect(() => {
    if (placement === "inline") {
      setRoom(cap);
      return;
    }
    function measure() {
      const menu = ref.current;
      if (!menu) {
        return;
      }
      let clipTop = 0;
      let clipBottom = window.innerHeight;
      for (
        let parent = menu.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent);
        if (style.overflowX === "visible" && style.overflowY === "visible") {
          continue;
        }
        const box = parent.getBoundingClientRect();
        clipTop = Math.max(clipTop, box.top);
        clipBottom = Math.min(clipBottom, box.bottom);
      }
      // Measure from the anchored edge, the one that does not move when the
      // menu's height changes — otherwise the measurement feeds itself.
      const rect = menu.getBoundingClientRect();
      const available =
        placement === "above"
          ? rect.bottom - clipTop - MENU_EDGE_GAP_PX
          : clipBottom - rect.top - MENU_EDGE_GAP_PX;
      setRoom(
        Math.max(MIN_MENU_HEIGHT_PX, Math.min(cap, Math.floor(available))),
      );
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [cap, optionCount, placement, ref]);

  return room;
}

/**
 * The one popup behind `/command`, `@mention` and `:emoji:` completion. Keyboard
 * handling stays in the composer, which owns the caret; this only draws.
 */
export function AutocompleteMenu({
  id,
  label,
  heading,
  emptyLabel,
  options,
  selectedIndex,
  placement = "above",
  layout = "list",
  onSelect,
  onHover,
}: AutocompleteMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isGrid = layout === "grid";
  const maxHeight = useRoomToGrow(
    menuRef,
    placement,
    isGrid ? GRID_MAX_HEIGHT_PX : LIST_MAX_HEIGHT_PX,
    options.length,
  );

  if (options.length === 0) {
    return (
      <div
        id={id}
        className={cn(
          // `animate-fade-in`, not `animate-rise`: the latter slides the panel
          // through 14px of translate for 650ms, so anything measuring the menu
          // — a clip check, a scroll-into-view — sees a box it is not in yet.
          "animate-fade-in overflow-hidden rounded-lg border border-border bg-surface-1 p-3 shadow-[var(--shadow-popover)]",
          PLACEMENT_CLASS[placement],
        )}
      >
        <p className="text-sm text-text-muted">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div
      id={id}
      ref={menuRef}
      className={cn(
        "animate-fade-in overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface-1 p-1 shadow-[var(--shadow-popover)]",
        // `grid-cols-4` is `AUTOCOMPLETE_GRID_COLUMNS` spelled out: Tailwind
        // only sees class names it can read in the source, so the two have to
        // be changed together.
        //
        // Capped rather than stretched to the composer. A row menu wants the
        // full width because it is reading matter; four dice across 1400px are
        // four stamps adrift in a field, with a selection ring 350px wide
        // around a 28px die. 20rem is what the cells want to be, and it is the
        // same size of target on a phone and on a desk.
        isGrid && "grid w-full max-w-[20rem] grid-cols-4 gap-1",
        PLACEMENT_CLASS[placement],
      )}
      style={{ maxHeight: `${maxHeight}px` }}
      role="listbox"
      aria-label={label}
    >
      <p
        className={cn(
          "px-2.5 py-1.5 text-[11px] uppercase tracking-wider text-text-muted",
          isGrid && "col-span-full",
        )}
      >
        {heading}
      </p>
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        // mousedown, not click: the textarea must not lose focus first, or the
        // caret position the insertion depends on is already gone.
        const handlers = {
          onMouseEnter: () => onHover(index),
          onMouseDown: (event: ReactMouseEvent) => {
            event.preventDefault();
            onSelect(index);
          },
        };

        if (isGrid) {
          return (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={selected}
              aria-label={option.label}
              title={option.label}
              className={cn(
                "flex min-w-0 flex-col items-center justify-end gap-1.5 rounded-md px-1 py-2 text-center outline-none",
                selected
                  ? "bg-surface-2 text-text ring-1 ring-accent/50"
                  : "text-text-muted hover:bg-surface-2/70 hover:text-text",
              )}
              {...handlers}
            >
              {option.leading}
              <span className="w-full truncate font-mono text-[11px] font-medium text-accent">
                {option.primary}
              </span>
            </button>
          );
        }

        return (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={selected}
            aria-label={option.label}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm outline-none",
              selected
                ? "bg-surface-2 text-text"
                : "text-text-muted hover:bg-surface-2/70 hover:text-text",
            )}
            {...handlers}
          >
            {option.leading}
            <span className="shrink-0 font-medium text-accent">
              {option.primary}
            </span>
            {option.secondary !== undefined && (
              <span className="min-w-0 flex-1 truncate text-text/80">
                {option.secondary}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
