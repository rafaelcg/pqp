import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * Equal-width chip row. No native select: five or seven options stay
 * visible, keyboard-reachable, and wrap on a 360px panel.
 */
export function InviteChoiceRow<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const current = options.findIndex((option) => option.value === value);
    const next =
      options[(current + step + options.length) % options.length]!;
    onChange(next.value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[(current + step + options.length) % options.length]?.focus();
  }

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-text-secondary redesign:mb-2 redesign:text-[13px] redesign:font-semibold">{label}</p>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex flex-wrap gap-1 redesign:gap-1.5"
        onKeyDown={handleKeyDown}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={String(option.value)}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option.value)}
              className={cn(
                "min-h-[var(--control-sm)] min-w-[5.25rem] flex-1 whitespace-nowrap rounded-md border px-1.5 py-1.5 text-center text-xs font-medium",
                "transition-colors duration-[var(--duration-fast)]",
                "motion-reduce:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset",
                selected
                  ? "border-accent bg-accent-soft text-on-accent-soft"
                  : "border-border text-text-secondary hover:border-border-strong hover:text-text",
                // Under the redesign a choice is a pill: the card's edge when
                // idle, the selected row's fill with an accent edge when on.
                "redesign:rounded-full redesign:px-3 redesign:focus-visible:ring-[color:var(--list-row-ring)]",
                selected
                  ? "redesign:border-accent redesign:bg-[color:var(--list-row-selected)] redesign:font-semibold redesign:text-[color:var(--list-row-selected-text)]"
                  : "redesign:border-[color:var(--card-border)] redesign:hover:border-[color:var(--card-border)] redesign:hover:bg-[color:var(--card-row-hover)]",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
