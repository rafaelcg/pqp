import type { HTMLAttributes } from "react";
import { formatBadgeCount } from "@/lib/badge-count";
import { cn } from "@/lib/utils";

/**
 * A number in a pill: this many are waiting (unread messages, mentions,
 * conversations). Not a state; that is `Badge`.
 *
 * With the toggle off it draws the 18px danger pill the conversation list,
 * the quick switcher and the phone tabs each drew by hand (16px for `sm`).
 * Under the redesign it is a touch larger in type, semibold, with tabular
 * figures, so a two-digit count does not crowd its pill.
 *
 * Re-keyed on the count by default, so `pop` plays for each new number.
 * Positioning (a corner of an avatar or a tab) and a ring against the
 * surface behind it are the caller's, through `className`.
 */
export type CountBadgeTone = "danger" | "accent";
export type CountBadgeSize = "md" | "sm";

const TONE: Record<CountBadgeTone, string> = {
  danger: "bg-danger text-on-danger",
  accent: "bg-accent text-on-accent",
};

const SIZE: Record<CountBadgeSize, string> = {
  md: "h-[18px] min-w-[18px] redesign:h-[var(--count-badge-h)] redesign:min-w-[var(--count-badge-h)] redesign:text-[length:var(--count-badge-text)]",
  // 16px stays 16px; under the redesign its type is a step smaller than
  // `md`'s, so "99+" still fits.
  sm: "h-4 min-w-4 redesign:text-[length:var(--count-badge-sm-text)]",
};

export interface CountBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  count: number;
  tone?: CountBadgeTone;
  size?: CountBadgeSize;
  /** The pop on arrival (`animate-badge-pop`). */
  pop?: boolean;
}

export function CountBadge({
  count,
  tone = "danger",
  size = "md",
  pop = false,
  className,
  ...rest
}: CountBadgeProps) {
  if (count <= 0) {
    return null;
  }
  return (
    <span
      key={count}
      className={cn(
        "inline-flex items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none tabular-nums",
        SIZE[size],
        TONE[tone],
        pop && "animate-badge-pop",
        className,
        "redesign:font-semibold",
      )}
      {...rest}
    >
      {formatBadgeCount(count)}
    </span>
  );
}
