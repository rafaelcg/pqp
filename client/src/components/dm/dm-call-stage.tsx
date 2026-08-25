import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Phone,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { SCREEN_SHARE_LIMIT, type DmSummary } from "@pqp/shared";
import type { VoiceState } from "@/hooks/use-voice";
import type { VideoQuality } from "@/lib/video-quality";
import {
  detectFullscreenMode,
  supportsScreenShare,
  type FullscreenMode,
} from "@/components/voice/capabilities";
import { attemptElementFullscreen } from "@/components/voice/element-fullscreen";
import {
  NO_SCREEN_FULLSCREEN,
  reconcileScreenFullscreen,
  syncScreenFullscreen,
  toggleScreenFullscreen,
  toggleStageFullscreen,
  type ScreenFullscreenState,
  type ScreenFullscreenTransition,
} from "@/components/voice/screen-fullscreen";
import {
  collectScreenTiles,
  screenShareStageLayout,
  type ScreenShareTile,
} from "@/components/voice/screen-stage";
import {
  callControlsMayIdle,
  presentersToAsk,
  requestsOfUs,
  showsVideoQualityControl,
  videoQualityMenuOpen,
} from "@/components/voice/video-quality-control";
import { VideoQualityMenu } from "@/components/voice/video-quality-menu";
import { VoiceAvatar } from "@/components/voice/voice-avatar";
import { UserAvatar } from "@/components/user/user-avatar";
import { useLgUp } from "@/hooks/use-lg-up";
import { isScreenShareAtCap } from "@/lib/screen-share-roster";
import { useTranslation } from "@/lib/i18n";
import { conversationTitle } from "@/lib/conversations";
import { startSoundLoop, stopSoundLoop } from "@/lib/sounds";
import { cn } from "@/lib/utils";
import {
  callStartKey,
  callStartedAt,
  formatCallDuration,
  isStageCollapsed,
  markCallStarted,
  nearestCorner,
  rememberStageCollapsed,
  stageLayout,
  type PipCorner,
} from "@/components/dm/call-stage-state";

/**
 * The call surface of a conversation — a stage, not a strip.
 *
 * Deliberately NOT the channel `VoicePanel`: that component is a room you
 * navigate into, this is a call that happens on top of a conversation you are
 * already reading. It renders nothing at all while there is no call, and grows
 * through these states:
 *
 * - somebody else is in a call here → a slim "N in call · Join" banner
 * - we are in it, stage expanded → the call owns the pane: remote person or
 *   grid large, self as a draggable corner preview, controls docked on the
 *   stage. Chat compresses below it but stays reachable.
 * - we are in it, stage collapsed → a slim banner with the essentials, for
 *   reading chat mid-call. Remembered per conversation for the session.
 *
 * Camera is off by default and only ever turned on by its own toggle here (or
 * by the header's "start with video", which flips the same toggle on join).
 */

/** How one person appears on the stage, whatever transport carried them. */
interface StagePerson {
  key: string;
  name: string;
  avatarUrl: string | null;
  /** Camera video when they send it; null renders the avatar instead. */
  stream: MediaStream | null;
  speaking: boolean;
  muted: boolean;
  connecting: boolean;
  isSelf: boolean;
}

const PIP_CORNER_CLASS: Record<PipCorner, string> = {
  tl: "left-3 top-3",
  tr: "right-3 top-3",
  bl: "bottom-3 left-3",
  br: "bottom-3 right-3",
};

/** The Fullscreen API under both spellings — see `screen-share-view.tsx`. */
interface WebkitFullscreenVideo extends HTMLVideoElement {
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
}

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface WebkitFullscreenDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

function fullscreenDocument(): WebkitFullscreenDocument {
  return document as WebkitFullscreenDocument;
}

