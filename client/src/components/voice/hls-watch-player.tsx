import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { useTranslation } from "@/lib/i18n";
import {
  chooseHlsEngine,
  isAutoplayRefusal,
  setHlsPlaybackStats,
} from "@/lib/hls-playback";
import { cn } from "@/lib/utils";

/**
 * HLS playlist for a LiveKit egress screen share.
 *
 * Safari plays MPEG-TS natively. Everyone else uses hls.js. The picture is
 * 8–12 s behind the presenter; that is the product, not a bug, and the
 * badge says so.
 */
export function HlsWatchPlayer({
  src,
  delaySeconds = 10,
  className,
  videoRef,
  onDoubleClick,
}: {
  src: string;
  delaySeconds?: number;
  className?: string;
  videoRef?: RefObject<HTMLVideoElement | null>;
  onDoubleClick?: () => void;
}) {
  const { t } = useTranslation();
  const innerRef = useRef<HTMLVideoElement | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  // Autoplay with sound was refused (a tab that resumed the call without a
  // click, Safari's default). The picture runs muted and one tap fixes it.
  const [needsUnmute, setNeedsUnmute] = useState(false);

  useEffect(() => {
    setHasFrame(false);
    setNeedsUnmute(false);
    setHlsPlaybackStats(null);
  }, [src]);

  useEffect(() => {
    const el = videoRef?.current ?? innerRef.current;
    if (!el) {
      return;
    }
    const video: HTMLVideoElement = el;
    let cancelled = false;
    let hls: { destroy: () => void } | null = null;

    const reportSize = () => {
      if (cancelled || video.videoWidth === 0 || video.videoHeight === 0) {
        return;
      }
      setHlsPlaybackStats({
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    const onPlaying = () => {
      if (!cancelled) {
        setHasFrame(true);
        reportSize();
      }
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("loadedmetadata", reportSize);

    // A refused play() is a paused element behind the "loading" overlay
    // forever, not an error event. Retry muted so the picture at least
    // shows, and offer the sound back with a tap.
    async function play() {
      try {
        await video.play();
      } catch (error) {
        if (cancelled || !isAutoplayRefusal(error)) {
          return;
        }
        video.muted = true;
        try {
          await video.play();
          if (!cancelled) {
            setNeedsUnmute(true);
          }
        } catch {
          // Still refused even muted; the user can tap the frame.
        }
      }
    }

    async function attach() {
      // hls.js first, whenever MSE exists. Chrome answers "maybe" to the
      // native probe and then never plays; see `chooseHlsEngine`.
      const { default: Hls } = await import("hls.js");
      if (cancelled) {
        return;
      }
      const engine = chooseHlsEngine({
        nativeHls: video.canPlayType("application/vnd.apple.mpegurl"),
        mseSupported: Hls.isSupported(),
      });
      if (engine === "native") {
        video.src = src;
        void play();
        return;
      }
      if (engine === "none") {
        return;
      }
      const player = new Hls({
        liveSyncDurationCount: 3,
        enableWorker: true,
        // Playlist is written after the first 2 s segment. Retry the
        // initial 404 instead of giving up while egress is still starting.
        manifestLoadingMaxRetry: 12,
        manifestLoadingRetryDelay: 1000,
        manifestLoadingMaxRetryTimeout: 8000,
      });
      hls = player;
      player.loadSource(src);
      player.attachMedia(video);
      player.on(Hls.Events.MANIFEST_PARSED, () => {
        void play();
      });
    }

    void attach();
    return () => {
      cancelled = true;
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("loadedmetadata", reportSize);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
      setHlsPlaybackStats(null);
    };
  }, [src, videoRef]);

  return (
    <div className={cn("relative h-full w-full bg-black", className)}>
      <video
        ref={(node) => {
          innerRef.current = node;
          if (videoRef) {
            (videoRef as MutableRefObject<HTMLVideoElement | null>).current =
              node;
          }
        }}
        className="h-full w-full"
        autoPlay
        playsInline
        onDoubleClick={onDoubleClick}
      />
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5">
        <span className="rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-paper">
          {t("voice.hls.delay", { seconds: delaySeconds })}
        </span>
      </div>
      {!hasFrame ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-paper-muted">
          {t("voice.hls.buffering")}
        </div>
      ) : null}
      {hasFrame && needsUnmute ? (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-sm font-medium text-paper hover:bg-black/90"
          onClick={() => {
            const el = videoRef?.current ?? innerRef.current;
            if (el) {
              el.muted = false;
            }
            setNeedsUnmute(false);
          }}
        >
          {t("voice.hls.unmute")}
        </button>
      ) : null}
    </div>
  );
}
