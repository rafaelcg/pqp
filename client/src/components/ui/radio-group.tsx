import { useCallback, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface RadioOption<T extends string | number> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
  /**
   * `chips` and `segmented` only: drawn after the label, for a count that
   * belongs to the option ("Não lidas 3"). Decorative: say the same thing in
   * the label's accessible name if it matters (`aria-label` is the label).
   */
  trailing?: ReactNode;
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
  /**
   * `list` only: drawn under the checked option's description, for example a
   * `SettingsInlineStatus` for the write that option just started.
   */
  status?: ReactNode;
  /**
   * `auto` (default): the arrows move and select. `manual`: the arrows move
   * focus only, and Enter or Space selects. For a change that is expensive or
   * disruptive, like the language switch that reloads the app.
   */
  activation?: RadioActivation;
  /**
   * `segmented` only. `equal` (default): equal cells that fill the track and
   * truncate a label that does not fit. `content`: each cell as wide as its
   * label, never truncated, wrapping onto a second line when the row is too
   * narrow. Use it when one label is much longer than the others.
   */
  fit?: "equal" | "content";
  /**
   * Clicking the checked option commits it again. For a group whose checked
   * option is only the nearest match to a stored value (a synced chat size
   * between presets): picking it must snap the value to the preset.
   */
  reselect?: boolean;
}

export type RadioActivation = "auto" | "manual";

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
 * With `activation: "manual"` the arrows only move focus, and Enter or Space
 * selects the focused option. The arrows always step from the option that has
 * focus, so a manual group can be walked one option at a time.
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
  { activation = "auto" }: { activation?: RadioActivation } = {},
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
    const radios =
      event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    const focused = [...radios].findIndex(
      (radio) => radio === document.activeElement,
    );

    if (
      activation === "manual" &&
      (event.key === "Enter" || event.key === " ")
    ) {
      if (focused < 0) {
        return;
      }
      // Handled here rather than left to the button's own click, so Space
      // does not also scroll the pane and the choice lands exactly once.
      event.preventDefault();
      const picked = values[focused];
      if (picked !== undefined && enabled(picked) && picked !== value) {
        onChange(picked);
      }
      return;
    }

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
      const origin = focused >= 0 ? focused : stop;
      const from = origin >= 0 ? origin : forward ? -1 : count;
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
    if (activation === "auto" && values[index] !== value) {
      onChange(values[index]!);
    }
    radios[index]?.focus();
  };

  return { onKeyDown, tabIndexFor };
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring";

/**
 * The segmented track and cell, exported for a radio group that draws its own
 * cells (the appearance page's locked "Modo" picker), so the two never drift.
 * With the tokens unset this is the bordered `surface-0` box and `surface-2`
 * thumb the app always drew.
 */
export const SEGMENTED_TRACK =
  "gap-0.5 rounded-[var(--segmented-radius,var(--radius-control))] border-[length:var(--segmented-border-w,1px)] border-[color:var(--segmented-border,var(--color-border))] bg-[color:var(--segmented-bg,var(--color-surface-0))] p-[var(--segmented-pad,0.125rem)]";

/** A cell's shape and focus; the ring's offset is the track's padding. */
export const SEGMENTED_CELL = `inline-flex items-center justify-center rounded-[var(--segmented-radius,var(--radius-control))] whitespace-nowrap ${FOCUS_RING} focus-visible:ring-offset-[length:var(--segmented-ring-offset,2px)] redesign:focus-visible:ring-offset-transparent`;

export const SEGMENTED_CELL_ON =
  "bg-[color:var(--segmented-thumb,var(--color-surface-2))] font-medium text-text shadow-[var(--segmented-thumb-shadow,0_0_transparent)]";

