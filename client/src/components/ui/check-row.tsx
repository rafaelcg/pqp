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
  swatch,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  swatch?: string | null;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex w-full items-center justify-between gap-4 rounded-md px-2 py-2 text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
        disabled ? "cursor-not-allowed" : "hover:bg-ink-3",
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
        <span className="truncate text-sm text-paper">{label}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] transition-colors duration-150",
          checked ? "bg-signal" : "bg-ink-3 ring-1 ring-inset ring-ink-4",
          disabled && "opacity-50",
        )}
      >
        {checked ? <Check className="h-3 w-3 text-ink" strokeWidth={3} /> : null}
      </span>
    </button>
  );
}
