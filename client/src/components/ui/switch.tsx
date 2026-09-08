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
}) {
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex w-full justify-between gap-4 rounded-[var(--radius-control)] px-2 py-2 text-left",
        description ? "items-start" : "items-center",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
        disabled ? "cursor-not-allowed" : "hover:bg-surface-2",
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
          disabled && "opacity-50",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full transition-transform duration-[var(--duration-fast)]",
            checked ? "translate-x-4 bg-on-accent" : "bg-text-tertiary",
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
