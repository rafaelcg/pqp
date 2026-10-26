import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * THE REDESIGN (docs/DESIGN.md, "Input") changes a field through
 * `--input-*` tokens, unset with the toggle off, where each falls back in
 * the class to what the field always drew; a caller's `border-danger` or
 * `bg-transparent` still wins through `cn`. The two states only the field
 * can know, hover and invalid, are `redesign:` classes, as on Button.
 */
/** The box: border, fill, radius, ring, hover and invalid. */
export const FIELD_BOX =
  "rounded-[var(--input-radius,var(--radius-control))] border border-[color:var(--input-border,var(--color-border))] bg-[color:var(--input-bg,var(--color-surface-0))] text-sm text-text transition-colors duration-[var(--duration-fast)] redesign:enabled:hover:not-aria-invalid:border-[color:var(--input-hover-border)] redesign:aria-invalid:border-danger redesign:aria-invalid:not-disabled:bg-[color:var(--input-invalid-bg)] redesign:disabled:bg-transparent redesign:disabled:text-text-tertiary redesign:disabled:placeholder:text-[color:color-mix(in_oklab,var(--color-text-tertiary)_70%,transparent)]";

/** What the text inside a field draws: the placeholder above all. */
export const FIELD_TEXT =
  "placeholder:text-[color:var(--input-placeholder,color-mix(in_oklab,var(--color-text-tertiary)_70%,transparent))]";

const FIELD_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring";

/*
 * Height: 40px with the toggle off; under the redesign the field matches the
 * default button (`--input-h`), so a field and its Save line up. Disabled,
 * under the redesign, keeps its edge, drops its fill and dims its value,
 * placeholder and prefix, so an empty disabled field is not a resting one.
 */
const FIELD = cn(
  "flex h-[var(--input-h,var(--control-lg))] w-full px-[var(--input-px,0.75rem)] py-2 disabled:cursor-not-allowed disabled:opacity-[var(--input-disabled-opacity,0.5)]",
  FIELD_BOX,
  FIELD_TEXT,
  FIELD_RING,
);

export interface InputProps extends Omit<React.ComponentProps<"input">, "prefix"> {
  /**
   * Fixed text drawn inside the field before the value, for example
   * `pqp.gg/@`. It is not part of the value and not selectable. With a prefix,
   * `className` goes on the field box (the border, the ring, the font), so a
   * caller's `border-danger` or `font-mono` reaches both halves.
   */
  prefix?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, type, prefix, ...props }, ref) {
    if (prefix === undefined || prefix === null || prefix === false) {
      return (
        <input ref={ref} type={type} className={cn(FIELD, className)} {...props} />
      );
    }
    // The box draws what the bare input draws, with the ring on
    // `focus-within` so focusing the value rings the whole field, prefix
    // included. `aria-invalid` on the input turns the box's border red.
    return (
      <div
        className={cn(
          "flex h-[var(--input-h,var(--control-lg))] w-full items-center",
          FIELD_BOX,
          "focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-ring-offset focus-within:ring-focus-ring",
          "redesign:has-[input:enabled]:hover:not-has-[input[aria-invalid=true]]:border-[color:var(--input-hover-border)]",
          "has-[input[aria-invalid=true]]:border-danger has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-[var(--input-disabled-opacity,0.5)]",
          "redesign:has-[input:disabled]:bg-transparent redesign:has-[input:disabled]:[&>span]:text-[color:color-mix(in_oklab,var(--color-text-tertiary)_70%,transparent)] redesign:has-[input[aria-invalid=true]]:not-has-[input:disabled]:bg-[color:var(--input-invalid-bg)]",
          className,
        )}
      >
        <span
          aria-hidden
          className="shrink-0 pl-[var(--input-px,0.75rem)] text-[color:var(--input-prefix,var(--color-text-tertiary))] select-none"
        >
          {prefix}
        </span>
        <input
          ref={ref}
          type={type}
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent py-2 pr-[var(--input-px,0.75rem)] pl-[var(--input-prefix-gap,0.125rem)] text-text focus-visible:outline-none disabled:cursor-not-allowed redesign:disabled:text-text-tertiary redesign:disabled:placeholder:text-[color:color-mix(in_oklab,var(--color-text-tertiary)_70%,transparent)]",
            FIELD_TEXT,
          )}
          {...props}
        />
      </div>
    );
  },
);
