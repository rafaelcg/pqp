import { Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { STORY_SAFE_AREA } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import {
  TAP_MS,
  TAP_SLOP,
  dragTo,
  handleDrag,
  keyboardTransform,
  nearSafeEdge,
  overTrash,
  pinch,
  snap,
  wheelScale,
  type Box,
  type Natural,
  type Point,
  type Transform,
} from "@/lib/stories/layer-gestures";
import type { EditorAction, EditorLayer } from "@/lib/stories/layers";
import { LayerBox, LayerContent, type DisplayLayer } from "./story-layers";

/**
 * The placed layers on the canvas, and the gestures that move them.
 *
 * - One pointer drags a layer. A second pointer (anywhere on the canvas, while
 *   a layer is held) pinches it: scale by the gap, turn by the line between
 *   the two. A mouse has the corner handle for the same two things, and the
 *   wheel to scale.
 * - While a layer moves, the center lines light up and pull it on, and a trash
 *   target rises at the bottom: let go over it and the layer is deleted. Near the
 *   edge of the safe area (what a viewer's own bars can cover) a faint guide
 *   shows, and turns bright when the layer reaches past it.
 * - A layer never scales past the canvas it is on (its natural size is measured where
 *   it is drawn). The handle scales; it turns the layer only once swung past a small
 *   angle, or with Shift held (then it only turns).
 * - A tap on a text layer edits it.
 * - Every layer is a tab stop: arrows move it, + and - scale, [ and ] turn it,
 *   Page Up / Page Down reorder it, Delete removes it, Enter edits text.
 *
 * A gesture edits a LIVE copy of the layer (React state local to this
 * component) and commits ONE history entry when the last pointer lifts, so
 * undo takes back a whole drag, not a pixel of it.
 */

type Gesture =
  | { kind: "drag"; id: string; start: Transform; from: Point; pointerId: number; moved: boolean; startedAt: number; natural: Natural | null }
  | { kind: "pinch"; id: string; start: Transform; ids: [number, number]; from: [Point, Point]; natural: Natural | null }
  | { kind: "handle"; id: string; start: Transform; center: Point; grabbed: Point; pointerId: number; natural: Natural | null };

interface Live extends Transform {
  id: string;
}

function toDisplay(layer: EditorLayer): DisplayLayer {
  switch (layer.type) {
    case "image":
      return { id: layer.id, type: "image", x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation, src: layer.previewUrl, width: layer.width, height: layer.height, shape: layer.shape };
    case "drawing":
      return { id: layer.id, type: "drawing", x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation, strokes: layer.strokes };
    default:
      return layer;
  }
}

function buzz(): void {
  try {
    navigator.vibrate?.(8);
  } catch {
    // No haptics here; the guide line and the trash are the feedback.
  }
}

interface ComposerCanvasProps {
  layers: readonly EditorLayer[];
  selectedId: string | null;
  dispatch: Dispatch<EditorAction>;
  /** The layer being typed into: hidden here, shown by the text editor. */
  hiddenId: string | null;
  /** Off while a tool owns the pointer (drawing). Layers are still drawn. */
  interactive: boolean;
  renderCall: (layer: Extract<DisplayLayer, { type: "call" }>) => ReactNode;
  onEditText: (id: string) => void;
  /** Describes a layer for a screen reader: "Text: bora", "Photo", "Mention: Ana". */
  describe: (layer: EditorLayer) => string;
  /** A gesture is in flight (the contextual toolbar steps aside). */
  onGesture?: (active: boolean) => void;
}

export function ComposerCanvas({
  layers,
  selectedId,
  dispatch,
  hiddenId,
  interactive,
  renderCall,
  onEditText,
  describe,
  onGesture,
}: ComposerCanvasProps) {
  const { t } = useTranslation();
  const surface = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const liveRef = useRef<Live | null>(null);
  const [guides, setGuides] = useState({ x: false, y: false });
  const [safe, setSafe] = useState<{ near: boolean; outside: boolean }>({ near: false, outside: false });
  const [dragging, setDragging] = useState(false);
  const [hot, setHot] = useState(false);
  const hotRef = useRef(false);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const wheelTimer = useRef<number | null>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  /** A pointer that is not really down (a test, a stylus that lifted) has nothing to capture. */
  const capture = (pointerId: number) => {
    try {
      surface.current?.setPointerCapture(pointerId);
    } catch {
      // Events still arrive while the pointer is over the canvas.
    }
  };

  const publishLive = useCallback((next: Live | null) => {
    liveRef.current = next;
    setLive(next);
  }, []);

  const box = useCallback((): Box => {
    const rect = surface.current?.getBoundingClientRect();
    return { width: rect?.width || 1, height: rect?.height || 1 };
  }, []);

  const local = useCallback((event: { clientX: number; clientY: number }): Point => {
    const rect = surface.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }, []);

  /** A layer's size at scale 1, as drawn (layout size, which a transform does not touch). */
  const naturalOf = useCallback((id: string): Natural | null => {
    const element = surface.current?.querySelector<HTMLElement>(`[data-story-layer="${CSS.escape(id)}"]`);
    if (!element || element.offsetWidth <= 0 || element.offsetHeight <= 0) {
      return null;
    }
    return { width: element.offsetWidth, height: element.offsetHeight };
  }, []);

  const currentOf = useCallback((id: string): Transform | null => {
    const layer = layersRef.current.find((entry) => entry.id === id);
    return layer ? { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation } : null;
  }, []);

  const setActive = useCallback(
    (active: boolean) => {
      setDragging(active);
      onGesture?.(active);
    },
    [onGesture],
  );

  // ---------------------------------------------------------------- pointers
  function beginDrag(event: ReactPointerEvent<HTMLDivElement>, id: string) {
    const start = currentOf(id);
    if (!start) {
      return;
    }
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    gesture.current = { kind: "drag", id, start, from: point, pointerId: event.pointerId, moved: false, startedAt: performance.now(), natural: naturalOf(id) };
    publishLive({ id, ...start });
    dispatch({ type: "select", id });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-story-layer]");
    const id = target?.dataset.storyLayer ?? null;
    const layer = id ? layersRef.current.find((entry) => entry.id === id) : null;
    capture(event.pointerId);
    const current = gesture.current;
    // A second finger while a layer is held: pinch it, wherever the finger lands.
    if (current && current.kind === "drag" && pointers.current.size === 1) {
      const point = local(event);
      const held = pointers.current.get(current.pointerId);
      const live = liveRef.current;
      if (held && live) {
        pointers.current.set(event.pointerId, point);
        const start: Transform = { x: live.x, y: live.y, scale: live.scale, rotation: live.rotation };
        gesture.current = { kind: "pinch", id: current.id, start, ids: [current.pointerId, event.pointerId], from: [held, point], natural: current.natural };
        return;
      }
    }
    if (pointers.current.size > 0) {
      pointers.current.set(event.pointerId, local(event));
      return;
    }
    if (!layer || layer.type === "drawing") {
      dispatch({ type: "select", id: null });
      return;
    }
    beginDrag(event, layer.id);
  }

  function onHandleDown(event: ReactPointerEvent<HTMLElement>, id: string) {
    if (!interactive) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const start = currentOf(id);
    if (!start) {
      return;
    }
    capture(event.pointerId);
    const size = box();
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    gesture.current = {
      kind: "handle",
      id,
      start,
      center: { x: start.x * size.width, y: start.y * size.height },
      grabbed: point,
      pointerId: event.pointerId,
      natural: naturalOf(id),
    };
    publishLive({ id, ...start });
    setActive(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || !pointers.current.has(event.pointerId)) {
      return;
    }
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const size = box();
    if (active.kind === "drag") {
      if (event.pointerId !== active.pointerId) {
        return;
      }
      if (!active.moved) {
        if (Math.hypot(point.x - active.from.x, point.y - active.from.y) < TAP_SLOP) {
          return;
        }
        active.moved = true;
        setActive(true);
      }
      const nowHot = overTrash(point, size);
      if (nowHot !== hotRef.current) {
        hotRef.current = nowHot;
        setHot(nowHot);
        if (nowHot) {
          buzz();
        }
      }
      const moved = dragTo(active.start, active.from, point, size);
      const snapped = nowHot ? { ...moved, guideX: false, guideY: false } : snap(moved);
      setGuides((previous) => {
        if (snapped.guideX && !previous.x) {
          buzz();
        }
        if (snapped.guideY && !previous.y) {
          buzz();
        }
        return previous.x === snapped.guideX && previous.y === snapped.guideY ? previous : { x: snapped.guideX, y: snapped.guideY };
      });
      setSafe(nearSafeEdge(snapped, active.natural, size));
      publishLive({ id: active.id, x: snapped.x, y: snapped.y, scale: snapped.scale, rotation: snapped.rotation });
    } else if (active.kind === "pinch") {
      const a = pointers.current.get(active.ids[0]);
      const b = pointers.current.get(active.ids[1]);
      if (!a || !b) {
        return;
      }
      if (!dragging) {
        setActive(true);
      }
      const next = snap(pinch(active.start, active.from, [a, b], size, active.natural), { rotate: true });
      setGuides({ x: next.guideX, y: next.guideY });
      setSafe(nearSafeEdge(next, active.natural, size));
      publishLive({ id: active.id, x: next.x, y: next.y, scale: next.scale, rotation: next.rotation });
    } else if (event.pointerId === active.pointerId) {
      const turned = handleDrag(active.start, active.center, active.grabbed, point, {
        shift: event.shiftKey,
        fit: active.natural,
        canvas: size,
      });
      const next = snap(turned, { rotate: true });
      setSafe(nearSafeEdge({ ...turned, rotation: next.rotation }, active.natural, size));
      publishLive({ id: active.id, x: active.start.x, y: active.start.y, scale: next.scale, rotation: next.rotation });
    }
  }

  function finish(event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) {
    const active = gesture.current;
    pointers.current.delete(event.pointerId);
    try {
      surface.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    if (!active) {
      return;
    }
    // A pinch ends when either finger lifts; the remaining finger does nothing until it lifts too.
    if (active.kind === "pinch" && pointers.current.size > 0) {
      return;
    }
    if (active.kind === "drag" && event.pointerId !== active.pointerId) {
      return;
    }
    gesture.current = null;
    pointers.current.clear();
    const result = liveRef.current;
    const wasHot = hotRef.current;
    hotRef.current = false;
    setHot(false);
    setGuides({ x: false, y: false });
    setSafe({ near: false, outside: false });
    setActive(false);
    publishLive(null);
    if (cancelled || !result) {
      return;
    }
    if (active.kind === "drag" && !active.moved) {
      const layer = layersRef.current.find((entry) => entry.id === active.id);
      if (layer?.type === "text" && performance.now() - active.startedAt < TAP_MS * 4) {
        onEditText(layer.id);
      }
      return;
    }
    if (active.kind === "drag" && wasHot) {
      dispatch({ type: "remove", id: active.id });
      buzz();
      return;
    }
    dispatch({ type: "patch", id: active.id, patch: { x: result.x, y: result.y, scale: result.scale, rotation: result.rotation } });
  }

  // The wheel scales the layer under the pointer (or the selected one). It has
  // to be a native, non-passive listener to be allowed to stop the page scrolling.
  useEffect(() => {
    const element = surface.current;
    if (!element || !interactive) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-story-layer]");
      const id = target?.dataset.storyLayer ?? selectedRef.current;
      const base = id ? (liveRef.current?.id === id ? liveRef.current : currentOf(id)) : null;
      const layer = id ? layersRef.current.find((entry) => entry.id === id) : null;
      if (!id || !base || !layer || layer.type === "drawing") {
        return;
      }
      event.preventDefault();
      const next: Live = {
        id,
        x: base.x,
        y: base.y,
        rotation: base.rotation,
        scale: wheelScale(base.scale, event.deltaY, { natural: naturalOf(id), rotation: base.rotation, canvas: box() }),
      };
      publishLive(next);
      if (wheelTimer.current !== null) {
        window.clearTimeout(wheelTimer.current);
      }
      wheelTimer.current = window.setTimeout(() => {
        wheelTimer.current = null;
        const settled = liveRef.current;
        publishLive(null);
        if (settled) {
          dispatch({ type: "patch", id: settled.id, patch: { scale: settled.scale } });
        }
      }, 260);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      // A scale still waiting out its pause is committed now (a tool took the pointer),
      // not dropped: what the canvas shows has to be what is posted.
      if (wheelTimer.current !== null) {
        window.clearTimeout(wheelTimer.current);
        wheelTimer.current = null;
        const settled = liveRef.current;
        publishLive(null);
        if (settled) {
          dispatch({ type: "patch", id: settled.id, patch: { scale: settled.scale } });
        }
      }
    };
  }, [interactive, currentOf, naturalOf, box, dispatch, publishLive]);

  function onLayerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, layer: EditorLayer) {
    if (!interactive || event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      dispatch({ type: "remove", id: layer.id });
      return;
    }
    if (event.key === "Enter" && layer.type === "text") {
      event.preventDefault();
      onEditText(layer.id);
      return;
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      dispatch({ type: event.key === "PageUp" ? "forward" : "backward", id: layer.id });
      return;
    }
    const next = keyboardTransform(
      { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation },
      event.key,
      event.shiftKey,
      { natural: naturalOf(layer.id), canvas: box() },
    );
    if (next) {
      event.preventDefault();
      dispatch({ type: "patch", id: layer.id, patch: next });
    }
  }

  const ordered = useMemo(() => layers.filter((layer) => layer.id !== hiddenId), [layers, hiddenId]);

  return (
    <div
      ref={surface}
      data-story-surface=""
      className="absolute inset-0 touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
      onContextMenu={(event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-story-layer]");
        if (target?.dataset.storyLayer) {
          event.preventDefault();
          dispatch({ type: "select", id: target.dataset.storyLayer });
        }
      }}
    >
      {ordered.map((layer) => {
        const overridden = live && live.id === layer.id ? live : null;
        const geometry = overridden ?? layer;
        const display = { ...toDisplay(layer), x: geometry.x, y: geometry.y, scale: geometry.scale, rotation: geometry.rotation } as DisplayLayer;
        const selected = interactive && layer.id === selectedId && layer.type !== "drawing";
        const isDrawing = layer.type === "drawing";
        return (
          <LayerBox
            key={layer.id}
            layer={display}
            role={isDrawing ? undefined : "group"}
            aria-label={isDrawing ? undefined : describe(layer)}
            aria-hidden={isDrawing ? true : undefined}
            tabIndex={isDrawing || !interactive ? -1 : 0}
            className={isDrawing ? "pointer-events-none" : "story-layer"}
            style={{ ...(selected ? ({ "--inv": 1 / geometry.scale } as CSSProperties) : null), zIndex: selected ? 2 : undefined }}
            onFocus={() => interactive && !isDrawing && dispatch({ type: "select", id: layer.id })}
            onKeyDown={(event) => onLayerKeyDown(event, layer)}
          >
            <LayerContent layer={display} renderCall={renderCall} />
            {selected && (
              <>
                <span className="story-layer-frame" aria-hidden />
                <span
                  className="story-layer-handle hidden [@media(pointer:fine)]:block"
                  data-story-handle=""
                  aria-hidden
                  onPointerDown={(event) => onHandleDown(event, layer.id)}
                />
              </>
            )}
          </LayerBox>
        );
      })}

      {dragging && (safe.near || safe.outside) && (
        <span
          aria-hidden
          data-story-safe={safe.outside ? "outside" : "near"}
          className="story-safe"
          style={{
            left: `${STORY_SAFE_AREA.x * 100}%`,
            right: `${STORY_SAFE_AREA.x * 100}%`,
            top: `${STORY_SAFE_AREA.top * 100}%`,
            bottom: `${STORY_SAFE_AREA.bottom * 100}%`,
          }}
        />
      )}
      {dragging && guides.x && (
        <span aria-hidden className="story-guide inset-y-0 left-1/2 w-px -translate-x-1/2" />
      )}
      {dragging && guides.y && (
        <span aria-hidden className="story-guide inset-x-0 top-1/2 h-px -translate-y-1/2" />
      )}
      {dragging && (
        <span className="story-trash" data-hot={hot ? "true" : "false"} data-story-trash="" aria-hidden>
          <Trash2 className="h-[45%] w-[45%]" />
        </span>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {hot ? t("stories.editor.releaseToDelete") : ""}
      </span>
    </div>
  );
}
