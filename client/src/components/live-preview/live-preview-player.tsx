import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { chooseHlsEngine, isAutoplayRefusal, resolveHlsUrl } from "@/lib/hls-playback";
import { hlsLivePlayerConfig, llHlsConfig } from "@/lib/hls-live-edge";
import { useTranslation } from "@/lib/i18n";

/**
 * The signed-out live preview's player. Deliberately NOT `HlsWatchPlayer`:
 * that one attaches a Bearer to its own proxy URLs, sends presence beats and
 * telemetry, and refreshes its URL through `GET /api/channels/:id/live`, and
 * every one of those would 401 for a visitor with no account. This is the
 * film and nothing else: hls.js where MSE exists, the native player otherwise
 * (older iPhone webviews, the in-app browsers a streamer's link opens in),
 * muted autoplay with one tap to unmute, and no header on any request. The
 * capability is the `?t=` in the URL, and it stops working at the end of the
 * window whatever this component does.
 *
 * `onUnavailable` fires when the playlist refuses (401, 403 or 404: the
 * window ended, the flag went off, the party ended) or the native player
 * gives up. The panel decides what that means by asking the server again.
 */
export function LivePreviewPlayer({
  url,
  mode,
  onUnavailable,
}: {
  url: string;
  mode: "conventional" | "ll";
  onUnavailable: () => void;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    let cancelled = false;
    let destroy: (() => void) | null = null;
    const src = resolveHlsUrl(url);
    const fail = (reason: string) => {
      if (!cancelled) {
        // One line, so "the preview stopped" can be told apart in a bug report.
        console.warn("[live-preview] player unavailable:", reason);
        unavailableRef.current();
      }
    };
    const play = () => {
      video.muted = true;
      void video.play().catch((error: unknown) => {
        // Muted autoplay is allowed almost everywhere; a refusal leaves the
        // poster and the tap that unmutes also starts it. Any other rejection
        // (an `AbortError` while the source attaches) is not a broken stream
        // either: a real failure arrives as a player error below.
        if (!isAutoplayRefusal(error)) {
          console.warn("[live-preview] play() rejected:", error);
        }
      });
    };

    void (async () => {
      const { default: Hls } = await import("hls.js");
      if (cancelled) {
        return;
      }
      const engine = chooseHlsEngine({
        nativeHls: video.canPlayType("application/vnd.apple.mpegurl"),
        mseSupported: Hls.isSupported(),
      });
      if (engine === "none") {
        fail("no-engine");
        return;
      }
      if (engine === "native") {
        const onError = () => fail("native-error");
        video.src = src;
        video.addEventListener("error", onError);
        destroy = () => {
          video.removeEventListener("error", onError);
          video.removeAttribute("src");
          video.load();
        };
        play();
        return;
      }
      const hls = new Hls({
        ...(mode === "ll" ? llHlsConfig("segments") : hlsLivePlayerConfig()),
        enableWorker: true,
        capLevelToPlayerSize: true,
      });
      let networkRetries = 0;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // A refused PLAYLIST means the capability or the session is over. A
        // missing segment is ordinary live churn and is left to hls.js.
        const status = data.response?.code;
        const playlistLoad =
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.LEVEL_LOAD_ERROR;
        if (playlistLoad && (status === 401 || status === 403 || status === 404)) {
          hls.stopLoad();
          fail(`playlist-${status}`);
          return;
        }
        if (!data.fatal) {
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
          networkRetries += 1;
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }
        fail(`${data.type}:${data.details}`);
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        networkRetries = 0;
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, play);
      destroy = () => hls.destroy();
    })();

    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [url, mode]);

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const next = !video.muted;
    video.muted = next;
    setMuted(next);
    if (!next) {
      void video.play().catch(() => {});
    }
  };

  return (
    <div className="relative h-full w-full bg-surface-0">
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        playsInline
        muted
        autoPlay
        // A preview is a window onto a live film, not a file: no download,
        // no picture-in-picture that outlives the page, no remote playback.
        controlsList="nodownload noremoteplayback"
        disablePictureInPicture
        onClick={toggleSound}
      />
      <Button
        type="button"
        size="icon"
        variant="secondary"
        className="absolute bottom-3 right-3 rounded-full"
        aria-label={muted ? t("livePreview.player.unmute") : t("livePreview.player.mute")}
        onClick={toggleSound}
      >
        {muted ? (
          <VolumeX aria-hidden className="h-4 w-4" />
        ) : (
          <Volume2 aria-hidden className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}
