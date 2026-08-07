import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { useCallback, useRef, useState, type ReactNode } from "react";
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

/** Keeps the menu clear of the very edge of the window on every side. */
const COLLISION_PADDING = 8;

export function ContextMenu({
  items,
  children,
  disabled = false,
}: ContextMenuProps) {
  // Radix anchors the menu to a zero-size rect at the pointer, which is right —
  // but it hardcodes `side="right" align="start"`, so floating-ui handles
  // vertical overflow with `shift`, which slides the menu along the anchor
  // instead of flipping it. A menu taller than the room below the click (a
  // message menu is ~550px; the room below a message row is usually far less)
  // gets dragged up until its *middle* is at the pointer, leaving the click
  // sitting in the menu's left edge with the menu's corners hundreds of pixels
  // away. That is what reads as "the menu belongs to nothing".
  //
  // `side`/`align` are overwritten by Radix's own Content, so they cannot be
  // corrected from here — but `alignOffset` is passed through. Measuring the
  // menu as it mounts and offsetting by its own height flips it above the
  // pointer the way a native context menu does, which puts a corner back on the
  // click. When it fits neither way the offset stays at zero and Radix's
  // collision handling takes over, with a max-height so it can still never
  // spill out of the window.
  const pointerYRef = useRef(0);
  const [alignOffset, setAlignOffset] = useState(0);

  const recordPointer = useCallback((event: { clientY: number }) => {
    pointerYRef.current = event.clientY;
  }, []);

  const placeContent = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      // Next open starts from the unflipped placement and measures again.
      setAlignOffset(0);
      return;
    }
    const height = node.offsetHeight;
    const pointerY = pointerYRef.current;
    const fitsBelow =
      pointerY + height + COLLISION_PADDING <= window.innerHeight;
    const fitsAbove = pointerY - height - COLLISION_PADDING >= 0;
    setAlignOffset(!fitsBelow && fitsAbove ? -height : 0);
  }, []);

  if (disabled || items.length === 0) {
    return <>{children}</>;
  }

  return (
    <ContextMenuPrimitive.Root>
      {/* Radix composes these with its own handlers, so the coordinates
          recorded here are exactly the ones it anchors to — for a right-click
          and for the touch long-press alike. */}
      <ContextMenuPrimitive.Trigger
        asChild
        onContextMenu={recordPointer}
        onPointerDown={recordPointer}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          ref={placeContent}
          alignOffset={alignOffset}
          collisionPadding={COLLISION_PADDING}
          // `animate-fade-in` rather than `animate-rise`: the latter animates
          // `translateY(14px)` over 650ms, so the menu spends half a second
          // visibly detached from the point it is anchored to.
          className="z-[100] max-h-[var(--radix-context-menu-content-available-height)] min-w-[11.5rem] overflow-y-auto overscroll-contain rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)] animate-fade-in"
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
