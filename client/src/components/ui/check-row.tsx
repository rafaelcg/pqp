import { Check as CheckBold } from "@phosphor-icons/react";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type TickSize = "sm" | "md";

const TICK_BOX: Record<TickSize, string> = {
  // A row's tick: 16px off, 18px under the redesign.
  sm: "h-[var(--tick-size,1rem)] w-[var(--tick-size,1rem)]",
  // A tick that is its own 36px target (a person in a picker): 20px.
  md: "h-[var(--tick-size-md,1.25rem)] w-[var(--tick-size-md,1.25rem)]",
};

const TICK_OFF_RING: Record<TickSize, string> = {
  sm: "ring-[color:var(--tick-off-ring,var(--color-border))]",
  md: "ring-[color:var(--tick-off-ring,var(--color-border-strong))]",
};

/**
 * The square tick alone, for a checkbox whose row is laid out by its call
 * site. `CheckRow` draws one, and the native `Checkbox` draws the same box
 * from the same `--tick-*` tokens under the redesign.
 *
 * With the toggle off it is today's tick: a surface square with a hairline,
 * the accent with a Lucide check when on. Under the redesign the off box is a
 * faint tint inside the field's 3:1 edge and the check is Phosphor bold.
 */
export function TickBox({
  checked,
  disabled = false,
  size = "sm",
  className,
}: {
  checked: boolean;
  disabled?: boolean;
  size?: TickSize;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[var(--radius-tick)] transition-colors duration-[var(--duration-fast)]",
        TICK_BOX[size],
        checked
          ? "bg-accent"
          : cn(
              "bg-[color:var(--tick-off-bg,var(--color-surface-2))] ring-[length:var(--tick-ring-w,1px)] ring-inset",
              TICK_OFF_RING[size],
            ),
        disabled && !checked && "opacity-[var(--tick-disabled-opacity,0.5)]",
        // Off, a disabled tick stays full when checked; under the redesign it
        // fades with its label, as the native Checkbox does.
        disabled && checked && "redesign:opacity-[var(--tick-disabled-opacity,0.5)]",
        className,
      )}
    >
      {checked ? (
        <>
          <Check
            className={cn("text-on-accent redesign:hidden", size === "md" ? "h-3.5 w-3.5" : "h-3 w-3")}
            strokeWidth={3}
          />
          <CheckBold
            weight="bold"
            className={cn(
              "hidden text-on-accent redesign:block",
              size === "md" ? "size-[var(--tick-glyph-md)]" : "size-[var(--tick-glyph)]",
            )}
          />
        </>
      ) : null}
    </span>
  );
}

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
  description,
  title,
  swatch,
  icon,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  /** A quieter second line under the label: a count, or why the row is off. */
  description?: string;
  title?: string;
  swatch?: string | null;
  /**
   * A fixed-width slot before the label (an emoji, a glyph). Pass it on every
   * row of a list, `null` where a row has none, so the labels line up: a tag
   * without an emoji used to start where the others' emoji did.
   */
  icon?: ReactNode;
  className?: string;
}) {
  // A row that cannot be changed says so in its label too (redesign only).
  const labelText = "break-words text-sm text-text redesign:group-disabled:text-text-tertiary";
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
        // Under the redesign the tick sits on the label's first line, as a
        // Switch's track does, instead of centring on label and description.
        "group flex w-full [align-items:var(--check-row-align,center)] justify-between gap-4 rounded-[var(--choice-row-radius,var(--radius-control))] px-2 py-2 text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
        disabled
          ? "cursor-not-allowed"
          : "hover:bg-[color:var(--choice-row-hover,var(--color-surface-2))]",
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
        {icon !== undefined ? (
          <span
            aria-hidden
            className="grid w-5 shrink-0 place-items-center text-sm text-text-tertiary"
          >
            {icon}
          </span>
        ) : null}
        {description ? (
          <span className="min-w-0">
            <span className={cn("block", labelText)}>{label}</span>
            <span className="block break-words text-xs text-text-tertiary">
              {description}
            </span>
          </span>
        ) : (
          <span className={labelText}>{label}</span>
        )}
      </span>
      <TickBox
        checked={checked}
        disabled={disabled}
        className={cn(
          "mt-[var(--tick-line-offset,0px)]",
          !disabled && !checked && "redesign:group-hover:ring-[color:var(--tick-hover-ring)]",
        )}
      />
    </button>
  );
}
