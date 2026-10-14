import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { storyBaseFit, type StoryBackground, type StoryCallLive, type StoryKind } from "@pqp/shared";
import { giveBackVideo, takePreloadedVideo } from "@/lib/stories/preload";
import { Loader2 } from "lucide-react";
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
 * The card is a size container. The author's canvas is 9:16 and is NEVER
 * cropped: on a screen taller or wider than that (most phones are taller) the
 * canvas is fitted INSIDE the card (contain), the base and every layer on it,
 * and the rest of the card is filled with the blurred base (a photo, or a
 * video's poster) or the text card's own background. So a layer is exactly where
 * the author put it, on every screen, and nothing the author placed is cut off.
 * The viewer's own chrome (bars, header, reply row) is drawn over the card.
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
  /**
   * The picture is decoded, or the clip has its first frame (or either could not be loaded: the
   * caller must not wait forever). The viewer holds its clock until then, so a slow connection shows
   * a story for its full time instead of spending that time on a blank card.
   */
  onReady?: () => void;
  /**
   * Draw the story only once it can be drawn WHOLE: the base picture, every photo and the drawing,
   * the faces on a call card and the fonts decoded, then reveal it in one frame (a short fade, none
   * under reduced motion). Until then the card shows its own background, and a small spinner after
   * 300 ms. A story that appears piece by piece (the background, then the photo, then the words)
   * looks broken; this is what the viewer asks for, with `onReady` called at the reveal.
   */
  gate?: boolean;
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
 * The author's canvas: a 9:16 box as large as fits inside the card (contain), centered. It is a
 * size container itself, so every layer's `cqw` is a fraction of THIS canvas, and it clips what
 * a layer does past its edge. The base picture, the scrim and the layers live in it.
 */
export function LayerCanvas({ children }: { children: ReactNode }) {
  return (
    <div
      data-story-layer-canvas=""
      className="pointer-events-none absolute left-1/2 top-1/2 overflow-hidden [container-type:size]"
      style={{
        width: "min(100cqw, calc(100cqh * 9 / 16))",
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
      crisp
      style={{ pointerEvents: layer.type === "call" || layer.type === "mention" ? "auto" : "none" }}
    >
      {children}
    </LayerBox>
  );
}


function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** An image in the page, loaded and decoded (a failed one counts: the story must not wait forever). */
function imageSettled(image: HTMLImageElement): Promise<void> {
  const decoded = () => (typeof image.decode === "function" ? image.decode().catch(() => undefined) : Promise.resolve());
  if (image.complete) {
    return image.naturalWidth > 0 ? decoded() : Promise.resolve();
  }
  return new Promise((resolve) => {
    image.addEventListener("load", () => void decoded().then(resolve), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
}

/** How long a story may stay hidden waiting for its pieces before it is shown as it is. */
const REVEAL_MAX_MS = 10_000;
/** The spinner stays away for a story that is about to appear anyway. */
const SPINNER_AFTER_MS = 300;

/**
 * The reveal of one gated story (see `StoryContent`'s `gate`). Waits for every picture in the card
 * to be loaded and decoded, the fonts, and, for a clip with no poster, its first frame; then shows
 * everything on the next frame and says `onReady`. For a clip playing in the card `onReady` also
 * waits for the first frame, because that is when its time starts.
 */
function useStoryReveal({
  root,
  gated,
  storyId,
  needsVideoFrame,
  waitsForVideo,
  onReady,
}: {
  root: RefObject<HTMLDivElement | null>;
  gated: boolean;
  storyId: string;
  needsVideoFrame: boolean;
  /** No poster to show meanwhile: the picture IS the first frame, so the reveal waits for it. */
  waitsForVideo: boolean;
  onReady?: () => void;
}) {
  const [assetsDone, setAssetsDone] = useState(!gated);
  const [revealed, setRevealed] = useState(!gated);
  const [frame, setFrame] = useState(false);
  const [spinner, setSpinner] = useState(false);
  const ready = useRef(onReady);
  ready.current = onReady;
  const videoFrame = useCallback(() => setFrame(true), []);

  useEffect(() => {
    if (!gated) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => setSpinner(true), SPINNER_AFTER_MS);
    const settle = async () => {
      const element = root.current;
      if (!element) {
        return;
      }
      // A frame first, so the pictures and the text are in the page and the fonts they use have started.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const first = [...element.querySelectorAll("img")];
      await Promise.all(first.map(imageSettled));
      if (typeof document !== "undefined" && document.fonts) {
        await document.fonts.ready.catch(() => undefined);
      }
      // Whatever was added while those were loading (the faces on a call card).
      const later = [...element.querySelectorAll("img")].filter((image) => !first.includes(image));
      await Promise.all(later.map(imageSettled));
    };
    void Promise.race([settle(), new Promise<void>((resolve) => window.setTimeout(resolve, REVEAL_MAX_MS))]).then(() => {
      if (!cancelled) {
        setAssetsDone(true);
      }
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // One reveal per story: the viewer keys the card by it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gated, storyId]);

  useEffect(() => {
    if (!gated || revealed || !assetsDone || (waitsForVideo && !frame)) {
      return;
    }
    // Everything at once, on a frame of its own.
    const handle = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(handle);
  }, [gated, revealed, assetsDone, waitsForVideo, frame]);

  useEffect(() => {
    if (gated && revealed && (!needsVideoFrame || frame)) {
      ready.current?.();
    }
  }, [gated, revealed, needsVideoFrame, frame]);

  return { revealed, spinner, videoFrame };
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
    onReady,
    gate = false,
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

  const gated = gate && !still;
  const reveal = useStoryReveal({
    root,
    gated,
    storyId: story.id,
    needsVideoFrame: story.kind === "video" && playVideo && Boolean(story.mediaUrl),
    waitsForVideo: story.kind === "video" && !story.posterUrl,
    onReady,
  });

  const card = (
    <StoryCallCard
      call={story.call}
      preview={story.callPreview ?? null}
      server={story.callServer ?? null}
      onJoin={join}
    />
  );

  // What fills the card around the canvas: the base blurred (a photo, or a video's poster), or the
  // text card's own background. The blurred copy is only drawn where it can show: always for a base
  // shown whole, otherwise only when the card is not 9:16 (a container query, `.story-backdrop`).
  const backdropUrl = story.kind === "image" ? story.mediaUrl : story.kind === "video" ? story.posterUrl : null;

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
      {story.kind === "text" && (
        <div className="story-text-card absolute inset-0" data-bg={story.background ?? "night"} />
      )}
      <div
        data-story-reveal={gated ? (reveal.revealed ? "shown" : "hidden") : undefined}
        className="absolute inset-0"
        style={gated ? { opacity: reveal.revealed ? 1 : 0, transition: reveal.revealed && !prefersReducedMotion() ? "opacity 140ms ease-out" : "none" } : undefined}
      >
      {backdropUrl && (
        <img
          src={backdropUrl}
          alt=""
          aria-hidden
          draggable={false}
          decoding="async"
          data-story-base-blur=""
          data-always={contain ? "" : undefined}
          className="story-backdrop pointer-events-none absolute inset-0 h-full w-full scale-110 select-none object-cover blur-[28px]"
        />
      )}
      <LayerCanvas>
        {story.kind === "image" && story.mediaUrl && (
          <img
            src={story.mediaUrl}
            alt={altText ?? ""}
            draggable={false}
            decoding="async"
            className={cn(
              "absolute inset-0 h-full w-full select-none",
              contain ? "object-contain" : "object-cover",
            )}
          />
        )}
        {story.kind === "video" &&
          (playVideo && !still && story.mediaUrl ? (
            <StoryVideo
              src={story.mediaUrl}
              poster={story.posterUrl}
              muted={muted}
              paused={paused}
              onDuration={onVideoDuration}
              onTime={onVideoTime}
              onEnded={onVideoEnded}
              onReady={gated ? reveal.videoFrame : onReady}
              loop={loop}
              contain={contain}
            />
          ) : story.posterUrl ? (
            <img
              src={story.posterUrl}
              alt=""
              draggable={false}
              className={cn(
                "absolute inset-0 h-full w-full select-none",
                contain ? "object-contain" : "object-cover",
              )}
            />
          ) : null)}
        {isMedia && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: "var(--story-scrim)" }}
          />
        )}
        {story.kind === "text" && showLegacyText && story.text && (
          <p
            className={cn(TEXT_CARD_BOX_CLASS, textCardSizeClass(story.text))}
            style={{ color: "var(--story-on-media)" }}
          >
            {story.text}
          </p>
        )}
        {hasLayers &&
          layers.map((layer) => (
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
            className="absolute bottom-[calc(6%+var(--story-caption-lift,0px))] left-[5%] right-[5%] whitespace-pre-wrap break-words text-[4.4cqw] font-semibold leading-snug [text-shadow:0_1px_8px_var(--story-dim)]"
            style={{ color: "var(--story-on-media)" }}
          >
            {story.caption}
          </p>
        )}
      </LayerCanvas>
      </div>
      {gated && !reveal.revealed && reveal.spinner && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center" data-story-loading="">
          <Loader2 className="h-7 w-7 animate-spin text-[color:var(--story-on-media-2)] motion-reduce:animate-none" />
        </div>
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
  onReady,
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
  onReady?: () => void;
  loop: boolean;
  contain?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const callbacks = useRef({ onDuration, onTime, onEnded, onReady });
  callbacks.current = { onDuration, onTime, onEnded, onReady };

  // The element is made here, not by React, so a clip the preloader already buffered (the viewer warms
  // the next stories) is moved in WHOLE: its first frame is ready and nothing is requested again.
  // Anything else starts as a plain element. Either way it goes back to the preloader when this
  // story is left, so coming back to it, or React remounting it, finds the buffer.
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) {
      return;
    }
    const warmed = takePreloadedVideo(src) as HTMLVideoElement | null;
    const element = warmed ?? document.createElement("video");
    element.playsInline = true;
    element.preload = "auto";
    if (!warmed) {
      element.src = src;
    }
    if (poster) {
      element.poster = poster;
    }
    container.appendChild(element);
    video.current = element;
    const onMetadata = () => {
      const seconds = element.duration;
      if (Number.isFinite(seconds) && seconds > 0) {
        callbacks.current.onDuration?.(seconds * 1000);
      }
    };
    const onEnd = () => callbacks.current.onEnded?.();
    // The first frame is there (or the clip cannot be played): the viewer's clock may start.
    const onFrame = () => callbacks.current.onReady?.();
    element.addEventListener("loadedmetadata", onMetadata);
    element.addEventListener("loadeddata", onFrame);
    element.addEventListener("error", onFrame);
    element.addEventListener("ended", onEnd);
    if (element.readyState >= 1) {
      // A warmed clip had its metadata long ago: the event is not coming again.
      onMetadata();
    }
    if (element.readyState >= 2) {
      onFrame();
    }
    return () => {
      element.removeEventListener("loadedmetadata", onMetadata);
      element.removeEventListener("loadeddata", onFrame);
      element.removeEventListener("error", onFrame);
      element.removeEventListener("ended", onEnd);
      video.current = null;
      element.pause();
      try {
        element.currentTime = 0;
      } catch {
        // Not seekable yet: it starts from the top anyway.
      }
      element.remove();
      if (src.startsWith("blob:")) {
        // The composer's own preview of a clip it just recorded: nobody will warm that URL again.
        element.removeAttribute("src");
        element.load();
      } else {
        giveBackVideo(src, element);
      }
    };
  }, [src, poster]);

  useEffect(() => {
    const element = video.current;
    if (!element) {
      return;
    }
    element.muted = muted;
    element.loop = loop;
    element.className = cn("absolute inset-0 h-full w-full", contain ? "object-contain" : "object-cover");
  }, [muted, loop, contain, src, poster]);

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
    <div ref={host} data-story-video-host="" className="absolute inset-0">
      {/* The poster is on screen from the first paint (and in server markup); the video, added to this
          box after it, draws over it the moment it has a frame. */}
      {poster && (
        <img
          src={poster}
          alt=""
          aria-hidden
          draggable={false}
          className={cn("absolute inset-0 h-full w-full select-none", contain ? "object-contain" : "object-cover")}
        />
      )}
    </div>
  );
}
