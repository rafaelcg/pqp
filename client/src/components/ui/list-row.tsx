import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A row in a list: a channel, a person, a conversation, a thread, a follow.
 * A leading mark (an icon or an avatar), a label, an optional second line,
 * something trailing (a count, a time) and an optional action (a gear, a
 * close button).
 *
 * States, never told apart by colour alone (DESIGN.md, the row roles):
 *
 * - hover is a fill (`row-hover` under the redesign);
 * - `selected` is the accent's soft fill with its own label colour. A
 *   selected row is the one being read, so it shows no unread weight or pip
 *   even when `unread` is still set;
 * - `unread` is the body text at weight 600 plus the indicator pip at the
 *   end of the row;
 * - `muted` fades the whole row.
 *
 * Every value is a `--list-row-*` token with the toggle-off value as its
 * fallback, so a row that adopts this keeps its look with the toggle off and
 * becomes a Salas pill under the redesign. A shell row passes its old
 * colours through `className` and `cn` keeps them, as it does for Button.
 *
 * The row is a button. `trailing` and `count` are inside it, so they take
 * nothing interactive. An `action` is a control of its own: the row then becomes a
 * wrapper that draws the row's look, with the button and the action side by
 * side in it, never one inside the other.
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
  /** A time or a mark (muted) at the end of the row. Nothing interactive.
   *  An unread row keeps its pip beside it. */
  trailing?: React.ReactNode;
  /** A count of what is new (`ui/count-badge.tsx`). It replaces the pip,
   *  and like the pip it is not drawn on the selected row. */
  count?: React.ReactNode;
  /** A control of its own at the end of the row (a gear, a close). */
  action?: React.ReactNode;
}

function rowLook(selected: boolean, unread: boolean, muted: boolean): string {
  return cn(
    "rounded-[var(--list-row-radius,var(--radius-control))] text-sm transition-colors duration-[var(--duration-fast)]",
    selected
      ? "bg-[color:var(--list-row-selected,var(--color-surface-3))] font-medium text-[color:var(--list-row-selected-text,var(--color-text))]"
      : unread
        ? "font-semibold text-text hover:bg-[color:var(--list-row-hover,var(--color-surface-2))]"
        : "text-[color:var(--list-row-text,var(--color-text-secondary))] hover:bg-[color:var(--list-row-hover,var(--color-surface-2))] hover:text-text",
    muted && !selected && "opacity-[var(--list-row-muted-opacity,0.5)]",
  );
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
    count,
    action,
    type = "button",
    className,
    children,
    ...rest
  },
  ref,
) {
  const pip = unread && !selected;
  const content = (
    <>
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
          <span
            className={cn(
              "truncate text-xs font-normal",
              // On the selected fill the tertiary grey falls under 4.5:1 in
              // several looks; the selected label's own colour does not.
              selected
                ? "text-[color:var(--list-row-detail,var(--color-text-tertiary))] redesign:text-[color:var(--list-row-selected-text)]"
                : "text-[color:var(--list-row-detail,var(--color-text-tertiary))]",
            )}
          >
            {detail}
          </span>
        ) : null}
      </span>
      {count != null && !selected ? (
        <span data-list-row-count="" className="flex shrink-0 items-center">
          {count}
        </span>
      ) : null}
      {trailing || (count == null && pip) ? (
        <span
          data-list-row-trailing=""
          className={cn(
            // A time takes the second line's colour, the selected label's on
            // the selected fill (where tertiary falls under 4.5:1).
            "flex shrink-0 items-center gap-1.5 text-xs font-normal text-[color:var(--list-row-detail,var(--color-text-tertiary))]",
            selected && "redesign:text-[color:var(--list-row-selected-text)]",
            // A time over its pip on a two-line row.
            size === "lg" && trailing && pip && "flex-col items-end gap-1",
          )}
        >
          {trailing}
          {count == null && pip ? (
            <span
              data-list-row-pip=""
              aria-hidden="true"
              className="h-[var(--list-row-pip,0.375rem)] w-[var(--list-row-pip,0.375rem)] shrink-0 rounded-full bg-indicator"
            />
          ) : null}
        </span>
      ) : null}
    </>
  );
  const buttonState = {
    "aria-current": selected ? ("true" as const) : undefined,
    "data-selected": selected ? "" : undefined,
    "data-unread": unread ? "" : undefined,
  };
  const focus =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--list-row-ring,var(--color-focus-ring))]";

  if (!action) {
    return (
      <button
        ref={ref}
        type={type}
        {...buttonState}
        className={cn(
          "group/list-row flex w-full min-w-0 items-center px-[var(--list-row-px,0.5rem)] text-left",
          focus,
          "disabled:pointer-events-none disabled:opacity-[var(--list-row-disabled-opacity,0.4)]",
          SIZE[size],
          rowLook(selected, unread, muted),
          className,
        )}
        {...rest}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      data-list-row=""
      className={cn(
        "group/list-row flex w-full min-w-0 items-center gap-1 pr-[var(--list-row-action-pr,0.25rem)]",
        rest.disabled && "pointer-events-none opacity-[var(--list-row-disabled-opacity,0.4)]",
        rowLook(selected, unread, muted),
        className,
      )}
    >
      <button
        ref={ref}
        type={type}
        {...buttonState}
        className={cn(
          "flex min-w-0 flex-1 items-center self-stretch rounded-[inherit] pl-[var(--list-row-px,0.5rem)] text-left",
          focus,
          SIZE[size],
        )}
        {...rest}
      >
        {content}
      </button>
      <span
        data-list-row-action=""
        // A disabled row's action is out of reach of the pointer (above) and
        // of the keyboard.
        inert={rest.disabled ? true : undefined}
        className="flex shrink-0 items-center gap-0.5"
      >
        {action}
      </span>
    </div>
  );
});
