import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ContextMenuItemDef {
  id: string;
  label: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItemDef[];
  children: ReactNode;
  disabled?: boolean;
}

export function ContextMenu({
  items,
  children,
  disabled = false,
}: ContextMenuProps) {
  if (disabled || items.length === 0) {
    return <>{children}</>;
  }

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          className="z-[100] min-w-[11.5rem] overflow-hidden rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[0_12px_40px_oklch(0.1_0.02_250/0.55)] animate-rise"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {items.map((item) =>
            item.separator ? (
              <ContextMenuPrimitive.Separator
                key={item.id}
                className="my-1 h-px bg-ink-4"
              />
            ) : (
              <ContextMenuPrimitive.Item
                key={item.id}
                disabled={item.disabled}
                onSelect={() => item.onSelect?.()}
                className={cn(
                  "flex cursor-default select-none items-center rounded-md px-2.5 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-ink-3",
                  item.danger
                    ? "text-danger data-[highlighted]:bg-danger/15"
                    : "text-paper",
                )}
              >
                {item.label}
              </ContextMenuPrimitive.Item>
            ),
          )}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
