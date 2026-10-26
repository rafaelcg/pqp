import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The track and knob alone, for a switch whose row is laid out by its call
 * site. `Switch` draws one; use this only where `Switch`'s row cannot fit.
 *
 * Every size and colour is a `--switch-*` token with today's value as its
 * fallback, so the toggle off draws exactly what it drew before. Under the
 * redesign the track is a 40 by 24 pill, off is a faint tint inside the
 * field's 3:1 edge (`--color-field-border`), and the knob is lifted.
 */
export function SwitchTrack({
  checked,
  disabled = false,
  className,
}: {
  checked: boolean;
  /** Fades the track. Leave it off when the whole row is already dimmed. */
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative h-[var(--switch-h,1.25rem)] w-[var(--switch-w,2.25rem)] shrink-0 rounded-full transition-colors duration-[var(--duration-fast)]",
        checked
          ? "bg-accent"
          : "bg-[color:var(--switch-off-bg,var(--color-surface-2))] ring-1 ring-inset ring-[color:var(--switch-off-ring,var(--color-border))]",
        disabled && "opacity-[var(--switch-disabled-opacity,0.5)]",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-[var(--switch-pad,0.125rem)] left-[var(--switch-pad,0.125rem)] h-[var(--switch-knob,1rem)] w-[var(--switch-knob,1rem)] rounded-full shadow-[var(--switch-knob-shadow,0_0_transparent)] transition-transform duration-[var(--duration-fast)]",
          // Off: a mid-grey knob in dark. In every light look that grey is a
          // dark dot on a pale track, so light draws a pale knob with an
          // outline instead, the way a native light switch does.
          checked
            ? "translate-x-[var(--switch-travel,1rem)] bg-on-accent"
            : "bg-[color:var(--switch-knob-off,var(--color-text-tertiary))] [:root[data-theme=light]_&]:bg-surface-0 [:root[data-theme=light]_&]:ring-1 [:root[data-theme=light]_&]:ring-border-strong",
        )}
      />
    </span>
  );
}

/**
 * Independent on/off control. Chips are for one-of-many; this is for a list of
 * independent bits. Tokens match Button/Input: a surface track, the accent
 * when on, the focus ring on focus. The whole row is the hit target so a
 * 20-item list does not demand a 16px native tick.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  labelAdornment,
  description,
  title,
  className,
  hideLabel = false,
  dimRowWhenDisabled = false,
  busy = false,
  unavailable = false,
  ...data
}: {
  /** `data-*` attributes land on the button, for tests and hooks. */
  [key: `data-${string}`]: string | undefined;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  /** Drawn after the label on its line, such as a "new" badge. */
  labelAdornment?: ReactNode;
  description?: string;
  title?: string;
  className?: string;
  /**
   * Keep the label for assistive tech but do not paint it: for a switch that
   * sits beside a row that already names the setting.
   */
  hideLabel?: boolean;
  /**
   * Disabled dims the whole row (label, description and track together)
   * instead of the track alone. For a settings row, where a full-contrast
   * label beside a dimmed track reads as a setting that still works.
   */
  dimRowWhenDisabled?: boolean;
  /**
   * A write is running: looks and reads as unavailable (`aria-disabled`,
   * `aria-busy`) and ignores clicks, but keeps focus, which `disabled` would
   * drop on the page.
   */
  busy?: boolean;
  /**
   * Cannot be changed right now for a reason said beside it (the browser
   * blocked the permission): reads and behaves like `busy` but is not
   * announced as busy, and keeps focus where `disabled` would drop it.
   */
  unavailable?: boolean;
}) {
  const inert = busy || unavailable;
  const dimRow = (Boolean(disabled) || inert) && dimRowWhenDisabled;
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={inert || undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      {...data}
      onClick={() => {
        if (!inert) onCheckedChange(!checked);
      }}
      className={cn(
        "group flex w-full justify-between gap-4 rounded-[var(--choice-row-radius,var(--radius-control))] px-2 py-2 text-left",
        description ? "items-start" : "items-center",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
        disabled || inert
          ? "cursor-not-allowed"
          : "hover:bg-[color:var(--choice-row-hover,var(--color-surface-2))]",
        dimRow && "opacity-60",
        className,
      )}
    >
      <span className={cn("min-w-0", hideLabel && "sr-only")}>
        <span
          className={cn(
            "block text-sm text-text",
            // A switch that cannot be changed says so in its label too, not
            // only in a faded track (redesign only: off, the label stays).
            !dimRow && "redesign:group-disabled:text-text-tertiary",
            labelAdornment != null && "flex items-center gap-2",
          )}
        >
          {label}
          {labelAdornment}
        </span>
        {title && !description ? (
          <span className="sr-only">{title}</span>
        ) : null}
        {description ? (
          <span className="mt-0.5 block text-xs text-text-tertiary">
            {description}
          </span>
        ) : null}
      </span>
      <SwitchTrack
        checked={checked}
        disabled={Boolean(disabled) && !dimRow}
        className={description ? "mt-0.5" : undefined}
      />
    </button>
  );

  // Disabled buttons do not fire hover, so the title has to live on a wrapper.
  if (!title) {
    return control;
  }
  return (
    <span className="block cursor-help" title={title}>
      {control}
    </span>
  );
}
