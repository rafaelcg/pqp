import { cn } from "@/lib/utils";

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
  description,
  title,
  className,
  hideLabel = false,
  dimRowWhenDisabled = false,
  busy = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
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
}) {
  const dimRow = (Boolean(disabled) || busy) && dimRowWhenDisabled;
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => {
        if (!busy) onCheckedChange(!checked);
      }}
      className={cn(
        "flex w-full justify-between gap-4 rounded-[var(--radius-control)] px-2 py-2 text-left",
        description ? "items-start" : "items-center",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
        disabled || busy ? "cursor-not-allowed" : "hover:bg-surface-2",
        dimRow && "opacity-60",
        className,
      )}
    >
      <span className={cn("min-w-0", hideLabel && "sr-only")}>
        <span className="block text-sm text-text">{label}</span>
        {title && !description ? (
          <span className="sr-only">{title}</span>
        ) : null}
        {description ? (
          <span className="mt-0.5 block text-xs text-text-tertiary">
            {description}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-[var(--duration-fast)]",
          description && "mt-0.5",
          checked ? "bg-accent" : "bg-surface-2 ring-1 ring-inset ring-border",
          disabled && !dimRow && "opacity-50",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full transition-transform duration-[var(--duration-fast)]",
            // Off: a mid-grey knob in dark. In every light look that grey is a
            // dark dot on a pale track, so light draws a pale knob with an
            // outline instead, the way a native light switch does.
            checked
              ? "translate-x-4 bg-on-accent"
              : "bg-text-tertiary [:root[data-theme=light]_&]:bg-surface-0 [:root[data-theme=light]_&]:ring-1 [:root[data-theme=light]_&]:ring-border-strong",
          )}
        />
      </span>
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
