import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type Ref, type RefObject } from "react";
import { storyBaseFit, type StoryBackground, type StoryCallLive, type StoryKind } from "@pqp/shared";
import { cn } from "@/lib/utils";
import { StoryCallCard, type CallCardServer } from "./story-call-card";
import { LayerBox, LayerContent, type DisplayLayer, type MentionTarget } from "./story-layers";

/**
 * What a story looks like, without any of the viewer around it: the picture,
 * the clip or the text card, the layers placed on it, and (for a story from an
 * older build) the caption and the call sticker. The viewer, the deck's
 * outgoing card and the composer's preview all draw through this, so a story
 * looks the same before and after it is posted.
 *
 * The card is a size container, so a text card's type scales with the card
 * rather than with the window. LAYERS live on a 9:16 canvas of their own that
 * covers the card the way the picture does: on a screen that is not 9:16 (a
 * phone is taller) the base and the layers are cropped by the same amount, so
 * a layer stays on the part of the picture it was put on, and whatever falls
 * outside the card is clipped.
 */

export interface StoryDisplay {
  id: string;
  kind: StoryKind;
  text: string | null;
  background: StoryBackground | null;
  caption: string | null;
  mediaUrl: string | null;
  posterUrl: string | null;
  call: StoryCallLive | null;
  /** Placed layers, back to front. Empty for a story from before layers. */
  layers?: readonly DisplayLayer[];
  /** What a screen reader gets for the story. */
  altText?: string | null;
  /** The base picture's size, to decide how it meets the 9:16 canvas (`storyBaseFit`). */
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  /** The server the call card belongs to, for its name and icon. */
  callServer?: CallCardServer | null;
  /** Composer preview only: the room picked, before there is a live roster. */
  callPreview?: { channelName: string; names: string[] } | null;
}

interface StoryContentProps {
  story: StoryDisplay;
  /** Mount the video element. False during the open zoom (design §4). */
  playVideo?: boolean;
  muted?: boolean;
  paused?: boolean;
  onJoinCall?: (call: StoryCallLive) => void;
  /** A tap on a mention: open that person's card. `anchor` is the chip. */
  onOpenMention?: (person: MentionTarget, anchor: HTMLElement) => void;
  /** Video: its own length and position drive the bar. */
  onVideoDuration?: (ms: number) => void;
  onVideoTime?: (ms: number) => void;
  onVideoEnded?: () => void;
  /** Play again from the start (the composer's preview of a clip). */
  loop?: boolean;
  className?: string;
  /** Freeze: an outgoing deck card or a thumbnail. No controls, no playback. */
  still?: boolean;
  /** Draw the layers (default) or only the base, for the editor, which draws its own. */
  withLayers?: boolean;
  /**
   * CSS pixels kept clear along the bottom for a row of the viewer's own (the reply
   * bar). A call card or a mention that would sit on it is lifted just clear of it; text,
   * photos and the drawing, which cannot be tapped, are left where they were put.
   */
  reserveBottom?: number;
}

/** Where a text card's words sit. Kept for stories from before layers. */
export const TEXT_CARD_BOX_CLASS =
  "absolute left-[7.5%] right-[7.5%] top-[17%] whitespace-pre-wrap break-words font-display font-black tracking-[-0.01em]";

export function textCardSizeClass(text: string): string {
  const length = [...text].length;
  if (length <= 40) {
    return "text-[10.5cqw] leading-[1.02]";
  }
  if (length <= 110) {
    return "text-[8cqw] leading-[1.06]";
  }
  return "text-[6cqw] leading-[1.15]";
}

/**
 * The 9:16 box the layers are placed in: as wide as the card, or as tall as
 * it, whichever covers it (the `object-fit: cover` rule), centered. It is a
 * size container itself so every layer's `cqw` is a fraction of THIS canvas.
 */
/**
 * The same 9:16 box, for a base picture shown whole: it sits inside the canvas
 * the layers are placed on, so a layer stays on the part of the picture it was
 * put on however the base meets the card.
 */
function CoverBox({ children }: { children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-1/2"
      style={{
        width: "max(100cqw, calc(100cqh * 9 / 16))",
        aspectRatio: "9 / 16",
        transform: "translate(-50%, -50%)",
      }}
    >
      {children}
    </div>
  );
}

