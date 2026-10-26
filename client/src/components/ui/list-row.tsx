import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A row in a list: a channel, a person, a conversation, a thread, a follow.
 * A leading mark (an icon or an avatar), a label, an optional second line
 * and something trailing (a count, a time, an action).
 *
 * States, never told apart by colour alone (DESIGN.md, the row roles):
 *
 * - hover is a fill (`row-hover` under the redesign);
 * - `selected` is the accent's soft fill with its own label colour;
 * - `unread` is the body text at weight 600 plus the indicator pip at the
 *   end of the row;
 * - `muted` fades the whole row.
 *
 * Every value is a `--list-row-*` token with the toggle-off value as its
 * fallback, so a row that adopts this keeps its look with the toggle off and
 * becomes a Salas pill under the redesign. A shell row passes its old
 * colours through `className` and `cn` keeps them, as it does for Button.
 *
 * It is a button. A row that navigates calls `navigate` in `onClick`, as the
 * channel and conversation rows already do.
 */
export type ListRowSize = "sm" | "md" | "lg";

const SIZE: Record<ListRowSize, string> = {
  // A channel or a section link.
  sm: "min-h-[var(--list-row-h-sm,2rem)] gap-[var(--list-row-gap-sm,0.375rem)] py-1",
  // A person with an avatar.
  md: "min-h-[var(--list-row-h-md,2.5rem)] gap-[var(--list-row-gap,0.625rem)] py-1",
  // A person or a conversation with a second line.
  lg: "min-h-[var(--list-row-h-lg,3rem)] gap-[var(--list-row-gap,0.625rem)] py-1.5",
};

export interface ListRowProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: ListRowSize;
  selected?: boolean;
  unread?: boolean;
  muted?: boolean;
  /** An icon or an avatar, drawn before the label. */
  leading?: React.ReactNode;
  /** A second, quieter line under the label. */
  detail?: React.ReactNode;
  /** A count, a time or an action at the end of the row. */
  trailing?: React.ReactNode;
}

export const ListRow = React.forwardRef<HTMLButtonElement, ListRowProps>(function ListRow(
  {
    size = "sm",
    selected = false,
    unread = false,
    muted = false,
    leading,
    detail,
    trailing,
    type = "button",
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      data-unread={unread ? "" : undefined}
      className={cn(
        "group/list-row flex w-full min-w-0 items-center rounded-[var(--list-row-radius,var(--radius-control))] px-[var(--list-row-px,0.5rem)] text-left text-sm transition-colors duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring",
        "disabled:pointer-events-none disabled:opacity-[var(--list-row-disabled-opacity,0.4)]",
        SIZE[size],
        selected
          ? "bg-[color:var(--list-row-selected,var(--color-surface-3))] font-medium text-[color:var(--list-row-selected-text,var(--color-text))]"
          : unread
            ? "font-semibold text-text hover:bg-[color:var(--list-row-hover,var(--color-surface-2))]"
            : "text-[color:var(--list-row-text,var(--color-text-secondary))] hover:bg-[color:var(--list-row-hover,var(--color-surface-2))] hover:text-text",
        muted && !selected && "opacity-[var(--list-row-muted-opacity,0.5)]",
        className,
      )}
      {...rest}
    >
      {leading ? (
        <span
          data-list-row-leading=""
          className={cn(
            "flex shrink-0 items-center justify-center",
            selected
              ? "text-[color:var(--list-row-selected-text,var(--color-text))]"
              : "text-[color:var(--list-row-icon,var(--color-text-tertiary))]",
          )}
        >
          {leading}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {detail ? (
          <span className="truncate text-xs font-normal text-[color:var(--list-row-detail,var(--color-text-tertiary))]">
            {detail}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span data-list-row-trailing="" className="flex shrink-0 items-center gap-1">
          {trailing}
        </span>
      ) : unread && !selected ? (
        <span
          data-list-row-pip=""
          aria-hidden="true"
          className="h-[var(--list-row-pip,0.375rem)] w-[var(--list-row-pip,0.375rem)] shrink-0 rounded-full bg-indicator"
        />
      ) : null}
    </button>
  );
});
