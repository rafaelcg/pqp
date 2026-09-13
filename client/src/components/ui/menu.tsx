import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentType, ReactElement, ReactNode } from "react";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import {
  MenuItemRows,
  type MenuItemComponentProps,
  type MenuSeparatorComponentProps,
} from "@/components/ui/menu-items";

/** Keeps the menu clear of the very edge of the window on every side. */
const COLLISION_PADDING = 8;

export interface MenuProps {
  /** The exact type `ContextMenu` takes — the two are meant to share one array. */
  items: ContextMenuItemDef[];
  /** The trigger, rendered `asChild`. */
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Non-interactive content rendered above `items`, with its own trailing
   * separator baked in by the caller. Not a `ContextMenuItemDef`: an `Item`
   * row is always focusable and clickable, and this is neither — the server
   * header's "Público" row, a fact about the server rather than an action.
   */
  topContent?: ReactNode;
}

/**
 * A click-triggered dropdown, the sibling `docs/DESIGN.md` § Planned
 * primitives asks for: `ContextMenu` already covers right-click and
 * long-press, and nothing before this opened on a plain click.
 *
 * Draws the exact same rows as `ContextMenu` for the same `items` — see
 * `menu-items.tsx` — so a menu offered both ways (the server header's
 * right-click and its chevron) never drifts between the two triggers.
 */
export function Menu({
  items,
  children,
  align = "start",
  side = "bottom",
  disabled = false,
  onOpenChange,
  topContent,
}: MenuProps): ReactElement {
  if (items.length === 0 || disabled) {
    return <>{children}</>;
  }

  return (
    <DropdownMenuPrimitive.Root onOpenChange={onOpenChange}>
      <DropdownMenuPrimitive.Trigger asChild>
        {children}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={COLLISION_PADDING}
          // Named so a test can address the open menu without matching
          // translated labels.
          data-server-menu=""
          className="elevation-3 z-[100] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain rounded-[var(--radius-card)] p-1 animate-fade-in min-w-[11.5rem]"
          // No `onCloseAutoFocus` override, unlike `ContextMenu`'s: THIS
          // trigger is a single, real, focusable control (a right-click has
          // no such thing), so Radix's default — return focus to it on close
          // — is exactly what closing on Escape is supposed to do.
        >
          {topContent}
          <MenuItemRows
            items={items}
            Item={
              DropdownMenuPrimitive.Item as ComponentType<MenuItemComponentProps>
            }
            Separator={
              DropdownMenuPrimitive.Separator as ComponentType<MenuSeparatorComponentProps>
            }
          />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
