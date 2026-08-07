import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface AutocompleteOption {
  id: string;
  /** Leading, fixed-emphasis label — a command name or a handle. */
  primary: ReactNode;
  /** Trailing description, dimmed. */
  secondary?: ReactNode;
  /** Optional leading avatar / icon slot. */
  leading?: ReactNode;
}

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
  placement?: "above" | "below" | "inline";
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}

const PLACEMENT_CLASS = {
  above: "absolute left-0 right-0 z-20 bottom-full mb-2",
  below: "absolute left-0 right-0 z-20 top-full mt-2",
  inline: "relative z-20 mt-2",
} as const;

/**
 * The one popup behind both `/command` and `@mention` completion. Keyboard
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
  onSelect,
  onHover,
}: AutocompleteMenuProps) {
  if (options.length === 0) {
    return (
      <div
        id={id}
        className={cn(
          "animate-rise overflow-hidden rounded-lg border border-border bg-surface-1 p-3 shadow-[var(--shadow-popover)]",
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
      className={cn(
        "animate-rise max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface-1 p-1 shadow-[var(--shadow-popover)]",
        PLACEMENT_CLASS[placement],
      )}
      role="listbox"
      aria-label={label}
    >
      <p className="px-2.5 py-1.5 text-[11px] uppercase tracking-wider text-text-muted">
        {heading}
      </p>
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={selected}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm outline-none",
              selected
                ? "bg-surface-2 text-text"
                : "text-text-muted hover:bg-surface-2/70 hover:text-text",
            )}
            onMouseEnter={() => onHover(index)}
            // mousedown, not click: the textarea must not lose focus first, or
            // the caret position the insertion depends on is already gone.
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(index);
            }}
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
