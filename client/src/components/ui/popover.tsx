import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The panel a popover floats in: a picker, a small card of settings, a
 * "what's new" note anchored to the control that opened it.
 *
 * Only the surface is shared. Each popover keeps its own placement, portal
 * and dismissal, because each measures a different anchor (a composer
 * button, a call dock, the rail); unifying that is a behaviour change with
 * its own tests, not a look.
 *
 * With the toggle off this is the level-3 elevation every popover already
 * drew, with `--radius-card`. Under the redesign it takes the pane radius,
 * a faint edge and a lift with a top highlight, set through the elevation
 * variables, so a caller that overrides the fill or the edge keeps its own.
 */
export const POPOVER_SURFACE =
  "elevation-3 rounded-[var(--popover-radius,var(--radius-card))] redesign:[--elevation-3-border:var(--popover-border)] redesign:[--elevation-3-shadow:var(--popover-shadow)]";

/** The panel as an element, for a new popover. Placement is the caller's. */
export const PopoverPanel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function PopoverPanel({ className, ...props }, ref) {
    return <div ref={ref} className={cn(POPOVER_SURFACE, className)} {...props} />;
  },
);
