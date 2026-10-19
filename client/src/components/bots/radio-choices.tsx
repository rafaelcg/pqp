import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A row of picture choices that behaves as one radio group: one tab stop (the
 * chosen item), arrow keys move and choose, Home and End jump to the ends. The
 * bot's colour and face pickers, which are pictures rather than labelled dots,
 * so `RadioGroup` does not fit them.
 */
export function RadioChoices<T extends string>({
  label,
  values,
  value,
  onChange,
  itemLabel,
  itemClassName,
  renderItem,
  className,
}: {
  label: string;
  values: readonly T[];
  value: T;
  onChange: (next: T) => void;
  /** Accessible name of an item whose picture has no text. */
  itemLabel?: (item: T) => string;
  itemClassName: (selected: boolean) => string;
  renderItem: (item: T, selected: boolean) => ReactNode;
  className?: string;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = values.length - 1;
    const target =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    onChange(values[target]!);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[target]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {values.map((item, index) => {
        const selected = item === value;
        return (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={itemLabel?.(item)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]",
              itemClassName(selected),
            )}
          >
            {renderItem(item, selected)}
          </button>
        );
      })}
    </div>
  );
}