function currentFullscreenElement(): Element | null {
  const doc = fullscreenDocument();
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

async function requestElementFullscreen(element: HTMLElement): Promise<void> {
  const webkit = element as WebkitFullscreenElement;
  if (typeof element.requestFullscreen === "function") {
    await element.requestFullscreen();
    return;
  }
  if (typeof webkit.webkitRequestFullscreen === "function") {
    await webkit.webkitRequestFullscreen();
    return;
  }
  throw new Error("no element fullscreen API");
}

async function exitDocumentFullscreen(): Promise<void> {
  const doc = fullscreenDocument();
  if (typeof doc.exitFullscreen === "function") {
    await doc.exitFullscreen();
    return;
  }
  await doc.webkitExitFullscreen?.();
}

/**
 * Fullscreen for the stage container, with the iOS in-page fallback.
 *
 * Capability *detection* is `detectFullscreenMode` from
 * `components/voice/capabilities.ts` — not re-derived here. The event wiring
 * follows `screen-share-view.tsx`, including the reattach-on-exit fix: iOS's
 * native player detaches a MediaStream on the way out, so the same stream is
 * re-set and replayed, both no-ops anywhere the detach did not happen.
 *
 * THE ELEMENT THAT GOES FULLSCREEN IS ALWAYS THE STAGE, even when the user
 * asked for one particular shared screen. Which share is *alone* on that stage
 * is separate state (`screen-fullscreen.ts`), so:
 *   - a call with one sharer takes exactly the path it took before;
 *   - swapping which screen is blown up is a re-render, not a second
 *     `requestFullscreen` that would need a fresh gesture and would stack;
 *   - the iPhone `expand` fallback keeps working unchanged, because it never
 *     hands a <video> to the OS player (that is the PR #48 black-screen bug).
 */
function useStageFullscreen(
  containerRef: RefObject<HTMLDivElement | null>,
  videoRef: RefObject<WebkitFullscreenVideo | null>,
  hasPrimaryVideo: boolean,
  screenPeerIds: string[],
) {
  const [state, setState] = useState<ScreenFullscreenState>(
    NO_SCREEN_FULLSCREEN,
  );
  // `expand` needs no platform support, so it is the safe starting point and
  // the detector only ever upgrades it.
  const [mode, setMode] = useState<FullscreenMode>("expand");
  // Set once a platform that *claims* element fullscreen turns out not to
  // honour it (an Electron shell whose embedder denies the permission). It
  // pins the mode to `expand`, which the detector below must then stop
  // undoing: it re-runs whenever the stage gains or loses a video, and an
  // upgrade back to `element` would re-break the button mid-call.
  const refusedElementRef = useRef(false);

  useEffect(() => {
    if (refusedElementRef.current) {
      return;
    }
    const doc = fullscreenDocument();
    setMode(
      detectFullscreenMode({
        documentFullscreenEnabled:
          typeof document === "undefined"
            ? undefined
            : (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled),
        requestFullscreen: containerRef.current?.requestFullscreen,
        webkitRequestFullscreen: (
          containerRef.current as WebkitFullscreenElement | null
        )?.webkitRequestFullscreen,
      }),
    );
  }, [containerRef, videoRef, hasPrimaryVideo]);

  useEffect(() => {
    const video = videoRef.current;
    const onFullscreenChange = () => {
      const active = currentFullscreenElement() === containerRef.current;
      setState((was) => syncScreenFullscreen(was, active));
    };
    const onBegin = () => setState((was) => syncScreenFullscreen(was, true));
    const onEnd = () => {
      setState((was) => syncScreenFullscreen(was, false));
      const el = videoRef.current;
      if (el && el.srcObject) {
        const current = el.srcObject;
        el.srcObject = null;
        el.srcObject = current;
        void el.play().catch(() => {
          // The user can tap the frame; the stream itself is intact.
        });
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    video?.addEventListener("webkitbeginfullscreen", onBegin);
    video?.addEventListener("webkitendfullscreen", onEnd);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener(
        "webkitfullscreenchange",
        onFullscreenChange,
      );
      video?.removeEventListener("webkitbeginfullscreen", onBegin);
      video?.removeEventListener("webkitendfullscreen", onEnd);
    };
  }, [containerRef, videoRef, hasPrimaryVideo]);

  // A presenter can stop sharing while their screen is the one blown up.
  const screenPeerKey = screenPeerIds.join(",");
  useEffect(() => {
    const peerIds = screenPeerKey === "" ? [] : screenPeerKey.split(",");
    setState((was) => reconcileScreenFullscreen(was, peerIds));
  }, [screenPeerKey]);

  const apply = useCallback(
    (transition: ScreenFullscreenTransition) => {
      if (mode !== "element") {
        // `expand`: grow the stage inside the page. Replaces handing the
        // <video> to the OS media player, which cannot render a MediaStream and
        // left an iPhone showing a black rectangle with the audio still
        // playing. Nothing can refuse it, so the state is the whole story.
        setState(transition.next);
        return;
      }
      const container = containerRef.current;
      if (!container) {
        return;
      }
      if (transition.request === "none") {
        // Already fullscreen; only *which* screen is alone on it changed.
        setState(transition.next);
        return;
      }
      if (transition.request === "exit") {
        // `active` is confirmed by `fullscreenchange`, so do not pre-empt it:
        // a refused exit would otherwise leave the control lying.
        void exitDocumentFullscreen().catch((err: unknown) => {
          console.warn("[call] fullscreen exit refused", err);
        });
        return;
      }
      // Record the target now so the `fullscreenchange` that follows renders
      // the right screen; `active` still comes from the browser.
      setState((was) => ({ ...was, soloPeerId: transition.next.soloPeerId }));
      void attemptElementFullscreen({
        request: () => requestElementFullscreen(container),
        isActive: () => currentFullscreenElement() === container,
        onRefusal: (err) => console.warn("[call] fullscreen refused", err),
      }).then((entered) => {
        if (entered) {
          return;
        }
        // The platform did not take it, and on an Electron shell it did not
        // even say so — see `element-fullscreen.ts`. Fill the viewport in the
        // page instead, and stop asking for the rest of the session: leaving
        // the mode on `element` would strand the user, because the exit press
        // would call `exitFullscreen` on a document that is not fullscreen and
        // the state would never clear.
        console.warn("[call] element fullscreen unavailable; expanding in page");
        refusedElementRef.current = true;
        setMode("expand");
        setState(transition.next);
      });
    },
    [mode, containerRef],
  );

  // The click handlers need the *current* state without being re-created (and
  // re-bound) on every fullscreen change. A state updater cannot be used to
  // read it: `apply` calls into the platform, and React is free to run an
  // updater twice.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const toggle = useCallback(() => {
    apply(toggleStageFullscreen(stateRef.current));
  }, [apply]);

  const toggleScreen = useCallback(
    (peerId: string) => {
      apply(toggleScreenFullscreen(stateRef.current, peerId));
    },
    [apply],
  );

  // Nothing to gate on any more: expanding needs no platform support, and
  // there is always a stage to expand even when the call is audio-only.
  const available = true;
  return {
    isFullscreen: state.active,
    /** The one share alone on the stage, or null for the whole stage. */
    soloPeerId: state.active ? state.soloPeerId : null,
    mode,
    available,
    toggle,
    toggleScreen,
  };
}

