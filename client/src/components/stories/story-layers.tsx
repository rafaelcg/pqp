import { forwardRef, useLayoutEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import type { StoryLayer } from "@pqp/shared";
import { colorFromTokens, paintStrokes, type Stroke } from "@/lib/stories/drawing";
import {
  CALL_CARD_CQW,
  IMAGE_BASE_CQW,
  IMAGE_ROUNDED_CQW,
  MENTION_BASE_CQW,
  layerStyle,
  type ImageShape,
  type LayerGeometry,
  type TextLayerFields,
} from "@/lib/stories/layers";
import { cn } from "@/lib/utils";

/**
 * How a story layer LOOKS, with no interaction in it. The editor wraps these
 * in handles and gestures; the viewer draws them as they are. One drawing
 * path means a story looks the same before and after it is posted, at any
 * canvas size: every length here is a fraction of the canvas width (`cqw`),
 * and the canvas is a size container (see `.story-cmp-canvas` and
 * `StoryContent`).
 */

/** Who a tap on a mention opens. */
export interface MentionTarget {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

export type DisplayLayer =
  | (LayerGeometry & { type: "text" } & TextLayerFields)
  | (LayerGeometry & { type: "image"; src: string; width: number; height: number; shape: ImageShape })
  | (LayerGeometry & { type: "drawing"; src?: string; strokes?: readonly Stroke[] })
  | (LayerGeometry & { type: "call" })
  | (LayerGeometry & { type: "mention"; userId: string; name: string; avatarUrl?: string | null });

/** A layer read from the server, as the viewer draws it. */
export function displayLayerFrom(layer: StoryLayer): DisplayLayer {
  const geometry = { id: layer.id, x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation };
  switch (layer.type) {
    case "text":
      return {
        ...geometry,
        type: "text",
        text: layer.text,
        font: layer.font,
        color: layer.color,
        background: layer.background,
        align: layer.align,
        size: layer.size,
      };
    case "image":
      return { ...geometry, type: "image", src: layer.url, width: layer.width, height: layer.height, shape: layer.shape };
    case "drawing":
      return { ...geometry, type: "drawing", src: layer.url };
    case "call":
      return { ...geometry, type: "call" };
    case "mention":
      return { ...geometry, type: "mention", userId: layer.userId, name: layer.user.displayName, avatarUrl: layer.user.avatarUrl };
  }
}

export function TextLayerView({ layer, className }: { layer: TextLayerFields; className?: string }) {
  return (
    <div
      className={cn("story-tl", className)}
      data-font={layer.font}
      data-color={layer.color}
      data-bg={layer.background}
      style={{ "--tl-size": layer.size, "--tl-align": layer.align } as CSSProperties}
    >
      {layer.text}
    </div>
  );
}

function ImageLayerView({ layer }: { layer: Extract<DisplayLayer, { type: "image" }> }) {
  const circle = layer.shape === "circle";
  return (
    <img
      src={layer.src}
      alt=""
      draggable={false}
      decoding="async"
      className="block select-none"
      style={{
        width: `${IMAGE_BASE_CQW}cqw`,
        // The reset caps an img at 100% of its parent; the parent is as wide as this, so no cap.
        maxWidth: "none",
        // A circle crops to a square; the others keep the picture's own shape.
        aspectRatio: circle ? "1 / 1" : `${layer.width} / ${layer.height}`,
        objectFit: "cover",
        borderRadius: circle ? "50%" : layer.shape === "rounded" ? `${IMAGE_ROUNDED_CQW}cqw` : 0,
        boxShadow: "var(--story-layer-shadow)",
      }}
    />
  );
}

/** Strokes painted live on a canvas that fills the layer, at the device's resolution. */
export function DrawingCanvas({ strokes, className }: { strokes: readonly Stroke[]; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) {
      return;
    }
    const paint = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d");
      if (context) {
        paintStrokes(context, strokes, colorFromTokens);
      }
    };
    paint();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    observer?.observe(canvas);
    return () => observer?.disconnect();
  }, [strokes]);
  return <canvas ref={ref} aria-hidden className={cn("block h-full w-full", className)} />;
}

