import { AlignCenter, AlignLeft, AlignRight, Check, PaintBucket, X } from "lucide-react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  STORY_LAYER_ALIGNS,
  STORY_LAYER_COLORS,
  STORY_LAYER_FONTS,
  STORY_LAYER_TEXT_BACKGROUNDS,
  STORY_LAYER_SCALE_MAX,
  STORY_LAYER_SCALE_MIN,
  STORY_SAFE_AREA,
  STORY_TEXT_MAX,
} from "@pqp/shared";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { useWheelScrollX } from "@/lib/use-wheel-scroll-x";
import { NO_INSET, fitTextEdit } from "@/lib/stories/layer-gestures";
import { layerStyle, type TextLayerFields } from "@/lib/stories/layers";

/**
 * The text tool: editing the layer where it is (see `TextEditor`), and the
 * palette it shares with the draw tool.
 */

const FONT_KEY: Record<TextLayerFields["font"], MessageKey> = {
  classic: "stories.editor.font.classic",
  bold: "stories.editor.font.bold",
  typewriter: "stories.editor.font.typewriter",
  serif: "stories.editor.font.serif",
  neon: "stories.editor.font.neon",
};
const COLOR_KEY: Record<TextLayerFields["color"], MessageKey> = {
  white: "stories.editor.color.white",
  black: "stories.editor.color.black",
  lime: "stories.editor.color.lime",
  yellow: "stories.editor.color.yellow",
  orange: "stories.editor.color.orange",
  red: "stories.editor.color.red",
  pink: "stories.editor.color.pink",
  purple: "stories.editor.color.purple",
  blue: "stories.editor.color.blue",
  cyan: "stories.editor.color.cyan",
  green: "stories.editor.color.green",
  gray: "stories.editor.color.gray",
};
const BACKGROUND_KEY: Record<TextLayerFields["background"], MessageKey> = {
  none: "stories.editor.textBg.none",
  solid: "stories.editor.textBg.solid",
  soft: "stories.editor.textBg.soft",
};
const ALIGN_KEY: Record<TextLayerFields["align"], MessageKey> = {
  left: "stories.editor.align.left",
  center: "stories.editor.align.center",
  right: "stories.editor.align.right",
};

function next<T>(list: readonly T[], value: T): T {
  return list[(list.indexOf(value) + 1) % list.length]!;
}

/** The swatch row: the palette as tokens, each a button with its name. Shared with the draw tool. */
export function ColorSwatches({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (color: (typeof STORY_LAYER_COLORS)[number]) => void;
  label: string;
}) {
  const { t } = useTranslation();
  // Twelve swatches do not fit in the column: a mouse wheel scrolls the row, or the last two are out of reach.
  const row = useRef<HTMLDivElement>(null);
  useWheelScrollX(row);
  return (
    <div ref={row} role="radiogroup" aria-label={label} className="flex items-center gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none]">
      {STORY_LAYER_COLORS.map((color) => {
        const selected = value === color;
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t(COLOR_KEY[color])}
            data-story-color={color}
            onClick={() => onChange(color)}
            className="h-7 w-7 shrink-0 rounded-full transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none"
            style={{
              background: `var(--story-c-${color})`,
              transform: selected ? "scale(1.18)" : undefined,
              boxShadow: selected
                ? "0 0 0 2px var(--story-card), 0 0 0 4px var(--story-on-media)"
                : "0 0 0 1.5px var(--story-field-edge)",
            }}
          />
        );
      })}
    </div>
  );
}

export interface TextEditorGeometry {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

interface TextEditorProps {
  initial: TextLayerFields;
  /** Where the layer is, and how big and tilted: the words are edited right there. */
  geometry: TextEditorGeometry;
  /** The text, its style and its scale as they are now (the scale is the size slider's). */
  onDone: (fields: TextLayerFields, scale: number, center: { x: number; y: number }) => void;
  onCancel: () => void;
  /**
   * How far the whole stage has to rise to keep the layer (and the controls under it) above
   * a soft keyboard, in CSS pixels. 0 when nothing is covered. Called as the keyboard comes and goes.
   */
  onLift?: (pixels: number) => void;
  /**
   * New words are kept out of the band a viewer's own chrome covers (progress bars and header on
   * top, the reply row below): sized and placed to fit what is left. Words already on the canvas
   * are only kept on the canvas itself, so editing one never pulls it somewhere the author put it.
   */
  keepClearOfChrome?: boolean;
}

/** What a soft keyboard takes off the bottom of the window, from the visual viewport (0 without one). */
function keyboardHeight(): number {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  if (!viewport) {
    return 0;
  }
  return Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
}

/**
 * The text tool, IN PLACE. The words are typed where the layer is, at its size and tilt,
 * so nothing jumps when editing starts or ends. The canvas dims behind them; the strip
 * above and the palette and slider below change the layer LIVE (font, background,
 * alignment, color, and the slider is the layer's own scale). "Done" just stops
 * editing: one history step for the whole edit, no move.
 *
 * On a phone the keyboard can cover the layer: the whole stage rises just enough to
 * show it and settles back after (`onLift`), the layer's own position never changes.
 */
export function TextEditor({ initial, geometry, onDone, onCancel, onLift, keepClearOfChrome = false }: TextEditorProps) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<TextLayerFields>(initial);
  const [scale, setScale] = useState(geometry.scale);
  const area = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const patch = (change: Partial<TextLayerFields>) => setFields((current) => ({ ...current, ...change }));