export function DmCallStage({
  conversation,
  currentUser,
  voiceState,
  videoQuality,
  onJoinCall,
  onLeave,
  onToggleMute,
  onToggleCamera,
  onVideoQualityChange,
  onRequestScreenQuality,
  onStartScreenShare,
  onStopScreenShare,
  onFocusScreenShare,
}: {
  conversation: DmSummary;
  currentUser: { id: string; displayName: string; avatarUrl: string | null } | null;
  voiceState: VoiceState;
  /**
   * The one stored choice, straight from `LocalSettings.videoQuality`. Passed
   * in rather than read from the voice controller so that this menu and the
   * Settings dialog are two views of the same value: whichever you touch, the
   * other one is already showing the result next time you look.
   */
  videoQuality: VideoQuality;
  onJoinCall: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  /** Ask one presenter for a size, or withdraw with `auto`. Per-peer. */
  onRequestScreenQuality?: (peerId: string, quality: VideoQuality) => void;
  onStartScreenShare?: () => void;
  onStopScreenShare?: () => void;
  onFocusScreenShare?: (peerId: string) => void;
}) {
  const { t } = useTranslation();
  const channelId = conversation.channelId;
  const occupants = voiceState.occupancy[channelId] ?? [];
  const inThisCall =
    voiceState.voiceChannelId === channelId && voiceState.status !== "idle";

  const [collapsed, setCollapsed] = useState(() => isStageCollapsed(channelId));
  // Navigating between conversations reuses this mounted component, so the
  // remembered choice has to be re-read when the conversation under it changes.
  useEffect(() => {
    setCollapsed(isStageCollapsed(channelId));
  }, [channelId]);

  const setCollapsedRemembered = (next: boolean) => {
    setCollapsed(next);
    rememberStageCollapsed(channelId, next);
  };

  if (!inThisCall && occupants.length === 0) {
    return null;
  }

  if (!inThisCall) {
    return (
      <div className="flex items-center gap-3 border-b border-ink-4/60 bg-ink-2/70 px-4 py-2">
        <OccupantFaces
          faces={occupants.map((person) => ({
            key: person.peerId,
            displayName: person.displayName,
            avatarUrl: person.avatarUrl,
          }))}
        />
        <p className="min-w-0 flex-1 truncate text-sm text-paper-muted">
          {t("call.panel.inCall", { count: occupants.length })}
        </p>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md bg-success/90 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-success"
          onClick={onJoinCall}
        >
          <Phone className="h-3.5 w-3.5" />
          {t("call.panel.join")}
        </button>
      </div>
    );
  }

  return (
    <ActiveCall
      conversation={conversation}
      currentUser={currentUser}
      voiceState={voiceState}
      videoQuality={videoQuality}
      collapsed={collapsed}
      onSetCollapsed={setCollapsedRemembered}
      onLeave={onLeave}
      onToggleMute={onToggleMute}
      onToggleCamera={onToggleCamera}
      onVideoQualityChange={onVideoQualityChange}
      onRequestScreenQuality={onRequestScreenQuality}
      onStartScreenShare={onStartScreenShare}
      onStopScreenShare={onStopScreenShare}
      onFocusScreenShare={onFocusScreenShare}
    />
  );
}

