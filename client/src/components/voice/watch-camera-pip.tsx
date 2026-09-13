import { useEffect, useRef, useState } from "react";
import { Mic, Volume2 } from "lucide-react";
import {
  hasHlsViewerToken,
  hlsSessionKey,
  isOwnHlsPlaylistProxyUrl,
  shouldAdoptHlsSource,
} from "@/lib/hls-playback";
import { hlsLivePlayerConfig } from "@/lib/hls-live-edge";
import { getAuthToken } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import {
  getVoicePipVolume,
  saveVoicePipVolume,
} from "@/lib/watch-camera-voice-volume";
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
 * MUTED, UNLESS `hasVoiceAudio` SAYS OTHERWISE. By default `muted` is set on
 * the element and set again on every attach, and no volume state reaches this
 * file: the audience's sound comes off the main stream, which is the only
 * place it is mixed, and a second audio channel a second or two out of step
 * with the first is worse than silence. It is also what makes autoplay work
 * at all — a muted element is allowed to start without a gesture, everywhere.
 *
 * `hasVoiceAudio` (`LIVE_HLS_VOICE_TRACK`, "separada" —
 * `docs/plans/WATCH_PARTY_SEPARATE_TRACKS.md`) is the one case that changes
 * this: THIS playlist is the only place the presenter's voice exists at all,
 * so it unmutes, at a volume the viewer picks and this file remembers
 * (`lib/watch-camera-voice-volume.ts`). Autoplaying it unmuted relies on the
 * page already having a user gesture behind it — joining or opening the watch
 * stage always does — the same assumption every WebRTC voice call on this
 * page already makes; `video.play()`'s rejection is still swallowed, same as
 * the muted path, so a browser that refuses it just leaves the corner silent
 * rather than throwing.
 *
 * `hasVideo` is FALSE for the audio-only shape of the same flag (a presenter
 * with no camera who still shares their voice): there is no picture to draw,
 * so the box shows a small "voice" indicator instead of a black video frame,
 * and the underlying `<video>` element keeps existing — hls.js needs an
 * `HTMLMediaElement` to attach to either way — just visually hidden.
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
  hasVideo = true,
  hasVoiceAudio = false,
  className,
  onFrame,
}: {
  /** The camera/voice playlist, already resolved against the API base. */
  src: string;
  /** Whether this playlist carries a picture. See the file doc. */
  hasVideo?: boolean;
  /** Whether this playlist carries the presenter's voice. See the file doc. */
  hasVoiceAudio?: boolean;
  /** The box: a corner, the stage, or the corner plus `invisible`. */
  className: string;
  /** A frame arrived (or the source changed and there is none yet). */
  onFrame: (hasFrame: boolean) => void;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Held in a ref so the attach effect does not list it as a dependency: a
  // parent re-render that changes the callback's identity must not tear a
  // playing camera down.
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  // Read inside the attach effect below without being one of its
  // dependencies: a mode flip mid-party must not reattach hls.js (the
  // lightweight effect further down already applies it live), only change
  // what the NEXT attach starts with.
  const hasVoiceAudioRef = useRef(hasVoiceAudio);
  hasVoiceAudioRef.current = hasVoiceAudio;

  /**
   * "Voz" volume, persisted per browser. Only reachable when `hasVoiceAudio`
   * — every other case has nothing on the element to turn down.
   */
  const [volume, setVolumeState] = useState(getVoicePipVolume);
  const applyVolume = (next: number) => {
    setVolumeState(next);
    saveVoicePipVolume(next);
    if (videoRef.current) {
      videoRef.current.volume = next;
    }
  };

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
  /**
   * The browser refused unmuted autoplay (`NotAllowedError`). Only possible
   * while `hasVoiceAudio` — a muted element is never refused, anywhere. A
   * Farol review caught the gap this closes: without it, a viewer who opened
   * the watch stage with no prior gesture on THIS document (a link opened
   * straight into cinema fullscreen, say) stayed permanently silent, because
   * nothing after the first `play()` rejection ever tried again. This state
   * drives a small "tap to hear" affordance in the corner instead.
   */
  const [blocked, setBlocked] = useState(false);
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
   * `hasVoiceAudio` CAN CHANGE UNDER A RUNNING SESSION: the presenter is free
   * to flip "junto"/"separada" mid-party (`voiceTrackMode`), and that never
   * touches `cameraHlsUrl`'s path, so the attach effect above (keyed on
   * `activeSrc`) would not rerun to notice. Applied in place, same as a token
   * refresh — no reattach, no dropped buffer.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = !hasVoiceAudio;
    if (hasVoiceAudio) {
      video.volume = volume;
    }
  }, [hasVoiceAudio, volume]);

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
    setBlocked(false);

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
        setBlocked(false);
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
      // See the file doc: silent unless this playlist is the presenter's
      // voice, in which case the viewer's remembered level applies too.
      video.muted = !hasVoiceAudioRef.current;
      if (hasVoiceAudioRef.current) {
        video.volume = getVoicePipVolume();
      }
      // ONE PLACE BOTH `play()` CALLS GO THROUGH, so the "tap to hear"
      // fallback cannot drift from which failure it is actually for. Muted
      // autoplay is allowed everywhere, so a rejection there is never the
      // autoplay policy and stays silently swallowed exactly as before.
      //
      // ANY rejection while `hasVoiceAudio` is true shows the affordance,
      // not only `NotAllowedError` specifically: the autoplay-policy
      // rejection is the expected case, but different engines have not all
      // agreed on one error name for it over the years, and a version that
      // throws something else must not silently drop the retry path along
      // with it — the cost of over-showing the button once in a great while
      // (a genuinely transient failure that would have recovered on its
      // own) is far smaller than a viewer stuck permanently and silently
      // muted with nothing on screen explaining why.
      const attemptPlay = () => {
        void video.play().catch(() => {
          if (!cancelled && hasVoiceAudioRef.current) {
            setBlocked(true);
          }
        });
      };
      if (!Hls.isSupported()) {
        // Safari and iOS play MPEG-TS natively. No engine choice to make: a
        // browser with neither simply never produces a frame and the corner
        // stays empty.
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          usingNativeRef.current = true;
          video.src = latestSrcRef.current;
          attemptPlay();
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
        attemptPlay();
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

  /**
   * The click IS the user gesture: a `play()` called from inside a click
   * handler is not subject to the autoplay policy at all, so this always
   * succeeds where the automatic attempt was refused. `onPlaying` clears
   * `blocked`; a rejection here (element torn down mid-click, say) just
   * leaves the affordance showing rather than throwing.
   */
  const retryFromGesture = () => {
    void videoRef.current
      ?.play()
      .then(() => setBlocked(false))
      .catch(() => {
        // Stays visible — the click itself was a real gesture and the
        // browser still refused, which is worth knowing rather than
        // quietly going back to looking like nothing is wrong.
        setBlocked(true);
      });
  };

  return (
    <div
      data-testid="watch-camera-pip"
      data-has-video={hasVideo ? "" : undefined}
      data-has-voice-audio={hasVoiceAudio ? "" : undefined}
      className={cn("relative bg-black", className)}
    >
      <video
        ref={videoRef}
        // `hasVideo === false` still needs this element mounted and playing —
        // hls.js attaches to it either way — just drawn as nothing: `sr-only`
        // rather than `hidden`, so playback (and therefore its audio) is
        // never paused by the browser for being display:none.
        className={cn(
          "bg-black",
          hasVideo ? "h-full w-full" : "sr-only",
        )}
        autoPlay
        muted={!hasVoiceAudio}
        playsInline
        // Not a PiP candidate of its own: the browser's picture-in-picture
        // belongs to the film, and offering it here would put a webcam (or,
        // in "separada" with no camera, a blank frame) in the floating window
        // somebody opened to keep watching the film.
        disablePictureInPicture
      />
      {!hasVideo ? (
        // THE AUDIO-ONLY SHAPE OF "SEPARADA": no camera published, so there
        // is no picture for this box to be — just the fact that a voice is
        // here to hear, in the same corner a webcam would have used.
        <div className="flex h-full w-full items-center justify-center">
          <Mic
            aria-label={t("watchParty.camera.voiceOnly")}
            className="h-1/3 w-1/3 text-paper/70"
          />
        </div>
      ) : null}
      {hasVoiceAudio && blocked ? (
        // THE AUTOPLAY POLICY'S ESCAPE HATCH. Unmuted autoplay can be refused
        // with no prior gesture on this document at all (opening the watch
        // stage straight into cinema fullscreen, say); a click here IS that
        // gesture, so the retry always succeeds where the automatic one
        // could not.
        <button
          type="button"
          data-testid="watch-camera-pip-tap-to-hear"
          onClick={(event) => {
            event.stopPropagation();
            retryFromGesture();
          }}
          className="absolute inset-0 flex items-center justify-center gap-1 bg-black/50 text-xs font-medium text-paper"
        >
          <Volume2 className="h-4 w-4" aria-hidden />
          {t("watchParty.camera.tapToHear")}
        </button>
      ) : null}
      {hasVoiceAudio ? (
        <input
          type="range"
          data-testid="watch-camera-pip-voice-volume"
          aria-label={t("watchParty.camera.voiceVolume")}
          aria-valuetext={t("voice.tile.volumePercent", {
            percent: Math.round(volume * 100),
          })}
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(event) => applyVolume(Number(event.target.value))}
          onClick={(event) => event.stopPropagation()}
          className="absolute inset-x-1 bottom-1 h-1 cursor-pointer accent-signal"
        />
      ) : null}
    </div>
  );
}
