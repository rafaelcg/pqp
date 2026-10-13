import { Brush, Check, Eraser, Highlighter, Pen, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  DRAW_TOOLS,
  SIZE_MAX,
  SIZE_MIN,
  appendPointInPlace,
  strokeWidthFor,
  type DrawTool,
  type Stroke,
} from "@/lib/stories/drawing";
import { clamp } from "@/lib/stories/layers";
import { DrawingCanvas } from "./story-layers";
import { ColorSwatches } from "./composer-text";

/**
 * The draw tool: pen, marker, highlighter and eraser on a transparent layer
 * that covers the canvas. The overlay owns the pointer while it is open (the
 * placed layers stand still); each stroke is committed whole on release, so
 * undo takes one stroke at a time.
 */

export interface DrawSettings {
  tool: DrawTool;
  color: string;
  /** 0.5..2.5, the multiplier on the tool's own width. */
  size: number;
}

export const DEFAULT_DRAW: DrawSettings = { tool: "pen", color: "white", size: 1 };

const TOOL_ICON = { pen: Pen, marker: Brush, highlighter: Highlighter, eraser: Eraser } as const;
const TOOL_KEY: Record<DrawTool, MessageKey> = {
  pen: "stories.editor.draw.pen",
  marker: "stories.editor.draw.marker",
  highlighter: "stories.editor.draw.highlighter",
  eraser: "stories.editor.draw.eraser",
};

export function DrawOverlay({
  strokes,
  settings,
  onStroke,
}: {
  strokes: readonly Stroke[];
  settings: DrawSettings;
  onStroke: (stroke: Stroke) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const [current, setCurrent] = useState<Stroke | null>(null);
  // The stroke in progress lives in a buffer that grows in place; what is drawn is a
  // snapshot of it, taken at most once a frame, so a long stroke costs a frame, not a copy per sample.
  const head = useRef<Omit<Stroke, "points"> | null>(null);
  const buffer = useRef<number[]>([]);
  const frame = useRef<number | null>(null);

  const publish = () => {
    frame.current = null;
    if (head.current) {
      setCurrent({ ...head.current, points: buffer.current.slice() });
    }
  };
  useEffect(
    () => () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
      }
    },
    [],
  );

  const normalize = (event: { clientX: number; clientY: number }) => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return null;
    }
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
  };

  function down(event: ReactPointerEvent<HTMLDivElement>) {
    // One finger draws. A second one (a palm, a pinch) is ignored, not a second stroke.
    if (pointer.current !== null || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }
    const point = normalize(event);
    if (!point) {
      return;
    }
    pointer.current = event.pointerId;
    try {
      surface.current?.setPointerCapture(event.pointerId);
    } catch {
      // Not an active pointer (a synthetic event): the surface still gets the moves.
    }
    head.current = {
      tool: settings.tool,
      color: settings.color,
      width: strokeWidthFor(settings.tool, settings.size),
    };
    buffer.current = [point.x, point.y];
    publish();
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointer.current !== event.pointerId || !head.current) {
      return;
    }
    // A fast stroke arrives as several samples per event; take all of them.
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    let added = false;
    for (const sample of samples.length > 0 ? samples : [event.nativeEvent]) {
      const point = normalize(sample);
      if (point && appendPointInPlace(buffer.current, point.x, point.y)) {
        added = true;
      }
    }
    if (added && frame.current === null) {
      frame.current = requestAnimationFrame(publish);
    }
  }

  function up(event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) {
    if (pointer.current !== event.pointerId) {
      return;
    }
    pointer.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    const done: Stroke | null = head.current ? { ...head.current, points: buffer.current.slice() } : null;
    head.current = null;
    buffer.current = [];
    setCurrent(null);
    try {
      surface.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    if (done && !cancelled) {
      onStroke(done);
    }
  }

  return (
    <div
      ref={surface}
      data-story-draw-surface=""
      className="absolute inset-0 z-20 touch-none"
      style={{ cursor: "crosshair" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={(event) => up(event, false)}
      onPointerCancel={(event) => up(event, true)}
    >
      {/* The drawing, live: the committed strokes and the one being drawn, on one canvas (the
          layer underneath is hidden while this is open, so a highlighter never stacks on itself). */}
      <div className="pointer-events-none absolute inset-0">
        <DrawingCanvas strokes={current ? [...strokes, current] : strokes} />
      </div>
    </div>
  );
}

export function DrawBar({
  settings,
  onChange,
  onUndo,
  canUndo,
  onDone,
}: {
  settings: DrawSettings;
  onChange: (next: DrawSettings) => void;
  onUndo: () => void;
  canUndo: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2" data-story-draw-bar="">
      <div className="flex items-center gap-1.5 px-2">
        <div role="radiogroup" aria-label={t("stories.editor.drawTool")} className="flex flex-1 items-center justify-center gap-1.5">
          {DRAW_TOOLS.map((tool) => {
            const Icon = TOOL_ICON[tool];
            const selected = settings.tool === tool;
            return (
              <button
                key={tool}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t(TOOL_KEY[tool])}
                data-story-tool={tool}
                onClick={() => onChange({ ...settings, tool })}
                className="story-cbtn"
                style={selected ? { background: "var(--story-on-media)", color: "var(--story-card)" } : undefined}
              >
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </button>
            );
          })}
        </div>
        <button type="button" className="story-cbtn" aria-label={t("stories.editor.undo")} disabled={!canUndo} onClick={onUndo}>
          <Undo2 className="h-[18px] w-[18px]" aria-hidden />
        </button>
        <button
          type="button"
          className="story-cbtn !px-3.5"
          data-story-draw-done=""
          style={{ background: "var(--story-accent)", color: "var(--story-on-accent)" }}
          onClick={onDone}
        >
          <Check className="h-4 w-4" aria-hidden />
          {t("stories.compose.done")}
        </button>
      </div>
      <div className="flex items-center gap-3 px-5">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--story-on-media-2)" }} />
        <input
          type="range"
          min={SIZE_MIN}
          max={SIZE_MAX}
          step={0.05}
          value={settings.size}
          aria-label={t("stories.editor.size")}
          onChange={(event) => onChange({ ...settings, size: Number(event.target.value) })}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--story-accent)]"
        />
        <span aria-hidden className="h-4 w-4 rounded-full" style={{ background: "var(--story-on-media-2)" }} />
      </div>
      {settings.tool !== "eraser" && (
        <ColorSwatches value={settings.color} onChange={(color) => onChange({ ...settings, color })} label={t("stories.editor.color")} />
      )}
    </div>
  );
}
