import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import {
  Check,
  Crop,
  PictureInPicture2,
  Radio,
  Scan,
  Settings2,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import {
  chooseHlsEngine,
  isAutoplayRefusal,
  isOwnHlsPlaylistProxyUrl,
  setHlsPlaybackStats,
} from "@/lib/hls-playback";
import {
  buildMediaSessionMetadata,
  hasSafariPresentationMode,
  isBehindLive,
  isPipAvailable,
} from "@/lib/hls-live-edge";
import { fetchChannelLive, getAuthToken } from "@/lib/api";
import {
  hlsSessionKey,
  resolveHlsUrl,
  sameHlsSession,
} from "@/lib/hls-playback";
import { Tooltip } from "@/components/ui/tooltip";
import { useVideoFit } from "@/hooks/use-video-fit";
import { videoFitClass } from "@/lib/video-fit";
import { HlsStallWatch, channelIdFromHlsUrl } from "@/lib/hls-stall";
import {
  AUTO_HLS_QUALITY,
  describeHlsLevel,
  levelIndexFor,
  offeredHlsLevels,
  readHlsQuality,
  writeHlsQuality,
  type HlsLevelLike,
  type HlsQualityPref,
} from "@/lib/hls-quality";
import {
  applyMuteToggle,
  applySliderChange,
  effectiveMuted,
  readHlsVolume,
  writeHlsVolume,
  type HlsVolumePref,
} from "@/lib/hls-volume";
import { cn } from "@/lib/utils";

const STALL_TICK_MS = 1_000;

type StreamPhase = "playing" | "reconnecting" | "dead";

/** hls.js instance shape this file actually touches. */
interface HlsHandle {
  destroy: () => void;
  liveSyncPosition: number | null;
  media: HTMLMediaElement | null;
  /** `-1` is Auto. Assigning pins the rendition; hls.js owns it otherwise. */
  currentLevel: number;
  levels: HlsLevelLike[];
}

/** Safari's non-standard presentation-mode video element. */
interface SafariPipVideo extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture") => void;
  webkitPresentationMode?: "inline" | "picture-in-picture" | "fullscreen";
}