  // What the words may be and where they sit (`fitTextEdit`): NEW words are fitted to the canvas less
  // the chrome band; words already placed are held to the canvas and left where the author put them
  // unless they are bigger than it. Measured from the field's own size at scale 1, so it follows the
  // words, the font and the canvas as they change. The measurement lives in a ref and the editor
  // re-renders only when what it would draw actually changes, so most keystrokes cost nothing extra.
  const inset = keepClearOfChrome ? STORY_SAFE_AREA : NO_INSET;
  const measured = useRef<{ natural: { width: number; height: number }; canvas: { width: number; height: number } } | null>(null);
  // The words' own size when the edit opened: whether they fitted then decides how they are held.
  const startNatural = useRef<{ width: number; height: number } | null>(null);
  const drawn = useRef<{ scale: number; maxScale: number; center: { x: number; y: number } } | null>(null);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const fitFor = (requested: number) =>
    measured.current
      ? fitTextEdit({
          ...measured.current,
          rotation: geometry.rotation,
          scale: requested,
          center: { x: geometry.x, y: geometry.y },
          startScale: geometry.scale,
          startNatural: startNatural.current ?? measured.current.natural,
          inset,
          isNew: keepClearOfChrome,
          maxScaleCap: STORY_LAYER_SCALE_MAX,
        })
      : { maxScale: STORY_LAYER_SCALE_MAX, scale: requested, center: { x: geometry.x, y: geometry.y } };
  const fitNow = fitFor(scale);
  const { maxScale, scale: shownScale, center } = fitNow;
  drawn.current = fitNow;
  const latest = useRef({ fitFor, scale });
  latest.current = { fitFor, scale };
  const remeasure = useRef(() => {});
  remeasure.current = () => {
    const element = box.current;
    const canvas = root.current;
    if (!element || !canvas) {
      return;
    }
    measured.current = {
      natural: { width: element.offsetWidth, height: element.offsetHeight },
      canvas: { width: canvas.clientWidth, height: canvas.clientHeight },
    };
    startNatural.current ??= measured.current.natural;
    const next = latest.current.fitFor(latest.current.scale);
    const was = drawn.current;
    if (
      !was ||
      Math.abs(next.scale - was.scale) > 1e-4 ||
      Math.abs(next.maxScale - was.maxScale) > 1e-4 ||
      Math.abs(next.center.x - was.center.x) > 1e-5 ||
      Math.abs(next.center.y - was.center.y) > 1e-5
    ) {
      redraw();
    }
  };
  // Everything that changes the words' natural size.
  useLayoutEffect(() => {
    remeasure.current();
  }, [fields.text, fields.font, fields.size, fields.align, fields.background, geometry.rotation]);
  // The canvas itself changing size (a rotated phone, a resized window) changes the room and the words' size.
  useLayoutEffect(() => {
    const canvas = root.current;
    if (!canvas || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => remeasure.current());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = area.current;
    if (element) {
      element.focus({ preventScroll: true });
      const end = element.value.length;
      element.setSelectionRange(end, end);
    }
  }, []);