function ActiveCall({
  conversation,
  currentUser,
  voiceState,
  videoQuality,
  collapsed,
  onSetCollapsed,
  onLeave,
  onToggleMute,
  onToggleCamera,
  onVideoQualityChange,
  onRequestScreenQuality,
  onStartScreenShare,
  onStopScreenShare,
  onFocusScreenShare,
}: {
  conversation: DmSummary;
  currentUser: { id: string; displayName: string; avatarUrl: string | null } | null;
  voiceState: VoiceState;
  videoQuality: VideoQuality;
  collapsed: boolean;
  onSetCollapsed: (collapsed: boolean) => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  /** Ask one presenter for a size, or withdraw with `auto`. Per-peer. */
  onRequestScreenQuality?: (peerId: string, quality: VideoQuality) => void;
  onStartScreenShare?: () => void;
  onStopScreenShare?: () => void;
  onFocusScreenShare?: (peerId: string) => void;
}) {
  const { t } = useTranslation();
  const wide = useLgUp();
  const channelId = conversation.channelId;
  const joining = voiceState.status === "joining";
  // "Calling…" is a call we started that nobody has picked up: connected, but
  // alone in the room. (Everybody-left lands here too, which reads the same.)
  const callingOut =
    voiceState.status === "connected" && voiceState.remotePeers.length === 0;
  useEffect(() => {
    if (callingOut) {
      startSoundLoop("outgoingCall");
    } else {
      stopSoundLoop("outgoingCall");
    }
    return () => stopSoundLoop("outgoingCall");
  }, [callingOut]);
  const roster = voiceState.occupancy[channelId] ?? [];
  const rosterByPeerId = new Map(roster.map((p) => [p.peerId, p]));

  const speaking = new Set(voiceState.speakingPeerIds);
  const self: StagePerson | null = currentUser
    ? {
        key: "self",
        name: currentUser.displayName,
        avatarUrl: currentUser.avatarUrl,
        stream: voiceState.localCameraStream,
        speaking:
          voiceState.peerId !== null &&
          speaking.has(voiceState.peerId) &&
          !voiceState.isMuted,
        muted: voiceState.isMuted,
        connecting: false,
        isSelf: true,
      }
    : null;
  const remotes: StagePerson[] = voiceState.remotePeers.map((peer) => ({
    key: peer.peerId,
    name: peer.displayName ?? t("voice.share.someone"),
    avatarUrl: peer.avatarUrl ?? null,
    stream: peer.cameraStream,
    speaking: speaking.has(peer.peerId),
    muted: rosterByPeerId.get(peer.peerId)?.muted ?? false,
    connecting: peer.connectionState !== "connected",
    isSelf: false,
  }));

  const screenTiles = collectScreenTiles({
    peerIds: voiceState.screenSharePeerIds,
    localPeerId: voiceState.peerId,
    localName: currentUser?.displayName ?? t("voice.share.someone"),
    localStream: voiceState.localScreenStream,
    remotePeers: voiceState.remotePeers,
    fallbackName: t("voice.share.someone"),
  });
  const focusedTile =
    screenTiles.find(
      (tile) => tile.peerId === voiceState.focusedScreenPeerId,
    ) ?? screenTiles[0];
  const screenStream = focusedTile?.stream ?? null;
  const presenterName = focusedTile?.presenterName;
  const splitTwo =
    screenShareStageLayout(screenTiles.length, wide) === "split";

  const layout = stageLayout(
    remotes.length,
    voiceState.screenSharePeerIds.length > 0,
  );
  const anyVideo =
    screenStream !== null ||
    voiceState.localCameraStream !== null ||
    remotes.some((person) => person.stream !== null);

  // --- elapsed timer ------------------------------------------------------
  // Starts when the call genuinely has two ends, not while it is still
  // ringing; survives collapse/expand and navigation via the module map.
  const timerKey = voiceState.peerId
    ? callStartKey(channelId, voiceState.peerId)
    : null;
  const timerRunning =
    voiceState.status === "connected" && remotes.length > 0 && timerKey !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timerRunning || !timerKey) {
      return;
    }
    markCallStarted(timerKey, Date.now());
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timerRunning, timerKey]);
  const startedAt = timerKey ? callStartedAt(timerKey) : null;
  const elapsedLabel =
    timerRunning && startedAt !== null
      ? formatCallDuration(now - startedAt)
      : null;

  const declinedNames = voiceState.callDeclinedUserIds
    .map(
      (userId) =>
        conversation.participants.find((p) => p.id === userId)?.displayName ??
        null,
    )
    .filter((name): name is string => name !== null);

  // --- fullscreen ---------------------------------------------------------
  const stageRef = useRef<HTMLDivElement>(null);
  const primaryVideoRef = useRef<WebkitFullscreenVideo>(null);
  const hasPrimaryVideo =
    screenStream !== null ||
    (layout === "spotlight" && (remotes[0]?.stream ?? null) !== null);
  const fullscreen = useStageFullscreen(
    stageRef,
    primaryVideoRef,
    hasPrimaryVideo,
    voiceState.screenSharePeerIds,
  );
  // Which share, if any, is alone on the stage right now. `soloTile` is null
  // for every call with a single sharer, which is what keeps that path
  // identical to before.
  const soloTile =
    fullscreen.soloPeerId === null
      ? null
      : (screenTiles.find((tile) => tile.peerId === fullscreen.soloPeerId) ??
        null);
  // EVERY share carries its own control, including the only one in the call.
  //
  // This used to be `screenTiles.length > 1`, on the reasoning that a single
  // sharer already has the stage control and a second button would be new
  // chrome. What that left behind is a call where the only way to enlarge
  // somebody's screen is a small icon down in the control bar, and that bar
  // fades to `opacity-0` after three seconds of the pointer resting, which is
  // precisely what a person does while watching a screen share. Reported
  // verbatim as "nem consigo ampliar os compartilhamentos de tela de outros
  // usuarios". The channel stage never had this gap: `screen-share-view.tsx`
  // puts a fullscreen button on every share and answers a double click on the
  // video, and this is the same call in a different room.

  // --- controls fade-on-idle ---------------------------------------------
  // Desktop pointer + video only: on touch there is no "pointer resting", and
  // over avatars there is nothing the bar hides. Reduced motion keeps the bar
  // put — appearing and vanishing chrome is exactly the motion being declined.
  const autoHide = useMemo(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) {
      return false;
    }
    return (
      window.matchMedia("(hover: hover)").matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }, []);
  const [controlsIdle, setControlsIdle] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // --- video quality menu -------------------------------------------------
  // "Requested" rather than "open": the open state is derived, so turning the
  // camera off (or collapsing) takes the menu down with the button it hangs
  // from instead of leaving a popover anchored to nothing.
  const [qualityMenuRequested, setQualityMenuRequested] = useState(false);
  const qualityMenuOpen = videoQualityMenuOpen({
    requested: qualityMenuRequested,
    isCameraOn: voiceState.isCameraOn,
    isSharingScreen: voiceState.isSharingScreen,
    hasIncomingVideo: receivingVideo(voiceState),
    collapsed,
  });
  // Cleared rather than merely ignored: a menu that was open when the camera
  // went off must not spring back open by itself when the camera returns.
  useEffect(() => {
    if (qualityMenuRequested && !qualityMenuOpen) {
      setQualityMenuRequested(false);
    }
  }, [qualityMenuRequested, qualityMenuOpen]);
  const shouldAutoHide = callControlsMayIdle({
    autoHide,
    anyVideo,
    collapsed,
    menuOpen: qualityMenuOpen,
  });
  const wakeControls = useCallback(() => {
    setControlsIdle(false);
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (!shouldAutoHide) {
      return;
    }
    idleTimerRef.current = setTimeout(() => setControlsIdle(true), 3000);
  }, [shouldAutoHide]);
  useEffect(() => {
    if (!shouldAutoHide) {
      setControlsIdle(false);
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    }
    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
    };
  }, [shouldAutoHide]);

  // --- draggable self-preview --------------------------------------------
  const [pipCorner, setPipCorner] = useState<PipCorner>("br");
  const [pipDrag, setPipDrag] = useState<{ x: number; y: number } | null>(null);
  const onPipPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setPipDrag({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  const onPipPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pipDrag) {
      return;
    }
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setPipDrag({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  const onPipPointerUp = () => {
    if (!pipDrag) {
      return;
    }
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect) {
      setPipCorner(nearestCorner(pipDrag.x, pipDrag.y, rect.width, rect.height));
    }
    setPipDrag(null);
  };
  const pipStyle: CSSProperties | undefined = pipDrag
    ? {
        left: pipDrag.x,
        top: pipDrag.y,
        transform: "translate(-50%, -50%)",
      }
    : undefined;

  const statusLine = joining
    ? t("call.panel.connecting")
    : callingOut
      ? t("call.panel.calling")
      : null;

  const controls = (
    <CallControls
      voiceState={voiceState}
      collapsed={collapsed}
      fullscreenAvailable={fullscreen.available}
      isFullscreen={fullscreen.isFullscreen}
      onToggleFullscreen={fullscreen.toggle}
      onToggleMute={onToggleMute}
      onToggleCamera={onToggleCamera}
      videoQuality={videoQuality}
      onVideoQualityChange={onVideoQualityChange}
      onRequestScreenQuality={onRequestScreenQuality}
      qualityMenuOpen={qualityMenuOpen}
      onQualityMenuOpenChange={setQualityMenuRequested}
      onStartScreenShare={onStartScreenShare}
      onStopScreenShare={onStopScreenShare}
      onToggleCollapsed={() => onSetCollapsed(!collapsed)}
      onLeave={onLeave}
    />
  );

  if (collapsed) {
    return (
      <div
        data-testid="call-stage-collapsed"
        className="flex items-center gap-3 border-b border-ink-4/60 bg-ink-2/70 px-3 py-1.5"
      >
        <OccupantFaces
          faces={
            roster.length > 0
              ? roster.map((person) => ({
                  key: person.peerId,
                  displayName: person.displayName,
                  avatarUrl: person.avatarUrl,
                }))
              : remotes.map((person) => ({
                  key: person.key,
                  displayName: person.name,
                  avatarUrl: person.avatarUrl,
                }))
          }
        />
        <p className="min-w-0 flex-1 truncate text-xs text-paper-muted" role="status">
          {statusLine ?? conversationTitle(conversation.participants)}
          {elapsedLabel && (
            <span className="ml-2 tabular-nums" aria-label={t("call.stage.duration")}>
              {elapsedLabel}
            </span>
          )}
        </p>
        {controls}
      </div>
    );
  }

  return (
    <div
      ref={stageRef}
      data-testid="call-stage"
      className={cn(
        "relative shrink-0 overflow-hidden border-b border-ink-4/60 bg-ink",
        fullscreen.isFullscreen
          ? fullscreen.mode === "element"
            ? "h-full max-h-none"
            : // In-page fullscreen. `fixed inset-0` rather than a viewport
              // height unit because on an iPhone those overshoot the visible
              // area and hide the exit control under Safari's toolbar, which
              // is how somebody gets stuck in a fullscreen they cannot leave.
              "fixed inset-0 z-50 h-auto max-h-none"
          : anyVideo
            ? "h-[68svh] min-h-[280px]"
            : "h-[38svh] max-h-[420px] min-h-[220px]",
      )}
      onPointerMove={shouldAutoHide ? wakeControls : undefined}
      onFocusCapture={shouldAutoHide ? wakeControls : undefined}
    >
      {/* --- the stage's content, by layout --------------------------------- */}
      {layout === "screen" ? (
        <div className="flex h-full w-full flex-col bg-black">
          {soloTile ? (
            /* One share blown up on its own. The stage is already fullscreen;
               this only decides what is on it, which is why switching between
               the two shares costs no platform call. */
            <ScreenTileFrame
              tile={soloTile}
              videoRef={primaryVideoRef}
              isFullscreen
              showName
              onToggleFullscreen={() => fullscreen.toggleScreen(soloTile.peerId)}
              className="min-h-0 flex-1"
            />
          ) : splitTwo ? (
            <div className="grid min-h-0 flex-1 grid-cols-2">
              {screenTiles.map((tile, index) => (
                <ScreenTileFrame
                  key={tile.peerId}
                  tile={tile}
                  videoRef={index === 0 ? primaryVideoRef : undefined}
                  isFullscreen={false}
                  showName
                  onToggleFullscreen={() => fullscreen.toggleScreen(tile.peerId)}
                  className="h-full min-h-0"
                />
              ))}
            </div>
          ) : focusedTile ? (
            <ScreenTileFrame
              tile={focusedTile}
              videoRef={primaryVideoRef}
              isFullscreen={false}
              onToggleFullscreen={() =>
                fullscreen.toggleScreen(focusedTile.peerId)
              }
              className="min-h-0 flex-1"
            />
          ) : (
            <StageVideo
              stream={screenStream}
              videoRef={primaryVideoRef}
              className="min-h-0 flex-1 object-contain"
            />
          )}
          {/* The switcher. Kept while one share is blown up so the other one is
              still reachable: swapping which screen is alone on the stage is
              pure state, so it happens without leaving fullscreen at all. */}
          {screenTiles.length > 1 && (soloTile !== null || !splitTwo) && (
            <div className="flex shrink-0 gap-1 overflow-x-auto p-1">
              {screenTiles.map((tile) => {
                const selected =
                  tile.peerId ===
                  (soloTile ? soloTile.peerId : focusedTile?.peerId);
                return (
                  <button
                    key={tile.peerId}
                    type="button"
                    className={cn(
                      "truncate rounded-md px-2 py-1 text-[11px]",
                      selected
                        ? "bg-signal/20 text-signal"
                        : "bg-ink-3 text-paper-muted",
                    )}
                    aria-pressed={selected}
                    onClick={() => {
                      onFocusScreenShare?.(tile.peerId);
                      if (soloTile && tile.peerId !== soloTile.peerId) {
                        fullscreen.toggleScreen(tile.peerId);
                      }
                    }}
                  >
                    {tile.isSelf
                      ? t("voice.share.youPresenting")
                      : tile.presenterName}
                  </button>
                );
              })}
            </div>
          )}
          {/* Everyone in the call, small, over the screen's top edge. */}
          <div className="pointer-events-none absolute right-3 top-3 flex max-h-[40%] flex-col gap-2 overflow-hidden">
            {[...(self ? [self] : []), ...remotes].map((person) => (
              <MiniTile key={person.key} person={person} youLabel={t("voice.tile.you")} />
            ))}
          </div>
        </div>
      ) : layout === "grid" ? (
        <ul
          className="grid h-full w-full gap-2 p-2"
          style={{
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(45%, 16rem), 1fr))",
          }}
        >
          {[...(self ? [self] : []), ...remotes].map((person) => (
            <GridTile key={person.key} person={person} youLabel={t("voice.tile.you")} />
          ))}
        </ul>
      ) : layout === "spotlight" ? (
        <PrimaryTile person={remotes[0]!} videoRef={primaryVideoRef} />
      ) : (
        /* ring: calling out (or everyone left) — one large pulsing identity. */
        <RingView
          conversation={conversation}
          joining={joining}
          label={statusLine ?? t("call.panel.calling")}
        />
      )}

      {/* Self-preview: floats over spotlight and ring layouts; the grid and the
          screen rail already carry a self tile. */}
      {(layout === "spotlight" || layout === "ring") && self && (
        <div
          data-call-tile={self.name}
          role="group"
          aria-label={t("call.stage.selfPreview")}
          className={cn(
            "absolute z-10 w-28 touch-none overflow-hidden rounded-lg bg-ink-3 shadow-lg ring-1 ring-ink-4/80 sm:w-40",
            pipDrag ? "cursor-grabbing" : "cursor-grab",
            !pipDrag && PIP_CORNER_CLASS[pipCorner],
          )}
          style={pipStyle}
          onPointerDown={onPipPointerDown}
          onPointerMove={onPipPointerMove}
          onPointerUp={onPipPointerUp}
          onPointerCancel={onPipPointerUp}
        >
          <div className="relative aspect-video w-full">
            {self.stream ? (
              <StageVideo
                stream={self.stream}
                mirrored
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <VoiceAvatar
                  name={self.name}
                  avatarUrl={self.avatarUrl}
                  isSpeaking={self.speaking}
                  muted={self.muted}
                  size="md"
                />
              </div>
            )}
            <TileBadge name={t("voice.tile.you")} muted={self.muted} />
          </div>
        </div>
      )}

      {/* --- overlays -------------------------------------------------------- */}
      {voiceState.error && (
        <p className="absolute inset-x-0 top-0 z-20 bg-danger/15 px-3 py-1.5 text-center text-xs text-danger">
          {voiceState.error}
        </p>
      )}

      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 bg-gradient-to-b from-ink/70 to-transparent px-3 py-2 transition-opacity duration-300 motion-reduce:transition-none",
          controlsIdle && "opacity-0",
          voiceState.error && "mt-7",
        )}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-paper">
            {conversationTitle(conversation.participants)}
          </p>
          <p className="truncate text-xs text-paper-muted" role="status">
            {/* The ring layout already announces "Calling…"/"Connecting…" at
                centre stage — saying it twice reads like two calls. */}
            {layout === "ring"
              ? null
              : (statusLine ??
                t("call.panel.inCall", { count: remotes.length + 1 }))}
            {declinedNames.map((name) => (
              <span key={name} className="ml-2 text-warning">
                {t("call.panel.declined", { name })}
              </span>
            ))}
            {presenterName && screenStream && (
              <span className="ml-2 text-signal">
                {voiceState.isSharingScreen
                  ? t("voice.share.youPresenting")
                  : t("voice.share.peerPresenting", { name: presenterName })}
                {/* Only about our own share: whether someone else's carries
                    sound is their business, and we would only be guessing. */}
                {voiceState.isSharingScreen &&
                  !voiceState.isSharingScreenAudio && (
                    <span className="ml-1 text-paper-muted">
                      ({t("voice.share.noAudioShort")})
                    </span>
                  )}
              </span>
            )}
          </p>
        </div>
        {elapsedLabel && (
          <span
            className="shrink-0 rounded bg-ink/60 px-1.5 py-0.5 text-xs tabular-nums text-paper-muted"
            aria-label={t("call.stage.duration")}
          >
            {elapsedLabel}
          </span>
        )}
      </div>

      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-ink/80 to-transparent px-3 pb-3 pt-8 transition-opacity duration-300 motion-reduce:transition-none",
          controlsIdle && "pointer-events-none opacity-0",
        )}
      >
        {controls}
      </div>
    </div>
  );
}

