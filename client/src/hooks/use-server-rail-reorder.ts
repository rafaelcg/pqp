import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  autoscrollStep,
  clampTop,
  dropLineY,
  keyMoveTarget,
  moveId,
  railKeyMove,
  targetSlot,
  type RailSlot,
} from "@/lib/server-rail-reorder";

/**
 * DRAG A SERVER ON THE RAIL (and move it with the keyboard).
 *
 * POINTER EVENTS, NOT HTML5 DRAG. The channel list (`channel-list.tsx`) uses
 * native drag and drop, and that is right for it: rows, pins and voice
 * occupants already share one drag state, and a phone reorders through a menu
 * mode. The rail has a different problem. A server tile is a 48px icon with a
 * context menu, a tooltip and a tap that opens the server, and it has to be
 * draggable by a finger on a phone-width web page. Native drag cannot be
 * started by a long press on every touch browser, gives no say over the
 * autoscroll of a rail that overflows, and swallows `pointermove`, so the tile
 * could not follow the pointer or the line track it. A pointer gesture does
 * all of that with one code path for mouse, pen and finger.
 *
 * THE GESTURE
 *  - Mouse: press and move 5px. A press without the move is a click, which
 *    opens the server as it always did.
 *  - Touch and pen: press and HOLD for 380ms without moving more than 10px.
 *    Moving first means the person is scrolling the rail, and the gesture is
 *    dropped so the page scrolls normally. Once armed, a non-passive
 *    `touchmove` listener stops the page scrolling under the finger.
 *  - Esc, a lost pointer, or the list changing under the drag cancels it.
 *
 * WHILE DRAGGING the tile follows the pointer (vertical only, kept inside the
 * list), a line says where it will land, and a frame loop scrolls the rail when
 * the pointer is near either edge. Everything is measured once, at the start,
 * in the rail's scrollable-content coordinates, which is the one space that
 * does not move while the rail scrolls. On drop the tiles glide to their new
 * places (WAAPI, transform only, skipped under `prefers-reduced-motion`).
 *
 * KEYBOARD: Alt+Up / Alt+Down move the focused tile one place, Alt+Home /
 * Alt+End to the ends, and the new place is announced through `message`. The
 * global channel shortcuts own Alt+Up/Down, so `use-keyboard-shortcuts.ts`
 * steps aside for anything inside `[data-rail-item]`.
 */

const MOUSE_SLOP_PX = 5;
const TOUCH_SLOP_PX = 10;
const LONG_PRESS_MS = 380;
const DEFAULT_GAP_PX = 8;

interface Gesture {
  id: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  pointerY: number;
  startScroll: number;
  active: boolean;
  slots: RailSlot[];
  from: number;
  gap: number;
  listTop: number;
  target: number;
  offset: number;
  timer: number | null;
  frame: number | null;
}

export interface RailDrag {
  id: string;
  /** The drop line's top in the list's own coordinates, or null for "no change". */
  lineY: number | null;
}

export interface UseServerRailReorder {
  navRef: (node: HTMLElement | null) => void;
  listRef: (node: HTMLElement | null) => void;
  itemRef: (id: string) => (node: HTMLElement | null) => void;
  drag: RailDrag | null;
  /** The sentence for the live region: where a tile just went. */
  message: string;
  /** Move `id` to index `to`, with the same focus and announcement as a key. */
  moveTo: (id: string, to: number) => void;
  itemProps: (id: string) => {
    onPointerDown: (event: ReactPointerEvent) => void;
    onKeyDown: (event: ReactKeyboardEvent) => void;
    onClickCapture: (event: ReactMouseEvent) => void;
    onContextMenuCapture: (event: ReactMouseEvent) => void;
    onDragStart: (event: DragEvent) => void;
  };
}

