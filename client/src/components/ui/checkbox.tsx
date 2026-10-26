import { Check } from "@phosphor-icons/react";
import { forwardRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A native checkbox, for a form: a `<label>` around it toggles it, a form
 * submits it, and a screen reader knows it without help.
 *
 * Use it inside a form or beside a sentence ("Allow comments"). A row in a
 * list of independent bits is `CheckRow`; a setting is `Switch`.
 *
 * With the toggle off it is the operating system's own box, tinted by
 * `accent-color`, exactly as before. Under the redesign `appearance: none`
 * drops it and the box is drawn from the tick tokens `CheckRow` uses, with a
 * Phosphor check over it; the check ignores the pointer, so a click still
 * lands on the input.
 */
export interface CheckboxProps extends Omit<ComponentProps<"input">, "type"> {
  /** Classes for the wrapper: margins and alignment go here. */
  wrapperClassName?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, wrapperClassName, ...props },
  ref,
) {
  return (
    <span className={cn("relative inline-grid shrink-0 place-items-center", wrapperClassName)}>
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          "peer h-4 w-4 accent-[var(--color-accent)]",
          "[appearance:var(--checkbox-appearance,auto)] rounded-[var(--radius-tick)]",
          "border-[length:var(--tick-ring-w,0px)] border-[color:var(--tick-off-ring,transparent)] bg-[color:var(--tick-off-bg,transparent)]",
          "redesign:size-[var(--tick-size)] redesign:transition-colors redesign:duration-[var(--duration-fast)]",
          "redesign:checked:border-accent redesign:checked:bg-accent",
          "redesign:enabled:hover:not-checked:border-[color:var(--tick-hover-ring)]",
          "redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-focus-ring redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-ring-offset",
          "disabled:cursor-not-allowed redesign:disabled:opacity-[var(--tick-disabled-opacity,0.5)]",
          className,
        )}
        {...props}
      />
      <Check
        aria-hidden
        weight="bold"
        className="pointer-events-none absolute hidden size-[var(--tick-glyph)] text-on-accent redesign:peer-checked:block"
      />
    </span>
  );
});
