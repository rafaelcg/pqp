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

/**
 * One emoji in the strip across the top of the menu.
 *
 * Separate from `ContextMenuItemDef` on purpose. Quick reactions used to be
 * ordinary items, and an item is a full-width row — eight of them stacked into
 * a tall column of one emoji per line, which is what the menu looked like on
 * desktop and on iOS. Giving them their own type is what stops the next person
 * from putting an emoji back in `items` and re-growing the column.
 */
export interface ContextMenuReactionDef {
  emoji: string;
  /**
   * Accessible name override. Left undefined the emoji itself names the
   * button, which is what a reader wants; set it only to add state ("you
   * already reacted with this one") that the glyph cannot carry.
   */
  label?: string;
  onSelect: () => void;
  /** Drawn lit, the same way the reaction pill under the message is. */
  active?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItemDef[];
  /**
   * Drawn as ONE horizontal row at the top of the menu, above `items`.
   * Empty or omitted and the strip is not rendered at all.
   */
  reactions?: ContextMenuReactionDef[];
  /** Accessible name for the strip as a whole. */
  reactionsLabel?: string;
  /** The `+` at the tail of the strip. Omitted and no tail is drawn. */
  onMoreReactions?: () => void;
  /** Accessible name for that `+`. */
  moreReactionsLabel?: string;
  children: ReactNode;
  disabled?: boolean;
}

/** Keeps the menu clear of the very edge of the window on every side. */
const COLLISION_PADDING = 8;

export function ContextMenu({
  items,
  reactions,
  reactionsLabel,
  onMoreReactions,
  moreReactionsLabel,
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

  const strip = reactions ?? [];
  const hasStrip = strip.length > 0;

  if (disabled || (items.length === 0 && !hasStrip)) {
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
          className={cn(
            "z-[100] max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto overscroll-contain rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)] animate-fade-in",
            // The strip sets the width: it is a fixed number of equal cells
            // laid out in a row, and a menu narrower than their natural width
            // would wrap them back into the column this exists to kill.
            hasStrip ? "min-w-[16.5rem]" : "min-w-[11.5rem]",
          )}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {hasStrip && (
            <>
              {/* ONE ROW. `flex` with no wrapping and equal-basis cells is the
                  whole fix — every emoji shares a y-centre, which is what a
                  quick-reaction strip is supposed to look like and what the
                  e2e test measures. */}
              <div
                role="group"
                aria-label={reactionsLabel}
                className="flex items-center gap-0.5 px-0.5 pb-1"
                data-quick-reactions=""
              >
                {strip.map((reaction) => (
                  <ContextMenuPrimitive.Item
                    key={reaction.emoji}
                    aria-label={reaction.label}
                    onSelect={reaction.onSelect}
                    data-quick-reaction=""
                    className={cn(
                      "flex h-8 flex-1 cursor-default select-none items-center justify-center rounded-md text-base leading-none outline-none data-[highlighted]:bg-ink-3",
                      reaction.active && "bg-signal/15 ring-1 ring-signal/40",
                    )}
                  >
                    {reaction.emoji}
                  </ContextMenuPrimitive.Item>
                ))}
                {onMoreReactions && (
                  <ContextMenuPrimitive.Item
                    aria-label={moreReactionsLabel}
                    onSelect={onMoreReactions}
                    data-quick-reaction-more=""
                    className="flex h-8 flex-1 cursor-default select-none items-center justify-center rounded-md border border-dashed border-ink-4 text-sm leading-none text-paper-muted outline-none data-[highlighted]:bg-ink-3 data-[highlighted]:text-paper"
                  >
                    <span aria-hidden="true">+</span>
                  </ContextMenuPrimitive.Item>
                )}
              </div>
              {items.length > 0 && <div className="mb-1 h-px bg-ink-4" />}
            </>
          )}
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