/**
 * Whether somebody else's video has actually arrived.
 *
 * Off the peers rather than off `screenSharePeerIds`, which is the roster's
 * *claim* and also counts this machine's own share. What decides whether the
 * quality control has anything to report to a watcher is whether a stream is
 * really there.
 */
function receivingVideo(voiceState: VoiceState): boolean {
  return voiceState.remotePeers.some(
    (peer) => peer.cameraStream !== null || peer.screenStream !== null,
  );
}

function CallControls({
  voiceState,
  collapsed,
  fullscreenAvailable,
  isFullscreen,
  onToggleFullscreen,
  onToggleMute,
  onToggleCamera,
  videoQuality,
  onVideoQualityChange,
  onRequestScreenQuality,
  qualityMenuOpen,
  onQualityMenuOpenChange,
  onStartScreenShare,
  onStopScreenShare,
  onToggleCollapsed,
  onLeave,
}: {
  voiceState: VoiceState;
  collapsed: boolean;
  fullscreenAvailable: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  videoQuality: VideoQuality;
  onVideoQualityChange: (quality: VideoQuality) => void;
  /** Ask one presenter for a size, or withdraw with `auto`. Per-peer. */
  onRequestScreenQuality?: (peerId: string, quality: VideoQuality) => void;
  qualityMenuOpen: boolean;
  onQualityMenuOpenChange: (open: boolean) => void;
  onStartScreenShare?: () => void;
  onStopScreenShare?: () => void;
  onToggleCollapsed: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  // Probed once per mount — whether the browser has getDisplayMedia never
  // changes mid-session. Same probe the channel voice panel uses.
  const canShare = useMemo(() => supportsScreenShare(), []);
  const shareAtCap = isScreenShareAtCap(
    voiceState.screenSharePeerIds,
    voiceState.peerId,
    voiceState.roomTransport,
  );
  const shareLimit = SCREEN_SHARE_LIMIT[voiceState.roomTransport ?? "mesh"];
  const size = collapsed ? "h-8 w-8" : "h-10 w-10";
  const iconSize = collapsed ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <div
      className={cn(
        "flex items-center",
        collapsed ? "gap-1" : "gap-2 rounded-full bg-ink-2/90 px-2.5 py-1.5 shadow-lg ring-1 ring-ink-4/60 backdrop-blur",
      )}
    >
      <button
        type="button"
        title={voiceState.isMuted ? t("call.panel.unmute") : t("call.panel.mute")}
        aria-label={
          voiceState.isMuted ? t("call.panel.unmute") : t("call.panel.mute")
        }
        aria-pressed={voiceState.isMuted}
        className={cn(
          "flex items-center justify-center rounded-full",
          size,
          voiceState.isMuted
            ? "bg-danger/20 text-danger"
            : "bg-ink-3 text-paper hover:bg-ink-4",
        )}
        onClick={onToggleMute}
      >
        {voiceState.isMuted ? (
          <MicOff className={iconSize} />
        ) : (
          <Mic className={iconSize} />
        )}
      </button>
      <button
        type="button"
        title={
          voiceState.isCameraOn
            ? t("call.panel.cameraOn")
            : t("call.panel.cameraOff")
        }
        aria-label={
          voiceState.isCameraOn
            ? t("call.panel.cameraOn")
            : t("call.panel.cameraOff")
        }
        aria-pressed={voiceState.isCameraOn}
        className={cn(
          "flex items-center justify-center rounded-full",
          size,
          voiceState.isCameraOn
            ? "bg-signal/20 text-signal"
            : "bg-ink-3 text-paper hover:bg-ink-4",
        )}
        onClick={onToggleCamera}
      >
        {voiceState.isCameraOn ? (
          <Video className={iconSize} />
        ) : (
          <VideoOff className={iconSize} />
        )}
      </button>
      {/* Video, in whichever direction this call has any, immediately to the
          right of the camera. Absent on an audio-only call, so that bar is the
          bar it has always been. Sending shows the sizes; watching shows what
          is arriving and whose choice it was, which is the whole of what a
          viewer can truthfully be told. */}
      {showsVideoQualityControl({
        isCameraOn: voiceState.isCameraOn,
        isSharingScreen: voiceState.isSharingScreen,
        hasIncomingVideo: receivingVideo(voiceState),
        collapsed,
      }) && (
        <VideoQualityMenu
          value={videoQuality}
          open={qualityMenuOpen}
          onOpenChange={onQualityMenuOpenChange}
          onChange={onVideoQualityChange}
          isSendingVideo={voiceState.isCameraOn || voiceState.isSharingScreen}
          presenters={presentersToAsk(voiceState.remotePeers)}
          requestsOfUs={requestsOfUs(voiceState.remotePeers)}
          onRequestQuality={
            onRequestScreenQuality
              ? (quality) => {
                  for (const presenter of presentersToAsk(
                    voiceState.remotePeers,
                  )) {
                    onRequestScreenQuality(presenter.peerId, quality);
                  }
                }
              : undefined
          }
          buttonClassName={size}
          iconClassName={iconSize}
        />
      )}
      {!collapsed && canShare && (onStartScreenShare || onStopScreenShare) && (
        <button
          type="button"
          title={
            shareAtCap && !voiceState.isSharingScreen
              ? t("voice.control.shareLimit", { limit: shareLimit })
              : voiceState.isSharingScreen
                ? t("voice.control.stopShare")
                : t("voice.control.share")
          }
          aria-label={
            voiceState.isSharingScreen
              ? t("voice.control.stopShare")
              : t("voice.control.share")
          }
          aria-pressed={voiceState.isSharingScreen}
          disabled={shareAtCap && !voiceState.isSharingScreen}
          className={cn(
            "flex items-center justify-center rounded-full disabled:opacity-40",
            size,
            voiceState.isSharingScreen
              ? "bg-signal/20 text-signal"
              : "bg-ink-3 text-paper hover:bg-ink-4",
          )}
          onClick={
            voiceState.isSharingScreen ? onStopScreenShare : onStartScreenShare
          }
        >
          {voiceState.isSharingScreen ? (
            <ScreenShareOff className={iconSize} />
          ) : (
            <ScreenShare className={iconSize} />
          )}
        </button>
      )}
      {!collapsed && fullscreenAvailable && (
        <button
          type="button"
          title={
            isFullscreen
              ? t("voice.share.exitFullscreen")
              : t("voice.share.fullscreen")
          }
          aria-label={
            isFullscreen
              ? t("voice.share.exitFullscreen")
              : t("voice.share.fullscreen")
          }
          aria-pressed={isFullscreen}
          className={cn(
            "flex items-center justify-center rounded-full bg-ink-3 text-paper hover:bg-ink-4",
            size,
          )}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? (
            <Minimize2 className={iconSize} />
          ) : (
            <Maximize2 className={iconSize} />
          )}
        </button>
      )}
      <button
        type="button"
        title={collapsed ? t("call.stage.expand") : t("call.stage.collapse")}
        aria-label={collapsed ? t("call.stage.expand") : t("call.stage.collapse")}
        aria-expanded={!collapsed}
        className={cn(
          "flex items-center justify-center rounded-full bg-ink-3 text-paper hover:bg-ink-4",
          size,
        )}
        onClick={onToggleCollapsed}
      >
        {collapsed ? (
          <ChevronDown className={iconSize} />
        ) : (
          <ChevronUp className={iconSize} />
        )}
      </button>
      <span
        aria-hidden="true"
        className={cn("mx-0.5 w-px self-stretch bg-ink-4/70", collapsed ? "my-1" : "my-1.5")}
      />
      <button
        type="button"
        title={t("call.panel.leave")}
        aria-label={t("call.panel.leave")}
        className={cn(
          "flex items-center justify-center rounded-full bg-danger/90 text-paper hover:bg-danger",
          collapsed ? size : "h-10 w-14",
        )}
        onClick={onLeave}
      >
        <PhoneOff className={iconSize} />
      </button>
    </div>
  );
}

