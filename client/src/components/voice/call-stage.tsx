import {
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorSpeaker,
  PhoneOff,
  Pin,
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
import { SCREEN_SHARE_LIMIT, MESH_VOICE_WARNING } from "@pqp/shared";
import type { VoiceInputMode, VoiceState } from "@/hooks/use-voice";
import type { VideoQuality } from "@/lib/video-quality";
import { shareStreamHasAudio } from "@/lib/screen-capture-audio";
import {
  canShareScreenAudio,
  detectFullscreenMode,
  screenShareUnavailableMessage,
  supportsScreenShare,
  type FullscreenMode,
} from "@/components/voice/capabilities";
import { attemptElementFullscreen } from "@/components/voice/element-fullscreen";
import { Tooltip } from "@/components/ui/tooltip";
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
  showsVideoQualityControl,
  videoQualityMenuOpen,
} from "@/components/voice/video-quality-control";
import { VideoQualityMenu } from "@/components/voice/video-quality-menu";
import { VoiceAvatar } from "@/components/voice/voice-avatar";
import { UserAvatar } from "@/components/user/user-avatar";
import { useLgUp } from "@/hooks/use-lg-up";
import { isScreenShareAtCap } from "@/lib/screen-share-roster";
import { useTranslation, type MessageKey, type MessageVars } from "@/lib/i18n";
import { PeerTileControls } from "@/components/voice/peer-tile-controls";
import { startSoundLoop, stopSoundLoop } from "@/lib/sounds";
import {
  requestConnectionCheck,
  requestSettingsSection,
} from "@/lib/settings-request";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  callStartKey,
  callStartedAt,
  cameraSoloId,
  formatCallDuration,
  hasWatchableVideo,
  isCameraSoloId,
  isStageCollapsed,
  isStageGrid,
  markCallStarted,
  nearestCorner,
  personKeyFromCameraSoloId,
  pickSpotlightKey,
  rememberStageCollapsed,
  rememberStageGrid,
  rememberStagePinnedKey,
  resolvedStageLayout,
  shouldShowExpandedStage,
  stagePinnedKey,
  type PipCorner,
} from "@/components/dm/call-stage-state";

/**
 * The live-call stage shared by conversation calls and server voice channels.
 *
 * A picture owns the room; voice-only occupancy does not. The stage is a slim
 * bar until a camera or a screen share is on, then it expands unless the user
 * tucked it away for the session.
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
  /** Mesh/SFU connection failed. Remote tiles offer Retry. */
  failed?: boolean;
  isSelf: boolean;
  /** userId (preferred) or peerId, for the playback volume map. */
  volumeKey?: string;
  volume?: number;
  onSetVolume?: (volume: number) => void;
  onRetry?: () => void;
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

