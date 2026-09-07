import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { useTranslation } from "@/lib/i18n";
import { setHlsPlaybackStats } from "@/lib/hls-playback";
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

  useEffect(() => {
    setHasFrame(false);
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

    async function attach() {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        void video.play().catch(() => {});
        return;
      }
      const { default: Hls } = await import("hls.js");
      if (cancelled) {
        return;
      }
      if (!Hls.isSupported()) {
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
        void video.play().catch(() => {});
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
    </div>
  );
}
