import * as React from "react";
import { cn } from "@/lib/utils";

const FIELD =
  "flex h-[var(--control-lg)] w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-tertiary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50";

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
          "flex h-[var(--control-lg)] w-full items-center rounded-[var(--radius-control)] border border-border bg-surface-0 text-sm text-text",
          "focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-ring-offset focus-within:ring-focus-ring",
          "has-[input[aria-invalid=true]]:border-danger has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-50",
          className,
        )}
      >
        <span aria-hidden className="shrink-0 pl-3 text-text-tertiary select-none">
          {prefix}
        </span>
        <input
          ref={ref}
          type={type}
          className="h-full min-w-0 flex-1 bg-transparent py-2 pr-3 pl-0.5 text-text placeholder:text-text-tertiary/70 focus-visible:outline-none disabled:cursor-not-allowed"
          {...props}
        />
      </div>
    );
  },
);
