import { cn } from "@/lib/utils";

/**
 * Independent on/off control. Chips are for one-of-many; this is for a list of
 * independent bits. Tokens match Button/Input: ink track, signal when on,
 * ring-signal on focus. The whole row is the hit target so a 20-item list does
 * not demand a 16px native tick.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  description,
  title,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
  title?: string;
  className?: string;
}) {
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex w-full justify-between gap-4 rounded-md px-2 py-2 text-left",
        description ? "items-start" : "items-center",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
        disabled ? "cursor-not-allowed" : "hover:bg-ink-3",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm text-paper">{label}</span>
        {title && !description ? (
          <span className="sr-only">{title}</span>
        ) : null}
        {description ? (
          <span className="mt-0.5 block text-xs text-paper-muted">
            {description}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150",
          description && "mt-0.5",
          checked ? "bg-signal" : "bg-ink-3 ring-1 ring-inset ring-ink-4",
          disabled && "opacity-50",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full transition-transform duration-150",
            checked ? "translate-x-4 bg-ink" : "bg-paper-muted",
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
