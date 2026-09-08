import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Independent on/off row with a square tick. Switch is the control for
 * permission bits; cargos are a checklist, so they use this instead.
 * Tokens match Switch: the whole row is the hit target.
 */
export function CheckRow({
  checked,
  onCheckedChange,
  disabled,
  label,
  title,
  swatch,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  title?: string;
  swatch?: string | null;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={title ? `${label}. ${title}` : undefined}
      title={title}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex w-full items-center justify-between gap-4 rounded-[var(--radius-control)] px-2 py-2 text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
        disabled ? "cursor-not-allowed" : "hover:bg-surface-2",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {swatch !== undefined ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: swatch ?? "currentColor" }}
            aria-hidden
          />
        ) : null}
        <span className="break-words text-sm text-text">{label}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-tick)] transition-colors duration-[var(--duration-fast)]",
          checked ? "bg-accent" : "bg-surface-2 ring-1 ring-inset ring-border",
          disabled && !checked && "opacity-50",
        )}
      >
        {checked ? <Check className="h-3 w-3 text-on-accent" strokeWidth={3} /> : null}
      </span>
    </button>
  );
}
