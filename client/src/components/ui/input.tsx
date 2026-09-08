import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<"input">
>(function Input({ className, type, ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-[var(--control-lg)] w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-tertiary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