export const SEGMENTED_CELL_OFF = "text-[color:var(--segmented-text,var(--color-text-tertiary))]";

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
 *
 * Every colour and radius is a `--segmented-*`, `--chip-*` or `--radio-*`
 * token with today's value as its fallback, so the toggle off is unchanged.
 * Under the redesign the track is a tinted pill with a raised thumb, chips
 * take a stronger edge, and the list's dot is a filled accent disc.
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
  status,
  activation = "auto",
  fit = "equal",
  reselect = false,
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
    { activation },
  );
  const content = variant === "segmented" && fit === "content";

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        variant === "segmented" && SEGMENTED_TRACK,
        variant === "segmented" &&
          (content
            ? "inline-flex max-w-full flex-wrap"
            : "grid auto-cols-fr grid-flow-col"),
        variant === "chips" && "flex flex-wrap gap-2",
        variant === "list" && "flex flex-col divide-y divide-border",
        className,
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;
        const optionDisabled = isDisabled(option.value);
        const showStatus = variant === "list" && checked && Boolean(status);
        const radio = (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={optionDisabled}
            tabIndex={tabIndexFor(option.value)}
            onClick={() => {
              if (!checked || reselect) onValueChange(option.value);
            }}
            className={cn(
              "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
              optionDisabled && "cursor-not-allowed opacity-[var(--radio-disabled-opacity,0.4)]",
              variant === "segmented" && [
                SEGMENTED_CELL,
                content ? "shrink-0" : "min-w-0",
                // The track sits on the control ladder under the redesign: a
                // cell is the control height less the track's padding.
                size === "sm"
                  ? "h-9 px-2.5 text-[length:var(--radio-text-sm,0.75rem)] leading-4 sm:h-[var(--segmented-h-sm,1.75rem)]"
                  : "h-10 px-3 text-sm sm:h-[var(--segmented-h,2rem)]",
                checked ? SEGMENTED_CELL_ON : SEGMENTED_CELL_OFF,
                !checked && !optionDisabled && "hover:text-text",
              ],
              variant === "chips" && [
                "inline-flex items-center rounded-full border",
                size === "sm"
                  ? "h-9 px-2.5 text-[length:var(--radio-text-sm,0.75rem)] leading-4 sm:h-7"
                  : "h-10 px-3 text-sm sm:h-8",
                // 44px to a finger on a phone: the hit area reaches past the
                // drawn pill, into the gap between rows.
                "relative max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:content-['']",
                size === "sm" ? "max-sm:after:-inset-y-1" : "max-sm:after:-inset-y-0.5",
                checked
                  ? "border-accent bg-accent-soft text-on-accent-soft"
                  : "border-[color:var(--chip-border,var(--color-border))] text-text-secondary",
                !checked &&
                  !optionDisabled &&
                  "hover:bg-[color:var(--chip-hover,var(--color-surface-2))] hover:text-text",
                FOCUS_RING,
              ],
              variant === "list" && [
                "flex min-h-12 w-full items-center gap-3 px-4 pt-3 text-left",
                // With a status the option's bottom padding moves under the
                // status, so the line sits tight under the description.
                showStatus ? "pb-0" : "pb-3",
                !optionDisabled &&
                  "hover:bg-[color:var(--radio-row-hover,var(--color-surface-2))]",
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
                    "flex h-[var(--radio-size,1rem)] w-[var(--radio-size,1rem)] shrink-0 items-center justify-center rounded-full border-[length:var(--radio-ring-w,1px)] transition-colors duration-[var(--duration-fast)]",
                    checked
                      ? "border-accent redesign:bg-accent"
                      : "border-[color:var(--radio-off-ring,var(--color-border-strong))] bg-[color:var(--radio-off-bg,transparent)]",
                  )}
                >
                  {checked ? (
                    <span className="h-[var(--radio-dot-size,0.5rem)] w-[var(--radio-dot-size,0.5rem)] rounded-full bg-[color:var(--radio-dot,var(--color-accent))]" />
                  ) : null}
                </span>
              </>
            ) : option.trailing ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span className={content ? undefined : "truncate"}>
                  {option.label}
                </span>
                <span className="redesign:text-[color:color-mix(in_oklab,currentColor_70%,transparent)] redesign:tabular-nums">
                  {option.trailing}
                </span>
              </span>
            ) : (
              <span className={content ? undefined : "truncate"}>
                {option.label}
              </span>
            )}
          </button>
        );
        if (variant !== "list") {
          return radio;
        }
        // Every list option has the same wrapper whether or not a status is
        // showing, so the button is never remounted (and never drops focus)
        // when "Salvando…" appears under it.
        return (
          <div key={String(option.value)}>
            {radio}
            {showStatus ? <div className="px-4 pb-3">{status}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