export interface CallStagePerson {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CallStageProps {
  channelId: string;
  title: string;
  currentUser: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  voiceState: VoiceState;
  videoQuality: VideoQuality;
  /** Faces shown while ringing out. Server voice omits this. */
  ringFaces?: CallStagePerson[];
  declinedNames?: string[];
  playOutgoingRingtone?: boolean;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  onStartScreenShare?: () => void;
  /**
   * Start the same share with no sound at all. Offered only after sound is
   * what killed the last attempt, and separate from `onStartScreenShare`
   * because it must also disarm the toggle: the tick is what failed.
   */
  onShareWithoutSound?: () => void;
  onStopScreenShare?: () => void;
  shareSystemAudio?: boolean;
  onShareSystemAudioChange?: (next: boolean) => void;
  onFocusScreenShare?: (peerId: string) => void;
  inputMode?: VoiceInputMode;
  pushToTalkKeyLabel?: string | null;
  windowFocused?: boolean;
  onPushToTalk?: (held: boolean) => void;
  onSetPeerVolume?: (peerId: string, volume: number) => void;
  onRetryPeer?: (peerId: string) => void;
  /** Shrinks the thumbnail strip. Same setting the old lobby grid used. */
  compactPeers?: boolean;
  /**
   * Conversation calls fade the chrome after a few idle seconds of video.
   * Server voice does not: the quality menu and share live here.
   */
  controlsMayIdle?: boolean;
  /**
   * DM ringing copy. Server voice does not ring: being the only person in a
   * Lobby is occupancy, not an outgoing call.
   */
  ringWhenAlone?: boolean;
}

export function CallStage({
  channelId,
  title,
  currentUser,
  voiceState,
  videoQuality,
  ringFaces = [],
  declinedNames = [],
  playOutgoingRingtone = false,
  onLeave,
  onToggleMute,
  onToggleCamera,
  onVideoQualityChange,
  onStartScreenShare,
  onShareWithoutSound,
  onStopScreenShare,
  shareSystemAudio = false,
  onShareSystemAudioChange,
  onFocusScreenShare,
  inputMode = "voice-activity",
  pushToTalkKeyLabel = null,
  windowFocused = true,
  onPushToTalk,
  onSetPeerVolume,
  onRetryPeer,
  compactPeers = false,
  controlsMayIdle = true,
  ringWhenAlone = true,
}: CallStageProps) {
  const [userCollapsed, setUserCollapsed] = useState(() =>
    isStageCollapsed(channelId),
  );
  useEffect(() => {
    setUserCollapsed(isStageCollapsed(channelId));
  }, [channelId]);

  const hasVideo = hasWatchableVideo({
    localCameraOn:
      voiceState.isCameraOn || voiceState.localCameraStream !== null,
    remoteHasCamera: voiceState.remotePeers.some(
      (peer) => peer.cameraStream !== null,
    ),
    screenShareCount: voiceState.screenSharePeerIds.length,
  });

  return (
    <ActiveCall
      channelId={channelId}
      title={title}
      currentUser={currentUser}
      voiceState={voiceState}
      videoQuality={videoQuality}
      ringFaces={ringFaces}
      declinedNames={declinedNames}
      playOutgoingRingtone={playOutgoingRingtone}
      hasVideo={hasVideo}
      userCollapsed={userCollapsed}
      onSetCollapsed={(next) => {
        setUserCollapsed(next);
        rememberStageCollapsed(channelId, next);
      }}
      onLeave={onLeave}
      onToggleMute={onToggleMute}
      onToggleCamera={onToggleCamera}
      onVideoQualityChange={onVideoQualityChange}
      onStartScreenShare={onStartScreenShare}
      onShareWithoutSound={onShareWithoutSound}
      shareSystemAudio={shareSystemAudio}
      onShareSystemAudioChange={onShareSystemAudioChange}
      onStopScreenShare={onStopScreenShare}
      onFocusScreenShare={onFocusScreenShare}
      inputMode={inputMode}
      pushToTalkKeyLabel={pushToTalkKeyLabel}
      windowFocused={windowFocused}
      onPushToTalk={onPushToTalk}
      onSetPeerVolume={onSetPeerVolume}
      onRetryPeer={onRetryPeer}
      compactPeers={compactPeers}
      controlsMayIdle={controlsMayIdle}
      ringWhenAlone={ringWhenAlone}
    />
  );
}

function ActiveCall({
  channelId,
  title,
  currentUser,
  voiceState,
  videoQuality,
  ringFaces,
  declinedNames,
  playOutgoingRingtone,
  hasVideo,
  userCollapsed,
  onSetCollapsed,
  onLeave,
  onToggleMute,
  onToggleCamera,
  onVideoQualityChange,
  onStartScreenShare,
  onShareWithoutSound,
  onStopScreenShare,
  shareSystemAudio = false,
  onShareSystemAudioChange,
  onFocusScreenShare,
  inputMode = "voice-activity",
  pushToTalkKeyLabel = null,
  windowFocused = true,
  onPushToTalk,
  onSetPeerVolume,
  onRetryPeer,
  compactPeers = false,
  controlsMayIdle = true,
  ringWhenAlone = true,
}: {
  channelId: string;
  title: string;
  currentUser: CallStageProps["currentUser"];
  voiceState: VoiceState;
  videoQuality: VideoQuality;
  ringFaces: CallStagePerson[];
  declinedNames: string[];
  playOutgoingRingtone: boolean;
  hasVideo: boolean;
  userCollapsed: boolean;
  onSetCollapsed: (collapsed: boolean) => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  onStartScreenShare?: () => void;
  /**
   * Start the same share with no sound at all. Offered only after sound is
   * what killed the last attempt, and separate from `onStartScreenShare`
   * because it must also disarm the toggle: the tick is what failed.
   */
  onShareWithoutSound?: () => void;
  shareSystemAudio?: boolean;
  onShareSystemAudioChange?: (next: boolean) => void;
  onStopScreenShare?: () => void;
  onFocusScreenShare?: (peerId: string) => void;
  inputMode?: VoiceInputMode;
  pushToTalkKeyLabel?: string | null;
  windowFocused?: boolean;
  onPushToTalk?: (held: boolean) => void;
  onSetPeerVolume?: (peerId: string, volume: number) => void;
  onRetryPeer?: (peerId: string) => void;
  compactPeers?: boolean;
  controlsMayIdle?: boolean;
  ringWhenAlone?: boolean;
}) {
  const { t } = useTranslation();
  const wide = useLgUp();
  const joining = voiceState.status === "joining";
  // "Calling…" is a DM we started that nobody has picked up. Alone in a
  // server Lobby is occupancy, not an outgoing ring.
  const callingOut =
    ringWhenAlone &&
    voiceState.status === "connected" &&
    voiceState.remotePeers.length === 0;
  const ringing = callingOut || (joining && ringWhenAlone);
  const collapsed = !shouldShowExpandedStage(hasVideo, userCollapsed, ringing);
  useEffect(() => {
    if (playOutgoingRingtone && callingOut) {
      startSoundLoop("outgoingCall");
    } else {
      stopSoundLoop("outgoingCall");
    }
    return () => stopSoundLoop("outgoingCall");
  }, [callingOut, playOutgoingRingtone]);
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
  const remotes: StagePerson[] = voiceState.remotePeers.map((peer) => {
    const volumeKey = peer.userId ?? peer.peerId;
    const failed = peer.connectionState === "failed";
    return {
      key: peer.peerId,
      name: peer.displayName ?? t("voice.share.someone"),
      avatarUrl: peer.avatarUrl ?? null,
      stream: peer.cameraStream,
      speaking: speaking.has(peer.peerId),
      muted: rosterByPeerId.get(peer.peerId)?.muted ?? false,
      connecting: peer.connectionState !== "connected",
      failed,
      isSelf: false,
      volumeKey,
      volume: voiceState.peerVolumes[volumeKey] ?? 1,
      onSetVolume: onSetPeerVolume
        ? (volume: number) => onSetPeerVolume(volumeKey, volume)
        : undefined,
      onRetry:
        failed && onRetryPeer ? () => onRetryPeer(peer.peerId) : undefined,
    };
  });

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
  // Whose tile is on the big slot, which is not the same question as "am I
  // sharing": a presenter watching somebody else's share was being told they
  // were the one presenting.
  const focusedIsLocal =
    focusedTile != null && focusedTile.peerId === voiceState.peerId;
  const receivedShareHasAudio = useReceivedShareAudio(
    focusedIsLocal ? null : screenStream,
  );
  const focusedShareHasAudio = focusedIsLocal
    ? voiceState.isSharingScreenAudio
    : receivedShareHasAudio;
  const splitTwo =
    screenShareStageLayout(screenTiles.length, wide) === "split";

  const allPeople: StagePerson[] = [...(self ? [self] : []), ...remotes];
  const cameraCount = allPeople.filter((person) => person.stream !== null).length;
  const [preferGrid, setPreferGrid] = useState(() => isStageGrid(channelId));
  const [pinnedKey, setPinnedKey] = useState(() => stagePinnedKey(channelId));
  useEffect(() => {
    setPreferGrid(isStageGrid(channelId));
    setPinnedKey(stagePinnedKey(channelId));
  }, [channelId]);
  const layout = resolvedStageLayout({
    remoteCount: remotes.length,
    hasScreenShare: voiceState.screenSharePeerIds.length > 0,
    cameraCount,
    preferGrid,
  });
  const spotlightKey = pickSpotlightKey(allPeople, pinnedKey);
  const spotlightPerson =
    allPeople.find((person) => person.key === spotlightKey) ?? remotes[0] ?? self;
  const stripPeople = allPeople.filter(
    (person) => person.key !== spotlightPerson?.key,
  );
  const anyVideo = hasVideo;

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

  // --- fullscreen ---------------------------------------------------------
  const stageRef = useRef<HTMLDivElement>(null);
  const primaryVideoRef = useRef<WebkitFullscreenVideo>(null);
  const hasPrimaryVideo =
    screenStream !== null ||
    (layout === "spotlight" && (spotlightPerson?.stream ?? null) !== null) ||
    (layout === "ring" && (self?.stream ?? null) !== null);
  const cameraSoloIds = allPeople
    .filter((person) => person.stream !== null)
    .map((person) => cameraSoloId(person.key));
  const fullscreen = useStageFullscreen(
    stageRef,
    primaryVideoRef,
    hasPrimaryVideo,
    [...voiceState.screenSharePeerIds, ...cameraSoloIds],
  );
  const soloTile =
    fullscreen.soloPeerId === null || isCameraSoloId(fullscreen.soloPeerId)
      ? null
      : (screenTiles.find((tile) => tile.peerId === fullscreen.soloPeerId) ??
        null);
  const soloPersonKey = fullscreen.soloPeerId
    ? personKeyFromCameraSoloId(fullscreen.soloPeerId)
    : null;
  const soloPerson = soloPersonKey
    ? (allPeople.find((person) => person.key === soloPersonKey) ?? null)
    : null;
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
    autoHide: autoHide && controlsMayIdle,
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

  const pushToTalk = inputMode === "push-to-talk";
  const pushToTalkBlocked = voiceState.isMuted || voiceState.isDeafened;
  const showMeshWarning =
    !voiceState.usingSfu && voiceState.remotePeers.length >= MESH_VOICE_WARNING;

  const togglePin = (key: string) => {
    const next = pinnedKey === key ? null : key;
    setPinnedKey(next);
    rememberStagePinnedKey(channelId, next);
  };
  const toggleCameraFullscreen = (key: string) => {
    fullscreen.toggleScreen(cameraSoloId(key));
  };

  const controls = (
    <CallControls
      voiceState={voiceState}
      collapsed={collapsed}
      canExpand={hasVideo}
      userCollapsed={userCollapsed}
      fullscreenAvailable={fullscreen.available && !collapsed}
      isFullscreen={fullscreen.isFullscreen}
      onToggleFullscreen={fullscreen.toggle}
      onToggleMute={onToggleMute}
      onToggleCamera={onToggleCamera}
      videoQuality={videoQuality}
      onVideoQualityChange={onVideoQualityChange}
      qualityMenuOpen={qualityMenuOpen}
      onQualityMenuOpenChange={setQualityMenuRequested}
      onStartScreenShare={onStartScreenShare}
      shareSystemAudio={shareSystemAudio}
      onShareSystemAudioChange={onShareSystemAudioChange}
      onStopScreenShare={onStopScreenShare}
      showGridToggle={!collapsed && layout !== "screen" && cameraCount >= 2}
      preferGrid={preferGrid}
      onToggleGrid={() => {
        const next = !preferGrid;
        setPreferGrid(next);
        rememberStageGrid(channelId, next);
      }}
      onToggleCollapsed={() => onSetCollapsed(!userCollapsed)}
      onLeave={onLeave}
      pushToTalk={pushToTalk}
      pushToTalkBlocked={pushToTalkBlocked}
      isTransmitting={voiceState.isTransmitting}
      pushToTalkKeyLabel={pushToTalkKeyLabel}
      windowFocused={windowFocused}
      onPushToTalk={onPushToTalk}
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
              ? roster.map((person) => {
                  const remote = remotes.find((r) => r.key === person.peerId);
                  return {
                    key: person.peerId,
                    displayName: person.displayName,
                    avatarUrl: person.avatarUrl,
                    volume: remote?.volume,
                    onSetVolume: remote?.onSetVolume,
                    failed: remote?.failed,
                    onRetry: remote?.onRetry,
                  };
                })
              : remotes.map((person) => ({
                  key: person.key,
                  displayName: person.name,
                  avatarUrl: person.avatarUrl,
                  volume: person.volume,
                  onSetVolume: person.onSetVolume,
                  failed: person.failed,
                  onRetry: person.onRetry,
                }))
          }
        />
        <p className="min-w-0 flex-1 truncate text-xs text-paper-muted" role="status">
          {statusLine ?? title}
          {declinedNames.map((name) => (
            <span key={name} className="ml-2 text-warning">
              {t("call.panel.declined", { name })}
            </span>
          ))}
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
      {showMeshWarning && (
        <p className="absolute inset-x-0 top-0 z-30 bg-warning/10 px-3 py-1 text-center text-xs text-warning">
          {t("voice.meshWarning")}
        </p>
      )}
      {soloPerson ? (
        <PrimaryTile
          person={soloPerson}
          videoRef={primaryVideoRef}
          isFullscreen
          onToggleFullscreen={() => toggleCameraFullscreen(soloPerson.key)}
          onPin={
            cameraCount >= 2 ? () => togglePin(soloPerson.key) : undefined
          }
          pinned={pinnedKey === soloPerson.key}
        />
      ) : layout === "screen" ? (
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
              <MiniTile
                key={person.key}
                person={person}
                youLabel={t("voice.tile.you")}
                compact={compactPeers}
                onToggleFullscreen={
                  person.stream
                    ? () => toggleCameraFullscreen(person.key)
                    : undefined
                }
                onPin={
                  cameraCount >= 2 && !person.isSelf
                    ? () => togglePin(person.key)
                    : undefined
                }
                pinned={pinnedKey === person.key}
              />
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
            <GridTile
              key={person.key}
              person={person}
              youLabel={t("voice.tile.you")}
              isFullscreen={false}
              onToggleFullscreen={
                person.stream
                  ? () => toggleCameraFullscreen(person.key)
                  : undefined
              }
              onPin={cameraCount >= 2 ? () => togglePin(person.key) : undefined}
              pinned={pinnedKey === person.key}
            />
          ))}
        </ul>
      ) : layout === "spotlight" && spotlightPerson ? (
        <>
          <PrimaryTile
            person={spotlightPerson}
            videoRef={primaryVideoRef}
            isFullscreen={false}
            onToggleFullscreen={
              spotlightPerson.stream
                ? () => toggleCameraFullscreen(spotlightPerson.key)
                : undefined
            }
            onPin={
              cameraCount >= 2 ? () => togglePin(spotlightPerson.key) : undefined
            }
            pinned={pinnedKey === spotlightPerson.key}
          />
          {stripPeople.filter((person) => !person.isSelf).length > 0 && (
            <div className="pointer-events-auto absolute right-3 top-12 flex max-h-[40%] flex-col gap-2 overflow-hidden">
              {stripPeople
                .filter((person) => !person.isSelf)
                .map((person) => (
                  <MiniTile
                    key={person.key}
                    person={person}
                    youLabel={t("voice.tile.you")}
                    compact={compactPeers}
                    onToggleFullscreen={
                      person.stream
                        ? () => toggleCameraFullscreen(person.key)
                        : undefined
                    }
                    onPin={() => togglePin(person.key)}
                    pinned={pinnedKey === person.key}
                  />
                ))}
            </div>
          )}
        </>
      ) : self?.stream ? (
        <PrimaryTile
          person={self}
          videoRef={primaryVideoRef}
          isFullscreen={false}
          onToggleFullscreen={() => toggleCameraFullscreen(self.key)}
        />
      ) : (
        <RingView
          faces={ringFaces}
          joining={joining}
          label={statusLine ?? t("call.panel.calling")}
        />
      )}

      {/* Self-preview: floats over spotlight and ring layouts; the grid and the
          screen rail already carry a self tile. */}
      {(layout === "spotlight" || layout === "ring") &&
        self &&
        !soloPerson?.isSelf &&
        !(layout === "spotlight" && spotlightPerson?.isSelf) &&
        !(layout === "ring" && self.stream) && (
        <div
          data-call-tile={self.name}
          role="group"
          aria-label={t("call.stage.selfPreview")}
          className={cn(
            "absolute z-10 touch-none overflow-hidden rounded-lg bg-ink-3 shadow-lg ring-1 ring-ink-4/80",
            compactPeers ? "w-24 sm:w-32" : "w-28 sm:w-40",
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
                onDoubleClick={() => toggleCameraFullscreen(self.key)}
                label={t("voice.tile.yourCamera")}
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
        <div
          role="alert"
          data-voice-error
          className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-danger/15 px-3 py-1.5 text-center text-xs text-danger"
        >
          <span>{voiceState.error}</span>
          {/* Every microphone error is fixed by picking another microphone,
              so the banner carries the door to where that happens. */}
          {voiceState.errorKind === "connection" && (
            <button
              type="button"
              data-voice-error-check
              className="rounded-md bg-danger/20 px-2 py-0.5 font-semibold text-danger hover:bg-danger/30"
              onClick={() => requestConnectionCheck()}
            >
              {t("connection.check")}
            </button>
          )}
          {/* Sound is the only part of a capture that can fail on its own and
              take the picture with it. One click puts the share back, minus
              the thing that broke it, and it has to be a click: the picker
              already spent this attempt's user activation. */}
          {voiceState.screenShareAudioFailed && onShareWithoutSound && (
            <button
              type="button"
              data-voice-error-share-silent
              className="rounded-md bg-danger/20 px-2 py-0.5 font-semibold text-danger hover:bg-danger/30"
              onClick={onShareWithoutSound}
            >
              {t("voice.control.shareWithoutSound")}
            </button>
          )}
          {voiceState.errorKind === "mic" && (
            <button
              type="button"
              data-voice-error-settings
              className="rounded-md bg-danger/20 px-2 py-0.5 font-semibold text-danger hover:bg-danger/30"
              onClick={() => requestSettingsSection("voice")}
            >
              {t("voice.error.openVoiceSettings")}
            </button>
          )}
        </div>
      )}
      {!voiceState.error && voiceState.notice && (
        <p
          role="status"
          data-voice-notice
          className="absolute inset-x-0 top-0 z-20 bg-ink/70 px-3 py-1.5 text-center text-xs text-paper-muted backdrop-blur-sm"
        >
          {voiceState.notice}
        </p>
      )}

      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 bg-gradient-to-b from-ink/70 to-transparent px-3 py-2 transition-opacity duration-300 motion-reduce:transition-none",
          controlsIdle && "opacity-0",
          (voiceState.error || voiceState.notice) && "mt-7",
        )}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-paper">
            {title}
          </p>
          <p className="truncate text-xs text-paper-muted" role="status">
            {/* RingView already says Connecting/Calling at centre stage.
                A video-call ring uses the self preview instead, so the
                overlay still has to carry that line. */}
            {layout === "ring" && !self?.stream
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
                {focusedIsLocal
                  ? t("voice.share.youPresenting")
                  : t("voice.share.peerPresenting", { name: presenterName })}
                {/* Said to whoever is looking at the tile, about the tile they
                    are looking at. For our own share we know what we captured;
                    for somebody else's we know what arrived on this machine,
                    which is the same question the person asking "why can't I
                    hear it" is trying to answer. */}
                {!focusedShareHasAudio && (
                  <span className="ml-1 text-paper-muted">
                    ({t("voice.share.noAudioShort")})
                  </span>
                )}
                {/* Said while it is happening. The presenter's own machine is
                    playing what they shared, so they are the one person who
                    cannot hear the echo they are causing. */}
                {voiceState.isSharingSystemAudio && (
                  <span className="ml-1 block text-warning">
                    {t("voice.share.systemAudioLive")}
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
/**
 * Whether a share we are receiving is carrying sound, kept current.
 *
 * A remote screen's audio track does not have to arrive with its video. In the
 * mesh it lands on a later renegotiation, so a value read once at render is a
 * value that says "sem som" over a share that gained sound a second later.
 * `addtrack` / `removetrack` on the MediaStream are what make the label
 * correct instead of merely first.
 *
 * Null for our own share: what we captured is already known from state, and
 * reading our own tracks back would answer a slightly different question.
 */
function useReceivedShareAudio(stream: MediaStream | null): boolean {
  const [hasAudio, setHasAudio] = useState(() =>
    shareStreamHasAudio(stream?.getAudioTracks() ?? []),
  );

  useEffect(() => {
    const sync = () =>
      setHasAudio(shareStreamHasAudio(stream?.getAudioTracks() ?? []));
    sync();
    if (!stream) {
      return;
    }
    stream.addEventListener("addtrack", sync);
    stream.addEventListener("removetrack", sync);
    // A track the presenter stops mid-share fires `ended` on the track itself
    // and nothing on the stream, so the stream listeners alone would miss it.
    const tracks = stream.getAudioTracks();
    for (const track of tracks) {
      track.addEventListener("ended", sync);
    }
    return () => {
      stream.removeEventListener("addtrack", sync);
      stream.removeEventListener("removetrack", sync);
      for (const track of tracks) {
        track.removeEventListener("ended", sync);
      }
    };
  }, [stream]);

  return hasAudio;
}

function receivingVideo(voiceState: VoiceState): boolean {
  return voiceState.remotePeers.some(
    (peer) => peer.cameraStream !== null || peer.screenStream !== null,
  );
}

function CallControls({
  voiceState,
  collapsed,
  canExpand,
  userCollapsed,
  fullscreenAvailable,
  isFullscreen,
  onToggleFullscreen,
  onToggleMute,
  onToggleCamera,
  videoQuality,
  onVideoQualityChange,
  qualityMenuOpen,
  onQualityMenuOpenChange,
  onStartScreenShare,
  onStopScreenShare,
  shareSystemAudio = false,
  onShareSystemAudioChange,
  showGridToggle = false,
  preferGrid = false,
  onToggleGrid,
  onToggleCollapsed,
  onLeave,
  pushToTalk = false,
  pushToTalkBlocked = false,
  isTransmitting = true,
  pushToTalkKeyLabel = null,
  windowFocused = true,
  onPushToTalk,
}: {
  voiceState: VoiceState;
  collapsed: boolean;
  canExpand: boolean;
  userCollapsed: boolean;
  fullscreenAvailable: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  videoQuality: VideoQuality;
  onVideoQualityChange: (quality: VideoQuality) => void;
  qualityMenuOpen: boolean;
  onQualityMenuOpenChange: (open: boolean) => void;
  onStartScreenShare?: () => void;
  shareSystemAudio?: boolean;
  onShareSystemAudioChange?: (next: boolean) => void;
  onStopScreenShare?: () => void;
  showGridToggle?: boolean;
  preferGrid?: boolean;
  onToggleGrid?: () => void;
  onToggleCollapsed: () => void;
  onLeave: () => void;
  pushToTalk?: boolean;
  pushToTalkBlocked?: boolean;
  isTransmitting?: boolean;
  pushToTalkKeyLabel?: string | null;
  windowFocused?: boolean;
  onPushToTalk?: (held: boolean) => void;
}) {
  const { t } = useTranslation();
  // Probed once per mount — whether the browser has getDisplayMedia never
  // changes mid-session. Same probe the channel voice panel uses.
  const canShare = useMemo(() => supportsScreenShare(), []);
  const [shareHint, setShareHint] = useState<string | null>(null);
  const shareAtCap = isScreenShareAtCap(
    voiceState.screenSharePeerIds,
    voiceState.peerId,
    voiceState.roomTransport,
  );
  const shareLimit = SCREEN_SHARE_LIMIT[voiceState.roomTransport ?? "mesh"];
  // The cap only bites somebody who is not already one of the shares.
  const shareCappedOut = shareAtCap && !voiceState.isSharingScreen;
  const size = collapsed ? "h-8 w-8" : "h-10 w-10";
  const iconSize = collapsed ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <div className={cn("flex flex-col items-center", collapsed ? "gap-0" : "gap-1.5")}>
      {pushToTalk && (
        <div className={cn("w-full", collapsed ? "mb-1" : "mb-0.5")}>
          <Button
            variant={isTransmitting ? "default" : "secondary"}
            size={collapsed ? "sm" : "default"}
            className={cn(
              "w-full select-none touch-none",
              isTransmitting && "ring-2 ring-accent",
            )}
            disabled={pushToTalkBlocked}
            aria-pressed={isTransmitting}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              onPushToTalk?.(true);
            }}
            onPointerUp={() => onPushToTalk?.(false)}
            onPointerCancel={() => onPushToTalk?.(false)}
            onLostPointerCapture={() => onPushToTalk?.(false)}
            onKeyDown={(event) => {
              if (event.key === " " && !event.repeat) {
                event.preventDefault();
                onPushToTalk?.(true);
              }
            }}
            onKeyUp={(event) => {
              if (event.key === " ") {
                event.preventDefault();
                onPushToTalk?.(false);
              }
            }}
            onBlur={() => onPushToTalk?.(false)}
          >
            {isTransmitting ? (
              <Mic className="h-4 w-4" aria-hidden="true" />
            ) : (
              <MicOff className="h-4 w-4" aria-hidden="true" />
            )}
            {pushToTalkBlocked
              ? t("voice.ptt.blocked")
              : isTransmitting
                ? t("voice.ptt.transmitting")
                : t("voice.ptt.hold")}
          </Button>
          {!collapsed && (
            <p className="mt-1 text-center text-[11px] text-paper-muted">
              {pushToTalkKeyLabel
                ? t("voice.ptt.hintKey", { key: pushToTalkKeyLabel })
                : t("voice.ptt.hintButton")}
            </p>
          )}
          {pushToTalkKeyLabel && !windowFocused && (
            <p role="status" className="mt-1 text-center text-[11px] text-warning">
              {t("voice.ptt.unfocused")}
            </p>
          )}
        </div>
      )}
    <div
      className={cn(
        "flex items-center",
        collapsed ? "gap-1" : "gap-2 rounded-full bg-ink-2/90 px-2.5 py-1.5 shadow-lg ring-1 ring-ink-4/60 backdrop-blur",
      )}
    >
      {/* Every control in this bar used to carry a `title` beside its
          `aria-label`: two copies of one string, a one-second wait, and
          nothing at all for a keyboard. The `Tooltip` is one copy, quicker,
          and it opens on focus. */}
      {/* Mute lives on the expanded stage (you are looking at the picture).
          On the slim bar it is the user panel, one pair, Discord's corner.
          Deafen is only ever the user panel. */}
      {!collapsed && (
        <Tooltip
          label={
            voiceState.isMuted ? t("voice.control.unmute") : t("voice.control.mute")
          }
        >
          <button
            type="button"
            aria-pressed={voiceState.isMuted}
            aria-label={
              voiceState.isMuted ? t("voice.control.unmute") : t("voice.control.mute")
            }
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
        </Tooltip>
      )}
      <Tooltip
        label={
          voiceState.isCameraOn
            ? t("call.panel.cameraOn")
            : t("call.panel.cameraOff")
        }
      >
        <button
          type="button"
          aria-pressed={voiceState.isCameraOn}
          aria-label={
            voiceState.isCameraOn
              ? t("call.panel.cameraOn")
              : t("call.panel.cameraOff")
          }
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
      </Tooltip>
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
          buttonClassName={size}
          iconClassName={iconSize}
        />
      )}
      {/* The opt-in to sending this machine's sound. Off unless armed, and
          only while nothing is being shared: it changes the NEXT capture, and
          a control that looks like it acts on the live share and does not is
          worse than no control. Sending system audio is what re-broadcast
          everyone's voices back into the call; see
          `lib/screen-capture-audio.ts`. */}
      {canShare &&
        onStartScreenShare &&
        onShareSystemAudioChange &&
        /* Hidden where the platform cannot deliver it. A dead toggle is not a
           neutral thing here: arming it used to cost people the whole share. */
        canShareScreenAudio() &&
        !voiceState.isSharingScreen && (
          /* The second line is the same one the channel bar gives this
             button, because it is the same button and the same consequence.
             It is the one control on this bar that a person cannot work out
             by looking at it. Arm it before the share starts: it only
             changes the next capture. */
          <Tooltip
            label={t("voice.control.shareSound")}
            detail={t("voice.control.shareSoundDetail")}
          >
            <button
              type="button"
              aria-pressed={shareSystemAudio}
              className={cn(
                "flex items-center justify-center rounded-full",
                size,
                shareSystemAudio
                  ? "bg-signal/20 text-signal"
                  : "bg-ink-3 text-paper hover:bg-ink-4",
              )}
              onClick={() => onShareSystemAudioChange(!shareSystemAudio)}
            >
              <MonitorSpeaker className={iconSize} />
            </button>
          </Tooltip>
        )}
      {!canShare && onStartScreenShare && (
        <Tooltip
          label={t("voice.control.shareUnavailable")}
          detail={screenShareUnavailableMessage("no-api")}
        >
          <button
            type="button"
            aria-label={t("voice.control.shareUnavailable")}
            aria-disabled
            className={cn(
              "flex items-center justify-center rounded-full bg-ink-3 text-paper opacity-50",
              size,
            )}
            onClick={() =>
              setShareHint(screenShareUnavailableMessage("no-api"))
            }
          >
            <ScreenShare className={iconSize} />
          </button>
        </Tooltip>
      )}
      {canShare && (onStartScreenShare || onStopScreenShare) && (
        <Tooltip
          label={
            voiceState.isSharingScreen
              ? t("voice.control.stopShare")
              : t("voice.control.share")
          }
          detail={
            shareCappedOut
              ? t("voice.control.shareLimit", { limit: shareLimit })
              : undefined
          }
        >
          {/* `aria-disabled` rather than `disabled`, matching the channel
              bar: the cap is the only thing worth saying about this button
              while it is dim, and a disabled button gets no hover and no
              focus, so it could never say it. The `title` that used to carry
              the sentence was dead for the same reason. */}
          <button
            type="button"
            aria-pressed={voiceState.isSharingScreen}
            aria-disabled={shareCappedOut || undefined}
            className={cn(
              "flex items-center justify-center rounded-full",
              size,
              shareCappedOut && "opacity-40",
              voiceState.isSharingScreen
                ? "bg-signal/20 text-signal"
                : "bg-ink-3 text-paper hover:bg-ink-4",
            )}
            onClick={() => {
              if (shareCappedOut) {
                return;
              }
              if (voiceState.isSharingScreen) {
                onStopScreenShare?.();
                return;
              }
              onStartScreenShare?.();
            }}
          >
            {voiceState.isSharingScreen ? (
              <ScreenShareOff className={iconSize} />
            ) : (
              <ScreenShare className={iconSize} />
            )}
          </button>
        </Tooltip>
      )}
      {showGridToggle && onToggleGrid && (
        <Tooltip
          label={preferGrid ? t("call.stage.focus") : t("call.stage.grid")}
        >
          <button
            type="button"
            aria-pressed={preferGrid}
            className={cn(
              "flex items-center justify-center rounded-full bg-ink-3 text-paper hover:bg-ink-4",
              size,
            )}
            onClick={onToggleGrid}
          >
            <LayoutGrid className={iconSize} />
          </button>
        </Tooltip>
      )}
      {!collapsed && fullscreenAvailable && (
        <Tooltip
          label={
            isFullscreen
              ? t("voice.share.exitFullscreen")
              : t("voice.share.fullscreen")
          }
        >
          <button
            type="button"
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
        </Tooltip>
      )}
      {canExpand && (
        <Tooltip
          label={userCollapsed ? t("call.stage.expand") : t("call.stage.collapse")}
        >
          <button
            type="button"
            aria-expanded={!userCollapsed}
            className={cn(
              "flex items-center justify-center rounded-full bg-ink-3 text-paper hover:bg-ink-4",
              size,
            )}
            onClick={onToggleCollapsed}
          >
            {userCollapsed ? (
              <ChevronDown className={iconSize} />
            ) : (
              <ChevronUp className={iconSize} />
            )}
          </button>
        </Tooltip>
      )}
      <span
        aria-hidden="true"
        className={cn("mx-0.5 w-px self-stretch bg-ink-4/70", collapsed ? "my-1" : "my-1.5")}
      />
      <Tooltip label={t("call.panel.leave")}>
        <button
          type="button"
          aria-label={t("call.panel.leave")}
          className={cn(
            "flex items-center justify-center rounded-full bg-danger/90 text-paper hover:bg-danger",
            collapsed ? size : "h-10 w-14",
          )}
          onClick={onLeave}
        >
          <PhoneOff className={iconSize} />
        </button>
      </Tooltip>
    </div>
    {shareHint && (
      <p role="status" className="text-center text-[11px] text-paper-muted">
        {shareHint}
      </p>
    )}
    </div>
  );
}

