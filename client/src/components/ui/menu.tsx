import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  useRef,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { useFullscreenPortalHost } from "@/components/ui/tooltip";
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
  // Inside a fullscreen element when there is one, or the menu opens where
  // nothing can see it (the watch player's layout picker, 2026-09-25).
  const portalHost = useFullscreenPortalHost();
  const triggerRef = useRef<HTMLElement>(null);
  // Set when the menu closes because a row was chosen, not Escape or a
  // click outside. A row that opens a dialog hands focus to that dialog, and
  // Radix's own return-to-trigger would run after it and pull focus back out
  // from under the modal (Enter then reopened the menu behind it).
  const chosenRef = useRef(false);
  if (items.length === 0 || disabled) {
    return <>{children}</>;
  }

  return (
    <DropdownMenuPrimitive.Root onOpenChange={onOpenChange}>
      <DropdownMenuPrimitive.Trigger asChild ref={triggerRef as never}>
        {children}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={portalHost ?? undefined}>
        <DropdownMenuPrimitive.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={COLLISION_PADDING}
          // Named so a test can address the open menu without matching
          // translated labels.
          data-server-menu=""
          className="elevation-3 z-[100] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain rounded-[var(--radius-card)] p-1 animate-fade-in min-w-[11.5rem]"
          onClickCapture={(event: ReactMouseEvent) => {
            if ((event.target as Element).closest?.('[role^="menuitem"]')) {
              chosenRef.current = true;
            }
          }}
          onKeyDownCapture={(event: ReactKeyboardEvent) => {
            if (
              (event.key === "Enter" || event.key === " ") &&
              (event.target as Element).closest?.('[role^="menuitem"]')
            ) {
              chosenRef.current = true;
            }
          }}
          // Escape or a click outside: Radix's default, focus back on this
          // trigger. A chosen row: whatever it opened keeps focus, and the
          // trigger only gets it back when nothing took it.
          onCloseAutoFocus={(event: Event) => {
            if (!chosenRef.current) {
              return;
            }
            chosenRef.current = false;
            event.preventDefault();
            window.setTimeout(() => {
              const active = document.activeElement;
              if (!active || active === document.body) {
                triggerRef.current?.focus();
              }
            }, 0);
          }}
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
