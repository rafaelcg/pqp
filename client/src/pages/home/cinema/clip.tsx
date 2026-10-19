import { Pause, Play } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SMALL_QUERY } from "../hero-media";
import { useReducedMotion } from "../shared/motion";
import "./cinema.css";
import { useClipGroup } from "./clip-group";
import { useFinePointer } from "./progress";
import { smallStill, srcSetFor } from "./stills";

/**
 * Real footage of the app, played like a GIF: muted, inline, looping, only
 * while on screen and the tab is visible, with a pause control you can reach
 * by keyboard. With reduced motion it shows the poster and a play button.
 *
 * Files live in /media/home/ by name: `<name>.webm`, `<name>.mp4`, the
 * 960-wide `<name>-960.webm` / `<name>-960.mp4` for phones, and the
 * `<name>.webp` / `<name>-960.webp` poster (the loop's first frame).
 * `manifest.json` there is the presence gate: a clip plays only once the
 * manifest lists it. Until then (and if every file fails) the still shows, so
 * a page never draws a broken video. A WebM the browser cannot decode (Chrome's
 * hardware VP9 decoder gives up on some, with several playing at once) is
 * dropped for its MP4, since a decode error never moves on to the next source.
 *
 * Stills from /media/home/ get their smaller copies on their own (see
 * `stills.ts`): a srcset on wide screens, and on phones the small copy at
 * once, without waiting for the manifest.
 */

export type ClipName = "call-join" | "share" | "chat" | "raise-hand" | "appearance" | "profile" | "import";

/**
 * A still image: a bare URL, or a URL with a responsive `srcSet` (and its
 * `sizes`). `stillImg()` and `clipPoster()` from `stills.ts` return one.
 */
export type Still =
  | string
  | { src: string; srcSet?: string; sizes?: string; width?: number; height?: number; alt?: string };

/**
 * Phone framing: the point of the footage to keep in view, in percent of its
 * width (`x`) and height (`y`), and how far to crop in (`zoom`, 1 or more).
 */
export interface ClipFocus {
  x: number;
  y: number;
  zoom: number;
}

/** Explicit sources, for footage that does not follow the naming convention. */
export interface ClipSources {
  webm?: string;
  mp4?: string;
  /** The 960-wide files, used on phones. */
  webmSmall?: string;
  mp4Small?: string;
  poster?: string;
  posterSmall?: string;
}

const MEDIA_BASE = "/media/home/";
/** `MediaError.MEDIA_ERR_DECODE`, spelled out: the page also renders where there is no DOM. */
const MEDIA_ERR_DECODE = 3;
// Phones and tablets get the small files: `SMALL_QUERY` in hero-media.ts,
// shared with the static first screen.

interface ResolvedStill {
  src: string;
  srcSet?: string;
  sizes?: string;
  alt?: string;
  /** The file asked for, tried once if its small copy fails to load. */
  retry?: string;
}

/**
 * A manifest reader. It caches a definitive answer only: the manifest's text,
 * or "no footage" (a 404, or a 200 that is not JSON, which is what a dev server
 * or an SPA fallback sends for a missing file). Concurrent callers share one
 * request. A network error, an abort, a 5xx or a body that does not parse is a
 * blip, not an answer: that caller gets null and the next one tries again,
 * so one bad moment while the page loads does not leave every clip on its
 * still for the rest of the visit.
 */
export function createManifestLoader(): () => Promise<string | null> {
  let memo: Promise<string | null> | null = null;
  return () => {
    if (memo) return memo;
    const request: Promise<string | null> = fetch(`${MEDIA_BASE}manifest.json`, {
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) return retryLater();
        const type = res.headers.get("content-type") ?? "";
        if (!type.includes("json")) return null;
        const text = await res.text();
        JSON.parse(text);
        return text;
      })
      .catch(retryLater);
    // Forget this request, so the next caller starts a fresh one.
    function retryLater(): null {
      if (memo === request) memo = null;
      return null;
    }
    memo = request;
    return request;
  };
}

/** Shared by every clip on the page; asked only when a clip first comes near. */
const loadManifest = createManifestLoader();

