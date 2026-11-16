import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A short status word on a card or beside a name: "Novo", "Resolvido",
 * "Fixado", "Fechado", "OP", "Feed", a "Staff" marker on a tag row.
 *
 * Not a count. The sidebar's mention number and the unread pip are their own
 * shapes on purpose: a number in a pill means "this many are waiting", a word
 * in a badge means "this thing is in this state". And not `BetaTag`, which is
 * one word about the product rather than about a thing in it.
 *
 * Two sizes: `md` on a card or row (18px, 10px uppercase bold with the
 * toggle off; 20px, 11px semibold, sentence case under the redesign) and
 * `tag` beside a name (the line's height off; 18px under the redesign). A
 * badge that grew with its surroundings would stop reading as the same
 * signal from one surface to the next. Every variant is a token pair the bench already measures:
 *
 * | Variant   | Fill            | Use                                      |
 * |-----------|-----------------|------------------------------------------|
 * | `new`     | `accent`        | Something the viewer has not seen yet    |
 * | `accent`  | `accent-soft`   | A marker that is not a warning (Fixado)  |
 * | `success` | `success-soft`  | Done, answered (Resolvido)               |
 * | `warning` | `warning-soft`  | Needs attention, not an error            |
 * | `danger`  | `danger-soft`   | Refused, removed                         |
 * | `neutral` | `surface-3`     | A plain state (Fechado, OP)              |
 * | `muted`   | `surface-3`     | Gone, removed: quieter text              |
 *
 * The word is the meaning, never the colour alone (DESIGN.md, Principles):
 * every badge carries text, and the optional icon is decorative.
 */
export type BadgeVariant =
  | "new"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "muted";

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  new: "bg-accent text-on-accent",
  accent: "bg-accent-soft text-on-accent-soft",
  success: "bg-success-soft text-on-success-soft",
  warning: "bg-warning-soft text-on-warning-soft",
  danger: "bg-danger-soft text-on-danger-soft",
  neutral: "bg-surface-3 text-text-secondary",
  muted: "bg-surface-3 text-text-tertiary",
};

/*
 * The same pairs again as `redesign:` classes, so a call site that painted
 * its tag its own way with the toggle off (a webhook's old grey) still draws
 * the variant under the redesign. Written out because Tailwind only
 * generates classes it can read in the source. `neutral` and `muted` are a
 * step stronger than with the toggle off, so an 11px word clears 4.5:1 in
 * every look (measured by the bench).
 */
const VARIANT_REDESIGN: Record<BadgeVariant, string> = {
  new: "redesign:bg-accent redesign:text-on-accent",
  accent: "redesign:bg-accent-soft redesign:text-on-accent-soft",
  success: "redesign:bg-success-soft redesign:text-on-success-soft",
  warning: "redesign:bg-warning-soft redesign:text-on-warning-soft",
  danger: "redesign:bg-danger-soft redesign:text-on-danger-soft",
  neutral: "redesign:bg-surface-3 redesign:text-text",
  muted: "redesign:bg-surface-2 redesign:text-text-secondary",
};

/**
 * `md` is the badge on a card or a row. `tag` is the smaller one beside a
 * name in a message header ("OP", "BOT", "AutoMod"): with the toggle off it
 * keeps the geometry those tags always had, so it carries no height of its
 * own and takes the line's.
 */
export type BadgeSize = "md" | "tag";

const SIZE_CLASS: Record<BadgeSize, string> = {
  md: "h-[18px] px-1.5 font-bold leading-none tracking-[0.06em]",
  tag: "px-1 py-px font-semibold tracking-wide",
};

/*
 * Under the redesign a badge is a small pill in sentence case: 11px
 * semibold, no letter spacing, the word as written ("Novo", not "NOVO").
 * These come last so a call site's toggle-off geometry cannot leak into
 * the new look.
 */
const SIZE_REDESIGN: Record<BadgeSize, string> = {
  md: "redesign:h-[var(--badge-h)] redesign:px-[var(--badge-px)]",
  tag: "redesign:h-[var(--badge-tag-h)] redesign:px-[var(--badge-tag-px)] redesign:py-0 redesign:self-center",
};

export const BADGE_REDESIGN =
  "redesign:rounded-[var(--badge-radius)] redesign:text-[length:var(--badge-text)] redesign:font-semibold redesign:normal-case redesign:leading-none redesign:tracking-normal";

/**
 * The badge's look under the redesign alone, for a tag that must keep its own
 * toggle-off markup (a choice card's "Original"). One recipe, two hosts.
 */
export function badgeRedesignClasses(
  variant: BadgeVariant = "neutral",
  size: BadgeSize = "md",
): string {
  return cn(BADGE_REDESIGN, SIZE_REDESIGN[size], VARIANT_REDESIGN[variant], "redesign:inline-flex redesign:items-center");
}

/**
 * A group conversation's size beside its name (the DM lists): the tag on the
 * tick radius, so it never reads as a second, grey unread count.
 */
export const GROUP_SIZE_REDESIGN = cn(
  badgeRedesignClasses("neutral", "tag"),
  "redesign:rounded-[var(--radius-tick)] redesign:tabular-nums",
);

export function Badge({
  variant = "neutral",
  size = "md",
  icon: Icon,
  className,
  children,
  ...rest
}: {
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Drawn before the word, decorative. */
  icon?: LucideIcon;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children" | "className">) {
  return (
    <span
      data-badge={variant}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-tick)] text-[10px] uppercase",
        SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        className,
        BADGE_REDESIGN,
        SIZE_REDESIGN[size],
        VARIANT_REDESIGN[variant],
      )}
      {...rest}
    >
      {Icon ? <Icon aria-hidden="true" className="h-3 w-3 shrink-0" /> : null}
      {children}
    </span>
  );
}
