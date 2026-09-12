import { useEffect, useRef } from "react";
import { hasHlsViewerToken, isOwnHlsPlaylistProxyUrl } from "@/lib/hls-playback";
import { hlsLivePlayerConfig } from "@/lib/hls-live-edge";
import { getAuthToken } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The presenter's camera, as a second playlist beside the film.
 *
 * DELIBERATELY MUCH SMALLER THAN `HlsWatchPlayer`, and this is the design
 * rather than a shortcut. That player carries a ladder, a quality menu, a
 * volume preference, a live-edge badge, a stall watchdog that refetches the
 * session from the API, Media Session metadata and a Picture-in-Picture
 * affordance. The camera needs exactly none of it: one rendition, no sound, no
 * chrome, and a failure whose correct response is to disappear rather than to
 * tell anybody anything. Reusing the big player here would mean a webcam that
 * can claim someone's lock screen, fight the film for the volume preference
 * and put a second "reconnecting" overlay on the stage.
 *
 * MUTED, AND NOT FROM A PREFERENCE. `muted` is set on the element and set
 * again on every attach, and no volume state reaches this file. The audience's
 * sound comes off the main stream, which is the only place it is mixed; a
 * second audio channel a second or two out of step with the first is worse
 * than silence. It is also what makes autoplay work at all — a muted element
 * is allowed to start without a gesture, everywhere.
 *
 * DRIFT IS EXPECTED AND IS NOT CHASED. The two playlists are two independent
 * egresses started seconds apart, each with its own 2 s segments, so the
 * camera runs one to three seconds off the film. Holding the film back to
 * match a webcam would be a worse film. See
 * `docs/plans/WATCH_PARTY_CAMERA_PIP.md`, "Sync".
 *
 * A FAILURE IS SILENT. No overlay, no retry banner, no "loading". The camera
 * is not what anybody came for, and the one thing it must never do is take
 * attention away from the film to report its own health. The element simply
 * never reports a frame, and the corner box stays invisible.
 */
export function WatchCameraPip({
  src,
  className,
  onFrame,
}: {
  /** The camera playlist, already resolved against the API base. */
  src: string;
  /** The box: a corner, the stage, or the corner plus `invisible`. */
  className: string;
  /** A frame arrived (or the source changed and there is none yet). */
  onFrame: (hasFrame: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Held in a ref so the attach effect does not list it as a dependency: a
  // parent re-render that changes the callback's identity must not tear a
  // playing camera down.
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    let cancelled = false;
    let hls: { destroy: () => void } | null = null;
    onFrameRef.current(false);

    // Same rule as the film's player: the header is only for our own proxy,
    // only when the URL carries no `?t=`, and never on the presigned bucket
    // URLs the playlist's segment lines point at. See CLAUDE.md pitfall 16 for
    // what attaching it unconditionally cost.
    let authToken: string | null = null;
    const refreshAuthToken = () => {
      void getAuthToken().then((token) => {
        if (!cancelled) {
          authToken = token;
        }
      });
    };
    refreshAuthToken();
    const authTokenTimer = window.setInterval(refreshAuthToken, 30_000);

    const onPlaying = () => {
      if (!cancelled) {
        onFrameRef.current(true);
      }
    };
    const onFailed = () => {
      if (!cancelled) {
        onFrameRef.current(false);
      }
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("error", onFailed);
    video.addEventListener("emptied", onFailed);

    async function attach() {
      const { default: Hls } = await import("hls.js");
      if (cancelled || !video) {
        return;
      }
      video.muted = true;
      if (!Hls.isSupported()) {
        // Safari and iOS play MPEG-TS natively. No engine choice to make: a
        // browser with neither simply never produces a frame and the corner
        // stays empty.
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = src;
          void video.play().catch(() => {
            // Muted autoplay is allowed everywhere; if it still refused, the
            // camera stays hidden and the film is untouched.
          });
        }
        return;
      }
      const player = new Hls({
        ...hlsLivePlayerConfig(),
        enableWorker: true,
        capLevelToPlayerSize: true,
        // One rendition, so there is no ladder to negotiate and nothing for
        // ABR to do. The camera's playlist is deliberately absent from the
        // master, which is why this loads the rung path directly.
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 1000,
        xhrSetup: (xhr, url) => {
          if (
            isOwnHlsPlaylistProxyUrl(url) &&
            authToken &&
            !hasHlsViewerToken(url)
          ) {
            xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
          }
        },
      });
      hls = player as unknown as { destroy: () => void };
      player.loadSource(src);
      player.attachMedia(video);
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && !cancelled) {
          // The film's watchdog owns reconnecting to a restarted session. This
          // one gives up: the camera egress stopping is an ordinary event (the
          // host closed their webcam) and `cameraHlsUrl` disappearing off the
          // next stream frame is what actually unmounts this.
          onFrameRef.current(false);
        }
      });
      player.on(Hls.Events.MANIFEST_PARSED, () => {
        void video.play().catch(() => {
          // See above: muted, so a refusal here is not the autoplay policy.
        });
      });
    }

    void attach();
    return () => {
      cancelled = true;
      window.clearInterval(authTokenTimer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onFailed);
      video.removeEventListener("emptied", onFailed);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
      onFrameRef.current(false);
    };
  }, [src]);

  return (
    <video
      ref={videoRef}
      data-testid="watch-camera-pip"
      className={cn("bg-black", className)}
      autoPlay
      muted
      playsInline
      // Not a PiP candidate of its own: the browser's picture-in-picture
      // belongs to the film, and offering it here would put a webcam in the
      // floating window somebody opened to keep watching the film.
      disablePictureInPicture
    />
  );
}