/** The 1:1 stage: one remote person, as large as the stage itself. */
function PrimaryTile({
  person,
  videoRef,
}: {
  person: StagePerson;
  videoRef: RefObject<WebkitFullscreenVideo | null>;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-call-tile={person.name}
      className={cn(
        "relative h-full w-full bg-ink-2",
        person.speaking && "ring-2 ring-inset ring-success",
      )}
    >
      {person.stream ? (
        <StageVideo
          stream={person.stream}
          videoRef={videoRef}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3">
          <StageAvatar person={person} large />
          <p className="max-w-full truncate px-4 text-base font-semibold text-paper">
            {person.name}
          </p>
        </div>
      )}
      <TileBadge
        name={person.name}
        muted={person.muted}
        connecting={person.connecting}
        connectingLabel={t("voice.tile.connecting")}
        prominent
      />
    </div>
  );
}

/** One cell of the group grid. */
function GridTile({
  person,
  youLabel,
}: {
  person: StagePerson;
  youLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <li
      data-call-tile={person.name}
      className={cn(
        "relative min-h-0 overflow-hidden rounded-xl bg-ink-2",
        person.speaking && "ring-2 ring-success",
        person.connecting && "opacity-70",
      )}
    >
      {person.stream ? (
        <StageVideo
          stream={person.stream}
          mirrored={person.isSelf}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <StageAvatar person={person} />
        </div>
      )}
      <TileBadge
        name={person.isSelf ? youLabel : person.name}
        muted={person.muted}
        connecting={person.connecting}
        connectingLabel={t("voice.tile.connecting")}
      />
    </li>
  );
}