function cameraLabel(
  t: (key: MessageKey, vars?: MessageVars) => string,
  person: StagePerson,
): string {
  return person.isSelf
    ? t("voice.tile.yourCamera")
    : t("voice.tile.cameraOf", { name: person.name });
}

function TileOverlay({
  isFullscreen = false,
  onToggleFullscreen,
  onPin,
  pinned = false,
  name,
}: {
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onPin?: () => void;
  pinned?: boolean;
  name: string;
}) {
  const { t } = useTranslation();
  if (!onToggleFullscreen && !onPin) {
    return null;
  }
  return (
    <div className="absolute left-2 top-2 z-20 flex items-center gap-1 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
      {onToggleFullscreen && (
        <Tooltip
          label={
            isFullscreen
              ? t("voice.share.exitFullscreen")
              : t("call.stage.fullscreenTile", { name })
          }
          side="bottom"
          align="start"
        >
          <button
            type="button"
            data-testid="camera-fullscreen"
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
        </Tooltip>
      )}
      {onPin && (
        <Tooltip
          label={pinned ? t("call.stage.unpin") : t("call.stage.pin", { name })}
          side="bottom"
          align="start"
        >
          <button
            type="button"
            aria-pressed={pinned}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink/70 text-paper hover:bg-ink-4",
              pinned && "text-signal",
            )}
            onClick={onPin}
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** The 1:1 stage: one remote person, as large as the stage itself. */
function PrimaryTile({
  person,
  videoRef,
  isFullscreen = false,
  onToggleFullscreen,
  onPin,
  pinned = false,
}: {
  person: StagePerson;
  videoRef: RefObject<WebkitFullscreenVideo | null>;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onPin?: () => void;
  pinned?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-call-tile={person.name}
      className={cn(
        "group relative h-full w-full bg-ink-2",
        person.speaking && "ring-2 ring-inset ring-success",
      )}
    >
      {person.stream ? (
        <StageVideo
          stream={person.stream}
          mirrored={person.isSelf}
          videoRef={videoRef}
          onDoubleClick={onToggleFullscreen}
          label={cameraLabel(t, person)}
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
      <TileOverlay
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
        onPin={onPin}
        pinned={pinned}
        name={person.name}
      />
      <TileBadge
        name={person.name}
        muted={person.muted}
        connecting={person.connecting}
        connectingLabel={t("voice.tile.connecting")}
        prominent
      />
      <PeerTileControls
        name={person.name}
        volume={person.volume}
        onSetVolume={person.onSetVolume}
        failed={person.failed}
        onRetry={person.onRetry}
        className="absolute bottom-8 left-2 right-2"
      />
    </div>
  );
}

/** One cell of the group grid. */
function GridTile({
  person,
  youLabel,
  isFullscreen = false,
  onToggleFullscreen,
  onPin,
  pinned = false,
}: {
  person: StagePerson;
  youLabel: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onPin?: () => void;
  pinned?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li
      data-call-tile={person.name}
      className={cn(
        "group relative min-h-0 overflow-hidden rounded-xl bg-ink-2",
        person.speaking && "ring-2 ring-success",
        person.connecting && "opacity-70",
      )}
    >
      {person.stream ? (
        <StageVideo
          stream={person.stream}
          mirrored={person.isSelf}
          onDoubleClick={onToggleFullscreen}
          label={cameraLabel(t, person)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <StageAvatar person={person} />
        </div>
      )}
      <TileOverlay
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
        onPin={onPin}
        pinned={pinned}
        name={person.name}
      />
      <TileBadge
        name={person.isSelf ? youLabel : person.name}
        muted={person.muted}
        connecting={person.connecting}
        connectingLabel={t("voice.tile.connecting")}
      />
      <PeerTileControls
        name={person.name}
        volume={person.volume}
        onSetVolume={person.onSetVolume}
        failed={person.failed}
        onRetry={person.onRetry}
        className="absolute bottom-6 left-1 right-1"
      />
    </li>
  );
}

/** A thumbnail on the screen-share rail. */
function MiniTile({
  person,
  youLabel,
  compact = false,
  onToggleFullscreen,
  onPin,
  pinned = false,
}: {
  person: StagePerson;
  youLabel: string;
  compact?: boolean;
  onToggleFullscreen?: () => void;
  onPin?: () => void;
  pinned?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-call-tile={person.name}
      className={cn(
        "group pointer-events-auto relative shrink-0 overflow-hidden rounded-md bg-ink-2/90",
        compact ? "w-20 sm:w-24" : "w-24 sm:w-32",
        person.speaking && "ring-2 ring-success",
      )}
    >
      <div className="relative aspect-video w-full">
        {person.stream ? (
          <StageVideo
            stream={person.stream}
            mirrored={person.isSelf}
            onDoubleClick={onToggleFullscreen}
            label={cameraLabel(t, person)}
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
        <TileOverlay
          onToggleFullscreen={onToggleFullscreen}
          onPin={onPin}
          pinned={pinned}
          name={person.name}
        />
        <TileBadge
          name={person.isSelf ? youLabel : person.name}
          muted={person.muted}
        />
        <PeerTileControls
          name={person.name}
          volume={person.volume}
          onSetVolume={person.onSetVolume}
          failed={person.failed}
          onRetry={person.onRetry}
          className="absolute bottom-5 left-1 right-1"
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
  faces,
  joining,
  label,
}: {
  faces: CallStagePerson[];
  joining: boolean;
  label: string;
}) {
  const shown = faces.slice(0, 3);
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
export function OccupantFaces({
  faces,
}: {
  faces: {
    key: string;
    displayName: string;
    avatarUrl: string | null;
    volume?: number;
    onSetVolume?: (volume: number) => void;
    failed?: boolean;
    onRetry?: () => void;
  }[];
}) {
  const interactive = faces.some(
    (person) => person.onSetVolume || person.onRetry,
  );
  return (
    <span
      className="flex shrink-0 -space-x-2"
      aria-hidden={interactive ? undefined : true}
    >
      {faces.slice(0, 3).map((person) => (
        <span key={person.key} className="group relative inline-flex">
          <UserAvatar
            name={person.displayName}
            avatarUrl={person.avatarUrl}
            rounded="full"
            className="h-6 w-6 ring-2 ring-ink-2"
            fallbackClassName="bg-ink-4 text-[10px] text-paper"
          />
          {(person.onSetVolume || person.onRetry) && (
            <PeerTileControls
              name={person.displayName}
              volume={person.volume}
              onSetVolume={person.onSetVolume}
              failed={person.failed}
              onRetry={person.onRetry}
              alwaysOpen
              className="absolute left-0 top-full z-30 hidden min-w-[8rem] rounded-md bg-ink-2 p-1 shadow-lg ring-1 ring-ink-4/80 group-hover:block group-focus-within:block"
            />
          )}
        </span>
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
          /* `side="bottom"`: this sits on the top edge of the share, so a
             bubble above it would be off the tile. */
          <Tooltip label={label} side="bottom" align="start">
            <button
              type="button"
              // The control bar carries a fullscreen button too, so the label
              // alone cannot tell a test which one it pressed.
              data-testid="share-fullscreen"
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
          </Tooltip>
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
  label,
}: {
  stream: MediaStream | null;
  mirrored?: boolean;
  className?: string;
  videoRef?: RefObject<WebkitFullscreenVideo | null>;
  /** Only shares and camera tiles pass this. */
  onDoubleClick?: () => void;
  label?: string;
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
      aria-label={label}
      onDoubleClick={onDoubleClick}
      className={cn(className, mirrored && "-scale-x-100")}
    />
  );
}
