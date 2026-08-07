import { useId } from "react";
import type { UserStatus } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The status pip: online / idle / do-not-disturb / offline.
 *
 * COLOUR IS NOT THE ONLY CHANNEL. Each state also has its own *shape* — filled,
 * crescent, barred, hollow — cut out of the pip with an SVG mask. Four small
 * coloured circles are four identical circles to a red-green colour-blind reader
 * (roughly one man in twelve), and this pip is the entire content of the
 * feature: there is no label next to it in a member row. The holes are real
 * transparency rather than a second circle in the background colour, so the
 * shape survives being drawn over an avatar, a hover state or either theme.
 *
 * Roles from the app's existing palette, not new colours: `success` for here,
 * `warning` for away, `danger` for do-not-disturb, `text-muted` for gone. Those
 * are the same four the timeout badge, the error text and the muted mic already
 * use, so status inherits the theme's light mode for free.
 */

const TONE: Record<UserStatus, string> = {
  online: "text-success",
  idle: "text-warning",
  dnd: "text-danger",
  offline: "text-text-muted",
};

export interface StatusDotProps {
  status: UserStatus;
  /** `sm` for a list row, `md` for the account's own footer. */
  size?: "sm" | "md";
  /**
   * A ring in the surrounding surface, so the pip stays legible when it overlaps
   * an avatar. Off for a pip that sits on its own in a row.
   */
  ringClassName?: string;
  className?: string;
  /**
   * Label override — the account's own pip says "Invisible" where everyone
   * else's says "Offline", and those are genuinely different facts.
   */
  label?: string;
}

export function StatusDot({
  status,
  size = "sm",
  ringClassName,
  className,
  label,
}: StatusDotProps) {
  const { t } = useTranslation();
  // Masks are referenced by id from the document, so two pips on one screen must
  // not share one — the second would silently adopt the first one's shape.
  const maskId = useId();
  const text =
    label ??
    t(
      status === "online"
        ? "status.online"
        : status === "idle"
          ? "status.idle"
          : status === "dnd"
            ? "status.dnd"
            : "status.offline",
    );

  return (
    <svg
      viewBox="0 0 12 12"
      role="img"
      aria-label={text}
      className={cn(
        "shrink-0",
        size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3",
        TONE[status],
        ringClassName,
        className,
      )}
    >
      <mask id={maskId}>
        {/* White keeps, black cuts. */}
        <rect x="0" y="0" width="12" height="12" fill="black" />
        <circle cx="6" cy="6" r="6" fill="white" />
        {status === "idle" && (
          // A crescent: the moon, which is what "away" means everywhere else.
          <circle cx="2.5" cy="2.5" r="5" fill="black" />
        )}
        {status === "dnd" && <rect x="2" y="5" width="8" height="2" fill="black" />}
        {status === "offline" && <circle cx="6" cy="6" r="3" fill="black" />}
      </mask>
      <rect
        x="0"
        y="0"
        width="12"
        height="12"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