/** A thumbnail on the screen-share rail. */
function MiniTile({
  person,
  youLabel,
}: {
  person: StagePerson;
  youLabel: string;
}) {
  return (
    <div
      data-call-tile={person.name}
      className={cn(
        "relative w-24 shrink-0 overflow-hidden rounded-md bg-ink-2/90 sm:w-32",
        person.speaking && "ring-2 ring-success",
      )}
    >
      <div className="relative aspect-video w-full">
        {person.stream ? (
          <StageVideo
            stream={person.stream}
            mirrored={person.isSelf}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <VoiceAvatar
              name={person.name}
              avatarUrl={person.avatarUrl}
              isSpeaking={person.speaking}
              muted={person.muted}
              size="md"
            />
          </div>
        )}
        <TileBadge
          name={person.isSelf ? youLabel : person.name}
          muted={person.muted}
        />
      </div>
    </div>
  );
}

/**
 * "Calling…": the people being rung, large, with a pulse that respects
 * `prefers-reduced-motion` (the ring simply holds still).
 */
function RingView({
  conversation,
  joining,
  label,
}: {
  conversation: DmSummary;
  joining: boolean;
  label: string;
}) {
  const shown = conversation.participants.slice(0, 3);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
      <div className="flex -space-x-4">
        {shown.map((person) => (
          <span key={person.id} className="relative inline-flex">
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-ping rounded-full bg-success/30 motion-reduce:animate-none"
            />
            <UserAvatar
              name={person.displayName}
              avatarUrl={person.avatarUrl}
              rounded="full"
              className="relative h-20 w-20 ring-2 ring-ink-2 sm:h-24 sm:w-24"
              fallbackClassName="bg-ink-4 text-2xl text-paper"
            />
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm text-paper-muted">
        {joining && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        <span>{label}</span>
      </div>
    </div>
  );
}

function StageAvatar({
  person,
  large = false,
}: {
  person: StagePerson;
  large?: boolean;
}) {
  return (
    <div className={cn(large ? "scale-150" : undefined)}>
      <VoiceAvatar
        name={person.name}
        avatarUrl={person.avatarUrl}
        isSpeaking={person.speaking}
        muted={person.muted}
        size="xl"
      />
    </div>
  );
}

/** Name + mute strip along a tile's bottom edge — the voice panel's language. */
function TileBadge({
  name,
  muted,
  connecting = false,
  connectingLabel,
  prominent = false,
}: {
  name: string;
  muted: boolean;
  connecting?: boolean;
  connectingLabel?: string;
  prominent?: boolean;
}) {
  return (
    <span
      className={cn(
        "absolute bottom-0 left-0 z-10 flex max-w-full items-center gap-1 truncate rounded-tr-md bg-ink/70 text-paper",
        prominent ? "px-2 py-1 text-xs" : "px-1.5 py-0.5 text-[10px]",
      )}
    >
      {muted && <MicOff className="h-3 w-3 shrink-0 text-danger" />}
      <span className="truncate">{name}</span>
      {connecting && connectingLabel && (
        <span className="flex items-center gap-1 text-paper-muted">
          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {connectingLabel}
        </span>
      )}
    </span>
  );
}

/** Small overlapped avatar row for the banner states. */
function OccupantFaces({
  faces,
}: {
  faces: { key: string; displayName: string; avatarUrl: string | null }[];
}) {
  return (
    <span className="flex shrink-0 -space-x-2" aria-hidden="true">
      {faces.slice(0, 3).map((person) => (
        <UserAvatar
          key={person.key}
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          rounded="full"
          className="h-6 w-6 ring-2 ring-ink-2"
          fallbackClassName="bg-ink-4 text-[10px] text-paper"
        />
      ))}
    </span>
  );
}

/**
 * A `<video>` bound to a MediaStream. Always muted: call audio already plays
 * through `VoiceAudioSinks` at the app root, and playing it here too would
 * double every voice.
 */
/**
 * One shared screen with its own fullscreen control.
 *
 * The control is per *screen*, not per stage: pressing it puts this share
 * alone on the stage instead of blowing up the two-up grid, which is the bug
 * this component exists to fix.
 *
 * A double click on the video does the same thing, which is the gesture people
 * reach for first and the one the channel stage has always answered
 * (`screen-share-view.tsx`). It sits on the <video> rather than on the frame so
 * that double clicking the button itself is not counted twice.
 */
function ScreenTileFrame({
  tile,
  videoRef,
  isFullscreen,
  showName = false,
  onToggleFullscreen,
  className,
}: {
  tile: ScreenShareTile;
  videoRef?: RefObject<WebkitFullscreenVideo | null>;
  isFullscreen: boolean;
  showName?: boolean;
  onToggleFullscreen?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = isFullscreen
    ? t("voice.share.exitFullscreen")
    : tile.isSelf
      ? // Naming yourself in your own button reads like somebody else's screen.
        t("voice.share.fullscreen")
      : t("voice.share.fullscreenPeer", { name: tile.presenterName });
  return (
    <div className={cn("relative", className)}>
      <StageVideo
        stream={tile.stream}
        videoRef={videoRef}
        onDoubleClick={onToggleFullscreen}
        className="h-full w-full object-contain"
      />
      {/* Top *left*: the stage already floats everyone's camera tiles at the
          top right, and on a split stage the right-hand share sits underneath
          them. */}
      <div className="absolute left-2 top-2 flex max-w-[80%] items-center gap-1.5">
        {onToggleFullscreen && (
          <button
            type="button"
            // The control bar carries a fullscreen button too, so the label
            // alone cannot tell a test which one it pressed.
            data-testid="share-fullscreen"
            title={label}
            aria-label={label}
            aria-pressed={isFullscreen}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink/70 text-paper hover:bg-ink-4"
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {showName && (
          <span className="pointer-events-none truncate rounded bg-ink/70 px-1.5 py-0.5 text-[11px] text-paper-muted">
            {tile.isSelf ? t("voice.share.youPresenting") : tile.presenterName}
          </span>
        )}
      </div>
    </div>
  );
}

function StageVideo({
  stream,
  mirrored = false,
  className,
  videoRef,
  onDoubleClick,
}: {
  stream: MediaStream | null;
  mirrored?: boolean;
  className?: string;
  videoRef?: RefObject<WebkitFullscreenVideo | null>;
  /** Only shares pass this; a camera tile has nothing to enlarge. */
  onDoubleClick?: () => void;
}) {
  const ownRef = useRef<HTMLVideoElement>(null);
  const ref = (videoRef ?? ownRef) as RefObject<HTMLVideoElement | null>;
  useEffect(() => {
    const video = ref.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [ref, stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      onDoubleClick={onDoubleClick}
      className={cn(className, mirrored && "-scale-x-100")}
    />
  );
}
