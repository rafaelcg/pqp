import type { ReactNode } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { Breu, type BreuMood } from "@/components/breu/breu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * An empty state: what is not here yet, and what to do about it. `page`
 * fills a pane (an empty channel, a forum with no posts, no search
 * results); `inline` sits inside a group or a list (no bots yet, nothing
 * saved).
 *
 * With the toggle off each caller passes the classes it always drew
 * (`className`, `titleClassName`, `bodyClassName`, and its own icon) and
 * keeps its look. Under the redesign the classes below come last and win:
 * a page empty state leads with its icon on a soft disc, a Gabarito title
 * and a body line in secondary text; an inline one is a quiet icon, a
 * label and a smaller line. A failure (`role="alert"`) draws its disc in the
 * warning tone, with the retry as its action.
 *
 * `mascot` draws Breu in place of the icon, in both looks: for the empty
 * states a person meets early and rarely (a new channel, no DMs yet, a forum
 * with no posts, a search that found nothing). Not for compact lists, where
 * Breu would take over the row.
 */
export type EmptyStateSize = "page" | "inline";

const ROOT: Record<EmptyStateSize, string> = {
  page: "redesign:gap-0 redesign:px-6 redesign:py-16",
  inline: "redesign:gap-0 redesign:px-4 redesign:py-6",
};

const ICON: Record<EmptyStateSize, string> = {
  page: "redesign:mb-4 redesign:flex redesign:h-[var(--empty-icon-disc)] redesign:w-[var(--empty-icon-disc)] redesign:items-center redesign:justify-center redesign:rounded-full redesign:bg-[color:var(--empty-icon-bg)] redesign:text-text-secondary",
  inline: "redesign:mb-2 redesign:text-text-tertiary",
};

const TITLE: Record<EmptyStateSize, string> = {
  page: "redesign:font-[family-name:var(--type-title-font)] redesign:text-[length:var(--empty-title-size)] redesign:leading-tight redesign:font-bold redesign:text-text redesign:text-balance",
  inline: "redesign:font-sans redesign:text-sm redesign:font-medium redesign:text-text-secondary",
};

const BODY: Record<EmptyStateSize, string> = {
  page: "redesign:mt-1.5 redesign:max-w-sm redesign:text-sm redesign:text-pretty redesign:text-text-secondary",
  inline: "redesign:mt-1 redesign:text-xs redesign:text-pretty redesign:text-text-tertiary",
};

export function EmptyState({
  size = "page",
  icon,
  mascot,
  title,
  body,
  actions,
  role,
  className,
  iconClassName,
  titleClassName,
  bodyClassName,
  actionsClassName,
  ...data
}: {
  size?: EmptyStateSize;
  /** A glyph, drawn on a soft disc under the redesign. */
  icon?: ReactNode;
  /** Breu in place of the icon, with this face. */
  mascot?: BreuMood;
  title: ReactNode;
  body?: ReactNode;
  /** One or two buttons. */
  actions?: ReactNode;
  role?: "alert" | "status";
  /** The toggle-off look, per caller. */
  className?: string;
  iconClassName?: string;
  titleClassName?: string;
  bodyClassName?: string;
  actionsClassName?: string;
} & { [key: `data-${string}`]: string | undefined }) {
  // A page failure always leads with its warning disc under the redesign;
  // a caller that drew no glyph gets one there, and none with the toggle off.
  const glyph =
    icon ??
    (role === "alert" && size === "page" ? <Icon icon={WarningCircle} size="lg" /> : undefined);
  return (
    <div
      role={role}
      data-empty-state={size}
      {...data}
      className={cn("flex flex-col items-center text-center", className, ROOT[size])}
    >
      {mascot ? (
        <div aria-hidden="true" data-empty-mascot={mascot} className="mb-3 flex justify-center">
          <Breu mood={mascot} size={size === "page" ? "md" : "sm"} />
        </div>
      ) : glyph ? (
        <div
          aria-hidden="true"
          className={cn(
            iconClassName,
            !icon && "hidden redesign:flex",
            ICON[size],
            // A failure to load is not an empty list: its disc takes the
            // warning tone, so the two read apart at a glance.
            role === "alert" && size === "page" && "redesign:bg-warning-soft redesign:text-on-warning-soft",
          )}
        >
          {glyph}
        </div>
      ) : null}
      <p className={cn(titleClassName, TITLE[size])}>{title}</p>
      {body ? <p className={cn(bodyClassName, BODY[size])}>{body}</p> : null}
      {actions ? (
        <div
          className={cn(
            "flex flex-wrap items-center justify-center gap-2",
            actionsClassName,
            "redesign:mt-5",
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
