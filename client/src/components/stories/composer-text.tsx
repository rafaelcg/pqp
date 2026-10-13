import { AlignCenter, AlignLeft, AlignRight, Check, PaintBucket, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  STORY_LAYER_ALIGNS,
  STORY_LAYER_COLORS,
  STORY_LAYER_FONTS,
  STORY_LAYER_TEXT_BACKGROUNDS,
  STORY_LAYER_TEXT_SIZE_MAX,
  STORY_LAYER_TEXT_SIZE_MIN,
  STORY_TEXT_MAX,
} from "@pqp/shared";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { TextLayerFields } from "@/lib/stories/layers";
import { cn } from "@/lib/utils";

/**
 * The text tool. The canvas dims, the words are typed straight onto it in the
 * layer's own type (so what is typed is what is placed), and the strip above
 * and below cycles font, background, alignment, color and size. "Pronto"
 * places it, in the middle, to be dragged wherever it belongs.
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
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none]">
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

interface TextEditorProps {
  initial: TextLayerFields;
  /** `null` text means the layer should go (it was emptied). */
  onDone: (fields: TextLayerFields) => void;
  onCancel: () => void;
}

export function TextEditor({ initial, onDone, onCancel }: TextEditorProps) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<TextLayerFields>(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  const patch = (change: Partial<TextLayerFields>) => setFields((current) => ({ ...current, ...change }));

  useEffect(() => {
    const element = area.current;
    if (element) {
      element.focus({ preventScroll: true });
      const end = element.value.length;
      element.setSelectionRange(end, end);
    }
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onDone(fields);
    }
  }

  const AlignIcon = fields.align === "left" ? AlignLeft : fields.align === "right" ? AlignRight : AlignCenter;
  const style = { "--tl-size": fields.size, "--tl-align": fields.align } as CSSProperties;

  return (
    <div
      role="group"
      aria-label={t("stories.editor.textTool")}
      data-story-text-editor=""
      onKeyDown={onKeyDown}
      className="story-dim absolute inset-0 z-30 flex flex-col"
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <button type="button" className="story-cbtn" aria-label={t("common.cancel")} onClick={onCancel}>
          <X className="h-[18px] w-[18px]" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          <button
            type="button"
            className="story-cbtn"
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
            className="story-cbtn"
            aria-pressed={fields.background !== "none"}
            aria-label={`${t("stories.editor.textBg")}: ${t(BACKGROUND_KEY[fields.background])}`}
            onClick={() => patch({ background: next(STORY_LAYER_TEXT_BACKGROUNDS, fields.background) })}
          >
            <PaintBucket className="h-[18px] w-[18px]" aria-hidden />
          </button>
          <button
            type="button"
            className="story-cbtn"
            aria-label={`${t("stories.editor.align")}: ${t(ALIGN_KEY[fields.align])}`}
            onClick={() => patch({ align: next(STORY_LAYER_ALIGNS, fields.align) })}
          >
            <AlignIcon className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="story-cbtn !px-3.5"
          data-story-text-done=""
          style={{ background: "var(--story-accent)", color: "var(--story-on-accent)" }}
          onClick={() => onDone(fields)}
        >
          <Check className="h-4 w-4" aria-hidden />
          {t("stories.compose.done")}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-[8%]">
        <div className="grid max-h-full max-w-full overflow-hidden" style={style}>
          {/* The mirror sizes the box to the words; the field is laid over it. */}
          <div
            aria-hidden
            className="story-tl invisible col-start-1 row-start-1"
            data-font={fields.font}
            data-color={fields.color}
            data-bg={fields.background}
            style={style}
          >
            {(fields.text || t("stories.editor.textPlaceholder")) + "​"}
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
            className={cn("story-tl story-field col-start-1 row-start-1 resize-none overflow-hidden border-0 outline-none")}
            data-font={fields.font}
            data-color={fields.color}
            data-bg={fields.background}
            style={{ ...style, width: "100%", maxWidth: "none", height: "100%", caretColor: "var(--story-accent)" }}
          />
        </div>
      </div>

      <div className="space-y-2 pb-3">
        <div className="flex items-center gap-3 px-5">
          <span className="story-tl !text-[12px] !shadow-none" aria-hidden style={{ textShadow: "none" }}>
            A
          </span>
          <input
            type="range"
            min={STORY_LAYER_TEXT_SIZE_MIN}
            max={STORY_LAYER_TEXT_SIZE_MAX}
            step={0.05}
            value={fields.size}
            aria-label={t("stories.editor.size")}
            data-story-size=""
            onChange={(event) => patch({ size: Number(event.target.value) })}
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
