import * as React from "react";
import { FIELD_BOX, FIELD_TEXT } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A multi-line text field: the `Input` recipe (`FIELD_BOX`, so the redesign
 * reaches both), with a minimum height and a
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
        "flex min-h-28 w-full resize-y px-[var(--input-px,0.75rem)] py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-[var(--input-disabled-opacity,0.5)]",
        FIELD_BOX,
        FIELD_TEXT,
        className,
      )}
      {...props}
    />
  );
});
