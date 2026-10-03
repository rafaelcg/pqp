import { useCallback, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface RadioOption<T extends string | number> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string | number> {
  value: T;
  onValueChange: (next: T) => void;
  options: readonly RadioOption<T>[];
  /** The group's accessible name. Required: e2e and screen readers find a group by it. */
  label: string;
  variant?: "segmented" | "chips" | "list";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}

/**
 * Roving tabindex and arrow keys for a `role="radiogroup"`.
 *
 * Only the checked option sits in the tab order, so a keyboard user crosses a
 * group with one Tab. The arrows move AND select, which is what a radio group
 * does in every platform's native control; both axes are accepted because a
 * segmented control and a wrapped chip row are horizontal while a list is
 * vertical, and a user should not have to know which one the CSS drew.
 *
 * Disabled options are skipped. When the checked value is itself disabled or
 * absent (night locks the brightness to dark and disables the rest), the first
 * enabled option takes the tab stop, so the group is never unreachable.
 *
 * Shared with `SettingsChoiceGrid`. The handler focuses the matching
 * `[role="radio"]` inside the element it is attached to, so the radios must be
 * rendered in the same order as `values`.
 */
export function useRovingRadio<T>(
  values: readonly T[],
  value: T,
  onChange: (v: T) => void,
  isDisabled?: (v: T) => boolean,
): {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  tabIndexFor: (v: T) => 0 | -1;
} {
  const enabled = (v: T) => !isDisabled?.(v);
  const checkedIndex = values.findIndex((v) => v === value);
  const stop =
    checkedIndex >= 0 && enabled(values[checkedIndex]!)
      ? checkedIndex
      : values.findIndex(enabled);

  const tabIndexFor = (v: T): 0 | -1 =>
    stop >= 0 && values[stop] === v ? 0 : -1;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const home = event.key === "Home";
    const end = event.key === "End";
    if (!forward && !back && !home && !end) {
      return;
    }
    const count = values.length;
    if (count === 0) {
      return;
    }
    event.preventDefault();

    let index = -1;
    if (home || end) {
      const order = values.map((_, i) => i);
      if (end) order.reverse();
      index = order.find((i) => enabled(values[i]!)) ?? -1;
    } else {
      const step = forward ? 1 : -1;
      const from = stop >= 0 ? stop : forward ? -1 : count;
      for (let hop = 1; hop <= count; hop++) {
        const candidate = (((from + step * hop) % count) + count) % count;
        if (enabled(values[candidate]!)) {
          index = candidate;
          break;
        }
      }
    }
    if (index < 0) {
      return;
    }
    if (values[index] !== value) {
      onChange(values[index]!);
    }
    const radios =
      event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    radios[index]?.focus();
  };

  return { onKeyDown, tabIndexFor };
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring";

/** Inside a group box the box clips an outer ring, so the ring goes inside. */
const INSET_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring focus-visible:ring-offset-0";

/**
 * One of a few. Three shapes for three jobs, one keyboard model:
 *
 * - `segmented`: two to four short options, a single track.
 * - `chips`: one of many, or tag-like options that wrap.
 * - `list`: two to four options that each need a description; full-width
 *   rows with a radio dot, meant to sit as one child of a `SettingsGroup`.
 *
 * Options with a `description` cannot be segmented: a track has no room for a
 * second line, so the description would be silently dropped.
 */
export function RadioGroup<T extends string | number>({
  value,
  onValueChange,
  options,
  label,
  variant = "segmented",
  size = "md",
  disabled = false,
  className,
}: RadioGroupProps<T>) {
  const isDisabled = useCallback(
    (v: T) =>
      disabled || Boolean(options.find((option) => option.value === v)?.disabled),
    [disabled, options],
  );
  const { onKeyDown, tabIndexFor } = useRovingRadio(
    options.map((option) => option.value),
    value,
    onValueChange,
    isDisabled,
  );

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        variant === "segmented" &&
          "grid auto-cols-fr grid-flow-col gap-0.5 rounded-[var(--radius-control)] border border-border bg-surface-0 p-0.5",
        variant === "chips" && "flex flex-wrap gap-2",
        variant === "list" && "flex flex-col divide-y divide-border",
        className,
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;
        const optionDisabled = isDisabled(option.value);
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={optionDisabled}
            tabIndex={tabIndexFor(option.value)}
            onClick={() => {
              if (!checked) onValueChange(option.value);
            }}
            className={cn(
              "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
              optionDisabled && "cursor-not-allowed opacity-40",
              variant === "segmented" && [
                "inline-flex min-w-0 items-center justify-center rounded-[var(--radius-control)] whitespace-nowrap",
                size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
                checked
                  ? "bg-surface-2 font-medium text-text"
                  : "text-text-tertiary",
                !checked && !optionDisabled && "hover:text-text",
                FOCUS_RING,
              ],
              variant === "chips" && [
                "inline-flex items-center rounded-full border",
                size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
                checked
                  ? "border-accent bg-accent-soft text-on-accent-soft"
                  : "border-border text-text-secondary",
                !checked &&
                  !optionDisabled &&
                  "hover:bg-surface-2 hover:text-text",
                FOCUS_RING,
              ],
              variant === "list" && [
                "flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left",
                !optionDisabled && "hover:bg-surface-2",
                INSET_FOCUS_RING,
              ],
            )}
          >
            {variant === "list" ? (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-text">{option.label}</span>
                  {option.description ? (
                    <span className="mt-0.5 block text-xs text-pretty text-text-tertiary">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    checked ? "border-accent" : "border-border-strong",
                  )}
                >
                  {checked ? (
                    <span className="h-2 w-2 rounded-full bg-accent" />
                  ) : null}
                </span>
              </>
            ) : (
              <span className="truncate">{option.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
