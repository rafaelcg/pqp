import { Download, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CommunityHomeMedia } from "@pqp/shared";
import {
  formatHomeBytes,
  instagramEmbedSrc,
  tiktokEmbedSrc,
  twitchEmbedSrc,
  youtubeEmbedSrc,
} from "@/lib/community-home/media";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function twitchPlayerParent(): string {
  if (typeof window !== "undefined" && window.location.hostname) {
    return window.location.hostname;
  }
  return "localhost";
}

/**
 * The player / file / image a published card shows. Composer live preview
 * reuses this so a paste looks like the feed, not a second embed.
 *
 * `flush` is for a Patreon-style card: the media is the top of the card,
 * edge to edge, no inner radius or border of its own.
 *
 * `reserveCorner` keeps the card's top-right corner free for the staff menu.
 * Only the file row needs it: players and pictures let the menu float over
 * them, but the file row has its size and download link in that corner.
 */
export function UnlockedMedia({
  media,
  flush = false,
  reserveCorner = false,
}: {
  media: CommunityHomeMedia;
  flush?: boolean;
  reserveCorner?: boolean;
}) {
  const { t } = useTranslation();
  const frame = cn(
    "overflow-hidden bg-surface-0",
    flush ? "rounded-none" : "rounded-lg border border-border",
  );
  if (media.kind === "youtube") {
    const src = media.youtubeUrl ? youtubeEmbedSrc(media.youtubeUrl) : null;
    if (!src) {
      return null;
    }
    return (
      <div className={frame} data-home-media="youtube">
        <iframe
          title={media.name}
          src={src}
          className="aspect-video w-full"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  if (media.kind === "twitch") {
    const src = media.twitchUrl
      ? twitchEmbedSrc(media.twitchUrl, twitchPlayerParent())
      : null;
    if (!src) {
      return null;
    }
    return (
      <div className={frame} data-home-media="twitch">
        <iframe
          title={media.name}
          src={src}
          className="aspect-video w-full"
          loading="lazy"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
    );
  }

  if (media.kind === "tiktok") {
    const src = media.youtubeUrl ? tiktokEmbedSrc(media.youtubeUrl) : null;
    if (!src) {
      return null;
    }
    return (
      <div className={frame} data-home-media="tiktok">
        <iframe
          title={t("communityHome.media.openTikTok")}
          src={src}
          className="mx-auto aspect-[9/16] w-full max-w-[325px]"
          loading="lazy"
          allow="encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  if (media.kind === "instagram") {
    const src = media.youtubeUrl ? instagramEmbedSrc(media.youtubeUrl) : null;
    if (!src) {
      return null;
    }
    return (
      <div className={frame} data-home-media="instagram">
        <iframe
          title={t("communityHome.media.openInstagram")}
          src={src}
          className="mx-auto min-h-[540px] w-full max-w-[540px]"
          loading="lazy"
          allow="encrypted-media; clipboard-write; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  if (media.kind === "file") {
    return (
      <div
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 text-sm",
          flush ? "border-t border-border" : "rounded-lg border border-border bg-surface-0",
          reserveCorner && "pr-12",
        )}
        data-home-media="file"
        data-home-media-reserve-corner={reserveCorner ? "" : undefined}
      >
        <span className="rounded bg-signal/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-signal">
          {media.name.toLowerCase().endsWith(".pdf")
            ? "PDF"
            : t("communityHome.media.file")}
        </span>
        <span className="min-w-0 truncate">{media.name}</span>
        {media.byteSize != null && (
          <span className="ml-auto shrink-0 text-xs text-paper-muted">
            {formatHomeBytes(media.byteSize)}
          </span>
        )}
        {media.url ? (
          <a
            className="inline-flex shrink-0 items-center gap-1 text-xs text-signal hover:underline"
            href={media.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={t("communityHome.media.download")}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
      </div>
    );
  }

  if (media.kind === "video") {
    return (
      <div className={frame} data-home-media="video">
        {media.url ? (
          <VideoPlayer url={media.url} />
        ) : (
          <div className="flex h-44 items-center justify-center text-xs text-paper-muted">
            {t("communityHome.media.unavailable")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={frame} data-home-media="image">
      {media.url ? (
        <img
          src={media.url}
          alt={media.name}
          loading="lazy"
          decoding="async"
          className="max-h-[32rem] w-full object-contain"
        />
      ) : (
        <div className="flex h-44 items-center justify-center text-xs text-paper-muted">
          {t("communityHome.media.unavailable")}
        </div>
      )}
    </div>
  );
}

/** A landscape video wider than this fills the card at its own shape. */
const FILL_MIN_RATIO = 4 / 3;

export function formatVideoDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The Baú's video. A landscape video takes the card's full width at its own
 * aspect ratio, so there are no black bars beside it. Anything taller than
 * 4:3 (a phone clip, a square) keeps a 24rem box and fills the sides with a
 * blurred copy of its first frame, because at full width it would be taller
 * than the screen.
 *
 * It draws its own bar instead of the browser's: play, the time, a progress
 * line you can drag, sound and fullscreen. Before the first play the bar says
 * "Assistir" and the length. While it plays the bar fades out after a moment
 * without the pointer, and comes back on any movement, focus or pause.
 */
function VideoPlayer({ url }: { url: string }) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const backdropRef = useRef<HTMLCanvasElement>(null);
  const hideTimer = useRef<number | null>(null);
  const [shape, setShape] = useState<{ w: number; h: number } | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [time, setTime] = useState(0);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const fills = !shape || shape.w / shape.h >= FILL_MIN_RATIO;

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  const wake = (isPlaying = playing) => {
    setChrome(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (isPlaying) hideTimer.current = window.setTimeout(() => setChrome(false), 2200);
  };

  const onMetadata = () => {
    const v = videoRef.current;
    if (!v) {
      return;
    }
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      setShape({ w: v.videoWidth, h: v.videoHeight });
    }
    if (Number.isFinite(v.duration) && v.duration > 0) {
      setDuration(v.duration);
    }
  };
  // The blurred sides are the first frame, drawn once into a small canvas.
  // A cross-origin frame only taints the canvas, which is fine: it is never read back.
  const onFirstFrame = () => {
    const v = videoRef.current;
    const c = backdropRef.current;
    if (!v || !c || v.videoWidth === 0) {
      return;
    }
    c.width = 48;
    c.height = Math.max(1, Math.round((48 * v.videoHeight) / v.videoWidth));
    try {
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    } catch {
      // No frame to draw: the sides stay the card's own colour.
    }
  };
  const toggle = () => {
    const v = videoRef.current;
    if (!v) {
      return;
    }
    setStarted(true);
    if (v.paused || v.ended) {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  };
  const seek = (value: number) => {
    const v = videoRef.current;
    if (v && Number.isFinite(value)) {
      v.currentTime = value;
      setTime(value);
    }
  };
  const toggleMute = () => {
    const v = videoRef.current;
    if (v) {
      v.muted = !v.muted;
    }
  };
  const toggleFullscreen = () => {
    const wrap = wrapRef.current;
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else if (wrap?.requestFullscreen) {
      void wrap.requestFullscreen().catch(() => {});
    } else {
      // iPhone Safari has no element fullscreen, only the video's own.
      v?.webkitEnterFullscreen?.();
    }
  };

  const progress = duration ? Math.min(1, time / duration) : 0;
  const showChrome = chrome || !playing;
  const iconButton =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-paper transition-colors duration-[var(--duration-fast)] hover:bg-paper/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

  return (
    <div
      ref={wrapRef}
      className={cn(
        "group/player relative w-full overflow-hidden bg-ink",
        !fills && !fullscreen && "h-96",
        fullscreen && "h-full",
        !showChrome && "cursor-none",
      )}
      style={fills && !fullscreen ? { aspectRatio: shape ? `${shape.w} / ${shape.h}` : "16 / 9" } : undefined}
      data-home-video={fills ? "fill" : "fit"}
      onPointerMove={() => wake()}
      onFocus={() => wake()}
    >
      {!fills && (
        <canvas
          ref={backdropRef}
          aria-hidden
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl"
        />
      )}
      <video
        ref={videoRef}
        className="relative h-full w-full object-contain"
        playsInline
        preload="metadata"
        // `#t=0.001` makes iOS Safari paint the first frame before play.
        src={`${url}#t=0.001`}
        onClick={toggle}
        onLoadedMetadata={onMetadata}
        onLoadedData={onFirstFrame}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => {
          setStarted(true);
          setPlaying(true);
          wake(true);
        }}
        onPause={() => {
          setPlaying(false);
          wake(false);
        }}
        onEnded={() => {
          setPlaying(false);
          wake(false);
        }}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
      >
        <track kind="captions" />
      </video>

      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-ink/90 to-transparent transition-opacity duration-300",
          showChrome ? "opacity-100" : "opacity-0",
        )}
        aria-hidden
      />
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex items-center gap-2 px-3 pb-3 transition-opacity duration-300 sm:gap-3 sm:px-5 sm:pb-4",
          showChrome ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        data-home-video-bar
      >
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? t("communityHome.media.pause") : t("communityHome.media.play")}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full bg-signal text-ink shadow-[0_8px_30px_var(--glow-accent)] transition-transform duration-[var(--duration-fast)] hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
            started ? "h-11 w-11" : "h-14 w-14",
          )}
          data-home-video-play
        >
          {playing ? (
            <Pause className="h-5 w-5 fill-current" aria-hidden />
          ) : (
            <Play className={cn("ml-0.5 fill-current", started ? "h-5 w-5" : "h-6 w-6")} aria-hidden />
          )}
        </button>
        {started ? (
          <span className="shrink-0 text-xs font-semibold tabular-nums text-paper sm:text-sm">
            {formatVideoDuration(time)}
            {duration != null && <span className="text-paper-muted"> / {formatVideoDuration(duration)}</span>}
          </span>
        ) : (
          <span className="flex shrink-0 flex-col leading-tight">
            <span className="font-display text-base font-extrabold text-paper sm:text-lg">
              {t("communityHome.media.watch")}
            </span>
            {duration != null && (
              <span className="text-xs tabular-nums text-paper-muted sm:text-sm">{formatVideoDuration(duration)}</span>
            )}
          </span>
        )}
        <div className="relative mx-1 flex h-11 min-w-0 flex-1 items-center">
          <div className="h-1 w-full rounded-full bg-paper/25">
            <div className="h-1 rounded-full bg-signal" style={{ width: `${progress * 100}%` }} />
          </div>
          <input
            type="range"
            min={0}
            max={duration ?? 0}
            step={0.1}
            value={time}
            onChange={(e) => seek(Number(e.currentTarget.value))}
            disabled={!duration}
            aria-label={t("communityHome.media.seek")}
            aria-valuetext={`${formatVideoDuration(time)} / ${formatVideoDuration(duration ?? 0)}`}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
          />
        </div>
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? t("communityHome.media.unmute") : t("communityHome.media.mute")}
          className={iconButton}
        >
          {muted ? <VolumeX className="h-5 w-5" aria-hidden /> : <Volume2 className="h-5 w-5" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? t("communityHome.media.exitFullscreen") : t("communityHome.media.fullscreen")}
          className={iconButton}
        >
          {fullscreen ? <Minimize className="h-5 w-5" aria-hidden /> : <Maximize className="h-5 w-5" aria-hidden />}
        </button>
      </div>
    </div>
  );
}
