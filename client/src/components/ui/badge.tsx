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
 * One size (18px tall, 10px uppercase bold), because a badge that grows with
 * its surroundings stops reading as the same signal from one surface to the
 * next. Every variant is a token pair the bench already measures:
 *
 * | Variant   | Fill            | Use                                      |
 * |-----------|-----------------|------------------------------------------|
 * | `new`     | `accent`        | Something the viewer has not seen yet    |
 * | `accent`  | `accent-soft`   | A marker that is not a warning (Fixado)  |
 * | `success` | `success-soft`  | Done, answered (Resolvido)               |
 * | `warning` | `warning-soft`  | Needs attention, not an error            |
 * | `danger`  | `danger-soft`   | Refused, removed                         |
 * | `neutral` | `surface-3`     | A plain state (Fechado, OP)              |
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
  | "neutral";

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  new: "bg-accent text-on-accent",
  accent: "bg-accent-soft text-on-accent-soft",
  success: "bg-success-soft text-on-success-soft",
  warning: "bg-warning-soft text-on-warning-soft",
  danger: "bg-danger-soft text-on-danger-soft",
  neutral: "bg-surface-3 text-text-secondary",
};

export function Badge({
  variant = "neutral",
  icon: Icon,
  className,
  children,
  ...rest
}: {
  variant?: BadgeVariant;
  /** Drawn before the word, decorative. */
  icon?: LucideIcon;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children" | "className">) {
  return (
    <span
      data-badge={variant}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-tick)] px-1.5 text-[10px] font-bold uppercase leading-none tracking-[0.06em]",
        VARIANT_CLASS[variant],
        className,
      )}
      {...rest}
    >
      {Icon ? <Icon aria-hidden="true" className="h-3 w-3 shrink-0" /> : null}
      {children}
    </span>
  );
}