function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9-])${escaped}(?![a-z0-9-])`, "i").test(text);
}

/**
 * Which files the manifest lists for `name`. The manifest's shape is not
 * fixed, so this reads it as text: file names it mentions are used; a name it
 * mentions with no file names at all means the whole convention set.
 */
function sourcesFor(name: string, text: string | null): ClipSources | null {
  if (!text) return null;
  const file = (suffix: string) => (mentions(text, `${name}${suffix}`) ? `${MEDIA_BASE}${name}${suffix}` : undefined);
  const found: ClipSources = {
    webm: file(".webm"),
    mp4: file(".mp4"),
    webmSmall: file("-960.webm"),
    mp4Small: file("-960.mp4"),
    poster: file(".webp"),
    posterSmall: file("-960.webp"),
  };
  if (found.webm || found.mp4 || found.webmSmall || found.mp4Small) return found;
  if (!mentions(text, name)) return null;
  return {
    webm: `${MEDIA_BASE}${name}.webm`,
    mp4: `${MEDIA_BASE}${name}.mp4`,
    webmSmall: `${MEDIA_BASE}${name}-960.webm`,
    mp4Small: `${MEDIA_BASE}${name}-960.mp4`,
    poster: `${MEDIA_BASE}${name}.webp`,
    posterSmall: `${MEDIA_BASE}${name}-960.webp`,
  };
}

/**
 * A still as drawn: with `small`, the small copy of a /media/home/ file and no
 * srcset; otherwise the srcset it came with, or the one its name implies.
 */
function resolveStill(still: Still | undefined, small: boolean): ResolvedStill | null {
  if (!still) return null;
  const s = typeof still === "string" ? { src: still } : still;
  // Only files with smaller copies (see stills.ts); anything else is drawn as given.
  if (small && srcSetFor(s.src)) {
    const file = smallStill(s.src);
    return { src: file, alt: s.alt, retry: file !== s.src ? s.src : undefined };
  }
  return { src: s.src, srcSet: s.srcSet ?? srcSetFor(s.src), sizes: s.sizes, alt: s.alt };
}

/** The same picture, whichever copy of it. */
function samePicture(a: string, b: string): boolean {
  return smallStill(a) === smallStill(b);
}

function useIsSmall() {
  // Read once at mount: swapping files mid-play on a resize is worse than a
  // slightly oversized file. Save-Data asks for the small files at any width.
  const [small] = useState(() => {
    if (typeof window === "undefined") return false;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    return window.matchMedia(SMALL_QUERY).matches || saveData === true;
  });
  return small;
}

export function Clip({
  name,
  src,
  fallbackStill,
  label,
  aspect,
  className,
  rounded,
  fit = "cover",
  position = "object-top",
  sizes,
  priority = false,
  playOnHover = false,
  controls = true,
  controlsClassName,
  focus,
  small = false,
  group,
}: {
  /** The clip's name in /media/home/. */
  name?: ClipName | (string & {});
  /** Explicit files; skips the manifest. */
  src?: ClipSources;
  /** Shown until the clip exists, and as the base layer under it. */
  fallbackStill?: Still;
  /** What the footage shows, for screen readers. */
  label: string;
  /** CSS aspect ratio ("16 / 10") to reserve the box. Omit to fill the parent. */
  aspect?: string;
  className?: string;
  /** Border radius class, for example "rounded-2xl". */
  rounded?: string;
  fit?: "cover" | "contain";
  /** object-position class for the still and the video. */
  position?: string;
  /** `sizes` for the stills. Default: the still's own `sizes`, else 100vw. */
  sizes?: string;
  /** Hero only: eager, high-priority still and an early video load. */
  priority?: boolean;
  /** Tiles: play while hovered or focused on a mouse; in view on touch. */
  playOnHover?: boolean;
  /** Show the pause and play control (default on; keep it on for autoplay). */
  controls?: boolean;
  controlsClassName?: string;
  /**
   * Phone framing, below md only: crop into this point of the footage (the
   * video, the poster and the still alike). Wider screens are unchanged.
   */
  focus?: ClipFocus;
  /** Use the 960-wide video and poster at every width (small tiles). */
  small?: boolean;
  /**
   * Clips sharing a group name play in view one at a time: the one the
   * visitor started, else the one hovered or focused, else the one nearest
   * the viewport centre. Supersedes `playOnHover`.
   */
  group?: string;
}) {
  const reduced = useReducedMotion();
  const finePointer = useFinePointer();
  const phone = useIsSmall();
  const smallFiles = phone || small;
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [near, setNear] = useState(priority);
  const [inView, setInView] = useState(false);
  const [tabVisible, setTabVisible] = useState(true);
  const [listed, setListed] = useState<ClipSources | null>(src ?? null);
  const [hovered, setHovered] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [userStarted, setUserStarted] = useState(false);
  // Sticky: once the visitor asked for motion (or a mouse hovered a tile, or
  // the clip led its group), the files stay loaded even if they pause or leave.
  const [userEngaged, setUserEngaged] = useState(false);
  const [hoverEngaged, setHoverEngaged] = useState(false);
  const [groupEngaged, setGroupEngaged] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [webmFailed, setWebmFailed] = useState(false);
  const [posterLoaded, setPosterLoaded] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const [baseRetried, setBaseRetried] = useState(false);
  const [baseFailed, setBaseFailed] = useState(false);

  // Near (400px ahead) starts loading; in view (a fifth visible) plays.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      setInView(true);
      return;
    }
    const nearIo = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setNear(true);
          nearIo.disconnect();
        }
      },
      { rootMargin: "400px 0px 400px 0px" },
    );
    const viewIo = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.2 });
    nearIo.observe(el);
    viewIo.observe(el);
    const onVis = () => setTabVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => {
      nearIo.disconnect();
      viewIo.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // The manifest decides whether a named clip exists yet.
  useEffect(() => {
    if (src || !name || !near) return;
    let live = true;
    void loadManifest().then((text) => {
      if (!live) return;
      setListed(sourcesFor(name, text));
    });
    return () => {
      live = false;
    };
  }, [src, name, near]);

  const files = src ?? listed;
  const video = useMemo(() => {
    if (!files) return [];
    const webm = smallFiles ? (files.webmSmall ?? files.webm) : (files.webm ?? files.webmSmall);
    const mp4 = smallFiles ? (files.mp4Small ?? files.mp4) : (files.mp4 ?? files.mp4Small);
    const list: { src: string; type: string }[] = [];
    if (webm && !webmFailed) list.push({ src: webm, type: "video/webm" });
    if (mp4) list.push({ src: mp4, type: "video/mp4" });
    return list;
  }, [files, smallFiles, webmFailed]);
  const videoKey = video.map((v) => v.src).join("|");
  const hasVideo = video.length > 0 && !videoFailed;

  // The base still: the fallback if given, else the clip's own poster (by
  // name, or from `src`). Drawn at once at every width: on phones it is the
  // small copy, so nothing waits on the manifest. `small` shrinks the poster
  // with the video; a fallback still keeps its srcset on wide screens.
  const posterFile = (f: ClipSources) =>
    smallFiles ? (f.posterSmall ?? f.poster) : (f.poster ?? f.posterSmall);
  const base = fallbackStill
    ? resolveStill(fallbackStill, phone)
    : name && !src
      ? resolveStill(`${MEDIA_BASE}${name}${smallFiles ? "-960" : ""}.webp`, smallFiles)
      : resolveStill(src ? posterFile(src) : undefined, smallFiles);
  const baseSrc = base && baseRetried && base.retry ? { src: base.retry, srcSet: undefined } : base;

  const inGroup = Boolean(group);
  const hoverMode = playOnHover && finePointer && !inGroup;
  const leader = useClipGroup(group, rootRef, {
    eligible: inGroup && hasVideo && near && inView && tabVisible,
    hovered,
    claimed: userStarted,
  });
  // No sources, no download: with reduced motion nothing plays until the
  // visitor asks, a hover tile waits for its first hover, and a group member
  // waits for its first turn.
  const gated =
    (reduced && !userEngaged) ||
    (hoverMode && !hoverEngaged && !userEngaged) ||
    (inGroup && !groupEngaged && !userEngaged);
  const elementKey = `${videoKey}:${gated ? "idle" : "live"}`;

  // On wide screens, over a fallback, the clip's poster fades in once its
  // video is on its way, so the first frame is already there when the loop
  // starts. Until then (reduced motion, a tile waiting for its hover or its
  // turn) the fallback still stays. Phones skip it: the video fades in over the
  // still by itself, and the extra file is the one thing a phone should not
  // fetch.
  const posterUrl = fallbackStill && files && !phone && !gated && !posterFailed ? posterFile(files) : undefined;
  const overlay =
    posterUrl && !(base && samePicture(posterUrl, base.src)) ? resolveStill(posterUrl, smallFiles) : null;

  const wantPlay =
    hasVideo &&
    near &&
    inView &&
    tabVisible &&
    !userPaused &&
    (!reduced || userStarted) &&
    (!hoverMode || hovered || userStarted) &&
    (!inGroup || leader);

  // Autoplay policies read the property, not only the attribute. The sources
  // render inside an empty element, which starts loading on its own; a new
  // set remounts the element (keyed below), so no load() call is needed.
  useEffect(() => {
    if (hovered && hoverMode) setHoverEngaged(true);
  }, [hovered, hoverMode]);

  useEffect(() => {
    if (leader && !reduced) setGroupEngaged(true);
  }, [leader, reduced]);

  // Losing the group's turn ends the visitor's own start, so a clip they
  // started never comes back on its own later (with reduced motion above all).
  useEffect(() => {
    if (inGroup && !leader) setUserStarted(false);
  }, [inGroup, leader]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.defaultMuted = true;
  }, [elementKey]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (wantPlay) v.play().catch(() => {});
    else v.pause();
  }, [wantPlay, elementKey]);

  // A decode error comes after the browser picked a source, so it never tries
  // the next one by itself. From a WebM, drop it: the list without it is a new
  // key, and the MP4 gets a fresh element. Anything else (the MP4 failing too,
  // a network error) keeps the still.
  const onVideoError = (el: HTMLVideoElement) => {
    const webm = video.find((s) => s.type === "video/webm");
    const fromWebm = Boolean(webm && el.currentSrc && el.currentSrc.endsWith(webm.src));
    if (el.error?.code === MEDIA_ERR_DECODE && fromWebm) {
      setPlaying(false);
      setVideoReady(false);
      setWebmFailed(true);
    } else {
      setVideoFailed(true);
    }
  };

  const toggle = () => {
    if (playing) {
      setUserPaused(true);
      setUserStarted(false);
    } else {
      setUserPaused(false);
      setUserStarted(true);
      setUserEngaged(true);
    }
  };

  const objectClass = cn("absolute inset-0 h-full w-full", fit === "cover" ? "object-cover" : "object-contain", position);
  const sizesOf = (s: ResolvedStill) => (s.srcSet ? (sizes ?? s.sizes ?? "100vw") : undefined);
  const focusStyle = focus
    ? ({
        "--focus-x": `${focus.x}%`,
        "--focus-y": `${focus.y}%`,
        "--focus-zoom": Math.max(1, focus.zoom),
      } as CSSProperties)
    : undefined;

  return (
    <div
      ref={rootRef}
      className={cn("relative isolate block w-full overflow-hidden bg-ink-2", !aspect && "h-full", rounded, className)}
      style={aspect ? { aspectRatio: aspect } : undefined}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(false);
      }}
    >
      {/* The media layer: everything the phone framing crops, never the control. */}
      <div className="cin-clip-media absolute inset-0" data-focus={focus ? "" : undefined} style={focusStyle}>
        {baseSrc && !baseFailed && (
          <img
            key={baseSrc.src}
            src={baseSrc.src}
            srcSet={baseSrc.srcSet}
            sizes={sizesOf(baseSrc)}
            alt={hasVideo ? "" : (base?.alt ?? label)}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "low"}
            decoding="async"
            draggable={false}
            onError={() => (base?.retry && !baseRetried ? setBaseRetried(true) : setBaseFailed(true))}
            className={objectClass}
          />
        )}
        {overlay && (
          <img
            src={overlay.src}
            srcSet={overlay.srcSet}
            sizes={sizesOf(overlay)}
            alt={hasVideo ? "" : (base?.alt ?? label)}
            loading="lazy"
            fetchPriority="low"
            decoding="async"
            draggable={false}
            onLoad={() => setPosterLoaded(true)}
            onError={() => setPosterFailed(true)}
            className={cn(objectClass, "cin-clip-layer")}
            style={{ opacity: posterLoaded ? 1 : 0 }}
          />
        )}
        {hasVideo && (
          <video
            key={elementKey}
            ref={videoRef}
            muted
            playsInline
            loop
            disablePictureInPicture
            preload={near && !gated ? "metadata" : "none"}
            aria-label={label}
            tabIndex={-1}
            onPlaying={() => {
              setPlaying(true);
              setVideoReady(true);
            }}
            onPause={() => setPlaying(false)}
            onError={(e) => onVideoError(e.currentTarget)}
            className={cn(objectClass, "cin-clip-layer")}
            style={{ opacity: videoReady ? 1 : 0 }}
          >
            {near &&
              !gated &&
              video.map((s, i) => (
                <source
                  key={s.src}
                  src={s.src}
                  type={s.type}
                  // The last source failing to load means none could play: keep the still.
                  onError={i === video.length - 1 ? () => setVideoFailed(true) : undefined}
                />
              ))}
          </video>
        )}
      </div>
      {controls && hasVideo && (
        <ClipControl
          playing={playing}
          label={label}
          reduced={reduced && !userStarted}
          onToggle={toggle}
          className={controlsClassName}
        />
      )}
    </div>
  );
}

function ClipControl({
  playing,
  label,
  reduced,
  onToggle,
  className,
}: {
  playing: boolean;
  /** What the footage shows, so each control has its own name. */
  label: string;
  reduced: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const base =
    "absolute bottom-3 right-3 z-10 inline-flex h-10 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-inset ring-white/15 transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";
  if (reduced && !playing) {
    // A round icon at every width: the "Ver em movimento" pill was about
    // four times as wide and covered the footage it sits on (the hero's
    // server name, the Aparência theme cards). The action stays as the
    // hover title and as the start of the accessible name (WCAG 2.5.3 only
    // asks for the visible label to be in the name, and there is none).
    const action = t("home.media.motion");
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label={t("home.media.named", { action, label })}
        title={action}
        className={cn(base, "w-10", className)}
      >
        <Play className="h-4 w-4" aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={t("home.media.named", {
        action: playing ? t("home.media.pause") : t("home.media.play"),
        label,
      })}
      className={cn(base, "w-10", className)}
    >
      {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
    </button>
  );
}
