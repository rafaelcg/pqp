import {
  Captions,
  CaptionsOff,
  Download,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CommunityHomeCaptionTrack, CommunityHomeMedia } from "@pqp/shared";
import { fetchCommunityHomeCaptions } from "@/lib/api";
import {
  captionLanguageName,
  captionsOnByDefault,
  captionTrackUrl,
  pickCaptionTrack,
  writeCaptionsPreference,
} from "@/lib/community-home/captions";
import {
  formatHomeBytes,
  instagramEmbedSrc,
  tiktokEmbedSrc,
  twitchEmbedSrc,
  youtubeEmbedSrc,
} from "@/lib/community-home/media";
import {
  communityHomeVideoUrl,
  readRenditionViewport,
} from "@/lib/community-home/rendition";
import { Slider } from "@/components/ui/slider";
import {
  currentFullscreenElement,
  exitDocumentFullscreen,
  requestElementFullscreen,
  type WebkitFullscreenElement,
} from "@/components/voice/document-fullscreen";
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
/** Where a video's automatic subtitles come from: the post that carries it. */
export interface VideoCaptionsSource {
  serverId: string;
  postId: string;
  /** The language the video is in, as the API heard it. */
  sourceLang: string;
  /** Length of the sound that was transcribed, when the API said. */
  durationMs?: number | null;
}

/** How far a phone cut's length may drift from the transcribed main video. */
const CAPTIONS_DURATION_TOLERANCE_MS = 1_500;