export function useServerRailReorder({
  ids,
  enabled,
  onReorder,
  announce,
}: {
  ids: readonly string[];
  enabled: boolean;
  onReorder: (ids: string[], movedId: string) => void;
  /** The sentence for a tile that now sits at `position` of `total`. */
  announce: (id: string, position: number, total: number) => string;
}): UseServerRailReorder {
  const nav = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLElement | null>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const refCache = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const focusAfter = useRef<string | null>(null);
  const pendingRects = useRef<Map<string, number> | null>(null);
  const lastRects = useRef<Map<string, number> | null>(null);
  const [drag, setDrag] = useState<RailDrag | null>(null);
  const [message, setMessage] = useState("");
  const [settle, setSettle] = useState(0);
  const idsKey = ids.join(",");

  // The latest props, read by the window listeners without re-binding them.
  const latest = useRef({ ids, enabled, onReorder, announce });
  latest.current = { ids, enabled, onReorder, announce };

  const navRef = useCallback((node: HTMLElement | null) => {
    nav.current = node;
  }, []);
  const listRef = useCallback((node: HTMLElement | null) => {
    list.current = node;
  }, []);
  const itemRef = useCallback((id: string) => {
    let ref = refCache.current.get(id);
    if (!ref) {
      ref = (node: HTMLElement | null) => {
        if (node) {
          items.current.set(id, node);
        } else {
          items.current.delete(id);
        }
      };
      refCache.current.set(id, ref);
    }
    return ref;
  }, []);

  /** Where every tile is, relative to the top of the list (scroll-proof). */
  const measureRelative = useCallback((): Map<string, number> | null => {
    const listEl = list.current;
    if (!listEl) {
      return null;
    }
    const origin = listEl.getBoundingClientRect().top;
    const out = new Map<string, number>();
    for (const [id, el] of items.current) {
      out.set(id, el.getBoundingClientRect().top - origin);
    }
    return out;
  }, []);

  const stopGesture = useCallback(() => {
    const g = gesture.current;
    if (!g) {
      return;
    }
    if (g.timer !== null) {
      window.clearTimeout(g.timer);
    }
    if (g.frame !== null) {
      window.cancelAnimationFrame(g.frame);
    }
    gesture.current = null;
    // The lifted tile is moved by hand (see `frame`); hand it back.
    items.current.get(g.id)?.style.removeProperty("transform");
    document.body.style.removeProperty("user-select");
    document.body.style.removeProperty("-webkit-user-select");
    window.removeEventListener("pointermove", onMoveRef.current);
    window.removeEventListener("pointerup", onUpRef.current);
    window.removeEventListener("pointercancel", onCancelRef.current);
    window.removeEventListener("keydown", onEscRef.current, true);
    setDrag(null);
    if (g.active) {
      // The click that follows a drag's pointer-up is not a tap on a server.
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 50);
    }
  }, []);

  const frame = useCallback(() => {
    const g = gesture.current;
    const navEl = nav.current;
    if (!g || !g.active || !navEl) {
      return;
    }
    const navRect = navEl.getBoundingClientRect();
    const step = autoscrollStep(g.pointerY, navRect.top, navRect.bottom);
    if (step !== 0) {
      navEl.scrollTop += step;
    }
    const slot = g.slots[g.from]!;
    const raw = slot.top + (g.pointerY - g.startY) + (navEl.scrollTop - g.startScroll);
    const top = clampTop(g.slots, raw);
    const target = targetSlot(g.slots, top + slot.height / 2);
    const offset = top - slot.top;
    if (offset !== g.offset) {
      g.offset = offset;
      // Straight onto the element, not through React state: this runs every
      // frame, and a state change would re-render the whole rail (every tile,
      // every menu) sixty times a second. React only hears about the drop
      // target, which changes a handful of times per drag.
      const el = items.current.get(g.id);
      if (el) {
        el.style.transform = `translateY(${offset}px) scale(1.06)`;
      }
    }
    if (target !== g.target) {
      g.target = target;
      const line = dropLineY(g.slots, g.from, target, g.gap);
      setDrag({
        id: g.id,
        lineY: line === null ? null : line - g.listTop,
      });
    }
    g.frame = window.requestAnimationFrame(frame);
  }, []);

  const activate = useCallback(
    (g: Gesture) => {
      const navEl = nav.current;
      const listEl = list.current;
      const { ids: current } = latest.current;
      if (!navEl || !listEl) {
        stopGesture();
        return;
      }
      const navTop = navEl.getBoundingClientRect().top;
      const slots: RailSlot[] = [];
      for (const id of current) {
        const el = items.current.get(id);
        if (!el) {
          stopGesture();
          return;
        }
        const rect = el.getBoundingClientRect();
        slots.push({ top: rect.top - navTop + navEl.scrollTop, height: rect.height });
      }
      g.slots = slots;
      g.from = current.indexOf(g.id);
      g.target = g.from;
      g.offset = 0;
      g.startScroll = navEl.scrollTop;
      g.listTop = listEl.getBoundingClientRect().top - navTop + navEl.scrollTop;
      const first = slots[0];
      const second = slots[1];
      g.gap = first && second ? second.top - (first.top + first.height) : DEFAULT_GAP_PX;
      g.active = true;
      if (g.timer !== null) {
        window.clearTimeout(g.timer);
        g.timer = null;
      }
      document.body.style.setProperty("user-select", "none");
      document.body.style.setProperty("-webkit-user-select", "none");
      if (g.pointerType !== "mouse") {
        // Radix's context menu opens on a 700ms touch press and clears that
        // timer on any pointermove. A held finger has not moved, so tell it
        // it did: the menu must not open under a drag that already started.
        const el = items.current.get(g.id)?.querySelector("button");
        el?.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: g.pointerType,
            pointerId: g.pointerId,
            isPrimary: true,
            // Where the finger is, so our own window listener reads it right.
            clientX: g.startX,
            clientY: g.pointerY,
          }),
        );
        try {
          navigator.vibrate?.(8);
        } catch {
          // No haptics here; the lift is visible anyway.
        }
      }
      const lifted = items.current.get(g.id);
      if (lifted) {
        lifted.style.transform = "translateY(0px) scale(1.06)";
      }
      setDrag({ id: g.id, lineY: null });
      g.frame = window.requestAnimationFrame(frame);
    },
    [frame, stopGesture],
  );

  const onMove = useCallback(
    (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || event.pointerId !== g.pointerId) {
        return;
      }
      g.pointerY = event.clientY;
      if (g.active) {
        return;
      }
      const moved = Math.hypot(event.clientX - g.startX, event.clientY - g.startY);
      if (g.pointerType === "mouse") {
        if (moved >= MOUSE_SLOP_PX) {
          activate(g);
        }
      } else if (moved > TOUCH_SLOP_PX) {
        // The finger moved before the hold finished: that is a scroll.
        stopGesture();
      }
    },
    [activate, stopGesture],
  );

  const onUp = useCallback(
    (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || event.pointerId !== g.pointerId) {
        return;
      }
      if (g.active && g.target !== g.from) {
        const { ids: current, onReorder: save, announce: say } = latest.current;
        const next = moveId(current, g.id, g.target);
        // Where every tile is right now (the dragged one under the pointer):
        // the glide to the new order starts from here.
        const rects = measureRelative();
        pendingRects.current = rects;
        save(next, g.id);
        setMessage((previous) =>
          nextMessage(previous, say(g.id, g.target + 1, current.length)),
        );
      } else if (g.active) {
        pendingRects.current = measureRelative();
      }
      const wasActive = g.active;
      stopGesture();
      if (wasActive) {
        setSettle((value) => value + 1);
      }
    },
    [measureRelative, stopGesture],
  );

  const onCancel = useCallback(
    (event: PointerEvent) => {
      const g = gesture.current;
      if (g && event.pointerId === g.pointerId) {
        stopGesture();
      }
    },
    [stopGesture],
  );

  const onEsc = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        event.stopPropagation();
        stopGesture();
      }
    },
    [stopGesture],
  );

  // The listeners are removed by identity, so keep the current ones reachable
  // from `stopGesture` without making it depend on them.
  const onMoveRef = useRef(onMove);
  const onUpRef = useRef(onUp);
  const onCancelRef = useRef(onCancel);
  const onEscRef = useRef(onEsc);
  onMoveRef.current = onMove;
  onUpRef.current = onUp;
  onCancelRef.current = onCancel;
  onEscRef.current = onEsc;

  const begin = useCallback(
    (id: string, event: ReactPointerEvent) => {
      if (!latest.current.enabled || latest.current.ids.length < 2) {
        return;
      }
      if (event.button !== 0 || !event.isPrimary || gesture.current) {
        return;
      }
      const g: Gesture = {
        id,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
        pointerY: event.clientY,
        startScroll: 0,
        active: false,
        slots: [],
        from: 0,
        gap: DEFAULT_GAP_PX,
        listTop: 0,
        target: 0,
        offset: 0,
        timer: null,
        frame: null,
      };
      gesture.current = g;
      if (g.pointerType !== "mouse") {
        g.timer = window.setTimeout(() => {
          g.timer = null;
          if (gesture.current === g) {
            activate(g);
          }
        }, LONG_PRESS_MS);
      }
      // Stable wrappers: `removeEventListener` must see the same function.
      window.addEventListener("pointermove", onMoveRef.current);
      window.addEventListener("pointerup", onUpRef.current);
      window.addEventListener("pointercancel", onCancelRef.current);
      window.addEventListener("keydown", onEscRef.current, true);
    },
    [activate],
  );

  // A touch drag must own the finger: nothing may scroll under it. Bound once,
  // non-passive, BEFORE any touch starts (a listener added mid-gesture cannot
  // cancel a scroll the browser already began).
  useEffect(() => {
    const navEl = nav.current;
    if (!navEl) {
      return;
    }
    const block = (event: TouchEvent) => {
      if (gesture.current?.active && event.cancelable) {
        event.preventDefault();
      }
    };
    navEl.addEventListener("touchmove", block, { passive: false });
    return () => navEl.removeEventListener("touchmove", block);
  }, []);

  // The list changed under a drag (a join, a leave, a remote reorder): the
  // measurements are stale, so drop the gesture instead of dropping on a lie.
  useEffect(() => {
    if (gesture.current) {
      stopGesture();
    }
  }, [idsKey, stopGesture]);

  useEffect(() => stopGesture, [stopGesture]);

  // Glide tiles to where they now are, and put focus back after a key move.
  useLayoutEffect(() => {
    const now = measureRelative();
    const before = pendingRects.current ?? lastRects.current;
    pendingRects.current = null;
    lastRects.current = now;
    if (now && before && !reducedMotion()) {
      const style = nav.current ? getComputedStyle(nav.current) : null;
      const duration = parseMs(style?.getPropertyValue("--duration-base") ?? "", 220);
      const easing = style?.getPropertyValue("--ease-emphasized").trim() || "ease-out";
      for (const [id, top] of now) {
        const was = before.get(id);
        const el = items.current.get(id);
        if (was === undefined || !el || typeof el.animate !== "function") {
          continue;
        }
        if (Math.abs(was - top) > 1) {
          el.animate(
            [{ transform: `translateY(${was - top}px)` }, { transform: "translateY(0)" }],
            { duration, easing },
          );
        }
      }
    }
    if (focusAfter.current) {
      items.current.get(focusAfter.current)?.querySelector("button")?.focus();
      focusAfter.current = null;
    }
  }, [idsKey, settle, measureRelative]);

  /** Put `id` at index `to` (keyboard and menu), keep focus on it, say where it went. */
  const moveTo = useCallback((id: string, to: number) => {
    const { ids: current, onReorder: save, announce: say } = latest.current;
    const from = current.indexOf(id);
    if (from < 0) {
      return;
    }
    const target = Math.max(0, Math.min(current.length - 1, to));
    if (target !== from) {
      focusAfter.current = id;
      save(moveId(current, id, target), id);
    }
    setMessage((previous) => nextMessage(previous, say(id, target + 1, current.length)));
  }, []);

  const itemProps = useCallback(
    (id: string) => ({
      onPointerDown: (event: ReactPointerEvent) => begin(id, event),
      onKeyDown: (event: ReactKeyboardEvent) => {
        const move = railKeyMove(event);
        if (!move || !latest.current.enabled) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const { ids: current } = latest.current;
        const from = current.indexOf(id);
        if (from >= 0) {
          moveTo(id, keyMoveTarget(move, from, current.length));
        }
      },
      onClickCapture: (event: ReactMouseEvent) => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onContextMenuCapture: (event: ReactMouseEvent) => {
        // A long press on a phone raises `contextmenu` (Android) about when our
        // hold completes. While a touch gesture is armed or running it is part
        // of the drag. A mouse right-click is never a gesture here.
        const g = gesture.current;
        if (g && g.pointerType !== "mouse") {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onDragStart: (event: DragEvent) => {
        // The tile's <img> would start a native drag and cancel our pointer.
        event.preventDefault();
      },
    }),
    [begin, moveTo],
  );

  return { navRef, listRef, itemRef, drag, message, itemProps, moveTo };
}

/** Two identical sentences in a row are not re-read; a trailing mark makes them differ. */
function nextMessage(previous: string, next: string): string {
  return previous === next ? `${next}\u200B` : next;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function parseMs(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("ms")) {
    return Number.parseFloat(trimmed) || fallback;
  }
  if (trimmed.endsWith("s")) {
    return (Number.parseFloat(trimmed) || fallback / 1000) * 1000;
  }
  return fallback;
}
