import { CaretDown } from "@phosphor-icons/react";
import { forwardRef, type ComponentProps } from "react";
import { FIELD_BOX } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A choice from a short list: a native `<select>` dressed as a text field.
 *
 * WHY NATIVE. A phone shows its own picker for a native list, which beats any
 * popover we could draw, and screen readers know it. Several e2e specs also
 * find these controls by their `<option>` values (`viewer-video-quality`).
 *
 * WHY A PRIMITIVE. The app drew about twenty of these by hand, in four
 * recipes (`SettingsSelect`, an `ink` palette copy in five settings sections,
 * and a `--control-md` one in AutoMod, Baú and the share dialog). They now
 * share `FIELD_BOX` with `Input`, so the redesign reaches all of them.
 *
 * | Size | Height | Where                                   |
 * |------|--------|-----------------------------------------|
 * | `md` | 40px   | beside an `Input`, which it matches (default) |
 * | `sm` | 36px   | a toolbar; 32px under the redesign, as `Button size="sm"` |
 *
 * Disabled follows the field: the same token opacity (1 under the redesign),
 * no fill, a dimmed value and a dimmed caret.
 *
 * THE ARROW. With the toggle off it is the operating system's own, exactly
 * as before. Under the redesign `appearance: none` drops it and a Phosphor
 * caret is drawn in its place, the only way to make it match the app; the
 * caret ignores the pointer, so the whole box still opens the list.
 */
export type SelectSize = "md" | "sm";

const HEIGHT: Record<SelectSize, string> = {
  // The field's height: 40px off, the default button's 36px under the redesign.
  md: "h-[var(--input-h,var(--control-lg))]",
  // One step under `md` in both looks: 36px off, 32px under the redesign.
  sm: "h-[var(--select-h-sm,var(--control-md))]",
};

export interface SelectProps extends Omit<ComponentProps<"select">, "size"> {
  size?: SelectSize;
  /** Classes for the wrapper: width and margins go here, not on the field. */
  wrapperClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, wrapperClassName, size = "md", ...props },
  ref,
) {
  return (
    <span className={cn("relative block w-full", wrapperClassName)}>
      <select
        ref={ref}
        className={cn(
          "peer w-full px-[var(--input-px,0.75rem)] [appearance:var(--select-appearance,auto)] pr-[var(--select-pr,0.75rem)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
          "disabled:cursor-not-allowed disabled:opacity-[var(--input-disabled-opacity,0.5)]",
          FIELD_BOX,
          HEIGHT[size],
          className,
        )}
        {...props}
      />
      <CaretDown
        aria-hidden
        weight="bold"
        className={cn(
          "pointer-events-none absolute top-1/2 right-[var(--input-px,0.75rem)] hidden size-[var(--icon-sm)] -translate-y-1/2 text-text-tertiary redesign:block",
          // The caret follows the field: brighter on hover and focus, red
          // when invalid, as faded as the value when disabled.
          "redesign:peer-enabled:peer-hover:text-text-secondary redesign:peer-focus-visible:text-text-secondary redesign:peer-aria-invalid:text-danger redesign:peer-disabled:text-[color:color-mix(in_oklab,var(--color-text-tertiary)_70%,transparent)]",
        )}
      />
    </span>
  );
});