function MentionChip({
  name,
  userId,
  avatarUrl,
  onOpen,
}: {
  name: string;
  userId: string;
  avatarUrl: string | null;
  /** In the viewer a mention is a button that opens the person; on the canvas it is just a chip. */
  onOpen?: (person: MentionTarget, anchor: HTMLElement) => void;
}) {
  const Tag = onOpen ? "button" : "span";
  return (
    <Tag
      data-story-mention=""
      {...(onOpen
        ? {
            type: "button" as const,
            "aria-label": name,
            onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
            onClick: (event: React.MouseEvent<HTMLElement>) => {
              event.stopPropagation();
              onOpen({ userId, name, avatarUrl }, event.currentTarget);
            },
          }
        : {})}
      className={cn(
        "inline-flex max-w-[80cqw] items-center whitespace-nowrap rounded-full font-extrabold",
        onOpen && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
      )}
      style={{
        fontFamily: '"Gabarito", "Instrument Sans", system-ui, sans-serif',
        fontSize: `${MENTION_BASE_CQW}cqw`,
        padding: "0.28em 0.8em",
        background: "var(--story-on-media)",
        color: "var(--story-card)",
        boxShadow: "var(--story-layer-shadow)",
      }}
    >
      <span className="truncate">@{name}</span>
    </Tag>
  );
}

/** The inside of one layer. `renderCall` draws the call card, which the story owns (it is live). */
export function LayerContent({
  layer,
  renderCall,
  onOpenMention,
}: {
  layer: DisplayLayer;
  renderCall?: (layer: Extract<DisplayLayer, { type: "call" }>) => ReactNode;
  onOpenMention?: (person: MentionTarget, anchor: HTMLElement) => void;
}) {
  switch (layer.type) {
    case "text":
      return <TextLayerView layer={layer} />;
    case "image":
      return <ImageLayerView layer={layer} />;
    case "drawing":
      return layer.strokes ? (
        <DrawingCanvas strokes={layer.strokes} />
      ) : (
        <img src={layer.src} alt="" draggable={false} className="block h-full w-full select-none" />
      );
    case "call":
      return <div style={{ width: `${CALL_CARD_CQW}cqw` }}>{renderCall?.(layer) ?? null}</div>;
    case "mention":
      return <MentionChip name={layer.name} userId={layer.userId} avatarUrl={layer.avatarUrl ?? null} onOpen={onOpenMention} />;
  }
}

/** A drawing covers the canvas; everything else is as big as it is. */
export function layerBoxStyle(layer: DisplayLayer): CSSProperties {
  const base = layerStyle(layer);
  return layer.type === "drawing" ? { ...base, width: "100cqw", height: "100cqh" } : base;
}

interface LayerBoxProps extends HTMLAttributes<HTMLDivElement> {
  layer: DisplayLayer;
}

/** One placed layer: positioned, turned and scaled. The viewer uses it as it is. */
export const LayerBox = forwardRef<HTMLDivElement, LayerBoxProps>(function LayerBox(
  { layer, style, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} data-story-layer={layer.id} data-layer-type={layer.type} style={{ ...layerBoxStyle(layer), ...style }} {...rest}>
      {children}
    </div>
  );
});

/** Every layer, back to front, with nothing interactive. */
export function LayerStack({
  layers,
  renderCall,
}: {
  layers: readonly DisplayLayer[];
  renderCall?: (layer: Extract<DisplayLayer, { type: "call" }>) => ReactNode;
}) {
  return (
    <>
      {layers.map((layer) => (
        <LayerBox key={layer.id} layer={layer} style={layer.type === "drawing" ? { pointerEvents: "none" } : undefined}>
          <LayerContent layer={layer} renderCall={renderCall} />
        </LayerBox>
      ))}
    </>
  );
}
