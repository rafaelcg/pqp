import { Check } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
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

export interface MenuItemComponentProps {
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  "aria-checked"?: boolean;
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
  const reserveIcon = items.some((item) => !item.separator && item.icon);

  return (
    <>
      {items.map((item) =>
        item.separator ? (
          <Separator key={item.id} className="my-1 h-px bg-border" />
        ) : (
          <Item
            key={item.id}
            disabled={item.disabled}
            onSelect={() => item.onSelect?.()}
            aria-checked={item.checked}
            data-menu-item={item.id}
            className={cn(
              "flex w-full cursor-default select-none items-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-2",
              item.danger
                ? "text-danger data-[highlighted]:bg-danger/15"
                : "text-text",
            )}
          >
            {reserveIcon && (
              <span
                aria-hidden="true"
                className="flex h-4 w-4 shrink-0 items-center justify-center"
              >
                {item.icon ? <item.icon className="h-3.5 w-3.5" /> : null}
              </span>
            )}
            <span className="min-w-0 flex-1">{item.label}</span>
            {item.checked ? (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : null}
          </Item>
        ),
      )}
    </>
  );
}
