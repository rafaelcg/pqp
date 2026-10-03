import { forwardRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A native `<select>`, kept native on purpose: there is no Select primitive
 * yet (DESIGN.md, Planned), a native list is what a phone shows best, and
 * `viewer-video-quality.spec.ts` finds this control by its `<option>` values.
 * It draws OS chrome, which `color-scheme` tints to the theme.
 */
export const SettingsSelect = forwardRef<
  HTMLSelectElement,
  ComponentProps<"select">
>(function SettingsSelect({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-[var(--control-lg)] w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 text-sm text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
