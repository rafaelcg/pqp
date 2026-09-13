import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  Check,
  Crop,
  Maximize2,
  MessageSquare,
  Minimize2,
  Move,
  Pause,
  PictureInPicture2,
  Play,
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
  hasHlsViewerToken,
  hlsSessionKey,
  isAutoplayRefusal,
  isOwnHlsPlaylistProxyUrl,
  nextFreshPlaylistUrl,
  recordHlsRebuild,
  resolveHlsUrl,
  sameHlsSession,
  sampleVideoPlaybackQuality,
  setHlsPlaybackStats,
  withFreshHlsToken,
} from "@/lib/hls-playback";
import {
  applyHlsRecoveryStep,
  buildMediaSessionMetadata,
  catchUpPlaybackRate,
  effectiveLiveSyncDurationCount,
  hasSafariPresentationMode,
  HLS_ABR_DEFAULT_ESTIMATE_BPS,
  hlsLivePlayerConfig,
  isBehindLive,
  isPipAvailable,
  liveSeekTarget,
  mediaSeekableEnd,
  resolveLiveEdge,
  secondsBehindCatchUpTarget,
} from "@/lib/hls-live-edge";
import { fetchChannelLive, getAuthToken } from "@/lib/api";
import { drainJitterMs } from "@/lib/reconnect-jitter";
import { Tooltip } from "@/components/ui/tooltip";
import { useVideoFit } from "@/hooks/use-video-fit";
import { videoFitClass } from "@/lib/video-fit";
import {
  HlsStallWatch,
  channelIdFromHlsUrl,
  type HlsStallReason,
} from "@/lib/hls-stall";
import {
  AUTH_GRACE_MS,
  RESTART_COUNTDOWN_SECONDS,
  resolveHoldingScreenReason,
} from "@/lib/watch-holding-screen";
import { browserConnection, hlsStartPlan } from "@/lib/hls-slow-start";
import {
  AUTO_HLS_QUALITY,
  applyHlsQualityLevel,
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
import {
  idleChromeClassName,
  tapIsOnStage,
  useIdleChrome,
} from "@/hooks/use-idle-chrome";
import {
  cameraPipBoxes,
  cameraPipMounted,
  nextCameraPipCorner,
  readCameraPipPref,
  writeCameraPipPref,
  type CameraPipPref,
} from "@/lib/watch-camera-pip";
import { WatchCameraPip } from "@/components/voice/watch-camera-pip";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { StreamStartingSoon } from "@/components/voice/stream-starting-soon";
import { cn } from "@/lib/utils";

const STALL_TICK_MS = 1_000;

/** Survives a teardown so the next instance does not reseed ABR at 500 kbit/s. */
let lastHlsBandwidthEstimate = HLS_ABR_DEFAULT_ESTIMATE_BPS;
/** True once a stream in this tab has actually measured the link. */
let hlsBandwidthMeasured = false;

type StreamPhase = "playing" | "reconnecting" | "dead";

/** hls.js instance shape this file actually touches. */
interface HlsHandle {
  destroy: () => void;
  liveSyncPosition: number | null;
  media: HTMLMediaElement | null;
  /** `-1` is Auto. Assigning flushes the buffer; use `nextLevel` mid-stream. */
  currentLevel: number;
  /** `-1` is Auto. Assigning waits for the next segment, no flush. */
  nextLevel: number;
  levels: HlsLevelLike[];
  recoverMediaError?: () => void;
  startLoad?: (startPosition?: number) => void;
  stopLoad?: () => void;
  bandwidthEstimate?: number;
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
 * ~20 s behind the presenter (the player's own cushion on 4 s segments,
 * `HLS_LIVE_SYNC_DURATION_COUNT` in `hls-live-edge.ts`, on top of whatever
 * the pipeline itself adds); that is the product, not a bug. The live badge
 * used to print that figure (2026-09-09 postmortem, C1) — it read as broken
 * more often than informative, since it was a constant off the wire config
 * rather than the stream's actual distance from live, so it is plain "Ao
 * vivo"/"Live" now (2026-09-13) and nothing here reads `delaySeconds` for
 * display. The prop stays on the type below for API compatibility with every
 * caller that still resolves one from the stream.
 */
export function HlsWatchPlayer({
  src,
  cameraSrc = null,
  className,
  videoRef,
  onDoubleClick,
  mediaTitle,
  communityName,
  coverUrl,
  fullscreen,
  chatOverlay,
  meta,
  actions,
  layout = "tile",
  dualDeviceWarning = false,
}: {
  src: string;
  /**
   * The presenter's camera, as a second playlist (`cameraHlsUrl` on the
   * stream frame, already resolved against the API base).
   *
   * A SECOND, MUTED hls.js INSTANCE, never a second audio source: the
   * audience's sound comes off the main stream, which is the only place it is
   * mixed. Null in every case the server is not running a camera transcode,
   * and non-`cinema` layouts ignore it entirely — a webcam inside a grid tile
   * or the docked mini player is a picture in a picture in a picture.
   */
  cameraSrc?: string | null;
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
  /** Native fullscreen of the watch pane. Omitted where the player is preview-only. */
  fullscreen?: { active: boolean; toggle: () => void };
  /**
   * Chat overlay while cinema fullscreen is on. Hidden in the ordinary split:
   * chat already has a column there.
   */
  chatOverlay?: { active: boolean; toggle: () => void };
  /** Audience count and similar, drawn on the film rather than below it. */
  meta?: ReactNode;
  /** Leave / join / host extras, same overlay as the player chrome. */
  actions?: ReactNode;
  /**
   * `cinema` is the watch-party viewer: full-bleed film, Twitch-like bar that
   * autohides. `tile` is a share in the call grid, where that bar would eat
   * the picture. `mini` is the docked player a viewer carries into another
   * channel, where a 240px box has room for the film and almost nothing else:
   * the caller's own `actions` in one corner, mute in the other, and none of
   * the badges, fit, quality or picture-in-picture chrome a tile offers.
   */
  layout?: "cinema" | "tile" | "mini";
  /**
   * The signed-in account holds a seat in this channel's call right now, on
   * some OTHER device or tab (`lib/dual-device-watch.ts`). Says so once,
   * plainly: this device's own audio and that seat's are about 25s apart, so
   * whichever one is unmuted is heard twice. Omitted for `mini`, the docked
   * corner player, which has no room for a second line of chrome.
   */
  dualDeviceWarning?: boolean;
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
  // "Começou em 480p pra não travar": shown once per attach on a slow link,
  // gone on its own, and never again for the session once dismissed.
  const [slowStartNotice, setSlowStartNotice] = useState(false);
  useEffect(() => {
    if (!slowStartNotice) {
      return;
    }
    const timer = window.setTimeout(() => setSlowStartNotice(false), 8_000);
    return () => window.clearTimeout(timer);
  }, [slowStartNotice]);
  const [pipAvailable, setPipAvailable] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [behindLive, setBehindLive] = useState(false);
  // Mirrors the element's own paused flag so the bar's play/pause button
  // agrees with hardware media keys, the lock screen and a tap on the frame.
  const [paused, setPaused] = useState(false);
  // Stall handling (`lib/hls-stall.ts`). `activeSrc` is what is actually
  // attached: the prop until a reconnect fetches a fresher URL from
  // `GET /api/channels/:id/live` (a restarted egress has a new playlist),
  // `attempt` re-runs the attach effect for a same-URL reconnect. `phase`
  // is the copy on the overlay.
  const [activeSrc, setActiveSrc] = useState(src);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<StreamPhase>("playing");
  const watchRef = useRef<HlsStallWatch>(new HlsStallWatch());
  // C3 (post-mortem, `watch-holding-screen.ts`): which of the watchdog's
  // reasons is behind the current stall, so the holding screen can say why
  // instead of just "loading". Mirrors `watchRef.current.lastReason`, which
  // is not itself reactive.
  const [stallReason, setStallReason] = useState<HlsStallReason>(null);
  // Pitfall 16 (CLAUDE.md): a dead Clerk JWT can 401 a perfectly good
  // playlist request for a few seconds around its refresh window, and the
  // player recovers on its own almost immediately. True for `AUTH_GRACE_MS`
  // after the last such 401, so the holding screen can stay quiet about a
  // failure the person never needs to know happened.
  const [authGraceActive, setAuthGraceActive] = useState(false);
  const authGraceTimerRef = useRef<number | null>(null);
  const clearAuthGraceTimer = useCallback(() => {
    if (authGraceTimerRef.current !== null) {
      window.clearTimeout(authGraceTimerRef.current);
      authGraceTimerRef.current = null;
    }
  }, []);
  const triggerAuthGrace = useCallback(() => {
    setAuthGraceActive(true);
    clearAuthGraceTimer();
    authGraceTimerRef.current = window.setTimeout(() => {
      setAuthGraceActive(false);
      authGraceTimerRef.current = null;
    }, AUTH_GRACE_MS);
  }, [clearAuthGraceTimer]);
  useEffect(() => clearAuthGraceTimer, [clearAuthGraceTimer]);
  // Held in a ref for the same reason `reconnectRef` is below: the attach
  // effect's deps are deliberately just `[activeSrc, attempt]`, so anything
  // it calls whose identity could otherwise change has to come through one.
  const triggerAuthGraceRef = useRef(triggerAuthGrace);
  triggerAuthGraceRef.current = triggerAuthGrace;
  const clearAuthGraceTimerRef = useRef(clearAuthGraceTimer);
  clearAuthGraceTimerRef.current = clearAuthGraceTimer;
  // The "transmissão reiniciou, volta em ~10s" countdown. Counts down on the
  // stall tick (1/s) while the reason is `restarting`; a static number would
  // have been fine too, but a moving one is what tells a person it is not
  // just frozen text.
  const [restartCountdown, setRestartCountdown] = useState(
    RESTART_COUNTDOWN_SECONDS,
  );
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
      // Next segment, not a flush. `currentLevel` pauses the picture for
      // about a second while hls.js dumps the buffer; Auto stays ABR.
      applyHlsQualityLevel(
        hls,
        levelIndexFor(hls.levels, next),
        "next-fragment",
      );
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
  // The freshest playlist URL known for the CURRENT session, kept a token
  // ahead of `activeSrc` without ever being a rebuild trigger itself
  // (`BROADCAST_PIPELINE.md` B1.3, item 3): `xhrSetup` below rewrites every
  // outgoing playlist request onto this ref, so a routine token restamp
  // reaches hls.js through the loader rather than through tearing the
  // instance down for it. Reset to `activeSrc` at the top of every real
  // attach (new session, or an actual rebuild), so a stale ref can never
  // outlive the instance it was rewriting requests for.
  const freshPlaylistUrlRef = useRef(activeSrc);
  useEffect(() => {
    // Same session: the server restamps `?t=` on every audience keyframe
    // (`hls-playback.ts`), and that restamped `src` prop is the ONLY door
    // this ref sees between one `reconnect()` poll and the next -- without
    // this, the loader token only refreshes when the watchdog happens to
    // ask, and can go stale for as long as the stream stays healthy and
    // quiet in between (Farol review, PR 570; see `nextFreshPlaylistUrl`).
    // Never touches `activeSrc`, so this can never re-attach hls.js.
    const fresh = nextFreshPlaylistUrl(sessionRef.current, src);
    if (fresh !== null) {
      freshPlaylistUrlRef.current = fresh;
      return;
    }
    sessionRef.current = hlsSessionKey(src);
    setActiveSrc(src);
    setPhase("playing");
    watchRef.current.reset(Date.now());
  }, [src]);

  // `attempt` re-runs this effect for a same-URL reconnect (the watchdog's
  // "sequence-stuck" recovery, `reconnect()` below), which is exactly the
  // in-flight restart the holding screen is trying to describe. Only a
  // genuine `activeSrc` change means the old stall is over and gone;
  // clearing `stallReason`/`restartCountdown` on every attempt bump made the
  // restart-specific copy and countdown disappear the instant the reconnect
  // it was announcing actually started, replaced by the generic "stalled"
  // copy until the new attach's `onPlaying` fires (Farol review, PR 529).
  const prevActiveSrcRef = useRef(activeSrc);
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
    setAuthGraceActive(false);
    clearAuthGraceTimer();
    const srcChanged = prevActiveSrcRef.current !== activeSrc;
    prevActiveSrcRef.current = activeSrc;
    if (srcChanged) {
      setStallReason(null);
      setRestartCountdown(RESTART_COUNTDOWN_SECONDS);
    }
  }, [activeSrc, attempt, clearAuthGraceTimer]);

  // Kept a render ahead of the closure `reconnect` captures, so an
  // in-flight call can tell -- once its `await` returns -- whether the
  // player has already moved on to a different source in the meantime.
  const activeSrcRef = useRef(activeSrc);
  activeSrcRef.current = activeSrc;
  // Guards only the automatic path (see `reconnect` below): a stuck egress
  // must never have two `fetchChannelLive` calls in flight at once. Bounded
  // by `apiFetch`'s own 12 s abort (`client/src/lib/api.ts`), not just the
  // backoff above it, so a single hung request cannot block every later
  // automatic attempt behind this flag forever (Farol review, PR 570).
  const reconnectInFlightRef = useRef(false);
  // Bumped once per REAL attach -- inside the big `[activeSrc, attempt]`
  // effect below, before its own async `attach()` runs -- including a
  // same-URL rebuild (`setAttempt`, no `activeSrc` change at all). Farol
  // review, PR 570: `activeSrcRef` alone cannot see that case, so a
  // response for the URL a person's own "try again" just rebuilt onto could
  // still pass the staleness check below and apply itself on top of the
  // fresh instance. Comparing this too closes it.
  const attachGenerationRef = useRef(0);

  const reconnect = useCallback(
    async (options: { forceRebuild?: boolean } = {}) => {
      // Only the automatic path (the watchdog's own "sequence-stuck"
      // reconnect checks) is guarded against overlap: a stuck egress could
      // otherwise stack one `fetchChannelLive` per tick with nothing to stop
      // two of them being in flight at once, and an earlier response
      // arriving after a later one had already moved the player on is
      // exactly the stale-write Farol flagged (PR 570). A person's own "try
      // again" always runs -- it is a single explicit action, not a loop.
      if (!options.forceRebuild && reconnectInFlightRef.current) {
        return;
      }
      // This call's own view of "the source we're checking on behalf of",
      // fixed at the moment it started. Compared against the live refs
      // below once the await returns, so a response this call receives is
      // only ever applied to the source it was actually asked about --
      // `requestedGeneration` catches a same-URL rebuild in between
      // (`activeSrc` unchanged, so the URL check alone would miss it;
      // Farol review, PR 570) as well as a genuinely different one.
      const requestedSrc = activeSrc;
      const requestedGeneration = attachGenerationRef.current;
      if (!options.forceRebuild) {
        reconnectInFlightRef.current = true;
      }
      setPhase("reconnecting");
      const channelId = channelIdFromHlsUrl(activeSrc);
      let next: string | null = null;
      try {
        if (channelId) {
          try {
            const live = await fetchChannelLive(channelId);
            next = live.stream ? resolveHlsUrl(live.stream.hlsUrl) : null;
          } catch {
            // The API is the thing that is down, or we lost access. Nothing
            // to adopt; fall through to the "nothing new" branch below.
          }
        }
      } finally {
        if (!options.forceRebuild) {
          reconnectInFlightRef.current = false;
        }
      }
      if (
        activeSrcRef.current !== requestedSrc ||
        attachGenerationRef.current !== requestedGeneration
      ) {
        // Something else -- a genuinely different session this same check
        // already adopted, a person's own "try again" (even a same-URL
        // rebuild, caught by the generation check), or another reconnect
        // that resolved first -- already moved the player on while this
        // request was in flight. Applying a response for the source we
        // asked about would be the stale write Farol flagged; drop it.
        return;
      }
      if (next && !sameHlsSession(next, activeSrc)) {
        // A genuinely different session: follow it, and remember it so the
        // `src` prop arriving with the same session a moment later does not
        // re-attach on top of this one. A new egress session is a new media
        // timeline, so a rebuild is correct here regardless of who asked
        // (B1.3, items 1/2: keep).
        sessionRef.current = hlsSessionKey(next);
        setActiveSrc(next);
        return;
      }
      if (options.forceRebuild) {
        // A person pressed "try again": always give them a visible restart,
        // on the freshest URL this check turned up (B1.3: "stays a rebuild").
        if (next) {
          setActiveSrc(next);
        } else {
          setAttempt((n) => n + 1);
        }
        return;
      }
      if (next && next !== activeSrc) {
        // Same session, fresher token only (B1.3, item 3: remove). No media
        // timeline changed, so swap the token into the loader instead of
        // dropping the buffer for it. If the true cause of whatever asked
        // for this reconnect was the token, this alone clears it; the
        // recovery ladder gets another pass before it asks again either way.
        freshPlaylistUrlRef.current = next;
        setPhase("playing");
        return;
      }
      // Nothing fresher is available -- the API is unreachable, or this
      // really is the same URL (B1.3, item 4: remove for the URL-unchanged
      // case). Rebuilding onto an identical source buys nothing a local
      // retry would not, so leave the player alone; the watchdog asks again
      // if the condition persists.
      setPhase("reconnecting");
    },
    [activeSrc],
  );

  // Held in a ref so the attach effect does not list `reconnect` as a
  // dependency. That callback's identity changes with `activeSrc`, and a
  // changing identity tears hls.js down, drops the buffer, and is a stall.
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  const retryFromDead = useCallback(() => {
    watchRef.current.reset(Date.now());
    void reconnect({ forceRebuild: true });
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
    const target = liveSeekTarget({
      currentTime: video.currentTime,
      liveSyncPosition: hlsRef.current?.liveSyncPosition ?? null,
      seekableEnd: mediaSeekableEnd(video),
    });
    if (target !== null) {
      video.currentTime = target;
    }
  }, [getVideo]);

  useEffect(() => {
    const video = getVideo();
    if (!video) {
      return;
    }
    const sync = () => setPaused(video.paused);
    video.addEventListener("play", sync);
    video.addEventListener("pause", sync);
    sync();
    return () => {
      video.removeEventListener("play", sync);
      video.removeEventListener("pause", sync);
    };
  }, [getVideo, src]);

  // Twitch's rule: pausing a live stream is fine, resuming it puts you back
  // at the edge. The window behind the playhead is ten seconds, so there is
  // nothing to catch up on and a resumed stream that trails by a minute is
  // just a stalled one.
  const togglePlay = useCallback(() => {
    const video = getVideo();
    if (!video) {
      return;
    }
    if (video.paused) {
      jumpToLive();
      void video.play();
      return;
    }
    video.pause();
  }, [getVideo, jumpToLive]);

  // Behind-live polling. `timeupdate` fires roughly 4x/s, which is plenty
  // for a badge nobody needs to the millisecond, and also drives the B1.1
  // catch-up curve below.
  useEffect(() => {
    const video = getVideo();
    if (!video) {
      return;
    }
    const check = () => {
      const liveEdge = resolveLiveEdge(
        hlsRef.current?.liveSyncPosition ?? null,
        mediaSeekableEnd(video),
      );
      if (liveEdge === null) {
        setBehindLive(false);
        // A recovery step (`startLoad`/`stopLoad`) can transiently leave
        // both clocks unreadable. Never leave an earlier tick's catch-up
        // rate stuck on the element through that gap (Farol review, PR
        // 570) -- the next `check()` re-applies the real curve once the
        // edge is knowable again.
        video.playbackRate = 1;
        return;
      }
      setBehindLive(isBehindLive(video.currentTime, liveEdge));
      if (video.paused) {
        // Nothing to chase without a running clock, and the pause path
        // already re-seeks to the edge on resume -- but a rate set by an
        // earlier tick must not survive into the paused state either.
        video.playbackRate = 1;
        return;
      }
      // Move the target smoothly rather than seeking: a small, continuous
      // playback-rate nudge closes ordinary drift over several seconds
      // instead of a jump-cut. `maxLiveSyncPlaybackRate` stays fixed at 1
      // (see the comment where the player is constructed) so hls.js's own
      // flat catch-up never fights this curve.
      //
      // Distance is measured from the player's INTENDED sync point
      // (`liveEdge` minus its ~20 s cushion), not the raw edge: the player
      // sits behind live ON PURPOSE (`HLS_PLAYER_CUSHION_SECONDS`), so an
      // ordinary viewer sitting exactly where the design put them is 0 s
      // behind target, not ~20 s behind the edge. Passing the raw edge
      // distance here pitched every viewer's audio for the whole party
      // (Farol review, PR 570) -- `secondsBehindLive`/`isBehindLive` above
      // stay edge-relative on purpose, for the "jump to live" badge only.
      const distance = secondsBehindCatchUpTarget(video.currentTime, liveEdge);
      video.playbackRate = catchUpPlaybackRate(distance);
    };
    video.addEventListener("timeupdate", check);
    check();
    return () => {
      video.removeEventListener("timeupdate", check);
      video.playbackRate = 1;
    };
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
    let hlsFragmentLoaded = false;
    // A real attach, whether `activeSrc` changed or this is a same-URL
    // rebuild (`attempt` alone). See `attachGenerationRef` above.
    attachGenerationRef.current += 1;
    // A restarted egress or an API blip stalls every open viewer's playlist
    // at once, so the watchdog's "reconnect" decision below fires for the
    // whole audience in the same instant — the same thundering-herd shape as
    // a `/ws` deploy drain (CLAUDE.md pitfall 10/11), just against
    // `GET /api/channels/:id/live`. Spread only that call, not the watchdog's
    // own tick cadence (`STALL_TICK_MS`, unchanged below).
    let reconnectJitterTimer: number | null = null;
    const clearPendingReconnect = () => {
      if (reconnectJitterTimer !== null) {
        window.clearTimeout(reconnectJitterTimer);
        reconnectJitterTimer = null;
      }
    };

    // `xhrSetup` runs synchronously (hls.js calls it, then `xhr.send()`,
    // with no await in between), so the token has to already be in hand --
    // an async read inside `xhrSetup` would set the header after the
    // request already went out. Kept fresh by polling well inside a Clerk
    // token's usual lifetime; a request that lands right after an unnoticed
    // expiry gets a 401 and the manifest retry policy above tries again.
    // Local to this attach, not React state: whether the countdown on the
    // "restarting" holding screen should keep ticking. Cheaper than reading
    // `watch.lastReason` on every tick, which stays "sequence-stuck" long
    // after recovery (`HlsStallWatch` never resets it on `onPlaying`).
    let restarting = false;
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
      const quality = sampleVideoPlaybackQuality(video);
      setHlsPlaybackStats({
        width: video.videoWidth,
        height: video.videoHeight,
        ...(quality ?? {}),
      });
    };
    const watch = watchRef.current;
    watch.onSourceChanged(Date.now());
    // This attach's own starting point for the token-swap ref (B1.3, item
    // 3): a real re-attach (this effect re-running at all) always deserves
    // the freshest URL it was actually given, never a stale ref left over
    // from whatever the previous instance was mid-swap on.
    freshPlaylistUrlRef.current = activeSrc;
    // Before the first frame, so a viewer who muted the last watch party does
    // not get one loud second of this one.
    video.volume = volumePrefRef.current.volume;
    video.muted = volumePrefRef.current.muted;
    const onPlaying = () => {
      if (!cancelled) {
        setHasFrame(true);
        setPhase("playing");
        setStallReason(null);
        setAuthGraceActive(false);
        clearAuthGraceTimerRef.current();
        restarting = false;
        setRestartCountdown(RESTART_COUNTDOWN_SECONDS);
        watch.onPlaying();
        reportSize();
        // The stream recovered on its own (or one of the recovery ladder's
        // in-place steps worked) before a jittered reconnect/rebuild from an
        // earlier tick fired. That response is now stale -- cancel it rather
        // than reloading a player that just came back (Farol review).
        clearPendingReconnect();
      }
    };
    const onWaiting = () => {
      watch.onWaiting(Date.now());
    };
    const onMediaError = () => {
      // The native player (no hls.js), or an MSE decode failure that
      // bubbled past hls.js to the element itself. `MEDIA_ERR_DECODE` is
      // the one code the recovery ladder treats specially: `recoverMediaError()`
      // is the one remedy built for it, and nothing else here plausibly
      // fixes a broken decoder pipeline.
      watch.onNativeMediaError({
        decode: video.error?.code === MediaError.MEDIA_ERR_DECODE,
      });
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
        // Still restarting: count the copy's countdown down rather than
        // freeze it at 10 forever.
        if (restarting) {
          setRestartCountdown((seconds) => Math.max(0, seconds - 1));
        }
        return;
      }
      restarting = watch.lastReason === "sequence-stuck";
      setStallReason(watch.lastReason);
      if (!restarting) {
        setRestartCountdown(RESTART_COUNTDOWN_SECONDS);
      }
      if (decision === "dead") {
        // The watchdog has given up outright; a reconnect still waiting out
        // its jitter from an earlier tick would only fire into a dead player.
        clearPendingReconnect();
        setPhase("dead");
        return;
      }
      if (
        decision === "recover-media-error" ||
        decision === "start-load" ||
        decision === "restart-load" ||
        decision === "reload-level"
      ) {
        // The recovery ladder, in place: never a new hls.js instance
        // (`BROADCAST_PIPELINE.md` B1.3). This tick is handling the stall
        // without a reconnect at all, so an earlier tick's still-pending
        // jittered reconnect/rebuild (below) would be a second, redundant
        // response to the same episode. Compute the seek before touching the
        // loader -- after `startLoad`/`stopLoad`, `liveSyncPosition` can
        // reset to the first-window value (~8 s) while the element still
        // holds a minute of back-buffer, and seeking that leftover is the
        // Chrome jump.
        clearPendingReconnect();
        const hls = hlsRef.current;
        console.warn(`[hls] stream stalled (${watch.lastReason}), ${decision}`);
        const target = liveSeekTarget({
          currentTime: video.currentTime,
          liveSyncPosition: hls?.liveSyncPosition ?? null,
          seekableEnd: mediaSeekableEnd(video),
        });
        applyHlsRecoveryStep(hls, decision);
        if (target !== null) {
          video.currentTime = target;
        }
        return;
      }
      // decision is "reconnect" (sequence-stuck checking whether the
      // session moved on) or "rebuild" (the fatal/stall ladder genuinely
      // exhausted -- three full cycles with no recovery, or a decode error
      // `recoverMediaError` did not clear). Both are jittered: a restarted
      // egress or an API blip stalls every open viewer's playlist at once,
      // so either decision firing for the whole audience in the same instant
      // is the same thundering-herd shape as a `/ws` deploy drain.
      if (reconnectJitterTimer !== null) {
        // Already waiting out a jittered response from an earlier tick of
        // the SAME ongoing episode -- let it run rather than stacking
        // another (each tick re-evaluates the same condition until it
        // resolves, so without this guard a persistent stall would queue one
        // per tick).
        return;
      }
      console.warn(
        decision === "reconnect"
          ? `[hls] stream stalled (${watch.lastReason}), checking for a fresher session`
          : `[hls] stream stalled (${watch.lastReason}), rebuilding the player`,
      );
      reconnectJitterTimer = window.setTimeout(() => {
        reconnectJitterTimer = null;
        if (cancelled) {
          return;
        }
        if (decision === "rebuild") {
          recordHlsRebuild();
          setAttempt((n) => n + 1);
        } else {
          void reconnectRef.current();
        }
      }, drainJitterMs());
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
      // On a link the browser calls slow, start on the lowest rung rather
      // than on the 720p guess. See `lib/hls-slow-start.ts`.
      const start = hlsStartPlan({
        connection: browserConnection(),
        rememberedEstimateBps: lastHlsBandwidthEstimate,
        measuredBefore: hlsBandwidthMeasured,
      });
      if (start.slowStart && !cancelled) {
        setSlowStartNotice(true);
      }
      const player = new Hls({
        ...hlsLivePlayerConfig(),
        enableWorker: true,
        capLevelToPlayerSize: true,
        // 1 = off, deliberately, and still. 1.5 sped playback up (and
        // pitched music) whenever the playhead drifted past the sync point,
        // which on the old 10 s window was most of the time. Catch-up now
        // lives OUTSIDE hls.js entirely (`catchUpPlaybackRate`, the
        // "Behind-live polling" effect below), keyed on actual distance from
        // the target rather than a single flat multiplier hls.js applies
        // whenever it judges itself behind; leaving this at 1 is what stops
        // the two fighting over the same `video.playbackRate`. A viewer far
        // enough behind that the gentle curve caps out still gets the
        // "jump to live" affordance.
        maxLiveSyncPlaybackRate: 1,
        startLevel: start.startLevel,
        abrEwmaDefaultEstimate: start.abrEwmaDefaultEstimate,
        // Playlist is written after the first 2 s segment. Retry the
        // initial 404 instead of giving up while egress is still starting.
        manifestLoadingMaxRetry: 12,
        manifestLoadingRetryDelay: 1000,
        manifestLoadingMaxRetryTimeout: 8000,
        // Every segment/media URL hls.js loads is already an absolute,
        // presigned bucket URL (the signed playlist proxy rewrites them
        // that way) -- only the playlist request itself is our own API,
        // and only that one could take a Bearer header. Attaching it to
        // every request would leak the token to R2.
        //
        // NOT SENT WHEN THE URL ALREADY CARRIES `?t=`, and that is the fix
        // for the stall rather than a tidy-up. The header was called belt and
        // braces; it was the only strap that could break. `handleApi`
        // resolves a Bearer ahead of the router, so a header that fails is a
        // 401 before anything looks at the capability in the URL. This
        // closure refreshes its Clerk JWT every 30 s without `forceRefresh`
        // and a Clerk JWT lives about 60, so roughly once a minute a playlist
        // request went out carrying a dead token and was rejected, and the
        // player stalled and recovered, over and over, for every web viewer
        // of every watch party. Proved on production: same URL and same valid
        // `?t=`, token alone 200, token plus an expired Bearer 401.
        //
        // The server no longer lets a failed Bearer veto a good capability
        // either. Both halves, because either alone fixes today and the pair
        // is what stops it coming back.
        //
        // The header still goes on a playlist URL that has NO token: a
        // deployment with no `LIVE_HLS_VIEWER_KEY` mints none, and there the
        // Bearer is the only door. hls.js calls this synchronously per XHR,
        // so the token has to be in hand already.
        //
        // B1.3, item 3: also the loader-level fix for a routine token
        // restamp. `freshPlaylistUrlRef` holds the newest `?t=` seen for
        // this SAME session, from either `reconnect()`'s own poll or a
        // restamped `src` prop (`nextFreshPlaylistUrl`); every request
        // against our own proxy is rewritten onto it here before anything
        // else runs, so a stale token reaches hls.js through the URL it
        // fetches rather than through a rebuilt instance. `xhr.open` is
        // called again deliberately: hls.js already opened the request
        // against the OLD url before this function ran, and re-opening
        // (still before `send()`) is the only way to redirect it.
        xhrSetup: (xhr, url) => {
          let effectiveUrl = url;
          if (isOwnHlsPlaylistProxyUrl(url)) {
            const fresh = withFreshHlsToken(url, freshPlaylistUrlRef.current);
            if (fresh !== url) {
              xhr.open("GET", fresh, true);
              effectiveUrl = fresh;
            }
          }
          if (
            isOwnHlsPlaylistProxyUrl(effectiveUrl) &&
            authToken &&
            !hasHlsViewerToken(effectiveUrl)
          ) {
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
        // Pitfall 16 (CLAUDE.md): a 401 on our own playlist proxy is almost
        // always a Clerk JWT that went stale a few seconds before its
        // refresh, not a real access failure — the `?t=` capability in the
        // URL is still good, and the very next attempt usually 200s. Say
        // nothing about it for a few seconds rather than flashing a stall
        // overlay over a failure the person never needs to know happened.
        if (!cancelled && data.response?.code === 401) {
          triggerAuthGraceRef.current();
        }
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
        // Never sync onto the oldest listed segment: against an API that
        // still serves the egress's raw five-segment window, a 5-count sync
        // point is the oldest entry with no slack, so a slow poll ages it
        // out and hls.js re-syncs or stalls. hls.js reads this live on each
        // playlist update, so capping it here keeps one segment of slack on
        // a short window; on the production 15-segment window it is a no-op.
        player.config.liveSyncDurationCount = effectiveLiveSyncDurationCount(
          data.details.fragments.length,
        );
      });
      player.on(Hls.Events.FRAG_LOADED, () => {
        hlsFragmentLoaded = true;
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
          applyHlsQualityLevel(
            player as unknown as HlsHandle,
            levelIndexFor(
              data.levels as HlsLevelLike[],
              qualityPrefRef.current,
            ),
            "immediate",
          );
        }
        void play();
      });
    }

    void attach();
    // `reconnect` lives on reconnectRef: listing it here re-created hls.js
    // on every restamp of the callback. `videoRef` is a parent object whose
    // identity must not tear the session down either; the element is always
    // on innerRef after the callback ref runs.
    return () => {
      cancelled = true;
      window.clearInterval(authTokenTimer);
      window.clearInterval(stallTimer);
      if (reconnectJitterTimer !== null) {
        window.clearTimeout(reconnectJitterTimer);
      }
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("error", onMediaError);
      video.removeEventListener("loadedmetadata", reportSize);
      if (
        hlsFragmentLoaded &&
        hls &&
        typeof hls.bandwidthEstimate === "number" &&
        hls.bandwidthEstimate > 0
      ) {
        lastHlsBandwidthEstimate = hls.bandwidthEstimate;
        hlsBandwidthMeasured = true;
      }
      hls?.destroy();
      hlsRef.current = null;
      // Belt and braces against a lingering soundtrack (2026-09-13: a watch
      // party seat handoff left two hls.js instances alive at once for a
      // beat, each with its own audio). `destroy()` should already stop
      // decoding, but an explicit pause before detaching the source means
      // this element can never keep making sound while it is torn down.
      video.pause();
      video.removeAttribute("src");
      video.load();
      setHlsPlaybackStats(null);
    };
  }, [activeSrc, attempt]);

  // Twitch-style chrome: sits on the picture, fades after the pointer rests,
  // comes back on move / tap. Same controller the call stage uses, so the
  // timing and the "first press wakes, does not hang up" rule stay one place.
  const reducedMotion = usePrefersReducedMotion();
  const [barHovered, setBarHovered] = useState(false);
  const [barFocused, setBarFocused] = useState(false);
  const chrome = useIdleChrome(
    layout === "cinema" && hasFrame,
    qualityOpen || barHovered || barFocused,
  );
  const chromeClass = idleChromeClassName({
    hidden: chrome.hidden,
    reducedMotion,
  });
  const touchDownRef = useRef<{ x: number; y: number } | null>(null);
  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      touchDownRef.current = { x: event.clientX, y: event.clientY };
      return;
    }
    chrome.wake();
  };
  const onStagePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      return;
    }
    const down = touchDownRef.current;
    touchDownRef.current = null;
    const travelled =
      down === null ||
      Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10;
    if (!travelled && tapIsOnStage(event.target)) {
      chrome.toggle();
      return;
    }
    chrome.wake();
  };
  const swallowPressWhileHidden = (event: SyntheticEvent<HTMLDivElement>) => {
    if (!chrome.isHidden()) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    chrome.wake();
  };
  const onBarBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setBarFocused(false);
    }
  };
  const iconBtn =
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-paper hover:bg-paper/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal";

  const cinema = layout === "cinema";
  const mini = layout === "mini";

  // C3 (post-mortem item, `lib/watch-holding-screen.ts`): what the overlay
  // over the picture says, mapped from `phase` and the stall watchdog's own
  // reason rather than a single generic "loading" for every cause.
  const holdingReason = resolveHoldingScreenReason({
    phase,
    hasFrame,
    stallReason,
    authGraceActive,
  });
  const holdingCaption =
    holdingReason === "restarting"
      ? t("voice.hls.restarting", { seconds: restartCountdown })
      : holdingReason === "reconnecting"
        ? t("voice.hls.stalled")
        : undefined;

  /**
   * THE PRESENTER'S CAMERA, FLOATING OVER THEIR FILM.
   *
   * A second, muted hls.js on a second playlist (`WatchCameraPip`), and a pure
   * module deciding which of the two pictures gets the stage and which gets
   * the corner (`lib/watch-camera-pip.ts`). Swapping moves the CLASSES, never
   * the players: neither instance is re-attached, so nobody rebuffers to look
   * at a webcam, and the control bar stays where it is because it belongs to
   * the stage rather than to a picture.
   */
  const [cameraPip, setCameraPip] = useState<CameraPipPref>(readCameraPipPref);
  const [cameraFrame, setCameraFrame] = useState(false);
  const cameraMounted = cameraPipMounted({
    cameraSrc,
    fullscreen: Boolean(fullscreen?.active),
    cinema,
  });
  const boxes = cameraPipBoxes({
    mounted: cameraMounted,
    hasFrame: cameraFrame,
    pref: cameraPip,
  });
  const updateCameraPip = useCallback((next: CameraPipPref) => {
    setCameraPip(next);
    writeCameraPipPref(next);
  }, []);

  return (
    <div
      className={cn(
        "relative h-full w-full bg-black",
        cinema && fullscreen?.active && chrome.hidden && "cursor-none",
        !cinema && "group",
        className,
      )}
      onPointerMove={
        cinema
          ? (event) => {
              if (event.pointerType !== "touch") {
                chrome.wake();
              }
            }
          : undefined
      }
      onPointerDown={cinema ? onStagePointerDown : undefined}
      onPointerUp={cinema ? onStagePointerUp : undefined}
      onPointerCancel={
        cinema
          ? () => {
              touchDownRef.current = null;
            }
          : undefined
      }
      onKeyDownCapture={cinema ? chrome.wake : undefined}
      onFocusCapture={cinema ? chrome.wake : undefined}
    >
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
           `lib/video-fit.ts` has the argument for the third kind.
           THE BOX IS NOT ALWAYS THE STAGE. With the camera swapped onto it
           the film becomes the corner thumbnail, and this is the whole of
           that move: the same element, the same hls.js, a different class.
           `absolute inset-0 h-full w-full` is what "the stage" means here, so
           the corner case needs no other change. */
        className={cn(boxes.film, videoFitClass(fit.fit))}
        autoPlay
        playsInline
        onDoubleClick={onDoubleClick}
      />
      {cameraMounted && cameraSrc ? (
        <WatchCameraPip
          src={cameraSrc}
          className={cn(boxes.camera ?? "", videoFitClass("cover"))}
          onFrame={setCameraFrame}
        />
      ) : null}
      {/* THE CONTROLS SIT OVER WHICHEVER PICTURE IS IN THE CORNER, which is
          why there is one of them rather than one per player: the corner is a
          box, and what is in it changes. `z-30` is above the pictures (z-20)
          and below the chrome (z-50), so the control bar is never behind a
          webcam. */}
      {boxes.corner ? (
        <div
          data-testid="watch-camera-pip-controls"
          data-camera-on-stage={cameraPip.onStage ? "" : undefined}
          className={cn(boxes.corner, "group/pip z-30")}
        >
          <button
            type="button"
            data-testid="watch-camera-pip-swap"
            aria-label={t("voice.hls.cameraSwap")}
            title={t("voice.hls.cameraSwap")}
            className="absolute inset-0 h-full w-full rounded-[var(--radius-card)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
            onClick={() =>
              updateCameraPip({ ...cameraPip, onStage: !cameraPip.onStage })
            }
          />
          <button
            type="button"
            data-testid="watch-camera-pip-corner"
            aria-label={t("voice.hls.cameraCorner")}
            title={t("voice.hls.cameraCorner")}
            className="absolute right-1 top-1 rounded bg-black/60 p-1 text-paper opacity-0 transition-opacity hover:bg-black/85 focus-visible:opacity-100 motion-reduce:transition-none group-hover/pip:opacity-100"
            onClick={() =>
              updateCameraPip({
                ...cameraPip,
                corner: nextCameraPipCorner(cameraPip.corner),
              })
            }
          >
            <Move className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {holdingReason === "dead" ? (
        <div
          data-testid="hls-dead"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/70 text-sm text-paper"
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
      ) : holdingReason === "silent" ? (
        // Pitfall 16: a fresh, likely self-resolving auth failure. Showing
        // NOTHING is the point here — the last frame stays on screen rather
        // than flashing a stall overlay over a hiccup nobody needs to know
        // about. Past `AUTH_GRACE_MS` this falls through to the branch below.
        null
      ) : holdingReason !== null ? (
        <div
          data-testid={
            holdingReason === "restarting"
              ? "hls-restarting"
              : phase === "reconnecting"
                ? "hls-reconnecting"
                : "hls-buffering"
          }
          className="pointer-events-none absolute inset-0 z-10"
        >
          <StreamStartingSoon caption={holdingCaption} />
        </div>
      ) : null}
      {cinema && hasFrame ? (
        // Plain and permanent, deliberately OUTSIDE `chromeClass` below: that
        // bar fades on idle (Twitch-style autohide), and a badge that
        // vanishes the moment the pointer rests is the "hover-only" shape
        // this replaces. No delay figure and no hover explanation here — see
        // `voice.hls.live` below: "how far behind" used to be printed as a
        // constant read off the wire config rather than the stream's actual
        // distance from live, which was worse than saying nothing.
        <div className="pointer-events-none absolute left-2 top-2 z-40 flex flex-col items-start gap-1">
          <span
            data-testid="hls-delay-badge"
            className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[11px] font-semibold text-paper"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-danger"
            />
            {t("voice.hls.live")}
          </span>
        </div>
      ) : null}
      {cinema ? (
      <div
        data-watch-chrome=""
        data-call-chrome=""
        className={cn(
          // z-50 beats the chat overlay's z-index: 40 on the pane
          // (`index.css`). z-20 sat under it, so Leave fullscreen could not
          // be clicked once chat was open.
          "pointer-events-none absolute inset-0 z-50 flex flex-col justify-between",
          chromeClass,
        )}
        onFocusCapture={() => setBarFocused(true)}
        onBlurCapture={onBarBlur}
      >
        <div
          className="pointer-events-auto flex items-start justify-end gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pb-8 pt-3"
          onPointerDown={swallowPressWhileHidden}
          onPointerEnter={() => setBarHovered(true)}
          onPointerLeave={() => setBarHovered(false)}
        >
      {slowStartNotice && hasFrame ? (
        <p
          data-testid="hls-slow-start"
          className="pointer-events-none absolute left-2 top-9 max-w-[85%] rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-paper"
        >
          {t("voice.hls.slowStart", {
            quality: describeHlsLevel(
              offered.length > 0 ? offered[offered.length - 1].height : 480,
            ),
          })}
        </p>
      ) : null}
          {/* The badge above is anchored top-LEFT and stays there; everything
              else in this bar reads top-RIGHT so the two never sit on top of
              each other, at any width. Narrower than `sm` stacks the pill
              above the actions instead of squeezing both into one row. */}
          <div className="flex min-w-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              {meta}
            </div>
            {actions ? (
              <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
            ) : null}
          </div>
        </div>
        <div
          data-testid="watch-player-bar"
          className="pointer-events-auto flex items-center justify-between gap-2 bg-gradient-to-t from-black/80 via-black/50 to-transparent px-3 pb-3 pt-10"
          onPointerDown={swallowPressWhileHidden}
          onPointerEnter={() => setBarHovered(true)}
          onPointerLeave={() => setBarHovered(false)}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              data-testid="hls-play"
              aria-label={paused ? t("voice.hls.play") : t("voice.hls.pause")}
              title={paused ? t("voice.hls.play") : t("voice.hls.pause")}
              className={iconBtn}
              onClick={togglePlay}
            >
              {paused ? (
                <Play className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Pause className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
            <div
              data-testid="hls-volume"
              className="flex min-w-0 items-center gap-1.5"
            >
            <button
              type="button"
              aria-pressed={silenced}
              aria-label={
                silenced ? t("voice.hls.unmuteControl") : t("voice.hls.mute")
              }
              className={iconBtn}
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
                if (!next.muted) {
                  setNeedsUnmute(false);
                }
                updateVolume(next);
              }}
              className="h-1 w-20 cursor-pointer accent-signal sm:w-24"
            />
            </div>
            {behindLive || (paused && hasFrame) ? (
              <button
                type="button"
                data-testid="watch-stage-jump-live"
                className="flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-[11px] font-semibold uppercase tracking-wide text-paper/80 hover:bg-paper/15 hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
                onClick={paused ? togglePlay : jumpToLive}
              >
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full bg-paper/50"
                />
                {t("voice.hls.jumpToLive")}
              </button>
            ) : (
              <span
                data-testid="watch-stage-live"
                className="flex h-8 items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-paper"
              >
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full bg-danger"
                />
                {t("voice.hls.live")}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {hasFrame ? (
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
                  className={cn(iconBtn, whole && "text-signal")}
                  onClick={fit.toggle}
                >
                  {whole ? (
                    <Crop className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Scan className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
            ) : null}
            {pipAvailable && hasFrame ? (
              <button
                type="button"
                aria-label={t("voice.hls.pip")}
                aria-pressed={isPip}
                className={iconBtn}
                onClick={() => void togglePip()}
              >
                <PictureInPicture2 className="h-4 w-4" />
              </button>
            ) : null}
            {offered.length > 1 ? (
              <div className="relative">
                <button
                  type="button"
                  data-testid="hls-quality-button"
                  aria-label={t("voice.hls.quality")}
                  aria-expanded={qualityOpen}
                  aria-haspopup="menu"
                  className="flex h-8 items-center gap-1 rounded-[var(--radius-control)] px-1.5 text-[11px] font-medium text-paper hover:bg-paper/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
                  onClick={() => setQualityOpen((open) => !open)}
                >
                  <Settings2 className="h-4 w-4" />
                  {qualityPref.height === null
                    ? autoHeight === null
                      ? t("voice.hls.qualityAuto")
                      : t("voice.hls.qualityAutoAt", {
                          quality: describeHlsLevel(
                            autoHeight,
                            levels.find((level) => level.height === autoHeight)
                              ?.frameRate,
                          ),
                        })
                    : describeHlsLevel(
                        qualityPref.height,
                        levels.find(
                          (level) => level.height === qualityPref.height,
                        )?.frameRate,
                      )}
                </button>
                {qualityOpen ? (
                  <div
                    role="menu"
                    data-testid="hls-quality-menu"
                    className="absolute bottom-10 right-0 min-w-32 overflow-hidden rounded-[var(--radius-card)] bg-black/90 py-1 text-[12px] text-paper shadow-lg"
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
                        {describeHlsLevel(level.height, level.frameRate)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {chatOverlay ? (
              <button
                type="button"
                data-testid="watch-stage-chat-overlay"
                aria-pressed={chatOverlay.active}
                aria-label={
                  chatOverlay.active
                    ? t("voice.watch.hideChat")
                    : t("voice.watch.showChat")
                }
                title={
                  chatOverlay.active
                    ? t("voice.watch.hideChat")
                    : t("voice.watch.showChat")
                }
                className={cn(iconBtn, chatOverlay.active && "text-signal")}
                onClick={chatOverlay.toggle}
              >
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            {fullscreen ? (
              <button
                type="button"
                data-testid="watch-stage-fullscreen"
                aria-pressed={fullscreen.active}
                aria-label={
                  fullscreen.active
                    ? t("voice.watch.exitFullscreen")
                    : t("voice.watch.fullscreen")
                }
                title={
                  fullscreen.active
                    ? t("voice.watch.exitFullscreen")
                    : t("voice.watch.fullscreen")
                }
                className={iconBtn}
                onClick={fullscreen.toggle}
              >
                {fullscreen.active ? (
                  <Minimize2 className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Maximize2 className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      ) : mini ? (
        /* The docked player. Everything a 240px box cannot afford is gone:
           the live badge, the delay badge, the fit toggle, the quality menu
           and picture-in-picture all live on the stage this came from, one
           click away. What is left is what a person carrying a stream into
           another channel actually reaches for. */
        <div
          data-testid="hls-mini-chrome"
          className="pointer-events-none absolute inset-0 z-30 flex flex-col justify-between p-1.5"
        >
          <div className="pointer-events-auto flex items-start justify-end gap-1">
            {actions}
          </div>
          <div className="pointer-events-auto flex items-end justify-end">
            <button
              type="button"
              data-testid="hls-mini-mute"
              aria-pressed={silenced}
              aria-label={
                silenced ? t("voice.hls.unmuteControl") : t("voice.hls.mute")
              }
              title={
                silenced ? t("voice.hls.unmuteControl") : t("voice.hls.mute")
              }
              className="flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-paper hover:bg-black/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
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
          </div>
        </div>
      ) : (
        <>
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
                <Radio className="h-3 w-3 text-danger" />
                {t("voice.hls.live")}
              </span>
            )}
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
          {hasFrame ? (
            <div
              data-testid="hls-volume"
              className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-full bg-black/70 px-1.5 py-1"
            >
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
                            quality: describeHlsLevel(
                              autoHeight,
                              levels.find((level) => level.height === autoHeight)
                                ?.frameRate,
                            ),
                          })
                      : describeHlsLevel(
                          qualityPref.height,
                          levels.find(
                            (level) => level.height === qualityPref.height,
                          )?.frameRate,
                        )}
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
                          {describeHlsLevel(level.height, level.frameRate)}
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
                  if (!next.muted) {
                    setNeedsUnmute(false);
                  }
                  updateVolume(next);
                }}
                className="h-1 w-20 cursor-pointer accent-signal"
              />
            </div>
          ) : null}
        </>
      )}
      {hasFrame && needsUnmute ? (
        <button
          type="button"
          className={cn(
            "absolute left-1/2 z-30 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-sm font-medium text-paper hover:bg-black/90",
            cinema ? "bottom-16" : "bottom-3",
          )}
          onClick={restoreSound}
        >
          {t("voice.hls.unmute")}
        </button>
      ) : null}
      {dualDeviceWarning && !mini ? (
        <div
          data-testid="hls-dual-device-warning"
          className={cn(
            "pointer-events-auto absolute left-1/2 z-40 flex max-w-[92%] -translate-x-1/2 items-center gap-2 rounded-[var(--radius-control)] bg-black/80 px-2.5 py-1.5 text-[11px] text-paper sm:max-w-[75%]",
            cinema ? "bottom-24" : "bottom-14",
          )}
        >
          <span className="min-w-0 flex-1">{t("voice.hls.dualDevice")}</span>
          <button
            type="button"
            className="shrink-0 rounded-[var(--radius-control)] border border-paper/30 px-2 py-1 text-[11px] font-medium hover:bg-paper/15"
            onClick={() =>
              updateVolume({ volume: volumePref.volume, muted: true })
            }
          >
            {t("voice.hls.dualDeviceMute")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