  // Keep the layer above the keyboard. Measured where the layer really is, after tilt and scale.
  const lifted = useRef(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !onLift) {
      return;
    }
    const settle = () => {
      const element = box.current;
      const keyboard = keyboardHeight();
      if (!element || keyboard <= 0) {
        lifted.current = 0;
        onLift(0);
        return;
      }
      const rect = element.getBoundingClientRect();
      // Where the layer would be with the stage back down.
      const bottom = rect.bottom + lifted.current;
      const top = rect.top + lifted.current;
      const visibleBottom = viewport.offsetTop + viewport.height;
      const need = Math.max(0, bottom + 16 - visibleBottom);
      // Never so far that the layer's top leaves the window.
      const room = Math.max(0, top - 8);
      lifted.current = Math.min(need, room);
      onLift(lifted.current);
    };
    settle();
    viewport.addEventListener("resize", settle);
    viewport.addEventListener("scroll", settle);
    return () => {
      viewport.removeEventListener("resize", settle);
      viewport.removeEventListener("scroll", settle);
      onLift(0);
    };
    // The layer moves as the text grows and as the slider scales it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.text, fields.font, scale, geometry.x, geometry.y, geometry.rotation]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onDone(fields, shownScale, center);
    }
  }

  const AlignIcon = fields.align === "left" ? AlignLeft : fields.align === "right" ? AlignRight : AlignCenter;
  const style = { "--tl-size": fields.size, "--tl-align": fields.align } as CSSProperties;

  return (
    <div
      role="group"
      ref={root}
      aria-label={t("stories.editor.textTool")}
      data-story-text-editor=""
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-30 overflow-hidden"
    >
      {/* Tapping outside the words ends the edit, as Done does. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        data-story-text-backdrop=""
        className="story-dim absolute inset-0 cursor-default"
        onClick={() => onDone(fields, shownScale, center)}
      />

      {/* The layer, where it is: same center, same scale, same tilt as on the canvas. */}
      <div ref={box} data-story-text-box="" style={{ ...layerStyle({ id: "editing", ...geometry, ...center, scale: shownScale }), ...style }}>
        <div className="grid max-w-full">
          {/* The mirror sizes the box to the words; the field is laid over it. */}
          <div
            aria-hidden
            className="story-tl invisible col-start-1 row-start-1"
            data-font={fields.font}
            data-color={fields.color}
            data-bg={fields.background}
            style={style}
          >
            {(fields.text || t("stories.editor.textPlaceholder")) + "\u200b"}
          </div>
          <textarea
            ref={area}
            value={fields.text}
            maxLength={STORY_TEXT_MAX}
            rows={1}
            spellCheck
            data-story-text=""
            aria-label={t("stories.compose.textLabel")}
            placeholder={t("stories.editor.textPlaceholder")}
            onChange={(event) => patch({ text: event.target.value })}
            className="story-tl story-field col-start-1 row-start-1 resize-none overflow-hidden border-0 outline-none"
            data-font={fields.font}
            data-color={fields.color}
            data-bg={fields.background}
            // Width and height 0 with a 100% minimum: the field fills the cell the mirror sizes, and adds nothing to it.
            style={{ ...style, width: 0, height: 0, minWidth: "100%", minHeight: "100%", maxWidth: "none", padding: 0, caretColor: "var(--story-accent)" }}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 pt-3">
        <button type="button" className="story-cbtn pointer-events-auto" aria-label={t("common.cancel")} onClick={onCancel}>
          <X className="h-[18px] w-[18px]" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          <button
            type="button"
            className="story-cbtn pointer-events-auto"
            data-story-font={fields.font}
            aria-label={`${t("stories.editor.font")}: ${t(FONT_KEY[fields.font])}`}
            onClick={() => patch({ font: next(STORY_LAYER_FONTS, fields.font) })}
          >
            <span className="story-tl !text-[15px] !shadow-none" data-font={fields.font} data-bg="none" style={{ textShadow: "none" }}>
              Aa
            </span>
          </button>
          <button
            type="button"
            className="story-cbtn pointer-events-auto"
            aria-pressed={fields.background !== "none"}
            aria-label={`${t("stories.editor.textBg")}: ${t(BACKGROUND_KEY[fields.background])}`}
            onClick={() => patch({ background: next(STORY_LAYER_TEXT_BACKGROUNDS, fields.background) })}
          >
            <PaintBucket className="h-[18px] w-[18px]" aria-hidden />
          </button>
          <button
            type="button"
            className="story-cbtn pointer-events-auto"
            aria-label={`${t("stories.editor.align")}: ${t(ALIGN_KEY[fields.align])}`}
            onClick={() => patch({ align: next(STORY_LAYER_ALIGNS, fields.align) })}
          >
            <AlignIcon className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="story-cbtn pointer-events-auto !px-3.5"
          data-story-text-done=""
          style={{ background: "var(--story-accent)", color: "var(--story-on-accent)" }}
          onClick={() => onDone(fields, shownScale, center)}
        >
          <Check className="h-4 w-4" aria-hidden />
          {t("stories.compose.done")}
        </button>
      </div>

      <div className="absolute inset-x-0 bottom-0 space-y-2 pb-3">
        <div className="flex items-center gap-3 px-5">
          <span className="story-tl !text-[12px] !shadow-none" aria-hidden style={{ textShadow: "none" }}>
            A
          </span>
          <input
            type="range"
            min={STORY_LAYER_SCALE_MIN}
            max={maxScale}
            step={0.02}
            value={shownScale}
            aria-label={t("stories.editor.size")}
            data-story-size=""
            onChange={(event) => setScale(Number(event.target.value))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--story-accent)]"
          />
          <span className="story-tl !text-[22px] !shadow-none" aria-hidden style={{ textShadow: "none" }}>
            A
          </span>
        </div>
        <ColorSwatches value={fields.color} onChange={(color) => patch({ color })} label={t("stories.editor.color")} />
      </div>
    </div>
  );
}
