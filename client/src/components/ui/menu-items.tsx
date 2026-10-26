import { Check as PhCheck } from "@phosphor-icons/react";
import { Check } from "lucide-react";
import { useId, type ComponentType, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { POPOVER_SURFACE } from "@/components/ui/popover";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";

/**
 * The row renderer both menus share.
 *
 * `ContextMenu` (right-click / long-press, on `@radix-ui/react-context-menu`)
 * and `Menu` (click-triggered, on `@radix-ui/react-dropdown-menu`) draw the
 * same `ContextMenuItemDef[]` for a surface like the server header, and they
 * must never drift — two copies of "how a row looks" is how one of them ends
 * up one padding value or one disabled state behind the other. The two Radix
 * packages ship near-identical `Item` / `Separator` primitives, so this
 * component is parameterised over which pair it draws into rather than
 * knowing about either package itself.
 *
 * The prop types below are deliberately the small slice of each primitive's
 * real props this file actually uses — not the full Radix type, which differs
 * slightly between the two packages and would force a union at every call
 * site. The cast at each call site (`context-menu.tsx`, `menu.tsx`) is safe
 * because both `Item` components accept a strict superset of this shape.
 */

/**
 * The menu recipe, for the two Radix menus and for a hand-built one that
 * cannot be a Radix menu (the composer's "+", anchored inside the field).
 * Positioning, width and z-index stay with each caller.
 */
export const MENU_SURFACE = `${POPOVER_SURFACE} overflow-y-auto overscroll-contain p-[var(--menu-pad,0.25rem)] animate-fade-in`;

const ROW_SHAPE =
  "flex w-full cursor-default select-none items-center gap-[var(--menu-row-gap,0.5rem)] whitespace-nowrap rounded-[var(--menu-row-radius,var(--radius-control))] px-2.5 py-[var(--menu-row-py,0.375rem)] text-sm outline-none";

/**
 * A Radix row: highlighted by the pointer or the arrows. Disabled fades the
 * whole row with the toggle off; under the redesign only the icon and the
 * label fade, so a detail that says how to enable the row stays readable.
 */
export const MENU_ROW = `group/menu-row ${ROW_SHAPE} data-[disabled]:pointer-events-none data-[disabled]:opacity-[var(--menu-disabled-opacity,0.4)] redesign:data-[disabled]:opacity-100 data-[highlighted]:bg-[color:var(--menu-row-hover,var(--color-surface-2))]`;

/** What fades on a disabled row under the redesign. */
const DISABLED_PART = "redesign:group-data-[disabled]/menu-row:opacity-[var(--menu-disabled-opacity)]";

/**
 * A heading over the rows below it, also for a menu's `topContent`. Under
 * the redesign it is sentence case in `text-secondary` and semibold, so it
 * does not read as a row's detail line.
 */
export const MENU_HEADING =
  "px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary redesign:pt-2 redesign:text-xs redesign:normal-case redesign:tracking-normal redesign:text-text-secondary";

/** The heading's redesign half alone, for a heading whose toggle-off size differs. */
export const MENU_HEADING_REDESIGN =
  "redesign:pt-2 redesign:text-xs redesign:normal-case redesign:tracking-normal redesign:text-text-secondary";

/** A hand-built row: a button highlighted on hover and keyboard focus. */
export const MENU_ROW_BUTTON = `group/menu-row ${ROW_SHAPE} text-left text-text hover:bg-[color:var(--menu-row-hover,var(--color-surface-2))] focus-visible:bg-[color:var(--menu-row-hover,var(--color-surface-2))]`;

/**
 * A row's icon: the label's colour with the toggle off; under the redesign a
 * quieter colour that comes up to the label's when the row is highlighted.
 */
export const MENU_ICON =
  "size-[var(--menu-icon-size,0.875rem)] shrink-0 text-[color:var(--menu-icon,currentColor)] redesign:[stroke-width:var(--icon-stroke)] group-data-[highlighted]/menu-row:text-current";

/**
 * The icon on a `MENU_ROW_BUTTON` row, which has no Radix highlight: it comes
 * up on hover and on keyboard focus instead. (A Radix row lifts only on its
 * highlight, so a resting pointer and the arrow keys never light two icons.)
 */
export const MENU_BUTTON_ICON = `${MENU_ICON} group-hover/menu-row:text-current group-focus-visible/menu-row:text-current`;

/** The column an icon sits in, so labels line up across rows. */
export const MENU_ICON_BOX = "flex size-[var(--menu-icon-box,1rem)] shrink-0 items-center justify-center";

export const MENU_SEPARATOR = "my-1 h-px bg-[color:var(--menu-separator,var(--color-border))]";

export interface MenuItemComponentProps {
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  "aria-checked"?: boolean;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-menu-item"?: string;
  className?: string;
  children?: ReactNode;
}

export interface MenuSeparatorComponentProps {
  className?: string;
}

export function MenuItemRows({
  items,
  Item,
  Separator,
}: {
  items: ContextMenuItemDef[];
  Item: ComponentType<MenuItemComponentProps>;
  Separator: ComponentType<MenuSeparatorComponentProps>;
}) {
  // Menus that put an icon on any row reserve the column for every row, so
  // the labels still line up when only some items carry one.
  const reserveIcon = items.some((item) => !item.separator && !item.heading && item.icon);
  const idPrefix = useId();

  return (
    <>
      {items.map((item) =>
        item.separator ? (
          <Separator key={item.id} className={MENU_SEPARATOR} />
        ) : item.heading ? (
          /* Not an `Item`: a row that cannot be focused or chosen. */
          <div
            key={item.id}
            data-menu-heading={item.id}
            className={MENU_HEADING}
          >
            {item.label}
          </div>
        ) : (
          <Item
            key={item.id}
            disabled={item.disabled}
            onSelect={() => item.onSelect?.()}
            aria-checked={item.checked}
            aria-labelledby={item.detail ? `${idPrefix}-${item.id}-label` : undefined}
            aria-describedby={item.detail ? `${idPrefix}-${item.id}-detail` : undefined}
            data-menu-item={item.id}
            className={cn(
              MENU_ROW,
              item.danger
                ? "text-danger [--menu-icon:currentColor] data-[highlighted]:bg-[color:var(--menu-danger-hover,color-mix(in_oklab,var(--color-danger)_15%,transparent))]"
                : "text-text",
            )}
          >
            {reserveIcon && (
              <span
                aria-hidden="true"
                className={cn(MENU_ICON_BOX, DISABLED_PART)}
              >
                {item.icon ? <item.icon className={MENU_ICON} /> : null}
              </span>
            )}
            {item.detail ? (
              <span className="flex min-w-0 max-w-64 flex-1 flex-col">
                {/* Wraps inside the column's width like the detail does: a long
                    label ran past the menu's edge and was cut off. */}
                <span
                  id={`${idPrefix}-${item.id}-label`}
                  className={cn("whitespace-normal", DISABLED_PART)}
                >
                  {item.label}
                </span>
                <span
                  id={`${idPrefix}-${item.id}-detail`}
                  className="whitespace-normal text-xs text-text-tertiary redesign:group-data-[disabled]/menu-row:opacity-[var(--menu-detail-disabled-opacity)]"
                >
                  {item.detail}
                </span>
              </span>
            ) : (
              <span className={cn("min-w-0 flex-1 whitespace-normal", DISABLED_PART)}>{item.label}</span>
            )}
            {item.trailing ? (
              <span className="ml-3 flex shrink-0 items-center">
                {item.trailing}
              </span>
            ) : null}
            {item.checked ? (
              <>
                <Check className="h-3.5 w-3.5 shrink-0 redesign:hidden" aria-hidden="true" />
                <PhCheck
                  weight="bold"
                  className="hidden size-4 shrink-0 text-accent redesign:block"
                  aria-hidden="true"
                />
              </>
            ) : null}
          </Item>
        ),
      )}
    </>
  );
}