export function UnlockedMedia({
  media,
  flush = false,
  reserveCorner = false,
  captions = null,
}: {
  media: CommunityHomeMedia;
  flush?: boolean;
  reserveCorner?: boolean;
  /** Set when the post has automatic subtitles (`post.captions`). */
  captions?: VideoCaptionsSource | null;
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
    return <HomeVideo media={media} frame={frame} captions={captions} />;
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

/**
 * An uploaded video, in the cut this screen should play: the vertical one on
 * a phone when the author attached it, the main one everywhere else (the rule
 * is `communityHomeVideoUrl`). Decided when the card mounts and again only
 * when the post's URLs change, never on a resize, so turning the phone does
 * not restart the video.
 */
function HomeVideo({
  media,
  frame,
  captions,
}: {
  media: CommunityHomeMedia;
  frame: string;
  captions: VideoCaptionsSource | null;
}) {
  const { t } = useTranslation();
  const mainUrl = media.url;
  const mobileUrl = media.mobile?.url ?? null;
  const chosen = useMemo(
    () =>
      communityHomeVideoUrl(
        { kind: "video", url: mainUrl, mobile: { url: mobileUrl } },
        readRenditionViewport(),
      ),
    [mainUrl, mobileUrl],
  );
  return (
    <div className={frame} data-home-media="video" data-home-video-rendition={chosen.rendition}>
      {chosen.url ? (
        <VideoPlayer
          key={chosen.url}
          url={chosen.url}
          captions={captions}
          // The subtitles were heard on the MAIN video. The phone cut is meant
          // to be the same video reframed, so it shows them too, but only
          // while its length agrees with what was transcribed: a cut that was
          // edited differently would put every line at the wrong moment.
          captionsMustMatchDuration={chosen.rendition === "mobile"}
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

/** m:ss, or h:mm:ss past an hour. Floored, like every player's clock. */
export function formatVideoDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

type LoadedTrack = CommunityHomeCaptionTrack & { url: string; id: string };

/** A cue's words as plain text: entities decoded, markup ignored. */
function cueText(cue: TextTrackCue): string {
  const vtt = cue as VTTCue;
  try {
    const html = vtt.getCueAsHTML?.();
    if (html) return html.textContent ?? "";
  } catch {
    // Fall through to the raw text.
  }
  return vtt.text ?? "";
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
 * without the pointer, and comes back on any movement, key press, focus or
 * pause. It never fades while keyboard focus is inside it.
 */
function VideoPlayer({
  url,
  captions: captionsSource,
  captionsMustMatchDuration = false,
}: {
  url: string;
  captions: VideoCaptionsSource | null;
  /** Show the subtitles only while this file's length agrees with the transcribed one. */
  captionsMustMatchDuration?: boolean;
}) {
  const { t, locale } = useTranslation();
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
  const [frameReady, setFrameReady] = useState(false);
  const fills = !shape || shape.w / shape.h >= FILL_MIN_RATIO;

  // Automatic subtitles. Fetched the first time the reader comes near the
  // player (pointer, focus, play), not for every video in the feed, and handed
  // to <track> as blob: URLs because a <track> cannot send the Authorization
  // header the API needs. The browser parses them; this player draws the
  // current cue itself (track mode "hidden") so the words sit above the bar
  // and follow it, and switches to the browser's own drawing ("showing") only
  // in the iPhone's native fullscreen, where nothing of ours is on screen.
  const captions =
    captionsSource &&
    (!captionsMustMatchDuration ||
      (captionsSource.durationMs != null &&
        duration != null &&
        Math.abs(duration * 1000 - captionsSource.durationMs) <= CAPTIONS_DURATION_TOLERANCE_MS))
      ? captionsSource
      : null;
  // null until the reader presses CC: the default can only be worked out
  // once the subtitles are known to fit this file.
  const [captionsChoice, setCaptionsChoice] = useState<boolean | null>(null);
  const captionsOn =
    captionsChoice ?? (captions ? captionsOnByDefault(captions.sourceLang, locale) : false);
  const [wantCaptions, setWantCaptions] = useState(false);
  const [tracks, setTracks] = useState<LoadedTrack[]>([]);
  const [cue, setCue] = useState("");
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const activeTrack = captionsOn ? pickCaptionTrack(tracks, locale) : null;
  const captionsServer = captions?.serverId;
  const captionsPost = captions?.postId;

  useEffect(() => {
    if (!captionsServer || !captionsPost || !wantCaptions) {
      return;
    }
    let cancelled = false;
    let made: string[] = [];
    fetchCommunityHomeCaptions(captionsServer, captionsPost, locale)
      .then((res) => {
        if (cancelled) {
          return;
        }
        const loaded = res.tracks.map((track) => ({
          ...track,
          id: `cc-${track.source ? "source" : track.lang}`,
          url: captionTrackUrl(track.vtt),
        }));
        made = loaded.map((track) => track.url);
        setTracks(loaded);
      })
      .catch(() => {
        // No subtitles is the player as it always was, until the next
        // approach, play or CC press asks again (a blip must not cost the
        // subtitles for as long as the card stays on screen).
        if (!cancelled) setWantCaptions(false);
      });
    return () => {
      cancelled = true;
      for (const blobUrl of made) URL.revokeObjectURL(blobUrl);
      setTracks([]);
    };
  }, [captionsServer, captionsPost, locale, wantCaptions]);

  const activeId = activeTrack?.id ?? null;
  useEffect(() => {
    const list = videoRef.current?.textTracks;
    if (!list) {
      return;
    }
    let current: TextTrack | null = null;
    const onCue = () => {
      const active = current?.activeCues;
      setCue(active ? Array.from(active).map(cueText).filter(Boolean).join("\n") : "");
    };
    const apply = () => {
      current?.removeEventListener("cuechange", onCue);
      current = null;
      for (let i = 0; i < list.length; i++) {
        const track = list[i]!;
        if (activeId && track.id === activeId) {
          track.mode = nativeFullscreen ? "showing" : "hidden";
          current = track;
        } else {
          track.mode = "disabled";
        }
      }
      current?.addEventListener("cuechange", onCue);
      onCue();
    };
    apply();
    list.addEventListener?.("addtrack", apply);
    return () => {
      current?.removeEventListener("cuechange", onCue);
      list.removeEventListener?.("addtrack", apply);
      setCue("");
    };
  }, [activeId, tracks, nativeFullscreen]);

  // iPhone's native fullscreen has none of our chrome: the browser draws the
  // cues there, and this player again once it is back on the page.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !captionsPost) {
      return;
    }
    const begin = () => setNativeFullscreen(true);
    const end = () => setNativeFullscreen(false);
    v.addEventListener("webkitbeginfullscreen", begin);
    v.addEventListener("webkitendfullscreen", end);
    return () => {
      v.removeEventListener("webkitbeginfullscreen", begin);
      v.removeEventListener("webkitendfullscreen", end);
    };
  }, [captionsPost]);

  const toggleCaptions = () => {
    const next = !captionsOn;
    writeCaptionsPreference(next ? "on" : "off");
    setWantCaptions(true);
    setCaptionsChoice(next);
  };
  const trackLabel = (track: LoadedTrack) => {
    const name = captionLanguageName(track.lang, locale) ?? t("communityHome.media.captionsUnknown");
    return t("communityHome.media.captionsAuto", { language: name });
  };

  useEffect(() => {
    const onChange = () => setFullscreen(currentFullscreenElement() === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  // The blurred sides are the first frame, drawn once into a small canvas.
  // Drawn from an effect because the canvas only mounts once the shape says
  // "fit", which can land after the frame does. A cross-origin frame only
  // taints the canvas, which is fine: it is never read back.
  useEffect(() => {
    const v = videoRef.current;
    const c = backdropRef.current;
    if (fills || !frameReady || !v || !c || v.videoWidth === 0) {
      return;
    }
    c.width = 48;
    c.height = Math.max(1, Math.round((48 * v.videoHeight) / v.videoWidth));
    try {
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    } catch {
      // No frame to draw: the sides stay the card's own colour.
    }
  }, [fills, frameReady]);

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
  const toggle = () => {
    const v = videoRef.current;
    if (!v) {
      return;
    }
    setStarted(true);
    if (captions) setWantCaptions(true);
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
    const wrap = wrapRef.current as WebkitFullscreenElement | null;
    if (!wrap) {
      return;
    }
    if (currentFullscreenElement()) {
      void exitDocumentFullscreen().catch(() => {});
    } else if (
      typeof wrap.requestFullscreen === "function" ||
      typeof wrap.webkitRequestFullscreen === "function"
    ) {
      void requestElementFullscreen(wrap).catch(() => {});
    } else {
      // iPhone Safari has no element fullscreen, only the video's own. Called
      // synchronously so the tap still counts as the gesture it needs.
      (videoRef.current as IosVideo | null)?.webkitEnterFullscreen?.();
    }
  };

  const showChrome = chrome || !playing;
  const iconButton =
    "flex h-9 w-9 shrink-0 @sm/player:h-11 @sm/player:w-11 items-center justify-center rounded-full text-text transition-colors duration-[var(--duration-fast)] hover:bg-text/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 focus-visible:ring-focus-ring";

  return (
    <div
      ref={wrapRef}
      className={cn(
        "group/player @container/player relative w-full overflow-hidden bg-surface-0",
        !fills && !fullscreen && "h-96",
        fullscreen && "h-full",
        !showChrome && "cursor-none",
      )}
      style={fills && !fullscreen ? { aspectRatio: shape ? `${shape.w} / ${shape.h}` : "16 / 9" } : undefined}
      data-home-video={fills ? "fill" : "fit"}
      onPointerMove={() => wake()}
      onPointerEnter={captions ? () => setWantCaptions(true) : undefined}
      onKeyDown={() => wake()}
      onFocus={() => {
        if (captions) setWantCaptions(true);
        wake();
      }}
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
        onLoadedData={() => setFrameReady(true)}
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
        {tracks.length > 0 ? (
          tracks.map((track) => (
            <track
              key={track.id}
              id={track.id}
              kind="subtitles"
              src={track.url}
              srcLang={track.lang === "und" ? undefined : track.lang}
              label={trackLabel(track)}
              data-home-video-track={track.source ? "source" : "translated"}
            />
          ))
        ) : (
          <track kind="captions" />
        )}
      </video>

      {activeTrack && cue && !nativeFullscreen ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 flex justify-center px-4 transition-[bottom] duration-[var(--duration-slow)]",
            showChrome ? "bottom-16 @sm/player:bottom-20 sm:bottom-24" : "bottom-3 sm:bottom-6",
          )}
          data-home-video-cue
        >
          <span
            lang={activeTrack.lang === "und" ? undefined : activeTrack.lang}
            className="max-w-[min(92%,40rem)] whitespace-pre-line rounded-md bg-black/75 px-2 py-0.5 text-center text-xs font-medium leading-snug text-paper @sm/player:px-2.5 @sm/player:py-1 @sm/player:text-sm @2xl/player:text-base"
          >
            {cue}
          </span>
        </div>
      ) : null}

      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-surface-0/90 to-transparent transition-opacity duration-[var(--duration-slow)]",
          showChrome ? "opacity-100" : "opacity-0 group-has-[:focus-visible]/player:opacity-100",
        )}
        aria-hidden
      />
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex items-center gap-1.5 px-3 pb-3 transition-opacity duration-[var(--duration-slow)] @sm/player:gap-2 sm:gap-3 sm:px-5 sm:pb-4",
          showChrome
            ? "opacity-100"
            : "pointer-events-none opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
        )}
        data-home-video-bar
        data-home-video-chrome={showChrome ? "shown" : "hidden"}
      >
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? t("communityHome.media.pause") : t("communityHome.media.play")}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full bg-accent text-on-accent shadow-[0_8px_30px_var(--glow-accent)] transition-transform duration-[var(--duration-fast)] hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 focus-visible:ring-focus-ring",
            started ? "h-9 w-9 @sm/player:h-11 @sm/player:w-11" : "h-11 w-11 @sm/player:h-14 @sm/player:w-14",
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
          <span className="shrink-0 text-xs font-semibold tabular-nums text-text sm:text-sm">
            {formatVideoDuration(time)}
            {duration != null && <span className="text-text-tertiary"> / {formatVideoDuration(duration)}</span>}
          </span>
        ) : (
          <span className="flex shrink-0 flex-col leading-tight">
            <span className="font-display text-base font-extrabold text-text sm:text-lg">
              {t("communityHome.media.watch")}
            </span>
            {duration != null && (
              <span className="text-xs tabular-nums text-text-tertiary sm:text-sm">{formatVideoDuration(duration)}</span>
            )}
          </span>
        )}
        <Slider
          variant="scrub"
          value={time}
          min={0}
          max={duration ?? 1}
          step={0.1}
          disabled={!duration}
          onValueChange={seek}
          aria-label={t("communityHome.media.seek")}
          aria-valuetext={`${formatVideoDuration(time)} / ${formatVideoDuration(duration ?? 0)}`}
          className="mx-1 h-11 min-w-0 flex-1 cursor-pointer"
        />
        {captions ? (
          <button
            type="button"
            onClick={toggleCaptions}
            aria-pressed={captionsOn}
            aria-label={captionsOn ? t("communityHome.media.captionsOff") : t("communityHome.media.captionsOn")}
            className={iconButton}
            data-home-video-cc={captionsOn ? "on" : "off"}
          >
            {captionsOn ? <Captions className="h-5 w-5" aria-hidden /> : <CaptionsOff className="h-5 w-5" aria-hidden />}
          </button>
        ) : null}
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