/** The glyph says the level, so a turned-down stream reads at a glance. */
function VolumeGlyph({ volume, muted }: { volume: number; muted: boolean }) {
  if (muted || volume === 0) {
    return <VolumeX className="h-3.5 w-3.5" />;
  }
  if (volume < 0.5) {
    return <Volume1 className="h-3.5 w-3.5" />;
  }
  return <Volume2 className="h-3.5 w-3.5" />;
}

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
  mediaTitle,
  communityName,
  coverUrl,
}: {
  src: string;
  delaySeconds?: number;
  className?: string;
  videoRef?: RefObject<HTMLVideoElement | null>;
  onDoubleClick?: () => void;
  /** Party/presenter title for the lock screen and the tab. */
  mediaTitle?: string;
  /** Server or community name, shown as the lock screen's subtitle. */
  communityName?: string | null;
  /** Server icon, used as lock-screen artwork when nothing better exists. */
  coverUrl?: string | null;
}) {
  const { t } = useTranslation();
  const fit = useVideoFit("watch");
  const whole = fit.fit === "contain";
  const innerRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<HlsHandle | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  // Autoplay with sound was refused (a tab that resumed the call without a
  // click, Safari's default). The picture runs muted and one tap fixes it.
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [pipAvailable, setPipAvailable] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [behindLive, setBehindLive] = useState(false);
  // Stall handling (`lib/hls-stall.ts`). `activeSrc` is what is actually
  // attached: the prop until a reconnect fetches a fresher URL from
  // `GET /api/channels/:id/live` (a restarted egress has a new playlist),
  // `attempt` re-runs the attach effect for a same-URL reconnect. `phase`
  // is the copy on the overlay.
  const [activeSrc, setActiveSrc] = useState(src);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<StreamPhase>("playing");
  const watchRef = useRef<HlsStallWatch>(new HlsStallWatch());
  // The viewer's own level for the broadcast, remembered per browser. Read
  // once, then held in a ref as well so the attach effect can apply it to a
  // fresh element without listing it as a dependency: that effect tears down
  // and rebuilds hls.js, and nudging the slider must not restart the stream.
  const [volumePref, setVolumePref] = useState<HlsVolumePref>(readHlsVolume);
  const volumePrefRef = useRef(volumePref);
  volumePrefRef.current = volumePref;
  // Where the mute button comes back to.
  const restoreRef = useRef(volumePref.volume || 1);
  useEffect(() => {
    if (volumePref.volume > 0) {
      restoreRef.current = volumePref.volume;
    }
  }, [volumePref.volume]);

  const updateVolume = useCallback((next: HlsVolumePref) => {
    setVolumePref(next);
    writeHlsVolume(next);
  }, []);

  // The ladder, and this viewer's own pick from it. `levels` is whatever the
  // master playlist turned out to carry, so a stream that ran one rendition
  // (a budget refusal, or a one-rung `LIVE_HLS_LADDER`) simply offers no
  // menu rather than a menu with one row in it. The preference is held in a
  // ref as well because the attach effect tears hls.js down and rebuilds it:
  // picking a rung must not restart the stream.
  const [levels, setLevels] = useState<HlsLevelLike[]>([]);
  const [autoHeight, setAutoHeight] = useState<number | null>(null);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [qualityPref, setQualityPref] =
    useState<HlsQualityPref>(readHlsQuality);
  const qualityPrefRef = useRef(qualityPref);
  qualityPrefRef.current = qualityPref;

  const pickQuality = useCallback((next: HlsQualityPref) => {
    setQualityPref(next);
    writeHlsQuality(next);
    setQualityOpen(false);
    const hls = hlsRef.current;
    if (hls) {
      hls.currentLevel = levelIndexFor(hls.levels, next);
    }
  }, []);

  const offered = offeredHlsLevels(levels);

  /**
   * A RESTAMPED URL IS NOT A NEW STREAM, and treating it as one is what made
   * every seatless web viewer rebuffer twice a minute for the whole film.
   *
   * `hlsUrl` carries a per-viewer `?t=` token and the server restamps it on
   * the audience keyframe, every 30 seconds while the channel is live, so this
   * prop changes constantly for a stream that has not moved. Adopting it
   * re-attaches the element, drops the buffer and starts the whole ladder
   * negotiation again. Only the path names the session
   * (`.../<channelId>/<startedAt>`), and only `startedAt` changing means the
   * viewer genuinely has to move.
   *
   * This is the same rule iOS's `WatchStreamSwap` was given when the audience
   * half was written; the web was never given it, and because the symptom is
   * identical on both it read as the stream being broken rather than one
   * platform missing a guard.
   */
  const sessionRef = useRef<string | null>(null);
  useEffect(() => {
    const key = hlsSessionKey(src);
    if (sessionRef.current !== null && sessionRef.current === key) {
      return;
    }
    sessionRef.current = key;
    setActiveSrc(src);
    setPhase("playing");
    watchRef.current.reset(Date.now());
  }, [src]);

  useEffect(() => {
    setHasFrame(false);
    setNeedsUnmute(false);
    setHlsPlaybackStats(null);
    // A restarted egress can come back with a different ladder (a rung
    // refused for budget this time). Forget the old one rather than offering
    // rows that no longer exist; the pin itself is kept and re-applied if
    // the height is still there.
    setLevels([]);
    setAutoHeight(null);
    setQualityOpen(false);
  }, [activeSrc, attempt]);

  const reconnect = useCallback(async () => {
    setPhase("reconnecting");
    const channelId = channelIdFromHlsUrl(activeSrc);
    let next: string | null = null;
    if (channelId) {
      try {
        const live = await fetchChannelLive(channelId);
        next = live.stream ? resolveHlsUrl(live.stream.hlsUrl) : null;
      } catch {
        // The API is the thing that is down, or we lost access: retry the
        // URL we have, the watchdog will call it dead if that fails too.
      }
    }
    if (next && !sameHlsSession(next, activeSrc)) {
      // A genuinely different session: follow it, and remember it so the
      // `src` prop arriving with the same session a moment later does not
      // re-attach on top of this one.
      sessionRef.current = hlsSessionKey(next);
      setActiveSrc(next);
    } else if (next && next !== activeSrc) {
      // Same session, fresher token. Worth taking on a reconnect (the old one
      // may be what failed) and never worth taking otherwise.
      setActiveSrc(next);
    } else {
      setAttempt((n) => n + 1);
    }
  }, [activeSrc]);

  const retryFromDead = useCallback(() => {
    watchRef.current.reset(Date.now());
    void reconnect();
  }, [reconnect]);

  const getVideo = useCallback(
    () => videoRef?.current ?? innerRef.current,
    [videoRef],
  );

  // The element follows the preference, plus the browser's own refusal.
  // `needsUnmute` is the temporary half: it is never written to storage, and
  // either unmute affordance clears it, so the two cannot fight.
  useEffect(() => {
    const video = getVideo();
    if (!video) {
      return;
    }
    video.volume = volumePref.volume;
    video.muted = effectiveMuted({
      pref: volumePref,
      autoplayMuted: needsUnmute,
    });
  }, [getVideo, volumePref, needsUnmute, activeSrc, attempt, hasFrame]);

  /** Both unmute affordances: the person asked for sound, so give them sound. */
  const silenced = effectiveMuted({
    pref: volumePref,
    autoplayMuted: needsUnmute,
  });

  const restoreSound = useCallback(() => {
    setNeedsUnmute(false);
    updateVolume({
      volume: volumePrefRef.current.volume || restoreRef.current || 1,
      muted: false,
    });
  }, [updateVolume]);

  const jumpToLive = useCallback(() => {
    const video = getVideo();
    if (!video) {
      return;
    }
    const hls = hlsRef.current;
    const liveEdge = hls?.liveSyncPosition ?? video.duration;
    if (Number.isFinite(liveEdge)) {
      video.currentTime = liveEdge as number;
    }
  }, [getVideo]);

  // Behind-live polling. `timeupdate` fires roughly 4x/s, which is plenty
  // for a badge nobody needs to the millisecond.
  useEffect(() => {
    const video = getVideo();
    if (!video) {
      return;
    }
    const check = () => {
      const hls = hlsRef.current;
      const liveEdge = hls?.liveSyncPosition ?? video.duration;
      if (!Number.isFinite(liveEdge)) {
        setBehindLive(false);
        return;
      }
      setBehindLive(isBehindLive(video.currentTime, liveEdge as number));
    };
    video.addEventListener("timeupdate", check);
    check();
    return () => video.removeEventListener("timeupdate", check);
  }, [getVideo, src]);

  // Picture-in-Picture: standard API where it exists, Safari's
  // presentation-mode fallback otherwise. Neither is relied on to
  // auto-trigger; both are a single explicit tap.
  useEffect(() => {
    const video = getVideo() as SafariPipVideo | null;
    if (!video) {
      setPipAvailable(false);
      return;
    }
    const standard = isPipAvailable({
      pictureInPictureEnabled: Boolean(document.pictureInPictureEnabled),
      disablePictureInPicture: video.disablePictureInPicture,
    });
    const safari = hasSafariPresentationMode(video);
    setPipAvailable(standard || safari);

    const onEnterPip = () => setIsPip(true);
    const onLeavePip = () => setIsPip(false);
    const onPresentationChange = () => {
      setIsPip(video.webkitPresentationMode === "picture-in-picture");
    };
    video.addEventListener("enterpictureinpicture", onEnterPip);
    video.addEventListener("leavepictureinpicture", onLeavePip);
    video.addEventListener(
      "webkitpresentationmodechanged",
      onPresentationChange,
    );
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnterPip);
      video.removeEventListener("leavepictureinpicture", onLeavePip);
      video.removeEventListener(
        "webkitpresentationmodechanged",
        onPresentationChange,
      );
    };
  }, [getVideo, src, hasFrame]);

  const togglePip = useCallback(async () => {
    const video = getVideo() as SafariPipVideo | null;
    if (!video) {
      return;
    }
    try {
      if (
        document.pictureInPictureEnabled &&
        !video.disablePictureInPicture
      ) {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
        return;
      }
      if (video.webkitSetPresentationMode) {
        const next =
          video.webkitPresentationMode === "picture-in-picture"
            ? "inline"
            : "picture-in-picture";
        video.webkitSetPresentationMode(next);
      }
    } catch {
      // A refused PiP request (no user gesture reached it, or the platform
      // said no) leaves the inline picture playing, which is fine.
    }
  }, [getVideo]);

  // Media Session: what the lock screen and hardware media keys show and
  // do. Only meaningful once we actually have a frame, so a dead stream
  // never claims to be "playing pqp" on someone's lock screen.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !hasFrame) {
      return;
    }
    const video = getVideo();
    navigator.mediaSession.metadata = new MediaMetadata(
      buildMediaSessionMetadata({
        title: mediaTitle ?? "pqp",
        communityName,
        coverUrl,
      }),
    );
    navigator.mediaSession.setActionHandler("play", () => {
      void video?.play();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      video?.pause();
    });
    try {
      // Not in every TS lib.dom version; guarded by the try/catch and the
      // `"seektolive" in` style check isn't reliable across browsers, so we
      // just swallow an unsupported-action exception.
      navigator.mediaSession.setActionHandler(
        // @ts-expect-error -- "seektolive" is a valid MediaSessionAction the
        // TS DOM lib does not list yet.
        "seektolive",
        jumpToLive,
      );
    } catch {
      // Not supported here; the on-screen "Pular pro ao vivo" button covers it.
    }
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      try {
        // @ts-expect-error -- see above.
        navigator.mediaSession.setActionHandler("seektolive", null);
      } catch {
        // ignore
      }
    };
  }, [hasFrame, mediaTitle, communityName, coverUrl, getVideo, jumpToLive]);

  useEffect(() => {
    const el = videoRef?.current ?? innerRef.current;
    if (!el) {
      return;
    }
    const video: HTMLVideoElement = el;
    let cancelled = false;
    let hls: HlsHandle | null = null;

    // `xhrSetup` runs synchronously (hls.js calls it, then `xhr.send()`,
    // with no await in between), so the token has to already be in hand --
    // an async read inside `xhrSetup` would set the header after the
    // request already went out. Kept fresh by polling well inside a Clerk
    // token's usual lifetime; a request that lands right after an unnoticed
    // expiry gets a 401 and the manifest retry policy above tries again.
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

    const reportSize = () => {
      if (cancelled || video.videoWidth === 0 || video.videoHeight === 0) {
        return;
      }
      setHlsPlaybackStats({
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    const watch = watchRef.current;
    watch.onSourceChanged(Date.now());
    // Before the first frame, so a viewer who muted the last watch party does
    // not get one loud second of this one.
    video.volume = volumePrefRef.current.volume;
    video.muted = volumePrefRef.current.muted;
    const onPlaying = () => {
      if (!cancelled) {
        setHasFrame(true);
        setPhase("playing");
        watch.onPlaying();
        reportSize();
      }
    };
    const onWaiting = () => {
      watch.onWaiting(Date.now());
    };
    const onMediaError = () => {
      // Native player (no hls.js): a decode or network failure on the
      // element itself. Same policy as a fatal hls.js error.
      watch.onError({ fatal: true });
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("error", onMediaError);
    video.addEventListener("loadedmetadata", reportSize);
    const stallTimer = window.setInterval(() => {
      if (cancelled) {
        return;
      }
      const decision = watch.tick(Date.now());
      if (decision === "none") {
        return;
      }
      if (decision === "dead") {
        setPhase("dead");
        return;
      }
      console.warn(`[hls] stream stalled (${watch.lastReason}), reconnecting`);
      void reconnect();
    }, STALL_TICK_MS);

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
        video.src = activeSrc;
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
        // Every segment/media URL hls.js loads is already an absolute,
        // presigned bucket URL (the signed playlist proxy rewrites them
        // that way) -- only the playlist request itself is our own API,
        // and only that one gets a Bearer header. Attaching it to every
        // request would leak the token to R2. hls.js calls this
        // synchronously per XHR; the token is read from the in-memory
        // Clerk-backed cache `getAuthToken` keeps, not fetched fresh here.
        //
        // The header is belt and braces now: the playlist URL carries its
        // own per-viewer token (`?t=`, see `hls-viewer-token.ts` on the
        // server) which authorizes the request on its own. That is what
        // lets the native `<video src>` path below and `useLiveHlsReady`'s
        // plain `fetch` work, since neither can set a header.
        xhrSetup: (xhr, url) => {
          if (isOwnHlsPlaylistProxyUrl(url) && authToken) {
            xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
          }
        },
      });
      hls = player as unknown as HlsHandle;
      hlsRef.current = hls;
      player.on(Hls.Events.ERROR, (_event, data) => {
        // Fatal network/media errors: hls.js has given up on this source;
        // non-fatal ones it retries on its own and the watchdog only notes.
        watch.onError({ fatal: Boolean(data.fatal) });
      });
      player.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        // What Auto actually settled on, so the button can say
        // "Automático (720p)" rather than leaving the viewer guessing which
        // rendition they are paying for.
        if (!cancelled) {
          setAutoHeight(player.levels[data.level]?.height ?? null);
        }
      });
      player.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
        // The live playlist's EXT-X-MEDIA-SEQUENCE. A dead egress leaves
        // the playlist answering but never advancing; this is how the
        // watchdog tells that apart from a slow network.
        watch.onMediaSequence(data.details.startSN, Date.now());
      });
      player.loadSource(activeSrc);
      player.attachMedia(video);
      player.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        if (!cancelled) {
          setLevels(data.levels as HlsLevelLike[]);
          // Re-apply the pin against THIS master playlist. A height that is
          // not in it comes back as -1, which is hls.js's own Auto, so a
          // viewer whose rung was refused for budget gets a working player
          // rather than a stuck one.
          player.currentLevel = levelIndexFor(
            data.levels as HlsLevelLike[],
            qualityPrefRef.current,
          );
        }
        void play();
      });
    }

    void attach();
    return () => {
      cancelled = true;
      window.clearInterval(authTokenTimer);
      window.clearInterval(stallTimer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("error", onMediaError);
      video.removeEventListener("loadedmetadata", reportSize);
      hls?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
      setHlsPlaybackStats(null);
    };
  }, [activeSrc, attempt, videoRef, reconnect]);

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
        /* THE PANE'S SHAPE ALMOST NEVER MATCHES THE SOURCE'S here, which is
           why this is the one player with its own answer. A grid tile is
           roughly the shape of a screen; a watch stage is whatever is left
           after the chat, the roster and the split, so a 16:9 film on it is
           letterboxed more often than not. Fit stays the default (a crop can
           eat a subtitle), and the button below is the way out.
           `lib/video-fit.ts` has the argument for the third kind. */
        className={cn("h-full w-full", videoFitClass(fit.fit))}
        autoPlay
        playsInline
        onDoubleClick={onDoubleClick}
      />
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5">
        {behindLive ? (
          <button
            type="button"
            className="pointer-events-auto flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-paper hover:bg-black/90"
            onClick={jumpToLive}
          >
            <Radio className="h-3 w-3" />
            {t("voice.hls.jumpToLive")}
          </button>
        ) : (
          <span className="flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-paper">
            <Radio className="h-3 w-3 text-red-400" />
            {t("voice.hls.live")}
          </span>
        )}
        <span className="rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-paper">
          {t("voice.hls.delay", { seconds: delaySeconds })}
        </span>
      </div>
      {pipAvailable && hasFrame ? (
        <button
          type="button"
          aria-label={t("voice.hls.pip")}
          aria-pressed={isPip}
          className="absolute right-2 top-2 rounded bg-black/70 p-1 text-paper opacity-0 transition-opacity hover:bg-black/90 focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
          onClick={() => void togglePip()}
        >
          <PictureInPicture2 className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {phase === "dead" ? (
        <div
          data-testid="hls-dead"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-sm text-paper"
        >
          <span>{t("voice.hls.dead")}</span>
          <button
            type="button"
            className="rounded-full bg-paper/15 px-3 py-1.5 font-medium text-paper hover:bg-paper/25"
            onClick={retryFromDead}
          >
            {t("voice.hls.retry")}
          </button>
        </div>
      ) : phase === "reconnecting" || !hasFrame ? (
        <div
          data-testid={
            phase === "reconnecting" ? "hls-reconnecting" : "hls-buffering"
          }
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-paper-muted"
        >
          {phase === "reconnecting"
            ? t("voice.hls.stalled")
            : t("voice.hls.buffering")}
        </div>
      ) : null}
      {hasFrame ? (
        <div
          data-testid="hls-volume"
          // Bottom RIGHT on purpose. Every other corner is taken: the live and
          // delay badges are top-left, Picture-in-Picture is top-right, the
          // "Toca pra ligar o som" button is bottom-centre, and the cinema
          // stage draws its own presence strip at bottom-left, which sat on
          // top of this control and swallowed the click (caught in QA, the
          // button was visible and unclickable).
          className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-full bg-black/70 px-1.5 py-1"
        >
          {/* Beside the quality menu and the volume, in the one cluster this
              player already has: the wish ("I want the bars gone") happens
              while looking at the picture, not in a settings page. */}
          <Tooltip
            label={whole ? t("call.fit.fill") : t("call.fit.whole")}
            detail={t("voice.hls.fitHint")}
            side="top"
            align="end"
          >
            <button
              type="button"
              data-testid="hls-fit"
              data-hls-fit={fit.fit}
              aria-pressed={whole}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-paper hover:bg-paper/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal",
                whole && "text-signal",
              )}
              onClick={fit.toggle}
            >
              {whole ? (
                <Crop className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Scan className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
          {offered.length > 1 ? (
            <div className="relative">
              <button
                type="button"
                data-testid="hls-quality-button"
                aria-label={t("voice.hls.quality")}
                aria-expanded={qualityOpen}
                aria-haspopup="menu"
                className="flex h-6 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium text-paper hover:bg-paper/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
                onClick={() => setQualityOpen((open) => !open)}
              >
                <Settings2 className="h-3.5 w-3.5" />
                {qualityPref.height === null
                  ? autoHeight === null
                    ? t("voice.hls.qualityAuto")
                    : t("voice.hls.qualityAutoAt", {
                        quality: describeHlsLevel(autoHeight),
                      })
                  : describeHlsLevel(qualityPref.height)}
              </button>
              {qualityOpen ? (
                <div
                  role="menu"
                  data-testid="hls-quality-menu"
                  className="absolute bottom-8 right-0 min-w-32 overflow-hidden rounded-lg bg-black/90 py-1 text-[12px] text-paper shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={qualityPref.height === null}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-paper/15"
                    onClick={() => pickQuality(AUTO_HLS_QUALITY)}
                  >
                    <Check
                      className={cn(
                        "h-3 w-3",
                        qualityPref.height === null
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                    {t("voice.hls.qualityAuto")}
                  </button>
                  {offered.map((level) => (
                    <button
                      key={level.height}
                      type="button"
                      role="menuitemradio"
                      aria-checked={qualityPref.height === level.height}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-paper/15"
                      onClick={() => pickQuality({ height: level.height })}
                    >
                      <Check
                        className={cn(
                          "h-3 w-3",
                          qualityPref.height === level.height
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />
                      {describeHlsLevel(level.height)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            aria-pressed={silenced}
            aria-label={
              silenced ? t("voice.hls.unmuteControl") : t("voice.hls.mute")
            }
            className="flex h-6 w-6 items-center justify-center rounded-full text-paper hover:bg-paper/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
            onClick={() => {
              if (silenced) {
                restoreSound();
                return;
              }
              updateVolume(applyMuteToggle(volumePref, restoreRef.current));
            }}
          >
            <VolumeGlyph volume={volumePref.volume} muted={silenced} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={silenced ? 0 : volumePref.volume}
            aria-label={t("voice.hls.volume")}
            aria-valuetext={t("voice.tile.volumePercent", {
              percent: Math.round((silenced ? 0 : volumePref.volume) * 100),
            })}
            onChange={(event) => {
              const next = applySliderChange(Number(event.target.value));
              // Dragging up off zero is itself a request for sound, so it
              // clears the autoplay refusal too rather than moving a slider
              // that stays silent.
              if (!next.muted) {
                setNeedsUnmute(false);
              }
              updateVolume(next);
            }}
            className="h-1 w-20 cursor-pointer accent-signal"
          />
        </div>
      ) : null}
      {hasFrame && needsUnmute ? (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-sm font-medium text-paper hover:bg-black/90"
          onClick={restoreSound}
        >
          {t("voice.hls.unmute")}
        </button>
      ) : null}
    </div>
  );
}