export function LayerCanvas({ children }: { children: ReactNode }) {
  return (
    <div
      data-story-layer-canvas=""
      className="pointer-events-none absolute left-1/2 top-1/2 [container-type:size]"
      style={{
        width: "max(100cqw, calc(100cqh * 9 / 16))",
        aspectRatio: "9 / 16",
        transform: "translate(-50%, -50%)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * A placed layer that keeps a tappable thing off the viewer's own bottom row. It is
 * measured where it really is (after scale and rotation) and moved with the CSS
 * `translate` property, which leaves the layer's own transform alone.
 */
function LiftedBox({
  layer,
  rootRef,
  reserve,
  children,
}: {
  layer: DisplayLayer;
  rootRef: RefObject<HTMLDivElement | null>;
  reserve: number;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    // A child's layout effect runs before its parent's ref is set, so the root is found by its mark.
    const root = rootRef.current ?? element?.closest<HTMLElement>("[data-story-root]") ?? null;
    if (!element || !root || reserve <= 0) {
      return;
    }
    const measure = () => {
      element.style.translate = "0 0";
      const overlap = element.getBoundingClientRect().bottom - (root.getBoundingClientRect().bottom - reserve);
      element.style.translate = overlap > 0 ? `0 ${-Math.ceil(overlap)}px` : "0 0";
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(element);
    return () => observer.disconnect();
  }, [reserve, rootRef, layer.x, layer.y, layer.scale, layer.rotation]);
  return (
    <LayerBox
      ref={box}
      layer={layer}
      style={{ pointerEvents: layer.type === "call" || layer.type === "mention" ? "auto" : "none" }}
    >
      {children}
    </LayerBox>
  );
}

export const StoryContent = forwardRef(function StoryContent(
  {
    story,
    playVideo = true,
    muted = true,
    paused = false,
    onJoinCall,
    onOpenMention,
    onVideoDuration,
    onVideoTime,
    onVideoEnded,
    loop = false,
    className,
    still = false,
    withLayers = true,
    reserveBottom = 0,
  }: StoryContentProps,
  ref: Ref<HTMLDivElement>,
) {
  const root = useRef<HTMLDivElement | null>(null);
  const setRoot = useCallback(
    (element: HTMLDivElement | null) => {
      root.current = element;
      if (typeof ref === "function") {
        ref(element);
      } else if (ref) {
        ref.current = element;
      }
    },
    [ref],
  );
  const isMedia = story.kind !== "text";
  // The base fills the canvas when it is near 9:16 and is shown whole otherwise (a photo over a
  // blurred copy of itself, a video on the card's dark): the one rule every platform shares.
  const contain =
    isMedia && Boolean(story.mediaWidth && story.mediaHeight) && storyBaseFit(story.mediaWidth!, story.mediaHeight!) === "contain";
  const layers = withLayers ? (story.layers ?? []) : [];
  const hasLayers = layers.length > 0;
  const hasCallLayer = layers.some((layer) => layer.type === "call");
  const hasTextLayer = layers.some((layer) => layer.type === "text");
  // A story from before layers speaks through its caption, text and sticker.
  // One with text layers has those words twice (the server copies them into
  // `text` and the author's build into `caption` for older builds): draw them once.
  const showLegacyText = !hasTextLayer;
  const altText = story.altText?.trim() || null;
  const join = still ? undefined : onJoinCall;

  const card = (
    <StoryCallCard
      call={story.call}
      preview={story.callPreview ?? null}
      server={story.callServer ?? null}
      onJoin={join}
    />
  );

  return (
    <div
      ref={setRoot}
      data-story-root=""
      // The story's description names the card for a screen reader. It is a label, not a second
      // copy of the words: the text layers are already text on the page.
      role={altText ? "group" : undefined}
      aria-label={altText ?? undefined}
      className={cn("absolute inset-0 overflow-hidden [container-type:size]", className)}
      style={{ background: "var(--story-card)" }}
    >
      {story.kind === "image" && story.mediaUrl && (
        <>
          {contain && (
            // A photo that is not 9:16 is shown whole over a blurred copy of itself.
            <img
              src={story.mediaUrl}
              alt=""
              aria-hidden
              draggable={false}
              decoding="async"
              data-story-base-blur=""
              className="absolute inset-0 h-full w-full scale-110 select-none object-cover blur-[28px]"
            />
          )}
          {contain ? (
            <CoverBox>
              <img
                src={story.mediaUrl}
                alt={altText ?? ""}
                draggable={false}
                decoding="async"
                className="h-full w-full select-none object-contain"
              />
            </CoverBox>
          ) : (
            <img
              src={story.mediaUrl}
              alt={altText ?? ""}
              draggable={false}
              decoding="async"
              className="absolute inset-0 h-full w-full select-none object-cover"
            />
          )}
        </>
      )}
      {story.kind === "video" &&
        (playVideo && !still && story.mediaUrl ? (
          contain ? (
            <CoverBox>
              <StoryVideo
                src={story.mediaUrl}
                poster={story.posterUrl}
                muted={muted}
                paused={paused}
                onDuration={onVideoDuration}
                onTime={onVideoTime}
                onEnded={onVideoEnded}
                loop={loop}
                contain
              />
            </CoverBox>
          ) : (
            <StoryVideo
              src={story.mediaUrl}
              poster={story.posterUrl}
              muted={muted}
              paused={paused}
              onDuration={onVideoDuration}
              onTime={onVideoTime}
              onEnded={onVideoEnded}
              loop={loop}
            />
          )
        ) : story.posterUrl ? (
          contain ? (
            <CoverBox>
              <img src={story.posterUrl} alt="" draggable={false} className="h-full w-full select-none object-contain" />
            </CoverBox>
          ) : (
            <img
              src={story.posterUrl}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full select-none object-cover"
            />
          )
        ) : null)}
      {story.kind === "text" && (
        <div
          className="story-text-card absolute inset-0"
          data-bg={story.background ?? "night"}
        >
          {showLegacyText && story.text && (
            <p
              className={cn(TEXT_CARD_BOX_CLASS, textCardSizeClass(story.text))}
              style={{ color: "var(--story-on-media)" }}
            >
              {story.text}
            </p>
          )}
        </div>
      )}
      {isMedia && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: "var(--story-scrim)" }}
        />
      )}
      {hasLayers && (
        <LayerCanvas>
          {layers.map((layer) => (
            <LiftedBox
              key={layer.id}
              layer={layer}
              rootRef={root}
              reserve={layer.type === "call" || layer.type === "mention" ? reserveBottom : 0}
            >
              <LayerContent
                layer={layer}
                renderCall={() => card}
                onOpenMention={still ? undefined : onOpenMention}
              />
            </LiftedBox>
          ))}
        </LayerCanvas>
      )}
      {/* An older build's sticker, or the composer's preview before any layer exists. */}
      {!hasCallLayer && (story.call || story.callPreview) && (
        <div
          className={cn(
            "absolute left-[9%] right-[9%]",
            story.kind === "text" ? "top-[52%]" : "bottom-[22%]",
          )}
        >
          {card}
        </div>
      )}
      {isMedia && story.caption && showLegacyText && (
        <p
          className="absolute bottom-[6%] left-[5%] right-[5%] whitespace-pre-wrap break-words text-[4.4cqw] font-semibold leading-snug [text-shadow:0_1px_8px_var(--story-dim)]"
          style={{ color: "var(--story-on-media)" }}
        >
          {story.caption}
        </p>
      )}
    </div>
  );
});

function StoryVideo({
  src,
  poster,
  muted,
  paused,
  onDuration,
  onTime,
  onEnded,
  loop,
  contain = false,
}: {
  src: string;
  poster: string | null;
  muted: boolean;
  paused: boolean;
  onDuration?: (ms: number) => void;
  onTime?: (ms: number) => void;
  onEnded?: () => void;
  loop: boolean;
  contain?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onDuration, onTime, onEnded });
  callbacks.current = { onDuration, onTime, onEnded };

  useEffect(() => {
    const element = video.current;
    if (!element) {
      return;
    }
    if (paused) {
      element.pause();
    } else {
      void element.play().catch(() => undefined);
    }
  }, [paused, src]);

  // The bar is the video's own clock, read off `currentTime` so it never runs
  // ahead of a stalled download. Ten reads a second, the same step as the
  // viewer's clock, so playback does not re-render the viewer every frame.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const element = video.current;
      if (element && !element.paused) {
        callbacks.current.onTime?.(element.currentTime * 1000);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <video
      ref={video}
      src={src}
      poster={poster ?? undefined}
      muted={muted}
      loop={loop}
      playsInline
      preload="auto"
      className={cn("h-full w-full", contain ? "object-contain" : "absolute inset-0 object-cover")}
      onLoadedMetadata={(event) => {
        const seconds = event.currentTarget.duration;
        if (Number.isFinite(seconds) && seconds > 0) {
          callbacks.current.onDuration?.(seconds * 1000);
        }
      }}
      onEnded={() => callbacks.current.onEnded?.()}
    />
  );
}
