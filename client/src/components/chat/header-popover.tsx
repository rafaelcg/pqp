import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { POPOVER_SURFACE } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/*
 * A popover held under a channel header button under the redesign (the text
 * channels canvas, "Painéis": search, pins, the bell and mentions open as
 * popovers on the button that called them). It places itself with its right
 * edge under the button, closes on Escape and on a press outside, and hands
 * focus back to the button. A row's own menu inside it is not outside.
 */

const EDGE = 12;
const GAP = 8;

/** The button that opened it: the focused one, else the first visible match. */
function findAnchor(selector: string): HTMLElement | null {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest(selector)) {
    return focused.closest<HTMLElement>(selector);
  }
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (el.getBoundingClientRect().width > 0) {
      return el;
    }
  }
  return null;
}

/** Right edge under the button, clamped inside the window. Pure, so it is tested. */
export function placeHeaderPopover(
  anchor: { right: number; bottom: number } | null,
  width: number,
  viewport: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  const right = anchor ? anchor.right : viewport.width - EDGE;
  const top = anchor ? anchor.bottom + GAP : 64;
  const left = Math.max(EDGE, Math.min(right - width, viewport.width - width - EDGE));
  return { left, top, maxHeight: Math.max(160, viewport.height - top - EDGE) };
}

export function HeaderPopover({
  open,
  anchorSelector,
  width,
  labelledBy,
  label,
  onClose,
  initialFocus,
  children,
  ...data
}: {
  open: boolean;
  /** Matches the header button; `[data-…]` so a test can address it. */
  anchorSelector: string;
  width: number;
  labelledBy?: string;
  label?: string;
  onClose: () => void;
  /** What takes focus on open; the panel itself by default. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
} & { [key: `data-${string}`]: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const focusedRef = useRef(false);
  const [box, setBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current?.isConnected ? anchorRef.current : findAnchor(anchorSelector);
    anchorRef.current = anchor;
    const fit = Math.min(width, window.innerWidth - EDGE * 2);
    setBox(
      placeHeaderPopover(anchor?.getBoundingClientRect() ?? null, fit, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [anchorSelector, width]);

  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    anchorRef.current = findAnchor(anchorSelector);
    place();
    focusedRef.current = false;
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      // Back to the button that opened it, as a dialog would.
      anchorRef.current?.focus({ preventScroll: true });
    };
    // `initialFocus` is a ref: read once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place, anchorSelector]);

  // Focus once it is placed: a panel still `visibility: hidden` cannot take it.
  useLayoutEffect(() => {
    if (open && box && !focusedRef.current) {
      focusedRef.current = true;
      (initialFocus?.current ?? panelRef.current)?.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, box]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const insideMenu = (target: EventTarget | null) =>
      target instanceof Element && target.closest("[role='menu']") !== null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || insideMenu(event.target)) {
        return;
      }
      event.stopPropagation();
      onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        !target ||
        panelRef.current?.contains(target) ||
        anchorRef.current?.contains(target) ||
        insideMenu(event.target)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby={labelledBy}
      aria-label={label}
      tabIndex={-1}
      {...data}
      style={{
        width: `min(${width}px, calc(100vw - ${EDGE * 2}px))`,
        left: box?.left ?? 0,
        top: box?.top ?? 0,
        maxHeight: box?.maxHeight,
        visibility: box ? "visible" : "hidden",
      }}
      className={cn(
        POPOVER_SURFACE,
        "fixed z-[90] flex flex-col overflow-hidden text-text animate-pop-in focus-visible:outline-none",
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
