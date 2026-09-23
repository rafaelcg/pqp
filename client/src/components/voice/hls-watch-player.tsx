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
  Loader2,
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
  createHlsTelemetryQueue,
  encodeToPaintLatencyMs,
  hasHlsViewerToken,
  hlsFallbackRungLabel,
  hlsRungFromPlaylistUrl,
  hlsSessionKey,
  hlsTelemetryIdentityFromToken,
  hlsTelemetrySessionKey,
  hlsViewerTokenFromUrl,
  HlsStallMeter,
  isAutoplayRefusal,
  isHlsStartupSample,
  isOwnHlsPlaylistProxyUrl,
  nextFreshPlaylistUrl,
  recordHlsRebuild,
  resolveHlsUrl,
  sameHlsSession,
  sampleVideoPlaybackQuality,
  sendHlsTelemetryBatch,
  setHlsPlaybackStats,
  type HlsTelemetryQueue,
  withFreshHlsToken,
} from "@/lib/hls-playback";
import {
  isSampledForHlsTelemetry,
  LIVE_HLS_TELEMETRY_STARTUP_MS,
  type LiveHlsTelemetrySample,
} from "@pqp/shared";
import {
  LlLatencyGovernor,
  llPartsOptedIn,
  llSegmentsCatchUpRate,
  type LlDelivery,
} from "@/lib/hls-ll-latency";
import {
  applyHlsRecoveryStep,
  behindLiveThresholdSeconds,
  bufferAheadSeconds,
  canJumpToLiveEdge,
  buildMediaSessionMetadata,
  catchUpPlaybackRate,
  effectiveHlsMode,
  effectiveLiveSyncDurationCount,
  hasSafariPresentationMode,
  HLS_ABR_DEFAULT_ESTIMATE_BPS,
  hlsLivePlayerConfig,
  isBehindLive,
  isInPlaceModeDemotion,
  isLlPartLoadErrorDetail,
  isMissingFragmentError,
  isPipAvailable,
  isPlaylistGoneError,
  isPlaylistUnavailableError,
  playlistErrorsWarrantDiscovery,
  liveSeekOffsetSeconds,
  liveSeekTarget,
  llHlsConfig,
  LL_HLS_STARTUP_GRACE_MS,
  mediaSeekableEnd,
  resolveLiveEdge,
  secondsBehindCatchUpTarget,
  validPartTargetMs,
  type HlsLLPlayerConfig,
  type HlsMode,
} from "@/lib/hls-live-edge";
import { fetchChannelLive, getAuthToken } from "@/lib/api";
import { drainJitterMs } from "@/lib/reconnect-jitter";
import { formatCallDuration } from "@/components/dm/call-stage-state";
import { Tooltip } from "@/components/ui/tooltip";
import { useVideoFit } from "@/hooks/use-video-fit";
import { videoFitClass } from "@/lib/video-fit";
import {
  HLS_WATCH_PLAYER_STALL_MS,
  HlsStallWatch,
  channelIdFromHlsUrl,
  livePlaylistProgress,
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
import { STAGE_LAYER } from "@/lib/stage-layers";

const STALL_TICK_MS = 1_000;
/** `HTMLMediaElement.HAVE_FUTURE_DATA`: enough to play on from here. */
const HAVE_FUTURE_DATA = 3;

/**
 * The ladder's console line. THE CONTEXT IS THE POINT: the 2026-09-16
 * capture had a loop of `[hls] stream stalled (fatal), start-load` and no
 * way to tell which hls.js error was behind it, which cadence the thresholds
 * had been derived from, or whether the buffer was starved or broken.
 * `HlsStallWatch.describeContext()` answers all three and is empty on
 * conventional, so that path's lines stay byte-for-byte what they were and
 * `hls-watch-player-conventional-recovery.test.tsx` still reads them.
 */
function stallLogLine(
  reason: string | null,
  what: string,
  context: string,
): string {
  const head = `[hls] stream stalled (${reason}), ${what}`;
  return context ? `${head} | ${context}` : head;
}

/**
 * What `HlsStallWatch.onError` is told about an hls.js `ERROR`. Everything
 * the 2026-09-16 capture was missing: which error it was, not only that our
 * own watchdog called it fatal. `data.error` is hls.js's own `Error`
 * (`GapController` puts the stall's buffer numbers in its message).
 */
function hlsErrorPayload(
  data: {
    fatal?: boolean;
    type?: string;
    details?: string;
    reason?: string;
    error?: { message?: string };
  },
  fatal: boolean,
): {
  fatal: boolean;
  type: string | null;
  details: string | null;
  reason: string | null;
  message: string | null;
  now: number;
} {
  return {
    fatal,
    type: data.type ?? null,
    details: data.details ?? null,
    reason: data.reason ?? null,
    message: data.error?.message ?? null,
    now: Date.now(),
  };
}

/** Survives a teardown so the next instance does not reseed ABR at 500 kbit/s. */
let lastHlsBandwidthEstimate = HLS_ABR_DEFAULT_ESTIMATE_BPS;
/** True once a stream in this tab has actually measured the link. */
let hlsBandwidthMeasured = false;

type StreamPhase = "playing" | "reconnecting" | "dead";

/**
 * How often a player parked on "the session is over" asks again.
 *
 * Slow on purpose, and nothing like the stall ladder's backoff. There is no
 * emergency here -- the show is over, or the presenter is away -- and the
 * ordinary way a new session arrives is the `src` prop, pushed over `/ws` the
 * moment the server starts one. This exists for the case that push does not
 * land (a frame lost, a socket that reconnected in between), which is
 * precisely the case that leaves a tab stuck until somebody reloads it. One
 * request every twenty seconds, only while a player is showing an
 * over/awaiting screen, is a rounding error beside a live viewer's own
 * playlist polling.
 */
const SESSION_OVER_POLL_MS = 20_000;

/** hls.js instance shape this file actually touches. */
interface HlsHandle {
  destroy: () => void;
  liveSyncPosition: number | null;
  /** Estimated seconds behind the live edge (hls.js's own reading, LL or not). */
  latency?: number;
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
  cameraHasVideo = true,
  cameraHasVoiceAudio = false,
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
  bottomActions,
  layout = "tile",
  forceMuted = false,
  dualDeviceWarning = false,
  mode = "live",
  partTargetMs: partTargetMsProp,
  onSessionOver,
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
  /**
   * Whether `cameraSrc` carries a picture. False is `LIVE_HLS_VOICE_TRACK`'s
   * "separada" mode with no camera published — an audio-only rung riding the
   * same playlist. Defaults true, the shape every camera ever had before
   * that flag. See `WatchCameraPip`.
   */
  cameraHasVideo?: boolean;
  /**
   * Whether `cameraSrc` carries the presenter's MICROPHONE, separately from
   * this player's own (muted) audio. `LIVE_HLS_VOICE_TRACK`, "separada" — see
   * `docs/plans/WATCH_PARTY_SEPARATE_TRACKS.md`. Defaults false, which keeps
   * every camera before that flag silent, exactly as it always was.
   */
  cameraHasVoiceAudio?: boolean;
  delaySeconds?: number;
  /**
   * `LiveHlsStream.partTargetMs`, read only when `mode === "ll"`. Defaults to
   * `LIVE_HLS_REMUX_PART_MS`'s own default for a stream that omits it (see
   * `LL_HLS_DEFAULT_PART_TARGET_MS`'s comment on why that field can be
   * missing even on an `ll` stream today).
   */
  partTargetMs?: number;
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
   * The watch party's own controls, at the right end of the bottom bar
   * (`docs/plans/WATCH_PARTY_UI.md` pass 2): the bar slot the party panel
   * and the guests overlay portal into, plus Parar de assistir. In the
   * bottom bar rather than the top one so that a viewer has ONE row of
   * controls on the picture, and it fades with the rest.
   */
  bottomActions?: ReactNode;
  /**
   * `cinema` is the watch-party viewer: full-bleed film, Twitch-like bar that
   * autohides. `tile` is a share in the call grid, where that bar would eat
   * the picture. `mini` is the docked player a viewer carries into another
   * channel, where a 240px box has room for the film and almost nothing else:
   * the caller's own `actions` in one corner, mute in the other, and none of
   * the badges, fit, quality or picture-in-picture chrome a tile offers.
   */
  layout?: "cinema" | "tile" | "mini" | "monitor";
  /*
   * `monitor` (pass 5b of `docs/plans/WATCH_PARTY_UI.md`, §10.4): the
   * picture and nothing else. For a player embedded in a stage that draws
   * its own chrome, the host's audience view above all: `tile` put a live
   * badge, a volume slider, fit, quality and picture-in-picture under the
   * party bar, a second set of controls the host could see and not reach.
   * The stage that embeds this owns every control; this draws none.
   */
  /**
   * Always silent, whatever the shared volume preference says, and no
   * mute button. For the presenter's audience monitor (2026-09-13): the
   * host is already hearing the film out of their own tab, and the mini
   * mute button writes the SAME per-browser preference the cinema player
   * reads, so a monitor that could be unmuted would silence a viewer's
   * player on the same machine.
   */
  forceMuted?: boolean;
  /**
   * The signed-in account holds a seat in this channel's call right now, on
   * some OTHER device or tab (`lib/dual-device-watch.ts`). Says so once,
   * plainly: this device's own audio and that seat's are about 25s apart, so
   * whichever one is unmuted is heard twice. Omitted for `mini`, the docked
   * corner player, which has no room for a second line of chrome.
   */
  dualDeviceWarning?: boolean;
  /**
   * `"live"` (the default) is a watch party in progress: the stall watchdog
   * treats a playlist that stops advancing as a dead egress and reconnects
   * to `GET /api/channels/:id/live`, the top-left corner carries a permanent
   * "Ao vivo" badge, and "jump to live" replaces the ordinary transport row.
   * Conventional live-sync tuning (`hlsLivePlayerConfig()`,
   * `maxLiveSyncPlaybackRate: 1`) -- byte-identical to before `"ll"` existed.
   *
   * `"vod"` is a finished broadcast's replay (`watch-party-history-dialog.tsx`):
   * the playlist is a fixed, ENDED `#EXT-X-MEDIA-SEQUENCE` that is SUPPOSED
   * to stop advancing once fully buffered, so the live watchdog's read of
   * that -- a dead egress, reconnect, and eventually "A transmissão caiu" --
   * is simply wrong here and used to restart a perfectly healthy replay
   * every ~20s until it gave up for good. This mode turns that reading off:
   * no reconnect-via-live-fetch, no live badge, no "jump to live", no live
   * watchdog chase, a plain buffering spinner instead of the "hold tight,
   * it's starting" holding screen, "A gravação não está mais disponível"
   * instead of "A transmissão caiu" if playback cannot recover, and a real
   * seek bar in its place. Never `"ll"` -- a replay is always the
   * conventional engine tuning above.
   *
   * `"ll"` is `LiveHlsStream.mode` (`docs/plans/LL_HLS.md`, task L2.4): it
   * stops this player overriding the manifest's own hold-back -- see
   * `llHlsConfig` and the attach effect's comments. Only ever set alongside
   * `partTargetMs`, and only while `mode` is not `"vod"`.
   */
  mode?: "live" | "vod" | "ll";
  /**
   * The server was asked directly and answered that nothing is live on this
   * channel: `"over"` (and no party either) or `"awaiting"` (the party is
   * still on, the presenter is not sharing). Fired once per episode, when the
   * player first learns it.
   *
   * WHY THE CALLER WANTS TO KNOW. A player left mounted on a session that has
   * ended is the whole of the 2026-09-17 viewer symptom: the pane kept the
   * film's slot, so the party panel underneath -- which owns "nothing is on
   * air" and the button that starts the next one -- never got the space back.
   * A caller that hands the pane back on this gets the right surface with no
   * reload; a caller that ignores it keeps today's behaviour plus the honest
   * holding screen. Never fired for a replay (`mode: "vod"`), which has no
   * live channel to ask about.
   */
  onSessionOver?: (reason: "over" | "awaiting") => void;
}) {
  const { t } = useTranslation();
  const isVod = mode === "vod";
  // `HlsMode` (hls-live-edge.ts) only distinguishes conventional-vs-LL live
  // tuning; VOD is an orthogonal axis (`isVod`, guarded independently
  // throughout this file) that never reaches the live-sync engine below, so
  // it maps onto "conventional" here -- inert, since every downstream read
  // of this value is already skipped when `isVod` is true.
  const hlsMode: HlsMode = mode === "ll" ? "ll" : "conventional";
  // Validated once, here, regardless of whether the caller went through
  // `hlsPartTargetMs` (which already validates) or passed a raw number
  // straight through -- the player is the one place every LL-HLS caller's
  // value ultimately reaches, so this is where a bad one gets caught
  // (Farol review, this PR).
  const partTargetMs = validPartTargetMs(partTargetMsProp);
  const fit = useVideoFit("watch");
  const whole = fit.fit === "contain";
  const innerRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<HlsHandle | null>(null);
  // BROADCAST_PIPELINE B0.5: how many times the attach effect below has run
  // for this mounted player, i.e. how many times the instance has been torn
  // down and rebuilt. Never reset across `activeSrc`/`attempt` changes within
  // one mount -- the whole point is to see whether B1.3 (never rebuild
  // unless unrecoverable) is working, and a counter that resets on every
  // rebuild could never show that.
  const rebuildCountRef = useRef(0);
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
  // A replay's own transport: `null` until `loadedmetadata` gives a real
  // duration. Unused (and never subscribed to) outside `mode: "vod"` -- a
  // live playlist's `duration` is `Infinity` and has nothing to scrub.
  const [vodCurrentTime, setVodCurrentTime] = useState(0);
  const [vodDuration, setVodDuration] = useState<number | null>(null);
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
  /**
   * THE SERVER'S OWN ANSWER, once it has been asked and has vouched for it:
   * `"over"` (nothing live, no party) or `"awaiting"` (nothing live, party
   * still on). Null until then, which is every ordinary moment of a healthy
   * stream.
   *
   * WHY THIS EXISTS AT ALL. Every other input this player has is an inference
   * from the outside: a playlist that stopped advancing, a 404, a fatal
   * hls.js error. None of them can tell "the egress is restarting, hold on"
   * from "the show ended twenty minutes ago", so the watchdog treats both as
   * the first and polls, and polls, and eventually says "A transmissão caiu"
   * with a retry button that cannot possibly help. That is exactly what
   * Rafael's second tab did on 2026-09-17 while the party was over and the
   * sidebar card next to it already said so.
   *
   * `reconnect()` already asks `GET /api/channels/:id/live` on every
   * reconnect check, and the answer already carries the fact: `ended: true`
   * is a null the server explicitly vouches for. This is simply that answer
   * being BELIEVED instead of thrown away as "nothing fresher".
   *
   * Cleared by a genuinely new session arriving through either door (the
   * `src` prop, or this player's own slow poll below), so recovery needs no
   * reload and no press.
   */
  const [sessionOver, setSessionOver] = useState<"over" | "awaiting" | null>(
    null,
  );
  // Read inside the attach effect's interval, which deliberately lists only
  // `[activeSrc, attempt]` as dependencies.
  const sessionOverRef = useRef(sessionOver);
  sessionOverRef.current = sessionOver;
  const watchRef = useRef<HlsStallWatch>(
    new HlsStallWatch({ stallMs: HLS_WATCH_PLAYER_STALL_MS }),
  );
  // A PIN puts this viewing session on conventional-style targeting for the
  // rest of it: today only when the LL hls.js config itself is refused at
  // construction (see `buildPlayer`'s catch). It used to be §4's answer to
  // two part-load errors inside 10 s too, by rebuilding the player; that is
  // now `LlLatencyGovernor`'s in-place switch to whole segments
  // (`hls-ll-latency.ts`), which keeps the buffer and costs no rebuild.
  //
  // A REF, mirrored by `pinnedToConventional` STATE below (same shape as
  // `stallReason`/`watchRef.current.lastReason`): the ref is what the
  // attach effect and its own event handlers read and write synchronously
  // (a pin must take effect on the very tick it fires, before any render
  // happens), and the state exists ONLY so a render -- the live badge, and
  // eventually any telemetry sample -- can see it too. A Farol review of
  // this PR found the badge kept showing an LL latency reading after a
  // session had already been pinned, because it read the raw `mode` prop
  // (which the server never updates for a client-only pin) with nothing to
  // re-render on.
  const pinnedToConventionalRef = useRef(false);
  const [pinnedToConventional, setPinnedToConventional] = useState(false);
  // What the LL governor (`LlLatencyGovernor`, created per attach) is doing
  // right now, for the effects OUTSIDE the attach effect that need it: the
  // behind-live badge and LL-lite's catch-up read the target, "jump to live"
  // seeks to it rather than to the raw edge. Null off the LL path.
  const llTargetSecondsRef = useRef<number | null>(null);
  const llDeliveryRef = useRef<LlDelivery | null>(null);
  // Rebuilds (a torn-down and recreated hls.js instance, `setAttempt` from
  // the watchdog or a pin) this mount has made, and how many of them the
  // telemetry has already reported: the difference is the per-window
  // `rebuilds` field. `rebuildCountRef` above stays the lifetime count.
  const rebuildEventsRef = useRef(0);
  const rebuildsReportedRef = useRef(0);
  // Which `activeSrc` the pin/error state above belongs to -- reset on a
  // genuine new session, kept across a same-URL `attempt` rebuild (the pin
  // itself causes one; forgetting the pin on the very rebuild that applies
  // it would undo it immediately).
  const pinSessionSrcRef = useRef<string | null>(null);
  // The mode this player last actually attached with, so the demotion effect
  // below can tell "the server changed its mind mid-party" (§5, an in-place
  // reload) apart from "this is the first render" (nothing to reload yet).
  const modeRef = useRef<HlsMode>(hlsMode);
  // hls.js's own `latency` getter (LL only; native/conventional leave this
  // null and the badge falls back to plain "Ao vivo"/"Live"). Read on the
  // existing stall-watchdog tick rather than a dedicated timer.
  const [llLatencySeconds, setLlLatencySeconds] = useState<number | null>(
    null,
  );
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
  const forceMutedRef = useRef(forceMuted);
  forceMutedRef.current = forceMuted;
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
    // A DIFFERENT SESSION IS THE RECOVERY. Whatever the server last told this
    // player about the channel is about to be wrong, and this is the door a
    // new party normally comes through: the push lands, the prop changes, the
    // over/awaiting screen goes away by itself. No reload, nothing pressed.
    setSessionOver(null);
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
      // Only the live-channel refetch is VOD-specific, and it is skipped
      // here by construction rather than by an early return: a replay's
      // URL (`/api/voice/hls-replay/<channel>/<startedAt>`) matches neither
      // the live proxy nor the raw bucket shape `channelIdFromHlsUrl`
      // knows, so `channelId` is null, `next` stays null, and every branch
      // below runs the same for both -- a person's "try again" still falls
      // through to `setAttempt` (a same-URL re-attach re-fetches the signed
      // playlist proxy, which mints fresh presigned segment URLs; there is
      // no `GET .../live` for a finished session to poll), and the
      // overlap/generation guards above cost nothing extra since there is
      // no network round trip for them to race against.
      const channelId = channelIdFromHlsUrl(activeSrc);
      let next: string | null = null;
      // What the server said about the channel itself, as opposed to about a
      // URL. `undefined` is "it did not say" -- the request failed, or it
      // answered a null it could not vouch for.
      let told: "over" | "awaiting" | null | undefined;
      try {
        if (channelId) {
          try {
            const live = await fetchChannelLive(channelId);
            next = live.stream ? resolveHlsUrl(live.stream.hlsUrl) : null;
            told = live.stream
              ? null
              : live.ended
                ? live.partyLive
                  ? "awaiting"
                  : "over"
                : undefined;
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
        //
        // THIS IS ALSO HOW A SESSION THAT WAS OVER COMES BACK. The slow poll
        // below keeps calling this while `sessionOver` is set, so a party
        // that goes live again is adopted here with nothing pressed and
        // nothing reloaded -- the `src` prop saying the same thing a moment
        // later is the belt, this is the braces.
        setSessionOver(null);
        sessionRef.current = hlsSessionKey(next);
        setActiveSrc(next);
        return;
      }
      if (told !== undefined) {
        // THE SERVER VOUCHED FOR IT: nothing is live on this channel, and it
        // said which kind of nothing. Believe it rather than falling through
        // to "nothing fresher, keep stalling" -- that fall-through is what
        // left a viewer polling a dead session behind "reconnecting" until
        // the watchdog's budget ran out and told them the stream had crashed.
        //
        // `told === null` is a stream the server HAS (the `next &&` branches
        // above handled it); reaching here with it means the same session,
        // which is ordinary and clears nothing.
        if (told !== null) {
          setSessionOver(told);
          setPhase("reconnecting");
          onSessionOver?.(told);
          return;
        }
        setSessionOver(null);
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
    [activeSrc, onSessionOver],
  );

  // Held in a ref so the attach effect does not list `reconnect` as a
  // dependency. That callback's identity changes with `activeSrc`, and a
  // changing identity tears hls.js down, drops the buffer, and is a stall.
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  // THE WAY BACK, WITH NOTHING TO PRESS. While the holding screen is saying
  // the session is over or the presenter is away, ask the server again every
  // `SESSION_OVER_POLL_MS`. A new session adopts itself inside `reconnect`
  // (`setSessionOver(null)` on the different-session branch), so the picture
  // simply appears. Stops the moment `sessionOver` clears, and never runs for
  // a replay, which has no live channel to ask about.
  useEffect(() => {
    if (sessionOver === null || isVod) {
      return;
    }
    const timer = window.setInterval(() => {
      void reconnectRef.current();
    }, SESSION_OVER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionOver, isVod]);

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
    video.muted =
      forceMuted ||
      effectiveMuted({
        pref: volumePref,
        autoplayMuted: needsUnmute,
      });
  }, [getVideo, volumePref, needsUnmute, activeSrc, attempt, hasFrame, forceMuted]);

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
    // §4's pin rule can have quietly moved this session onto
    // conventional-style targeting; a seek offset sized for LL parts would
    // undershoot a conventional segment's actual live edge.
    const effectiveMode = effectiveHlsMode(
      hlsMode,
      pinnedToConventionalRef.current,
    );
    const target = liveSeekTarget({
      currentTime: video.currentTime,
      liveSyncPosition: hlsRef.current?.liveSyncPosition ?? null,
      seekableEnd: mediaSeekableEnd(video),
      segmentSeconds: liveSeekOffsetSeconds(
        effectiveMode,
        partTargetMs,
        llTargetSecondsRef.current,
      ),
    });
    if (target !== null) {
      video.currentTime = target;
    }
  }, [getVideo, hlsMode, partTargetMs]);

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
      // A replay resumes wherever it was paused -- Twitch's "back to the
      // edge" rule is a live-only affordance. `jumpToLive` against a VOD
      // element's `seekable` end is not "catch up", it is "skip to the
      // final second", which is what actually happened here before this
      // guard: `mediaSeekableEnd` reads the replay's own duration.
      if (!isVod) {
        jumpToLive();
      }
      void video.play();
      return;
    }
    video.pause();
  }, [getVideo, isVod, jumpToLive]);

  // Behind-live polling. `timeupdate` fires roughly 4x/s, which is plenty
  // for a badge nobody needs to the millisecond, and also drives the B1.1
  // catch-up curve below. A no-op for a replay: hls.js never sets
  // `liveSyncPosition` on a VOD manifest, so `resolveLiveEdge` always
  // answers null and this never flips `behindLive` true -- kept running
  // anyway rather than special-cased, since a false negative here is
  // exactly the state a replay wants.
  useEffect(() => {
    const video = getVideo();
    if (!video) {
      return;
    }
    const check = () => {
      // `pinnedToConventionalRef` can flip this mid-session (§4's pin
      // rule); reading it fresh on every tick, rather than once per effect
      // run, is what makes the pin take effect immediately rather than
      // after the next attach.
      const effectiveMode = effectiveHlsMode(
        hlsMode,
        pinnedToConventionalRef.current,
      );
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
      setBehindLive(
        isBehindLive(
          video.currentTime,
          liveEdge,
          behindLiveThresholdSeconds(
            effectiveMode,
            partTargetMs,
            llTargetSecondsRef.current,
          ),
        ),
      );
      if (effectiveMode === "ll") {
        // Parts: hls.js's own low-latency catch-up owns `video.playbackRate`
        // on this path (`maxLiveSyncPlaybackRate`, set where the player is
        // constructed) -- writing it here too would be two controllers
        // fighting over the same property, the exact bug this effect's
        // comment already warns about for the conventional path.
        //
        // Segments (LL-lite): hls.js runs NO catch-up with `lowLatencyMode`
        // off, so without this a stall's latency would never be given back.
        // `llSegmentsCatchUpRate` is 1.05x at most, and only with buffer to
        // spare, so the catch-up can never be what empties it.
        if (llDeliveryRef.current === "segments") {
          video.playbackRate = video.paused
            ? 1
            : llSegmentsCatchUpRate({
                latencySeconds: hlsRef.current?.latency ?? null,
                targetSeconds: llTargetSecondsRef.current,
                bufferAheadSeconds: bufferAheadSeconds(video),
              });
        }
        return;
      }
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
      video.playbackRate = catchUpPlaybackRate(
        distance,
        bufferAheadSeconds(video),
      );
    };
    video.addEventListener("timeupdate", check);
    check();
    return () => {
      video.removeEventListener("timeupdate", check);
      video.playbackRate = 1;
    };
  }, [getVideo, src, hlsMode, partTargetMs]);

  // §5's demotion: the server flipped this SAME session from `ll` to
  // `conventional` mid-party (L1.6's watchdog, not yet merged). Reconfigure
  // in place rather than live-mutating the running hls.js instance: verified
  // against `hls.mjs` that `lowLatencyMode`/`liveSyncDurationCount` are only
  // read from the CONSTRUCTOR's `userConfig` when deciding whether to defer
  // to the manifest, so a runtime `player.config.xyz =` assignment cannot
  // retroactively flip that decision. Bumping `attempt` re-runs the attach
  // effect with a freshly constructed instance carrying the new mode's
  // config -- the established "same-URL rebuild" path this file already
  // uses for the stall ladder's own `"rebuild"` decision -- which survives
  // on the SAME `<video>` element, satisfying §5's "without tearing the
  // element down". `hlsRef.current` guards against firing before the first
  // attach has run at all (nothing to reload yet; the next attach reads the
  // current `mode` directly).
  useEffect(() => {
    const previous = modeRef.current;
    modeRef.current = hlsMode;
    if (
      hlsRef.current &&
      isInPlaceModeDemotion({
        previousMode: previous,
        nextMode: hlsMode,
        sameSession: true,
      })
    ) {
      console.warn("[hls] LL session demoted to conventional, reconfiguring in place");
      setAttempt((n) => n + 1);
    }
  }, [hlsMode]);

  // The replay's own transport. Not wired at all outside `mode: "vod"`: a
  // live element's `duration` is `Infinity` and nothing here should read it.
  useEffect(() => {
    if (!isVod) {
      return;
    }
    const video = getVideo();
    if (!video) {
      return;
    }
    const onTimeUpdate = () => setVodCurrentTime(video.currentTime);
    const onDuration = () => {
      setVodDuration(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDuration);
    video.addEventListener("loadedmetadata", onDuration);
    onDuration();
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("loadedmetadata", onDuration);
    };
  }, [getVideo, isVod, src, attempt]);

  const seekTo = useCallback(
    (seconds: number) => {
      const video = getVideo();
      if (!video || vodDuration === null) {
        return;
      }
      video.currentTime = Math.min(Math.max(0, seconds), vodDuration);
    },
    [getVideo, vodDuration],
  );

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
    if (!isVod) {
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
  }, [hasFrame, mediaTitle, communityName, coverUrl, getVideo, jumpToLive, isVod]);

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
    // BROADCAST_PIPELINE B0.3/B0.5. Set on every `FRAG_CHANGED` so a later
    // periodic sample can turn "what media time is painted right now" into
    // a wall clock. `currentRung` names the rendition the same way the
    // server does (the playlist path segment), read once alongside it.
    let currentFrag: { programDateTimeMs: number; startSeconds: number } | null =
      null;
    let currentRung: string | null = null;
    /** The manifest's own `PART-HOLD-BACK`, last time it changed (LL only). */
    let lastPartHoldBack: number | null = null;
    // Telemetry v2 (2026-09-23): stall EPISODES and their frozen
    // milliseconds, hole skips and visibility, per sample window
    // (`HlsStallMeter`); fatal hls.js details seen since the last sample.
    const stallMeter = new HlsStallMeter(
      Date.now(),
      typeof document !== "undefined" && document.visibilityState === "hidden",
    );
    let fatalSinceLastSample: string[] = [];
    let firstFrameAt: number | null = null;
    let startupMsPending: number | null = null;
    // Distinct from `startupMsPending` being null, which also means "already
    // reported": this stops a LATER `playing` event (after a stall recovers,
    // say) from recomputing "startup" as the time since attach, minutes in.
    let startupMsComputed = false;
    const attachStartedAt = Date.now();
    rebuildCountRef.current += 1;
    const rebuildCountAtAttach = rebuildCountRef.current;
    let telemetryQueue: HlsTelemetryQueue | null = null;
    let telemetrySampleTimer: number | null = null;
    // Farol finding, 2026-09-13: a naive "call requestVideoFrameCallback
    // every 5s" schedules a NEW one even while a previous one is still
    // outstanding (paused, backgrounded, or a stalled stream never paints a
    // fresh frame), so callbacks pile up and all fire at once when playback
    // resumes -- a burst of duplicate samples and a CPU/memory spike. This
    // tracks the one outstanding handle so at most one is ever pending, and
    // is cancelled on cleanup so a torn-down player cannot fire into it.
    let pendingRvfcHandle: number | null = null;
    let pendingRvfcSince = 0;

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
          // Keeps the queue's own cached copy current too, so a flush --
          // including the unmount one -- reads a token synchronously rather
          // than fetching one (Farol finding, 2026-09-14; see
          // `sendHlsTelemetryBatch`'s doc comment).
          telemetryQueue?.setToken(token);
        }
      });
    };
    refreshAuthToken();
    const authTokenTimer = window.setInterval(refreshAuthToken, 30_000);

    // BROADCAST_PIPELINE B0.5: sampled, batched, droppable playback
    // telemetry. The sampling decision is made once per attach, off whatever
    // `authToken` has resolved to by the time this first runs (a few hundred
    // ms after `refreshAuthToken()` above, well before the first segment
    // loads) -- a viewer whose token is not ready yet on this particular
    // tick simply never gets sampled for THIS attach, which matters far less
    // than never blocking playback on it.
    const TELEMETRY_SAMPLE_INTERVAL_MS = 5_000;
    function ensureTelemetryQueue(): void {
      if (telemetryQueue !== null || cancelled) {
        return;
      }
      const identity = hlsTelemetryIdentityFromToken(authToken);
      if (!identity || !isSampledForHlsTelemetry(identity)) {
        return;
      }
      const sessionId = hlsTelemetrySessionKey(activeSrc);
      if (!sessionId) {
        return;
      }
      telemetryQueue = createHlsTelemetryQueue({
        sessionId,
        // The server verifies this and, when it checks out, uses the
        // channel/session it names instead of `sessionId` above -- see the
        // route's own comment in `server/src/api/index.ts` (Farol finding,
        // 2026-09-13). Null on the `LIVE_HLS_SIGNED_URLS=false` config,
        // which mints no such token; the batch still goes out on `sessionId`.
        sessionToken: hlsViewerTokenFromUrl(activeSrc),
        // Seeded from the closure variable this function already required to
        // be non-null (`identity` above comes off it) -- kept current after
        // this by `refreshAuthToken`'s own `telemetryQueue?.setToken` call,
        // not by fetching one at flush time (Farol finding, 2026-09-14).
        token: authToken,
        send: sendHlsTelemetryBatch,
      });
    }
    function pushTelemetrySample(paintedMediaTimeSeconds: number): void {
      if (!telemetryQueue || !currentFrag || !currentRung) {
        return;
      }
      const latencyMs = encodeToPaintLatencyMs(currentFrag, paintedMediaTimeSeconds);
      if (latencyMs === null) {
        return;
      }
      const bufferSeconds =
        video.buffered.length > 0
          ? Math.max(
              0,
              video.buffered.end(video.buffered.length - 1) - video.currentTime,
            )
          : undefined;
      const now = Date.now();
      const win = stallMeter.take(now);
      const rebuilds = rebuildEventsRef.current - rebuildsReportedRef.current;
      rebuildsReportedRef.current = rebuildEventsRef.current;
      const llState = governor?.state() ?? null;
      const sample: LiveHlsTelemetrySample = {
        rung: currentRung,
        latencyMs: Math.round(latencyMs),
        bufferSeconds,
        stalls: win.stalls,
        rebufferMs: win.stalledMs,
        holeSkips: win.holeSkips,
        windowMs: Math.min(win.windowMs, 600_000),
        startupMs: startupMsPending ?? undefined,
        startup: isHlsStartupSample(
          firstFrameAt,
          now,
          LIVE_HLS_TELEMETRY_STARTUP_MS,
        ),
        playerRebuildCount: rebuildCountAtAttach - 1,
        rebuilds,
        playerMode: telemetryPlayerMode(),
        hidden: win.hidden,
        muted: video.muted,
        ...(llState
          ? { targetLatencyMs: Math.round(llState.targetSeconds * 1_000) }
          : {}),
        ...(fatalSinceLastSample.length > 0
          ? { fatal: fatalSinceLastSample }
          : {}),
      };
      telemetryQueue.push(sample);
      fatalSinceLastSample = [];
      startupMsPending = null;
    }
    function telemetryPlayerMode(): LiveHlsTelemetrySample["playerMode"] {
      if (governor) {
        return governor.state().delivery === "parts" ? "ll" : "ll-segments";
      }
      if (hlsMode === "ll" && pinnedToConventionalRef.current) {
        return "pinned";
      }
      return "conventional";
    }
    function sampleTelemetryOnce(): void {
      ensureTelemetryQueue();
      if (!telemetryQueue || cancelled) {
        return;
      }
      // A paused (or stalled-with-no-new-frame) video is showing a static
      // picture: "encode-to-paint" has no meaning for a frame that is not
      // newly arriving, and the fallback path below would otherwise report a
      // growing latency for the same painted frame for as long as the pause
      // lasts. Resuming playback picks sampling back up on the next tick.
      if (video.paused) {
        return;
      }
      const videoWithRvfc = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (
          callback: (now: number, metadata: { mediaTime: number }) => void,
        ) => number;
        cancelVideoFrameCallback?: (handle: number) => void;
      };
      if (typeof videoWithRvfc.requestVideoFrameCallback !== "function") {
        pushTelemetrySample(video.currentTime);
        return;
      }
      // At most one outstanding request at a time: a stalled stream that
      // never paints a new frame would otherwise accumulate one callback per
      // tick, all firing together (for the same frame) the moment playback
      // recovers.
      //
      // BUT A FRAME THAT NEVER COMES STILL DESERVES A SAMPLE (2026-09-23).
      // A hidden tab never runs the callback, and neither does a long
      // freeze, so those windows used to vanish from telemetry entirely: the
      // viewers having the worst time were the ones it could not see. A
      // request still pending a whole interval later is cancelled and the
      // window reported off `currentTime` instead.
      if (pendingRvfcHandle !== null) {
        if (Date.now() - pendingRvfcSince < TELEMETRY_SAMPLE_INTERVAL_MS) {
          return;
        }
        videoWithRvfc.cancelVideoFrameCallback?.(pendingRvfcHandle);
        pendingRvfcHandle = null;
        pushTelemetrySample(video.currentTime);
        return;
      }
      pendingRvfcSince = Date.now();
      pendingRvfcHandle = videoWithRvfc.requestVideoFrameCallback((_now, metadata) => {
        pendingRvfcHandle = null;
        if (!cancelled) {
          pushTelemetrySample(metadata.mediaTime);
        }
      });
    }
    telemetrySampleTimer = window.setInterval(
      sampleTelemetryOnce,
      TELEMETRY_SAMPLE_INTERVAL_MS,
    );

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
    // A genuine new session (`activeSrc` itself changed) starts the pin/error
    // state below fresh; a same-URL `attempt` rebuild -- which the pin rule
    // itself triggers, below -- must NOT un-pin the very attach that applies
    // it.
    if (pinSessionSrcRef.current !== activeSrc) {
      pinSessionSrcRef.current = activeSrc;
      pinnedToConventionalRef.current = false;
      setPinnedToConventional(false);
    }
    // §4's pin rule only ever forces LL DOWN to conventional-style
    // targeting for the rest of a session; nothing promotes the reverse.
    // Computed once per attach (this effect reruns whenever either changes,
    // via `attempt` for a pin/demotion and via `activeSrc` for a new
    // session), so every read below -- the hls.js config, the watchdog, the
    // badge -- agrees for the life of this instance.
    const effectiveMode = effectiveHlsMode(
      hlsMode,
      pinnedToConventionalRef.current,
    );
    watch.configureForMode(effectiveMode, partTargetMs);
    // THE LL GOVERNOR (`hls-ll-latency.ts`): whole segments by default
    // ("LL-lite"), parts only for a browser that opted in, a target a few
    // seconds behind the edge that grows with every stall and shrinks slowly,
    // and an in-place switch to segments for a parts viewer that cannot hold
    // them. LL only, never a replay.
    const governor =
      effectiveMode === "ll" && !isVod
        ? new LlLatencyGovernor({
            delivery: llPartsOptedIn() ? "parts" : "segments",
            now: Date.now(),
          })
        : null;
    let appliedTarget: number | null = null;
    let appliedDelivery: LlDelivery | null = null;
    const publishGovernor = () => {
      const state = governor?.state() ?? null;
      llTargetSecondsRef.current = state?.targetSeconds ?? null;
      llDeliveryRef.current = state?.delivery ?? null;
      watch.onLlDelivery(state?.delivery ?? null);
    };
    publishGovernor();
    // Pushes the governor's state onto the live hls.js instance. Every
    // setter here is one hls.js reads live (verified against 1.7.3:
    // `LatencyController.targetLatency`'s setter writes
    // `config.liveSyncDuration`, `maxLatency` reads
    // `config.liveMaxLatencyDuration`, and the playlist/stream controllers
    // read `config.lowLatencyMode` per decision), so nothing is rebuilt.
    const applyGovernor = () => {
      if (!governor || !hls || cancelled) {
        return;
      }
      const state = governor.state();
      const live = hls as unknown as {
        targetLatency: number | null;
        lowLatencyMode: boolean;
        config: { liveMaxLatencyDuration?: number };
      };
      if (state.delivery !== appliedDelivery) {
        if (appliedDelivery === "parts" && state.delivery === "segments") {
          console.warn(
            "[hls] LL link cannot hold parts, loading whole segments from here on",
          );
        }
        live.lowLatencyMode = state.delivery === "parts";
        appliedDelivery = state.delivery;
      }
      if (state.targetSeconds !== appliedTarget) {
        // Ceiling first: hls.js must never see a target above its own
        // force-seek line, even for one tick.
        live.config.liveMaxLatencyDuration = state.ceilingSeconds;
        live.targetLatency = state.targetSeconds;
        appliedTarget = state.targetSeconds;
      }
      publishGovernor();
    };
    // FELL BEHIND THE WINDOW: JUMP TO LIVE, DO NOT ANNOUNCE A DEATH.
    //
    // The recovery this attach may perform at most `LL_HLS_EDGE_JUMP_MAX`
    // times (`canJumpToLiveEdge`), for the one error that means the player
    // is asking for the wrong place rather than that the stream is gone: a
    // 404/410 on a part or segment (`isMissingFragmentError`). hls.js cannot
    // recover from it on its own -- it never retries a 4xx, and an LL master
    // has no second level to fail over to -- so it goes fatal, and before
    // this the fatal reached the watchdog and the watchdog eventually
    // reached "A transmissão caiu" over a broadcast that was still running.
    //
    // Bounded on purpose. Past the budget, or with no live edge to jump to,
    // this returns false and the error goes to the ladder exactly as it did
    // before, which is what still gets a person a holding screen and a retry
    // button when the session really has ended.
    const edgeJumps: number[] = [];
    // SAFETY NET, host- and classification-independent (2026-09-19, channel
    // d5559e70). Timestamps of recent master/level playlist load failures on
    // THIS attach. A run of them (or one fatal one) means the session URL is
    // no longer serving playlists, whatever the host or the exact status --
    // the case the host-keyed fast path silently stopped catching when
    // playlist delivery moved to `hls.pqp.gg`. Reset when a fragment loads
    // (the playlist is serving again) so isolated blips never accumulate.
    const playlistUnavailableTimes: number[] = [];
    const jumpToLiveEdgeAfterError = (what: string): boolean => {
      const now = Date.now();
      if (!canJumpToLiveEdge(edgeJumps, now)) {
        console.warn(`[hls] ${what}, out of live-edge jumps, escalating`);
        return false;
      }
      const hls = hlsRef.current;
      // Computed BEFORE the loader is touched, for the reason the stall
      // tick's own seek is: after `stopLoad`/`startLoad`, `liveSyncPosition`
      // can drop back to a first-window value while the element still holds
      // the old back-buffer.
      const target = liveSeekTarget({
        currentTime: video.currentTime,
        liveSyncPosition: hls?.liveSyncPosition ?? null,
        seekableEnd: mediaSeekableEnd(video),
        segmentSeconds: liveSeekOffsetSeconds(
          effectiveMode,
          partTargetMs,
          governor?.state().targetSeconds,
        ),
      });
      if (target === null) {
        console.warn(`[hls] ${what}, no live edge to jump to, escalating`);
        return false;
      }
      edgeJumps.push(now);
      console.warn(
        `[hls] ${what} is behind the playlist window, jumping to the live edge @${target.toFixed(3)}`,
      );
      applyHlsRecoveryStep(hls, "restart-load", target);
      video.currentTime = target;
      return true;
    };
    // This attach's own starting point for the token-swap ref (B1.3, item
    // 3): a real re-attach (this effect re-running at all) always deserves
    // the freshest URL it was actually given, never a stale ref left over
    // from whatever the previous instance was mid-swap on.
    freshPlaylistUrlRef.current = activeSrc;
    // Before the first frame, so a viewer who muted the last watch party does
    // not get one loud second of this one.
    video.volume = volumePrefRef.current.volume;
    video.muted = forceMutedRef.current || volumePrefRef.current.muted;
    const onPlaying = () => {
      if (!cancelled) {
        setHasFrame(true);
        setPhase("playing");
        watch.onPlaying();
        // A stale `playing` from buffered media after a restart `stopLoad`
        // must not clear the hold UI or cancel the reconnect poll (Farol,
        // PR 654). Real recovery is a new attach or a playlist that advances.
        if (!watch.isHoldingForRestart) {
          setStallReason(null);
          setAuthGraceActive(false);
          clearAuthGraceTimerRef.current();
          restarting = false;
          setRestartCountdown(RESTART_COUNTDOWN_SECONDS);
          clearPendingReconnect();
        }
        reportSize();
        stallMeter.onPlaying(Date.now());
        // First real frame of this attach: report it on the NEXT telemetry
        // sample and then forget it, rather than on every sample.
        if (!startupMsComputed) {
          startupMsComputed = true;
          firstFrameAt = Date.now();
          startupMsPending = firstFrameAt - attachStartedAt;
        }
      }
    };
    const onWaiting = () => {
      const now = Date.now();
      watch.onWaiting(now);
      const opened = stallMeter.onWaiting(now);
      // A NEW episode after startup is the governor's signal: more room,
      // and for a parts viewer, a step toward loading segments instead. The
      // attach's own first buffering, and the second `waiting` the gap
      // controller's seek-over-hole fires inside the same freeze, are not.
      if (
        opened &&
        governor &&
        firstFrameAt !== null &&
        now - firstFrameAt >= LL_HLS_STARTUP_GRACE_MS
      ) {
        governor.onStall(now);
        applyGovernor();
      }
    };
    // `stalled` is the element saying the NETWORK went quiet, not that the
    // picture stopped: on a playing element with media to spare it is
    // noise, and it used to count as a stall in telemetry and open the
    // watchdog's stall clock with no `playing` ever coming to close it.
    // Only an element that genuinely cannot play on is waiting.
    const onStalledEvent = () => {
      if (!video.paused && video.readyState < HAVE_FUTURE_DATA) {
        onWaiting();
      }
    };
    const onVisibility = () => {
      stallMeter.onVisibility(document.visibilityState === "hidden");
    };
    document.addEventListener("visibilitychange", onVisibility);
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
    video.addEventListener("stalled", onStalledEvent);
    video.addEventListener("error", onMediaError);
    video.addEventListener("loadedmetadata", reportSize);
    const stallTimer = window.setInterval(() => {
      if (cancelled) {
        return;
      }
      // hls.js's own `latency` getter (LL badge, item 3). Read
      // unconditionally: harmless on the conventional path (the badge only
      // ever renders it when `effectiveHlsMode(...) === "ll"`, which a §4
      // pin flips to `"conventional"`), and reading it here rather than
      // gating on mode means a mid-session pin/demotion clears the number
      // on its own next tick instead of needing its own branch.
      const measured = hlsRef.current?.latency;
      setLlLatencySeconds(
        typeof measured === "number" && Number.isFinite(measured) && measured > 0
          ? measured
          : null,
      );
      // THE WATCHDOG HAS NOTHING LEFT TO DECIDE. The server has said there is
      // no stream here, so every ladder step below is a recovery attempt on a
      // session that will never answer: the polls are wasted, and the budget
      // they spend ends in `"dead"` -- "A transmissão caiu", with a retry
      // button -- for a party that simply finished. The slow poll under
      // `sessionOver` is what watches for the next one, and any new session
      // clears this and re-arms the ladder with it.
      if (sessionOverRef.current !== null) {
        return;
      }
      if (governor) {
        governor.tick(Date.now());
        applyGovernor();
      }
      let decision = watch.tick(Date.now());
      if (decision === "jump-live") {
        // A "stall" episode's first rung, on an attach that has never
        // painted a frame (`HlsStallDecision`'s own doc comment: production,
        // 2026-09-17, a viewer landed ~60 s behind the live edge and spent
        // ~40 s walking start-load / reload-level / a rebuild before the
        // REBUILT instance happened to land on the edge). Try the SAME
        // bounded live-edge jump a missing-fragment error already earns,
        // silently -- no holding screen, no ladder log -- before falling
        // back to the ordinary first rung a stall would have run anyway.
        if (jumpToLiveEdgeAfterError("stalled before painting a frame")) {
          return;
        }
        decision = "start-load";
      }
      if (decision === "none") {
        // Still restarting: count the copy's countdown down rather than
        // freeze it at 10 forever.
        if (restarting) {
          setRestartCountdown((seconds) => Math.max(0, seconds - 1));
        }
        return;
      }
      restarting =
        watch.lastReason === "sequence-stuck" ||
        watch.lastReason === "playlist-gone";
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
      if (decision === "hold") {
        // Conventional restart dead window: stop the 1 Hz playlist /
        // last-segment loop, keep the restarting overlay up, and let the
        // next ticks' `"reconnect"` polls find a fresh master. No seek and
        // no startLoad — those are what made the dead window look broken.
        clearPendingReconnect();
        console.warn(
          `[hls] stream stalled (${watch.lastReason}), holding for restart`,
        );
        hlsRef.current?.stopLoad?.();
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
        console.warn(
          stallLogLine(watch.lastReason, decision, watch.describeContext()),
        );
        // Only the seek is VOD-specific -- a VOD manifest has no live edge
        // to seek back to: `liveSyncPosition` is null (hls.js never sets it
        // on a non-live playlist) and `mediaSeekableEnd` reads the replay's
        // own duration, so `liveSeekTarget` would return a point near the
        // END of the recording -- the Chrome-back-buffer jump this seek
        // exists to correct, applied to a stall that has nothing to do with
        // it. `applyHlsRecoveryStep` below still runs unconditionally
        // (a decode error still wants `recoverMediaError`, a stuck fragment
        // still wants `startLoad`, whichever the ladder picked), and this
        // tick never decides the terminal `"rebuild"`/`"dead"` outcome --
        // that stays entirely in `watch.tick()`'s own escalation, read at
        // the top of this handler, so a replay whose fragments keep
        // failing still reaches the ladder's bound the same as a live
        // stream would. Live (conventional or LL): `segmentSeconds` is the
        // LL-aware offset (`liveSeekOffsetSeconds`), byte-identical to
        // before on the conventional path since `effectiveMode` there is
        // "conventional".
        const target = isVod
          ? null
          : liveSeekTarget({
              currentTime: video.currentTime,
              liveSyncPosition: hls?.liveSyncPosition ?? null,
              seekableEnd: mediaSeekableEnd(video),
              segmentSeconds: liveSeekOffsetSeconds(
                effectiveMode,
                partTargetMs,
                governor?.state().targetSeconds,
              ),
            });
        // AND ON LL THE LOADER RESTARTS THERE TOO, not at the frozen
        // playhead. `startLoad(-1)` means "resume where you were" in hls.js,
        // not "go live" (`recoveryStartPosition`), so on LL every recovery
        // fired one request for a part that had left the ring minutes
        // earlier, got a 404, and went fatal before this seek ever landed.
        //
        // LL ONLY, and that gate is the whole difference between this PR and
        // PR 646. A conventional stream's window is sixty seconds and its
        // playhead is inside it: `-1` has been right there for the life of
        // this player, every viewer we have is on that path, and PR 646's
        // revert was a reviewer unable to rule out that this line had
        // started seeking conventional recoveries to the edge. It has not:
        // `null` is exactly what `applyHlsRecoveryStep` received before, on
        // conventional and on VOD alike, and
        // `hls-watch-player-conventional-recovery.test.tsx` pins the
        // resulting `startLoad(-1)` against the ladder recorded off
        // post-revert `main`.
        applyHlsRecoveryStep(
          hls,
          decision,
          effectiveMode === "ll" ? target : null,
        );
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
        stallLogLine(
          watch.lastReason,
          decision === "reconnect"
            ? "checking for a fresher session"
            : "rebuilding the player",
          watch.describeContext(),
        ),
      );
      reconnectJitterTimer = window.setTimeout(() => {
        reconnectJitterTimer = null;
        if (cancelled) {
          return;
        }
        if (decision === "rebuild") {
          recordHlsRebuild();
          rebuildEventsRef.current += 1;
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
      // Conventional (the only mode before this task): `hlsLivePlayerConfig()`,
      // unchanged, and `maxLiveSyncPlaybackRate: 1` below -- byte-identical
      // to before LL existed. LL: `llHlsConfig(partTargetMs)`, which
      // deliberately leaves `liveSyncDurationCount`/`liveSyncDuration` OUT
      // so hls.js defers to the manifest's own `PART-HOLD-BACK`
      // (`docs/plans/LL_HLS.md` §4; see that function's own comment).
      const llConfig =
        effectiveMode === "ll"
          ? llHlsConfig(governor?.state().delivery ?? "segments")
          : null;
      // A FUNCTION ONLY SO THE REFUSAL PATH BELOW HAS A NAME FOR IT. hls.js
      // validates the constructor config and refuses a bad combination by
      // THROWING (`mergeConfig`). Inside this async `attach()` that is a
      // rejected promise and nothing else: no source, no request, nothing in
      // the UI but the stall overlay laid over a player that was never built.
      // It shipped exactly that way (`applyLlLatencyCeiling`).
      const buildPlayer = (ll: HlsLLPlayerConfig | null) =>
        new Hls({
          // `hlsLivePlayerConfig()`/`ll` are entirely live-sync tuning
          // (`liveSyncDurationCount`, `liveMaxLatencyDurationCount`, buffer
          // lengths sized to a live sliding window) -- hls.js already treats a
          // playlist with `#EXT-X-ENDLIST` as VOD and picks its own sensible
          // buffering for it, and `maxLiveSyncPlaybackRate` (the live catch-up
          // speed-up) has nothing to turn off on a manifest that is not live.
          ...(isVod ? {} : (ll ?? hlsLivePlayerConfig())),
          enableWorker: true,
          capLevelToPlayerSize: true,
          ...(isVod
            ? {}
            : {
                // Conventional (`ll` null): 1 = off, deliberately, and
                // still. 1.5 sped playback up (and pitched music) whenever the
                // playhead drifted past the sync point, which on the old 10 s
                // window was most of the time. Catch-up now lives OUTSIDE
                // hls.js entirely (`catchUpPlaybackRate`, the "Behind-live
                // polling" effect below), keyed on actual distance from the
                // target rather than a single flat multiplier hls.js applies
                // whenever it judges itself behind; leaving this at 1 is what
                // stops the two fighting over the same `video.playbackRate`.
                // A viewer far enough behind that the gentle curve caps out
                // still gets the "jump to live" affordance. Not applicable to
                // a VOD manifest at all -- there is no live sync point to
                // drift from -- so the whole key is skipped there rather than
                // left at a value that means nothing.
                //
                // LL (`ll` set): the reverse choice. There is no 20 s
                // cushion to protect and the manifest's hold-back IS the
                // target, so hls.js's OWN built-in catch-up (verified against
                // `hls.mjs`'s `LatencyController`) does the job; the
                // "Behind-live polling" effect skips setting
                // `video.playbackRate` on this path for exactly the same
                // one-writer-only reason. See `LL_HLS_MAX_LIVE_SYNC_PLAYBACK_RATE`.
                maxLiveSyncPlaybackRate: ll
                  ? ll.maxLiveSyncPlaybackRate
                  : 1,
              }),
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
      let player: ReturnType<typeof buildPlayer>;
      try {
        player = buildPlayer(llConfig);
      } catch (error) {
        // Said out loud, always: an unhandled rejection in here is what made
        // the original failure invisible for a whole party.
        console.error("[hls] config error", error);
        if (cancelled) {
          return;
        }
        if (!llConfig || pinnedToConventionalRef.current) {
          // Nothing left to drop. Let it reach the caller's `.catch`, which
          // at least names it, rather than half-building a player.
          throw error;
        }
        // DOWN THE SAME SEAM §4's PIN ALREADY USES, and not by quietly
        // building a conventional engine here (a Farol finding on this PR):
        // `effectiveMode` is computed at the top of this effect and every
        // mode-dependent thing after it -- `watch.configureForMode`, the
        // badge, `liveSeekOffsetSeconds`, the pin rule's own arming -- was
        // already set up for `"ll"`. A second instance built inside this
        // catch would run conventional live-sync under LL stall thresholds,
        // which is a different wrong answer. Pinning and re-running the
        // effect makes all of them agree. The pin is sticky for the session,
        // so this can happen at most once and the branch above is the floor.
        pinnedToConventionalRef.current = true;
        setPinnedToConventional(true);
        rebuildEventsRef.current += 1;
        setAttempt((n) => n + 1);
        return;
      }
      hls = player as unknown as HlsHandle;
      hlsRef.current = hls;
      // AFTER the constructor, never inside it: hls.js `mergeConfig` throws
      // on `liveMaxLatencyDuration` in a config that does not also set
      // `liveSyncDuration` (production, 2026-09-15: it threw for EVERY LL
      // viewer and, because `attach()` was a bare `void`, silently). The
      // governor sets the target and the ceiling through the live setters
      // instead, here and on every change after.
      applyGovernor();
      // Enter the conventional restart dead window: stop the in-flight
      // playlist storm, keep the restarting overlay up, and let the next
      // ticks' bounded `"reconnect"` polls (`gateReconnect`) ask the server
      // what is live and adopt a fresh `startedAt`. Shared by the precise
      // 404/410 fast path below and the host-independent safety net beside
      // it, so the two can never drift into different hold behaviour.
      const enterRestartHold = () => {
        watch.onPlaylistGone();
        player.stopLoad();
        setStallReason("playlist-gone");
        setRestartCountdown(RESTART_COUNTDOWN_SECONDS);
      };
      player.on(Hls.Events.ERROR, (_event, data) => {
        // Fatal network/media errors: hls.js has given up on this source;
        // non-fatal ones it retries on its own and the watchdog only notes.
        const fatal = Boolean(data.fatal);
        // Telemetry v2: a seek over a buffer hole is the other kind of
        // `waiting`, and a fatal's own detail is the first thing anybody
        // reading a bad window asks for. Counted before any branch below
        // returns.
        if (!fatal && data.details === "bufferSeekOverHole") {
          stallMeter.onHoleSkip();
        }
        if (
          fatal &&
          typeof data.details === "string" &&
          /^[A-Za-z0-9_-]{1,48}$/.test(data.details) &&
          fatalSinceLastSample.length < 4 &&
          !fatalSinceLastSample.includes(data.details)
        ) {
          fatalSinceLastSample.push(data.details);
        }
        // WHETHER THIS ATTACH HAS A LIVE-EDGE JUMP AT ALL. LL only, and
        // never a replay. On every other path -- which is every watch party
        // anybody has actually run -- the watchdog is told FIRST and the
        // rest of this handler is what it always was, so there is nothing a
        // conventional viewer can reach that PR 646 could have changed.
        //
        // On LL the watchdog is told LAST instead, because the jump below
        // is a claim that this fatal is recoverable in place: handing the
        // ladder the same error would run a second, competing response to
        // it.
        const canJumpOnThisAttach = effectiveMode === "ll" && !isVod;
        // Conventional restart dead window (2026-09-15): a 404/410 on our
        // own playlist/master means the previous session is gone, not that
        // this player should walk the fatal start-load ladder. Intercept
        // before `onError({ fatal })` — hls.js marks these fatal after its
        // retry budget, and that ladder is exactly the 1 Hz / last-segment
        // loop the hold exists to stop. LL and VOD keep the ordinary path
        // (PR 650: do not reintroduce the broader PR 646 live-edge recovery).
        if (
          !cancelled &&
          !isVod &&
          effectiveMode === "conventional" &&
          // Own proxy only — an external HLS 404 must keep the ordinary
          // fatal path, not Farol's fetchChannelLive reconnect (Farol, PR 654).
          isOwnHlsPlaylistProxyUrl(activeSrc) &&
          isPlaylistGoneError({
            details: typeof data.details === "string" ? data.details : null,
            responseCode:
              typeof data.response?.code === "number"
                ? data.response.code
                : null,
          })
        ) {
          // Stop the in-flight 404 storm immediately rather than waiting
          // for the next stall tick to return `"hold"`.
          enterRestartHold();
          // Nothing else in this handler applies: the pin rule and the
          // live-edge jump are both LL-only, a 404 is never the 401 the
          // auth grace exists for, and telling the watchdog `onError` too
          // would start the very ladder the hold replaces.
          return;
        }
        // THE HOST-INDEPENDENT SAFETY NET (2026-09-19, channel d5559e70).
        // The precise fast path above fires only for a 404/410 on a URL this
        // build recognises as our own proxy. Production moved playlist
        // delivery to an edge host (`hls.pqp.gg`), the host-keyed check
        // silently stopped matching, and every 5xx/404 there fell through to
        // the FATAL ladder below -- which rebuilds in place and NEVER asks
        // the server what is live, so a viewer hammered the dead `startedAt`
        // (502 -> 503 -> 404, on a loop) for minutes while a newer session
        // was already up. This drives the SAME bounded hold+discover path off
        // a RUN of master/level failures (404/410 or 5xx), or one fatal such
        // error, for any URL whose channel we can look up -- whatever host
        // served it, and whatever the WS `channel-live` frame did or did not
        // deliver. Conventional live only; LL and VOD keep their own paths.
        if (
          !cancelled &&
          !isVod &&
          effectiveMode === "conventional" &&
          channelIdFromHlsUrl(activeSrc) !== null &&
          isPlaylistUnavailableError({
            details: typeof data.details === "string" ? data.details : null,
            responseCode:
              typeof data.response?.code === "number"
                ? data.response.code
                : null,
            fatal,
          })
        ) {
          const now = Date.now();
          playlistUnavailableTimes.push(now);
          if (fatal || playlistErrorsWarrantDiscovery(playlistUnavailableTimes, now)) {
            console.warn(
              `[hls] playlist unavailable (${data.details} ${
                data.response?.code ?? "?"
              }), discovering the current session`,
            );
            enterRestartHold();
            return;
          }
        }
        if (!canJumpOnThisAttach) {
          watch.onError(hlsErrorPayload(data, fatal));
        }
        // Pitfall 16 (CLAUDE.md): a 401 on our own playlist proxy is almost
        // always a Clerk JWT that went stale a few seconds before its
        // refresh, not a real access failure — the `?t=` capability in the
        // URL is still good, and the very next attempt usually 200s. Say
        // nothing about it for a few seconds rather than flashing a stall
        // overlay over a failure the person never needs to know happened.
        if (!cancelled && data.response?.code === 401) {
          triggerAuthGraceRef.current();
        }
        // §4's old pin rule, now in place: on LL, two part-load errors inside
        // 10 s move a parts viewer to whole segments (`LlLatencyGovernor`),
        // keeping the buffer and the instance. It used to rebuild the player
        // at the conventional path's ~25 s cushion to get the same effect.
        if (
          !cancelled &&
          governor &&
          isLlPartLoadErrorDetail(data.details) &&
          governor.onPartLoadError(Date.now())
        ) {
          applyGovernor();
        }
        if (!canJumpOnThisAttach) {
          // Conventional and VOD are finished: the watchdog already has the
          // error and its ladder is the only response there is, exactly as
          // before PR 646.
          return;
        }
        // A 404/410 on a part or segment: the player fell behind the ring,
        // which a jump to live fixes and a holding screen does not. Skipped
        // when the pin above already fired -- that rebuilds the instance
        // from the live edge anyway, and two responses to one error is how
        // a recovery ladder fights itself.
        //
        // Why this is LL-only rather than "live-only", which is what PR 646
        // shipped: on a conventional stream a 404 on a segment is NOT a
        // player that fell behind a twelve-second ring. The window is sixty
        // seconds and hls.js's own retry budget is generous enough to sit
        // inside it, so a 404 there means the object is genuinely not in the
        // bucket -- an egress that stopped writing, a session that ended --
        // and escalating to the ladder (and eventually to a holding screen
        // that says so) is the correct answer, not jumping the audience
        // forward over a hole.
        if (
          !cancelled &&
          isMissingFragmentError({
            fatal,
            details: data.details,
            responseCode: data.response?.code ?? null,
          }) &&
          jumpToLiveEdgeAfterError(`${data.details} ${data.response?.code}`)
        ) {
          return;
        }
        watch.onError(hlsErrorPayload(data, fatal));
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
        // A VOD manifest's EXT-X-MEDIA-SEQUENCE is fixed the moment it loads
        // -- it is SUPPOSED to stop advancing once the whole recording is
        // buffered, which `watch.onMediaSequence` (and the sequence-stuck
        // watchdog reading it) exists specifically to call a dead LIVE
        // egress. Feeding it a replay's frozen sequence restarted a healthy
        // recording's playback every ~20s (see the `mode` prop's doc
        // comment). Skipping the call is enough: `HlsStallWatch` only checks
        // `sequenceSeenAt`/`lastSequence` once `onMediaSequence` has set
        // them, so leaving them untouched leaves that branch permanently
        // unreachable, which is exactly the point for a replay.
        if (isVod) {
          return;
        }
        // The live playlist's newest segment number, NOT its
        // EXT-X-MEDIA-SEQUENCE: the proxy's widened window keeps the first
        // listed segment (`startSN`) still for the first 60 s a process
        // sees a session and after every API restart, while a dead egress
        // is one that stops APPENDING (`livePlaylistProgress`). This is how
        // the watchdog tells a dead egress apart from a slow network.
        watch.onMediaSequence(livePlaylistProgress(data.details), Date.now());
        // LL only, and a SEPARATE signal from the media-sequence one above
        // (Farol review, this PR): under LL's blocking reload, hls.js fires
        // this same event once per PART, not only once per segment --
        // `lastPartSn`/`lastPartIndex` are hls.js's own (segment, part)
        // pair for the newest part it has seen (verified against `hls.mjs`:
        // `onLevelLoaded`'s own debug log names exactly this pair). Feeding
        // that into `onPartAdvance` is what lets the watchdog's part-stuck
        // rule tell "no new part yet" apart from "no new segment yet",
        // which is the normal, healthy state for several seconds at a time.
        if (effectiveMode === "ll") {
          // WHAT THE PLAYLIST SAYS ABOUT ITS OWN CADENCE, before anything is
          // judged against it. `pqp-remux` closes a video segment on an IDR,
          // so a real party advertises `EXT-X-TARGETDURATION` 7 where the
          // client constant assumed 4, and the sequence backstop was firing
          // on a healthy stream (production, 2026-09-16).
          watch.onManifestTiming({
            targetDurationSeconds: data.details.targetduration,
            partTargetSeconds: data.details.partTarget,
          });
          // A PART IS ONLY PROGRESS IF THE PLAYLIST ACTUALLY LISTS ONE.
          // `lastPartSn`/`lastPartIndex` are hls.js's own newest-part pair;
          // on a playlist with no `partList` they are the segment's own
          // numbers with a `-1` index, which never changes between parts and
          // so must not be fed in as if it did.
          const parts = data.details.partList;
          if (parts && parts.length > 0) {
            watch.onPartAdvance(
              `${data.details.lastPartSn}.${data.details.lastPartIndex}`,
              Date.now(),
            );
          }
          // THE GOVERNOR HEARS WHAT THE MANIFEST ASKS FOR: a parts viewer
          // never sits closer than the manifest's own `PART-HOLD-BACK`, and
          // never closer than its own floor either. Re-applied only when the
          // value changes -- this event fires once per PART under the
          // blocking reload.
          const holdBack = data.details.partHoldBack;
          if (governor && holdBack !== lastPartHoldBack) {
            lastPartHoldBack = holdBack;
            governor.onManifest({ partHoldBackSeconds: holdBack });
            applyGovernor();
          }
        }
        // Conventional only. This is exactly the override §4 warns against
        // on an LL manifest: it fights `PART-HOLD-BACK` by giving
        // `userConfig.liveSyncDurationCount` a truthy value at construction
        // (`hlsLivePlayerConfig()`), which is what makes this live mutation
        // take effect at all (see `llHlsConfig`'s own comment on why LL's
        // config omits the field instead). Never sync onto the oldest
        // listed segment: against an API that still serves the egress's raw
        // five-segment window, a 5-count sync point is the oldest entry
        // with no slack, so a slow poll ages it out and hls.js re-syncs or
        // stalls. hls.js reads this live on each playlist update, so
        // capping it here keeps one segment of slack on a short window; on
        // the production 15-segment window it is a no-op.
        if (effectiveMode !== "ll") {
          player.config.liveSyncDurationCount = effectiveLiveSyncDurationCount(
            data.details.fragments.length,
          );
        }
      });
      // Media is still landing: the watchdog's stall rule is for a player
      // that is waiting AND getting nothing, never for one mid-recovery.
      player.on(Hls.Events.FRAG_BUFFERED, () => {
        watch.onBufferProgress(Date.now());
      });
      player.on(Hls.Events.FRAG_LOADED, () => {
        hlsFragmentLoaded = true;
        // The playlist is serving fragments again: forget any earlier
        // master/level failures so isolated blips can never accumulate into
        // a spurious session re-discovery on a stream that is otherwise fine.
        playlistUnavailableTimes.length = 0;
      });
      // BROADCAST_PIPELINE B0.3: which fragment is the one about to be
      // painted, and its own wall clock (`#EXT-X-PROGRAM-DATE-TIME`, real
      // from the egress or synthesised by the proxy -- either way hls.js
      // parses it onto `frag.programDateTime` the same way). `FRAG_CHANGED`
      // fires when playback actually MOVES onto a fragment, which is closer
      // to "this is what's on screen now" than `FRAG_LOADED`, which fires on
      // download and can run well ahead of the playhead.
      player.on(Hls.Events.FRAG_CHANGED, (_event, data) => {
        const frag = data.frag as {
          programDateTime?: number | null;
          start: number;
          level: number;
        };
        currentFrag = {
          programDateTimeMs: frag.programDateTime ?? NaN,
          startSeconds: frag.start,
        };
        const level = player.levels[frag.level] as
          | { url?: string[] | string; height?: number; frameRate?: number }
          | undefined;
        const levelUrl = Array.isArray(level?.url) ? level.url[0] : level?.url;
        // The proxy path names the rung directly; a level whose URL is not
        // our proxy at all (a raw public bucket URL, `LIVE_HLS_SIGNED_URLS=
        // false`) falls back to naming it from the level's own resolution
        // and framerate instead of reporting no rung -- and therefore never
        // sending telemetry -- for an otherwise fully supported stream.
        currentRung =
          hlsRungFromPlaylistUrl(levelUrl) ??
          hlsFallbackRungLabel({
            height: level?.height,
            framerate: level?.frameRate,
          }) ??
          currentRung;
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

    // NOT a bare `void attach()`. This function constructs hls.js, and a
    // throw in there (an hls.js config `mergeConfig` refuses, a dynamic
    // import that fails) leaves the element with no source, no request ever
    // issued, and nothing in the console but an unhandled rejection the
    // stall overlay then covers with "reconectando". Pitfall 16's rule --
    // something that refuses has to say why -- applied to our own attach.
    void attach().catch((error) => {
      console.error("[hls] attach failed", error);
      if (cancelled) {
        return;
      }
      // AND RECOVERED FROM, not merely logged (a Farol finding on this PR).
      // An attach that threw leaves an element with no source, which is as
      // fatal as hls.js declaring a source dead -- so it is handed to the one
      // ladder that already owns that: the stall tick reads it on its next
      // pass and escalates through reconnect / rebuild / "A transmissão
      // caiu" exactly as it does for a source that died after attaching.
      watch.onError({
        fatal: true,
        type: "attachError",
        message: error instanceof Error ? error.message : String(error),
        now: Date.now(),
      });
    });
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
      if (telemetrySampleTimer !== null) {
        window.clearInterval(telemetrySampleTimer);
      }
      if (pendingRvfcHandle !== null) {
        (
          video as HTMLVideoElement & {
            cancelVideoFrameCallback?: (handle: number) => void;
          }
        ).cancelVideoFrameCallback?.(pendingRvfcHandle);
        pendingRvfcHandle = null;
      }
      // The window since the last flush is worth sending: it is the tail
      // end of a viewer's session, exactly the part a fixed 30s timer would
      // otherwise lose on every navigate-away.
      telemetryQueue?.flush();
      telemetryQueue?.stop();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalledEvent);
      document.removeEventListener("visibilitychange", onVisibility);
      llTargetSecondsRef.current = null;
      llDeliveryRef.current = null;
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
  }, [activeSrc, attempt, isVod]);

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
  const monitor = layout === "monitor";

  // C3 (post-mortem item, `lib/watch-holding-screen.ts`): what the overlay
  // over the picture says, mapped from `phase` and the stall watchdog's own
  // reason rather than a single generic "loading" for every cause.
  const holdingReason = resolveHoldingScreenReason({
    phase,
    hasFrame,
    stallReason,
    authGraceActive,
    sessionOver,
    // `resolveHoldingScreenReason` only ever distinguishes VOD from
    // everything else -- LL changes the engine's live-sync tuning, not the
    // holding-screen vocabulary, so it collapses onto "live" here the same
    // as conventional does.
    mode: isVod ? "vod" : "live",
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

  // Item 3: the live badge shows the measured figure on LL instead of the
  // plain "Ao vivo"/"Live" every mode used to say — LL's whole product is
  // being fast, so a number under a couple of seconds is worth showing
  // rather than hiding the way the conventional badge deliberately does
  // (2026-09-09 postmortem, `hls-live-edge.ts`'s `endToEndDelaySeconds`
  // comment). `null` (no hls.js instance yet, the native engine, or a
  // reading not in yet) falls back to the plain label, same as always.
  //
  // `effectiveHlsMode` (not the raw `mode` prop) so §4's pin rule is
  // reflected here too (Farol review, this PR): a pinned session must say
  // conventional latency, not linger on an LL reading the server was never
  // told to demote.
  const displayMode = effectiveHlsMode(hlsMode, pinnedToConventional);
  const liveBadgeText =
    displayMode === "ll" && llLatencySeconds !== null
      ? t("voice.hls.liveLowLatency", {
          seconds: llLatencySeconds.toFixed(1),
        })
      : t("voice.hls.live");

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
          hasVideo={cameraHasVideo}
          hasVoiceAudio={cameraHasVoiceAudio}
          className={cn(boxes.camera ?? "", videoFitClass("cover"))}
          onFrame={setCameraFrame}
        />
      ) : null}
      {/* THE CONTROLS SIT OVER WHICHEVER PICTURE IS IN THE CORNER, which is
          why there is one of them rather than one per player: the corner is a
          box, and what is in it changes. `tileControls` in `lib/stage-layers.ts`
          is above the pictures and below the chrome, so the control bar is never behind
          webcam. */}
      {boxes.corner ? (
        <div
          data-testid="watch-camera-pip-controls"
          data-camera-on-stage={cameraPip.onStage ? "" : undefined}
          className={cn(boxes.corner, "group/pip", STAGE_LAYER.tileControls)}
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
      {holdingReason === "over" || holdingReason === "awaiting" ? (
        // THE TRUTH, AND NO SPINNER. The server has been asked and has
        // answered: there is nothing live on this channel. A person looking
        // at this needs to know which of the two silences it is and that
        // nothing is being hidden from them, not a bubble animation that
        // implies something is on its way. The player stays mounted and
        // keeps a slow poll running, so a new session appears here on its
        // own with nothing to press and nothing to reload.
        <div
          data-testid={
            holdingReason === "over" ? "hls-session-over" : "hls-awaiting-presenter"
          }
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-black/70 px-6 text-center"
        >
          <span className="text-sm font-semibold text-paper">
            {holdingReason === "over"
              ? t("voice.hls.sessionOver")
              : t("voice.hls.awaitingPresenter")}
          </span>
          <span className="text-xs text-paper-muted">
            {holdingReason === "over"
              ? t("voice.hls.sessionOverHint")
              : t("voice.hls.awaitingPresenterHint")}
          </span>
        </div>
      ) : holdingReason === "dead" || holdingReason === "unavailable" ? (
        <div
          data-testid={holdingReason === "unavailable" ? "hls-replay-dead" : "hls-dead"}
          className={cn("absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-sm text-paper", STAGE_LAYER.state)}
        >
          <span>
            {holdingReason === "unavailable"
              ? t("voice.hls.replayDead")
              : t("voice.hls.dead")}
          </span>
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
      ) : holdingReason === "buffering" ? (
        // A replay's plain "loading" state. Deliberately NOT the live
        // `StreamStartingSoon` holding screen: that bubbles loop and its
        // rotating "hold tight, it's about to start" lines describe a watch
        // party that has not gone live yet, which is never true of a
        // finished broadcast simply buffering its next segment.
        <div
          data-testid="hls-vod-loading"
          className={cn("pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40", STAGE_LAYER.state)}
        >
          <Loader2
            className="h-8 w-8 animate-spin text-paper/80"
            aria-hidden="true"
          />
        </div>
      ) : holdingReason !== null ? (
        <div
          data-testid={
            holdingReason === "restarting"
              ? "hls-restarting"
              : phase === "reconnecting"
                ? "hls-reconnecting"
                : "hls-buffering"
          }
          className={cn("pointer-events-none absolute inset-0", STAGE_LAYER.state)}
        >
          <StreamStartingSoon caption={holdingCaption} />
        </div>
      ) : null}
      {cinema && hasFrame && !isVod ? (
        // Plain and permanent, deliberately OUTSIDE `chromeClass` below: that
        // bar fades on idle (Twitch-style autohide), and a badge that
        // vanishes the moment the pointer rests is the "hover-only" shape
        // this replaces. No delay figure and no hover explanation here — see
        // `voice.hls.live` below: "how far behind" used to be printed as a
        // constant read off the wire config rather than the stream's actual
        // distance from live, which was worse than saying nothing.
        <div className={cn("pointer-events-none absolute left-2 top-2 flex flex-col items-start gap-1", STAGE_LAYER.badges)}>
          <span
            data-testid="hls-delay-badge"
            className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[11px] font-semibold text-paper"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-danger"
            />
            {liveBadgeText}
          </span>
        </div>
      ) : null}
      {cinema ? (
      <div
        data-watch-chrome=""
        data-call-chrome=""
        className={cn(
          // `chrome` beats the fullscreen chat overlay (45, `index.css`);
          // the bar once sat at 20 under it, so Leave fullscreen could not
          // be clicked once chat was open. See `lib/stage-layers.ts`.
          STAGE_LAYER.chrome,
          "pointer-events-none absolute inset-0 flex flex-col justify-between",
          chromeClass,
        )}
        onFocusCapture={() => setBarFocused(true)}
        onBlurCapture={onBarBlur}
      >
        <div
          // THE GRADIENT DOES NOT TAKE THE POINTER (pass 5 of
          // `docs/plans/WATCH_PARTY_UI.md` §10.3): only the content row inside
          // does, so a press on the picture under the fade reaches the picture
          // (and wakes the chrome through the stage's own handler) instead of
          // being swallowed by an invisible band.
          className="pointer-events-none flex items-start justify-end gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pb-8 pt-3"
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
          <div className="pointer-events-auto flex min-w-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
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
          className="pointer-events-none flex items-center justify-between gap-2 bg-gradient-to-t from-black/80 via-black/50 to-transparent px-3 pb-3 pt-10"
          onPointerDown={swallowPressWhileHidden}
          onPointerEnter={() => setBarHovered(true)}
          onPointerLeave={() => setBarHovered(false)}
        >
          <div className="pointer-events-auto flex min-w-0 items-center gap-1.5">
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
            {isVod ? (
              // A replay's real transport: no live edge to chase, a
              // beginning and an end instead. `vodDuration` is null until
              // `loadedmetadata` fires, which is also the only time a range
              // input with an unknown max would be meaningless to show.
              <div
                data-testid="hls-vod-seek"
                className="flex min-w-0 flex-1 items-center gap-2 pl-1"
              >
                <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-paper/80">
                  {formatCallDuration(vodCurrentTime * 1000)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={vodDuration ?? 0}
                  step={1}
                  value={Math.min(vodCurrentTime, vodDuration ?? 0)}
                  disabled={vodDuration === null}
                  aria-label={t("voice.hls.seek")}
                  onChange={(event) => seekTo(Number(event.target.value))}
                  className="h-1 min-w-0 flex-1 cursor-pointer accent-signal disabled:cursor-default disabled:opacity-50"
                />
                <span className="w-9 shrink-0 text-[11px] tabular-nums text-paper/80">
                  {vodDuration === null
                    ? "--:--"
                    : formatCallDuration(vodDuration * 1000)}
                </span>
              </div>
            ) : behindLive || (paused && hasFrame) ? (
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
                {liveBadgeText}
              </span>
            )}
          </div>
          <div className="pointer-events-auto flex shrink-0 items-center gap-0.5">
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
            {bottomActions}
          </div>
        </div>
      </div>
      ) : monitor ? null : mini ? (
        /* The docked player. Everything a 240px box cannot afford is gone:
           the live badge, the delay badge, the fit toggle, the quality menu
           and picture-in-picture all live on the stage this came from, one
           click away. What is left is what a person carrying a stream into
           another channel actually reaches for. */
        <div
          data-testid="hls-mini-chrome"
          className={cn("pointer-events-none absolute inset-0 flex flex-col justify-between p-1.5", STAGE_LAYER.chrome)}
        >
          <div className="pointer-events-auto flex items-start justify-end gap-1">
            {actions}
          </div>
          <div className="pointer-events-auto flex items-end justify-end">
            {!forceMuted && (
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
            )}
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
                {liveBadgeText}
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
      {hasFrame && needsUnmute && !monitor ? (
        <button
          type="button"
          className={cn(
            "absolute left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-sm font-medium text-paper hover:bg-black/90",
            STAGE_LAYER.tileControls,
            cinema ? "bottom-16" : "bottom-3",
          )}
          onClick={restoreSound}
        >
          {t("voice.hls.unmute")}
        </button>
      ) : null}
      {dualDeviceWarning && !mini && !monitor ? (
        <div
          data-testid="hls-dual-device-warning"
          className={cn(
            "pointer-events-auto absolute left-1/2 flex max-w-[92%] -translate-x-1/2 items-center gap-2 rounded-[var(--radius-control)] bg-black/80 px-2.5 py-1.5 text-[11px] text-paper sm:max-w-[75%]",
            STAGE_LAYER.badges,
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
