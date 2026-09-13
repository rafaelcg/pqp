import { useEffect, useRef, useState } from "react";
import {
  hasHlsViewerToken,
  hlsSessionKey,
  isOwnHlsPlaylistProxyUrl,
  shouldAdoptHlsSource,
} from "@/lib/hls-playback";
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
 * egresses started seconds apart, each with its own segments, so the camera
 * runs a second or more off the film. Holding the film back to match a webcam
 * would be a worse film. See `docs/WATCH_PARTY.md`, "The presenter's camera,
 * floating over the film".
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

  /**
   * A RESTAMPED TOKEN IS NOT A NEW SESSION, and this is the same rule
   * `hls-watch-player.tsx` needed for the film after every seatless viewer
   * rebuffered twice a minute on it (CLAUDE.md pitfall 16's sibling bug). The
   * server restamps `cameraHlsUrl`'s `?t=` on the same audience-keyframe
   * cadence it restamps the film's, so `src` changes about every 30s for a
   * camera transcode that has not moved at all. Adopting every change would
   * tear hls.js down, drop the buffer and hide the PiP on that cadence for
   * the whole party. Only the path (`hlsSessionKey`, which strips the query)
   * changing means the camera egress actually restarted.
   */
  const [activeSrc, setActiveSrc] = useState(src);
  const sessionRef = useRef<string | null>(hlsSessionKey(src));

  // The live hls.js instance, reachable outside the attach effect so a plain
  // token refresh (below) can hand it a fresh URL without tearing it down.
  const hlsPlayerRef = useRef<{
    loadSource: (url: string) => void;
    destroy: () => void;
  } | null>(null);
  // The latest `src`, including its current token, for the same reason: the
  // heavy attach effect only reruns on a genuine session change, but a
  // same-session token refresh still needs the freshest URL on hand.
  const latestSrcRef = useRef(src);
  latestSrcRef.current = src;
  // Set only in the native (non hls.js) branch of `attachOnce`, so the
  // token-refresh effect below knows there is no `hlsPlayerRef` to hand the
  // fresh URL to and must update the `<video>` element directly instead.
  const usingNativeRef = useRef(false);

  /**
   * TOKEN REFRESHES ARE APPLIED IN PLACE, NEVER BY REATTACHING. This runs
   * BEFORE the session-adopt effect below (declaration order is commit
   * order), so it reads `sessionRef.current` before that effect has a chance
   * to move it: on a genuine session change both effects see the OLD session
   * here, this one correctly does nothing, and the one below does the (one)
   * real reattach. On a same-session token restamp this is the whole fix —
   * the RUNNING instance still needs the fresh token before the old one
   * expires (`HLS_VIEWER_TOKEN_TTL_MS` is an hour, comfortably shorter than a
   * long party) — and `loadSource` reloads the manifest against the new URL
   * without detaching the `<video>` or losing anything `onFrame` already
   * reported, a world apart from destroying and recreating the whole player.
   *
   * NATIVE SAFARI GETS THE SAME TREATMENT, JUST APPLIED DIFFERENTLY: there is
   * no `loadSource` to call, so a same-session token refresh is applied
   * straight to the element's `src` in place — the same `<video>` node, not
   * a fresh one, and no unmount of this component. Leaving it alone (as a
   * previous revision did) meant a native viewer's camera silently stopped
   * once the URL's `?t=` the element was still fetching against expired,
   * even though the film's own player, playing on hls.js, kept refreshing
   * fine right beside it.
   */
  useEffect(() => {
    if (shouldAdoptHlsSource(sessionRef.current, src)) {
      // A genuine session change: the effect below does the (one) real
      // reattach, so there is nothing for this one to apply in place.
      return;
    }
    if (hlsPlayerRef.current) {
      hlsPlayerRef.current.loadSource(src);
      return;
    }
    if (usingNativeRef.current && videoRef.current) {
      videoRef.current.src = src;
    }
  }, [src]);

  /**
   * A RESTAMPED TOKEN IS NOT A NEW SESSION, and this is the same rule
   * `hls-watch-player.tsx` needed for the film after every seatless viewer
   * rebuffered twice a minute on it (CLAUDE.md pitfall 16's sibling bug). The
   * server restamps `cameraHlsUrl`'s `?t=` on the same audience-keyframe
   * cadence it restamps the film's, so `src` changes about every 30s for a
   * camera transcode that has not moved at all. Adopting every change as a
   * full reattach would tear hls.js down, drop the buffer and hide the PiP on
   * that cadence for the whole party. Only the path (`hlsSessionKey`, which
   * strips the query) changing means the camera egress actually restarted.
   */
  useEffect(() => {
    if (!shouldAdoptHlsSource(sessionRef.current, src)) {
      return;
    }
    sessionRef.current = hlsSessionKey(src);
    setActiveSrc(src);
  }, [src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    let cancelled = false;
    usingNativeRef.current = false;
    onFrameRef.current(false);

    // Same rule as the film's player: the header is only for our own proxy,
    // only when the URL carries no `?t=`, and never on the presigned bucket
    // URLs the playlist's segment lines point at. See CLAUDE.md pitfall 16 for
    // what attaching it unconditionally cost.
    //
    // SKIPPED ENTIRELY when the active URL already carries its own viewer
    // token, or is not our proxy at all (a public bucket URL, unsigned mode):
    // neither ever reads a Bearer header, so polling `getAuthToken()` for one
    // is pure waste at watch-party scale — hundreds of viewers, each an
    // immediate lookup plus one every 30s, for a header nothing will send.
    const needsAuthToken =
      isOwnHlsPlaylistProxyUrl(activeSrc) && !hasHlsViewerToken(activeSrc);
    let authToken: string | null = null;
    let authTokenTimer: ReturnType<typeof setInterval> | null = null;
    if (needsAuthToken) {
      const refreshAuthToken = () => {
        getAuthToken().then(
          (token) => {
            if (!cancelled) {
              authToken = token;
            }
          },
          () => {
            // Keep whatever token we already had rather than clearing it: a
            // transient refresh failure must not undo an otherwise-working
            // header, and this catch's only job is to stop the rejection
            // from going unhandled.
          },
        );
      };
      refreshAuthToken();
      authTokenTimer = setInterval(refreshAuthToken, 30_000);
    }

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

    async function attachOnce() {
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
          usingNativeRef.current = true;
          video.src = latestSrcRef.current;
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
      hlsPlayerRef.current = player as unknown as {
        loadSource: (url: string) => void;
        destroy: () => void;
      };
      // The freshest URL on hand, not the value this effect closed over: a
      // token refresh that landed between mount and this async resolution
      // (the dynamic import is one microtask, but still one) must not attach
      // with an already-stale one.
      player.loadSource(latestSrcRef.current);
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

    // BOUNDED RETRY ON THE IMPORT/ATTACH ITSELF, separate from the silent
    // give-up on a fatal playback error above. A chunk-loading failure (an
    // offline browser, a CDN hiccup) is exactly the kind of thing that
    // resolves on its own a few seconds later, and `void attachOnce()` with no
    // handler at all would both leave the camera invisible forever AND surface
    // as an unhandled rejection. Two retries, then the same silent give-up
    // every other failure in this file gets: the camera is not what anybody
    // came for, and it must never do more than log for itself.
    const ATTACH_RETRY_DELAYS_MS = [2_000, 5_000];
    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    function attachWithRetry(attempt: number): void {
      attachOnce().catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        console.error(
          `[watch-camera-pip] attach failed (attempt ${attempt + 1}):`,
          error,
        );
        onFrameRef.current(false);
        const delay = ATTACH_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          return;
        }
        const timer = setTimeout(() => {
          if (!cancelled) {
            attachWithRetry(attempt + 1);
          }
        }, delay);
        retryTimers.push(timer);
      });
    }
    attachWithRetry(0);

    return () => {
      cancelled = true;
      if (authTokenTimer !== null) {
        clearInterval(authTokenTimer);
      }
      for (const timer of retryTimers) {
        clearTimeout(timer);
      }
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onFailed);
      video.removeEventListener("emptied", onFailed);
      hlsPlayerRef.current?.destroy();
      hlsPlayerRef.current = null;
      video.removeAttribute("src");
      video.load();
      onFrameRef.current(false);
    };
  }, [activeSrc]);

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
