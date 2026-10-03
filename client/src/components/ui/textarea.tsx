import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A multi-line text field: the `Input` recipe, with a minimum height and a
 * vertical resize handle in place of the fixed control height. Like `Input`, it
 * renders no label; point one at it.
 */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-28 w-full resize-y rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-tertiary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
