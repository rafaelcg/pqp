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
 * its own fill (the brightest surface in light, so it reads lifted, not
 * sunk), a faint edge and a lift with a top highlight, set through the
 * elevation variables, so a caller that sets its own fill keeps it.
 */
export const POPOVER_SURFACE =
  "elevation-3 rounded-[var(--popover-radius,var(--radius-card))] redesign:[--elevation-3-surface:var(--popover-surface)] redesign:[--elevation-3-border:var(--popover-border)] redesign:[--elevation-3-shadow:var(--popover-shadow)]";

/**
 * For a caller that draws its own edge (`border border-border`): under the
 * redesign that edge becomes the popover's, so it never depends on whether
 * the caller's class or the elevation's shorthand is emitted last.
 */
export const POPOVER_OWN_EDGE = "redesign:border-[color:var(--popover-border)]";

/** The panel as an element, for a new popover. Placement is the caller's. */
export const PopoverPanel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function PopoverPanel({ className, ...props }, ref) {
    return <div ref={ref} className={cn(POPOVER_SURFACE, className)} {...props} />;
  },
);
