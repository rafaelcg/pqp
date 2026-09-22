import {
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  Crop,
  Eye,
  EyeOff,
  Hand,
  Loader2,
  Maximize2,
  MonitorPlay,
  PanelLeftClose,
  PanelLeftOpen,
  Mic,
  MicOff,
  MousePointer2,
  MousePointerBan,
  ShieldBan,
  Minimize2,
  PhoneOff,
  Pin,
  Scan,
  ScreenShare,
  ScreenShareOff,
  Music,
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
  type FocusEvent as ReactFocusEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { flushSync } from "react-dom";
import { MESH_VOICE_WARNING } from "@pqp/shared";
import type { VoiceInputMode, VoiceState } from "@/hooks/use-voice";
import {
  hlsModeOf,
  hlsPartTargetMs,
  watchPlayerMode,
} from "@/lib/hls-live-edge";
import type { VideoQuality } from "@/lib/video-quality";
import type { ScreenFrameRate } from "@/lib/hls-capture-rate";
import { desktopContext, isDesktopApp } from "@/lib/desktop";
import { shareStreamHasAudio } from "@/lib/screen-capture-audio";
import {
  canControlShareCursor,
  setShareCursor,
  useShareCursor,
} from "@/lib/screen-capture-cursor";
import {
  setHideScreenPreview,
  useHideScreenPreview,
} from "@/lib/screen-preview-pref";
import {
  setJoinLeaveAutoMuteEnabled,
  useJoinLeaveAutoMuteEnabled,
} from "@/lib/large-room-sounds";
import {
  canShareScreenAudio,
  detectFullscreenMode,
  screenShareUnavailableMessage,
  supportsScreenShare,
  type FullscreenMode,
} from "@/components/voice/capabilities";
import { attemptElementFullscreen } from "@/components/voice/element-fullscreen";
import {
  currentFullscreenElement,
  exitDocumentFullscreen,
  fullscreenDocument,
  requestElementFullscreen,
  type WebkitFullscreenElement,
} from "@/components/voice/document-fullscreen";
import { CinemaHint } from "@/components/voice/cinema-hint";
import { CapacityNotice } from "@/components/voice/capacity-notice";
import { MicFallbackNotice } from "@/components/voice/mic-fallback-notice";
import { RaisedHandQueue } from "@/components/voice/raised-hand-queue";
import {
  insertMusicStageTile,
  MUSIC_STAGE_TILE_ID,
  MusicStageTile,
} from "@/components/voice/music-stage-tile";
import {
  useMusicPlacement,
  useMusicStagePresence,
} from "@/lib/music-prefs";
import { useImmersiveStage } from "@/hooks/use-immersive-stage";
import {
  chooseFullscreenStrategy,
  enterNativeVideoFullscreen,
  exitNativeVideoFullscreen,
  lockLandscape,
  nativeVideoFullscreenAllowed,
  unlockOrientation,
  videoSupportsNativeFullscreen,
  type StageFullscreenStrategy,
} from "@/lib/fullscreen";
import { BringFriendsHint } from "@/components/layout/bring-friends-hint";
import { FeatureHint, useFeatureHintEnabled } from "@/components/layout/feature-hint";
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
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { CinemaStage } from "@/components/voice/cinema-stage";
import { useWatchFullscreen } from "@/components/voice/watch-fullscreen";
import { seatedInWatchPartyRoom, shouldShowCinema } from "@/lib/cinema-layout";
import {
  collectScreenTiles,
  resolveScreenTileSources,
  type ScreenShareTile,
} from "@/components/voice/screen-stage";
import {
  listenersOf,
  listenerStripSlots,
  planStage,
  stageGridColumns,
  tileClickFullscreens,
  STAGE_TILE_LIMIT_NARROW,
  STAGE_TILE_LIMIT_WIDE,
  STRIP_LIMIT_NARROW,
  STRIP_LIMIT_WIDE,
} from "@/components/voice/stage-layout";
import { ListenerStrip } from "@/components/voice/listener-strip";
import {
  showsVideoQualityControl,
  videoQualityMenuOpen,
} from "@/components/voice/video-quality-control";
import { VideoQualityMenu } from "@/components/voice/video-quality-menu";
import { bindRemoteVideo } from "@/lib/remote-video-binding";
import { VoiceAvatar } from "@/components/voice/voice-avatar";
import {
  CallControlDivider,
  CallControlGroup,
} from "@/components/voice/call-control-groups";
import {
  CallDockPortal,
  useCallDockPublisher,
} from "@/components/voice/call-dock";
import {
  collapsedPeopleLabel,
  collapsedPeopleLine,
} from "@/components/voice/collapsed-people-label";
import { PttFocusHint, PttHoldControl } from "@/components/voice/ptt-hold-control";
import {
  idleChromeClassName,
  tapIsOnStage,
  useIdleChrome,
} from "@/hooks/use-idle-chrome";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { UserAvatar } from "@/components/user/user-avatar";
import { useLgUp } from "@/hooks/use-lg-up";
import { useLiveHlsReady } from "@/hooks/use-live-hls-src";
import {
  isCameraAtCap,
  isScreenShareAtCap,
  meshRoomLinkOf,
  videoLimitOf,
} from "@/lib/screen-share-roster";
import {
  loadParticipantRailOpen,
  saveParticipantRailOpen,
} from "@/lib/participant-rail-preference";
import type { CallStageShape } from "@/lib/call-split";
import { useVideoFit, type VideoFitControls } from "@/hooks/use-video-fit";
import { videoFitClass } from "@/lib/video-fit";
import { useTranslation, type MessageKey, type MessageVars } from "@/lib/i18n";
import {
  PeerAudioMenu,
  PeerAudioMenuButton,
  usePeerAudioMenu,
  type PeerAudioTrack,
} from "@/components/voice/peer-audio-menu";
import { VoiceQualityMeter } from "@/components/voice/voice-quality-meter";
import { useVoiceLinkQuality } from "@/hooks/use-voice-link-quality";
import { useShareUplinkStrain } from "@/hooks/use-share-uplink-strain";
import { useStreamQualityTelemetry } from "@/hooks/use-stream-quality-telemetry";
import { cameraBitrateFor } from "@/lib/video-quality";
import type { VoiceLinkQuality } from "@/lib/voice-link-quality";
import { startSoundLoop, stopSoundLoop } from "@/lib/sounds";
import {
  requestConnectionCheck,
  requestSettingsSection,
} from "@/lib/settings-request";
import { cn } from "@/lib/utils";
import { toggleMusicOpen, useMusicDock } from "@/lib/music-store";
import { STAGE_LAYER, callControlsLayer } from "@/lib/stage-layers";
import { Button } from "@/components/ui/button";
import { VoiceNoticeBar } from "@/components/voice/voice-notice-bar";
import {
  callStartKey,
  callStartedAt,
  cameraSoloId,
  formatCallDuration,
  hasWatchableVideo,
  isCameraSoloId,
  isMusicPictureOnlyStage,
  isStageCollapsed,
  markCallStarted,
  nearestCorner,
  personKeyFromCameraSoloId,
  rememberStageCollapsed,
  rememberStagePinnedKey,
  shouldShowExpandedStage,
  stagePinnedKey,
  type PipCorner,
} from "@/components/dm/call-stage-state";

/**
 * The live-call stage shared by conversation calls and server voice channels.
 *
 * A picture owns the room; voice-only occupancy does not. The stage is a slim
 * bar until a camera or a screen share is on, then it expands unless the user
 * tucked it away for the session. Music on the stage is a clip in that
 * picture pane; it does not take the overlay bar or the listener strip.
 */

/** How one person appears on the stage, whatever transport carried them. */
export interface StagePerson {
  key: string;
  name: string;
  avatarUrl: string | null;
  /** Camera video when they send it; null renders the avatar instead. */
  stream: MediaStream | null;
  speaking: boolean;
  muted: boolean;
  /**
   * A moderator muted them for everyone. Drawn with its own glyph, because a
   * self-mute is a choice and this is a sanction, and the people in the room
   * (the muted person most of all) need to tell the two apart at a glance.
   */
  serverMuted: boolean;
  connecting: boolean;
  /** Mesh/SFU connection failed. Remote tiles offer Retry. */
  failed?: boolean;
  isSelf: boolean;
  /** userId (preferred) or peerId, for the playback volume map. */
  volumeKey?: string;
  volume?: number;
  onSetVolume?: (volume: number) => void;
  /**
   * The same knob for the screen this person is sharing, when that share
   * carries sound. Separate from `volume` because a film and a voice are two
   * different things to turn down, and the moderator who asked for this asked
   * for both in the same breath.
   */
  shareVolume?: number;
  onSetShareVolume?: (volume: number) => void;
  onRetry?: () => void;
  quality?: VoiceLinkQuality | null;
}

/**
 * A person's two sliders, or nothing when the caller wired neither. Kept as a
 * function so every surface that draws a face asks the same question.
 */
export function personAudioTracks(person: StagePerson): {
  voice?: PeerAudioTrack;
  share?: PeerAudioTrack;
} | undefined {
  const voice = person.onSetVolume
    ? { volume: person.volume ?? 1, onSetVolume: person.onSetVolume }
    : undefined;
  const share = person.onSetShareVolume
    ? { volume: person.shareVolume ?? 1, onSetVolume: person.onSetShareVolume }
    : undefined;
  return voice || share ? { voice, share } : undefined;
}

const PIP_CORNER_CLASS: Record<PipCorner, string> = {
  tl: "left-3 top-3",
  tr: "right-3 top-3",
  bl: "bottom-3 left-3",
  br: "bottom-3 right-3",
};

/**
 * The same corners with the listener row underneath: the preview sits above
 * it rather than on top of the last few chips.
 */
const PIP_CORNER_CLASS_WITH_STRIP: Record<PipCorner, string> = {
  tl: "left-3 top-3",
  tr: "right-3 top-3",
  bl: "bottom-28 left-3",
  br: "bottom-28 right-3",
};

/** The Fullscreen API under both spellings — see `screen-share-view.tsx`. */
interface WebkitFullscreenVideo extends HTMLVideoElement {
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
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
  const [mode, setMode] = useState<StageFullscreenStrategy>("expand");
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
    const elementMode: FullscreenMode = detectFullscreenMode({
      documentFullscreenEnabled:
        typeof document === "undefined"
          ? undefined
          : (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled),
      requestFullscreen: containerRef.current?.requestFullscreen,
      webkitRequestFullscreen: (
        containerRef.current as WebkitFullscreenElement | null
      )?.webkitRequestFullscreen,
    });
    // iPhone Safari has no element fullscreen; the native player is the
    // only real one it has, and it is opt-in (see `lib/fullscreen.ts`).
    setMode(
      chooseFullscreenStrategy({
        elementFullscreen: elementMode === "element",
        videoNativeFullscreen: videoSupportsNativeFullscreen(videoRef.current),
        hasVideo: hasPrimaryVideo,
        allowNativeVideo: nativeVideoFullscreenAllowed(),
      }),
    );
  }, [containerRef, videoRef, hasPrimaryVideo]);

  // A share is landscape; a phone in a hand usually is not. Asked after the
  // fact because Chrome only honours a lock while the document is fullscreen.
  useEffect(() => {
    if (state.active) {
      lockLandscape();
    } else {
      unlockOrientation();
    }
  }, [state.active]);

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
      if (mode === "video") {
        // iPhone: the focused <video> goes to the native player. `active` is
        // confirmed by `webkitbeginfullscreen` / `webkitendfullscreen` on the
        // element, wired above, so it is never pre-empted here.
        const video = videoRef.current;
        if (transition.request === "none" || !video) {
          setState(transition.next);
          return;
        }
        if (transition.request === "exit") {
          exitNativeVideoFullscreen(video);
          return;
        }
        setState((was) => ({ ...was, soloPeerId: transition.next.soloPeerId }));
        try {
          enterNativeVideoFullscreen(video);
        } catch (err) {
          // Older desktop Safari: the method exists, the element refuses.
          console.warn("[call] native video fullscreen refused; expanding in page", err);
          refusedElementRef.current = true;
          setMode("expand");
          setState(transition.next);
        }
        return;
      }
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
    [mode, containerRef, videoRef],
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
  /** Server or community name, for the watch player's lock-screen metadata. */
  serverName?: string | null;
  /** Server icon, used as lock-screen artwork when a watch stream is live. */
  serverIconUrl?: string | null;
  currentUser: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  voiceState: VoiceState;
  videoQuality: VideoQuality;
  screenFrameRate?: ScreenFrameRate;
  /** Faces shown while ringing out. Server voice omits this. */
  ringFaces?: CallStagePerson[];
  declinedNames?: string[];
  playOutgoingRingtone?: boolean;
  onLeave: () => void;
  onToggleMute: () => void;
  /**
   * The close (x) on `voiceState.micFallback`'s corner card. See
   * `use-voice.ts`'s `dismissMicFallbackNotice` for the whole lifecycle.
   */
  onDismissMicFallbackNotice: () => void;
  onToggleCamera: () => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  onScreenFrameRateChange?: (rate: ScreenFrameRate) => void;
  onStartScreenShare?: (
    intent?: { preferBrowserTab?: boolean },
  ) => void | Promise<void>;
  /**
   * Start the same share with no sound at all. Offered only after sound is
   * what killed the last attempt.
   */
  onShareWithoutSound?: () => void;
  onStopScreenShare?: () => void;
  onFocusScreenShare?: (peerId: string) => void;
  inputMode?: VoiceInputMode;
  pushToTalkKeyLabel?: string | null;
  windowFocused?: boolean;
  onPushToTalk?: (held: boolean) => void;
  onSetPeerVolume?: (peerId: string, volume: number) => void;
  /** Screen-share audio volume, separate from the voice slider. */
  onSetScreenVolume?: (userId: string, volume: number) => void;
  /** Stop watching one peer's share, and undo that. */
  onDismissShare?: (peerId: string) => void;
  onWatchShare?: (peerId: string) => void;
  onRetryPeer?: (peerId: string) => void;
  /**
   * Our own hand in the room's queue. Absent leaves the control off the bar
   * entirely, which is what a mount with no voice controller wants.
   */
  onToggleRaisedHand?: () => void;
  /**
   * `Permission.MUTE_MEMBERS` in this channel, the bit the other voice
   * moderation actions already use. Never set in a conversation call, which
   * has no moderators.
   */
  canLowerHands?: boolean;
  onLowerHand?: (userId: string) => void;
  /** Shrinks the listener chips. Same setting the old lobby grid used. */
  compactPeers?: boolean;
  /**
   * DM ringing copy. Server voice does not ring: being the only person in a
   * Lobby is occupancy, not an outgoing call.
   */
  ringWhenAlone?: boolean;
  /**
   * The stage's height is the container's, not its own `svh` rule. Set by
   * `CallSplit` once the divider is in charge of the number; false everywhere
   * the stage still sizes itself (a pane too short to split, a phone in
   * landscape, an Electron window mid-resize).
   */
  fill?: boolean;
  /**
   * Tells the pane what the stage currently is, so the divider is offered on
   * an expanded stage and on nothing else. Must be stable across renders: the
   * cleanup reports `none`, and an unstable identity would fire it on every
   * commit.
   */
  onShapeChange?: (shape: CallStageShape) => void;
  /**
   * A WATCH PARTY IS NOT A LOBBY. In a watch party channel with voice off,
   * the party bar is the host's control bar and this stage's strip (faces,
   * a status line, the call controls) is a second set of the same verbs in
   * a call's words: a share icon beside "Compartilhar tela", a red Sair
   * beside Encerrar. With this set the collapsed strip is not drawn at all
   * and an expanded stage draws no controls; the seat stays, the furniture
   * goes. See docs/plans/WATCH_PARTY_SETUP_UX.md section 10.
   */
  watchPartyChrome?: boolean;
  /**
   * This channel IS a watch party channel, full stop — the channel's own
   * `type`, not whether its party is currently `live`. `watchPartyChrome`
   * answers a narrower question (party live AND seated) and is what hides
   * the ordinary call controls, so it is deliberately allowed to lag behind
   * a fresh seat by a render: `watchParties.byChannel[id]?.state` comes off
   * its own fetch/socket, independent of the voice join.
   *
   * The cinema landing view has no such excuse to wait. `CallStage` mounts
   * (`VoiceChannelStage`'s `inThisCall` gate) ONLY once this account already
   * holds the seat, so "audience view with a join button" can never be true
   * for a watch party room the instant this component exists — the join
   * already happened. Gating that specifically on the channel's own type
   * removes the party-store race entirely: see the second half of the
   * 2026-09-13 incident in `cinema-layout.ts`.
   */
  isWatchPartyChannel?: boolean;
  /**
   * THE PRESENTER'S OWN STAGE (2026-09-13). With `watchPartyChrome`, when the
   * lone share on this stage is our own, the pane draws this instead of a
   * full-size mirror of the host's tab: a small monitor, the audience's
   * view, and the room's activity. See `WatchPartyPresenterStage`.
   */
  presenterStage?: (stream: MediaStream | null) => ReactNode;
}

export function CallStage({
  channelId,
  title,
  watchPartyChrome = false,
  isWatchPartyChannel = false,
  presenterStage,
  serverName = null,
  serverIconUrl = null,
  currentUser,
  voiceState,
  videoQuality,
  screenFrameRate,
  ringFaces = [],
  declinedNames = [],
  playOutgoingRingtone = false,
  onLeave,
  onToggleMute,
  onDismissMicFallbackNotice,
  onToggleCamera,
  onVideoQualityChange,
  onScreenFrameRateChange,
  onStartScreenShare,
  onShareWithoutSound,
  onStopScreenShare,
  onFocusScreenShare,
  inputMode = "voice-activity",
  pushToTalkKeyLabel = null,
  windowFocused = true,
  onPushToTalk,
  onSetPeerVolume,
  onSetScreenVolume,
  onDismissShare,
  onWatchShare,
  onRetryPeer,
  onToggleRaisedHand,
  canLowerHands = false,
  onLowerHand,
  compactPeers = false,
  ringWhenAlone = true,
  fill = false,
  onShapeChange,
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
      presenterStage={presenterStage}
      watchPartyChrome={watchPartyChrome}
      isWatchPartyChannel={isWatchPartyChannel}
      serverName={serverName}
      serverIconUrl={serverIconUrl}
      currentUser={currentUser}
      voiceState={voiceState}
      videoQuality={videoQuality}
      screenFrameRate={screenFrameRate}
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
      onDismissMicFallbackNotice={onDismissMicFallbackNotice}
      onToggleCamera={onToggleCamera}
      onVideoQualityChange={onVideoQualityChange}
      onScreenFrameRateChange={onScreenFrameRateChange}
      onStartScreenShare={onStartScreenShare}
      onShareWithoutSound={onShareWithoutSound}
      onStopScreenShare={onStopScreenShare}
      onFocusScreenShare={onFocusScreenShare}
      inputMode={inputMode}
      pushToTalkKeyLabel={pushToTalkKeyLabel}
      windowFocused={windowFocused}
      onPushToTalk={onPushToTalk}
      onSetPeerVolume={onSetPeerVolume}
      onSetScreenVolume={onSetScreenVolume}
      onDismissShare={onDismissShare}
      onWatchShare={onWatchShare}
      onRetryPeer={onRetryPeer}
      onToggleRaisedHand={onToggleRaisedHand}
      canLowerHands={canLowerHands}
      onLowerHand={onLowerHand}
      compactPeers={compactPeers}
      ringWhenAlone={ringWhenAlone}
      fill={fill}
      onShapeChange={onShapeChange}
    />
  );
}

function ActiveCall({
  channelId,
  title,
  watchPartyChrome = false,
  isWatchPartyChannel = false,
  presenterStage,
  serverName = null,
  serverIconUrl = null,
  currentUser,
  voiceState,
  videoQuality,
  screenFrameRate,
  ringFaces,
  declinedNames,
  playOutgoingRingtone,
  hasVideo,
  userCollapsed,
  onSetCollapsed,
  onLeave,
  onToggleMute,
  onDismissMicFallbackNotice,
  onToggleCamera,
  onVideoQualityChange,
  onScreenFrameRateChange,
  onStartScreenShare,
  onShareWithoutSound,
  onStopScreenShare,
  onFocusScreenShare,
  inputMode = "voice-activity",
  pushToTalkKeyLabel = null,
  windowFocused = true,
  onPushToTalk,
  onSetPeerVolume,
  onSetScreenVolume,
  onDismissShare,
  onWatchShare,
  onRetryPeer,
  onToggleRaisedHand,
  canLowerHands = false,
  onLowerHand,
  compactPeers = false,
  ringWhenAlone = true,
  fill = false,
  onShapeChange,
}: {
  channelId: string;
  title: string;
  watchPartyChrome?: boolean;
  isWatchPartyChannel?: boolean;
  presenterStage?: (stream: MediaStream | null) => ReactNode;
  serverName?: string | null;
  serverIconUrl?: string | null;
  currentUser: CallStageProps["currentUser"];
  voiceState: VoiceState;
  videoQuality: VideoQuality;
  screenFrameRate?: ScreenFrameRate;
  ringFaces: CallStagePerson[];
  declinedNames: string[];
  playOutgoingRingtone: boolean;
  hasVideo: boolean;
  userCollapsed: boolean;
  onSetCollapsed: (collapsed: boolean) => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onDismissMicFallbackNotice: () => void;
  onToggleCamera: () => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  onScreenFrameRateChange?: (rate: ScreenFrameRate) => void;
  onStartScreenShare?: (
    intent?: { preferBrowserTab?: boolean },
  ) => void | Promise<void>;
  /**
   * Start the same share with no sound at all. Offered only after sound is
   * what killed the last attempt.
   */
  onShareWithoutSound?: () => void;
  onStopScreenShare?: () => void;
  onFocusScreenShare?: (peerId: string) => void;
  inputMode?: VoiceInputMode;
  pushToTalkKeyLabel?: string | null;
  windowFocused?: boolean;
  onPushToTalk?: (held: boolean) => void;
  onSetPeerVolume?: (peerId: string, volume: number) => void;
  /** Screen-share audio volume, separate from the voice slider. */
  onSetScreenVolume?: (userId: string, volume: number) => void;
  /** Stop watching one peer's share, and undo that. */
  onDismissShare?: (peerId: string) => void;
  onWatchShare?: (peerId: string) => void;
  onRetryPeer?: (peerId: string) => void;
  /**
   * Our own hand in the room's queue. Absent leaves the control off the bar
   * entirely, which is what a mount with no voice controller wants.
   */
  onToggleRaisedHand?: () => void;
  /**
   * `Permission.MUTE_MEMBERS` in this channel, the bit the other voice
   * moderation actions already use. Never set in a conversation call, which
   * has no moderators.
   */
  canLowerHands?: boolean;
  onLowerHand?: (userId: string) => void;
  compactPeers?: boolean;
  ringWhenAlone?: boolean;
  fill?: boolean;
  onShapeChange?: (shape: CallStageShape) => void;
}) {
  const { t } = useTranslation();
  const wide = useLgUp();
  // Where the collapsed bar goes: the composer's dock when one is mounted
  // around us, our own place otherwise. See `call-dock.tsx`.
  const dockPublish = useCallDockPublisher();
  // For the floating self-preview, which is a camera like any other and so
  // follows the camera answer. It carries no button of its own: at 112px
  // there is no room for one, and the tiles that do carry it set the same
  // value for every camera on the stage, this one included.
  const selfFit = useVideoFit("camera");
  const joining = voiceState.status === "joining";
  // "Calling…" is a DM we started that nobody has picked up. Alone in a
  // server Lobby is occupancy, not an outgoing ring.
  const callingOut =
    ringWhenAlone &&
    voiceState.status === "connected" &&
    voiceState.remotePeers.length === 0;
  const ringing = callingOut || (joining && ringWhenAlone);
  const musicPlacement = useMusicPlacement();
  const musicPresence = useMusicStagePresence();
  const musicOnStage = musicPlacement === "stage" && musicPresence.active;
  // Cameras and shares take the overlay bar. Music on the stage is a clip.
  const chromeExpanded = shouldShowExpandedStage(
    hasVideo,
    userCollapsed,
    ringing,
  );
  const musicPictureOnly = isMusicPictureOnlyStage({
    musicOnStage,
    hasLiveVideo: hasVideo,
    ringing,
    watchPartyChrome,
  });
  const collapsed = !chromeExpanded && !musicPictureOnly;
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
  const meshQuality = useVoiceLinkQuality(voiceState.status !== "idle");
  // Only while this machine is the one presenting: the reading it acts on
  // is a *sender* limitation, which no viewer has.
  const uplinkStrained = useShareUplinkStrain(
    voiceState.isSharingScreen,
    videoQuality,
    voiceState.remotePeers.length,
    voiceState.roomTransport,
    // A camera on the same uplink legitimately takes a slice of the share, so
    // the rule has to expect a smaller screen ceiling rather than read it as
    // a weak link.
    voiceState.isCameraOn ? cameraBitrateFor(videoQuality) : 0,
  );
  // Operator-facing telemetry only: fps/bitrate/resolution/limitation-reason
  // for whoever is presenting or watching a screen share, beaconed to
  // GET /api/admin/metrics's streamQuality block. See the hook's own doc
  // comment for the cost bound and the sampling rule.
  useStreamQualityTelemetry(
    voiceState.status !== "idle",
    voiceState.roomTransport,
    currentUser?.id ?? null,
  );

  const speaking = new Set(voiceState.speakingPeerIds);
  const serverMuted = new Set(voiceState.serverMutedPeerIds);
  const selfServerMuted = voiceState.self?.serverMuted === true;
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
        serverMuted: selfServerMuted,
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
      // The hook already keeps a server-muted peer out of `speakingPeerIds`;
      // the second check is so the ring cannot outlive that by one frame.
      speaking: speaking.has(peer.peerId) && !serverMuted.has(peer.peerId),
      muted: rosterByPeerId.get(peer.peerId)?.muted ?? false,
      serverMuted: serverMuted.has(peer.peerId),
      connecting: peer.connectionState !== "connected",
      failed,
      isSelf: false,
      volumeKey,
      volume: voiceState.peerVolumes[volumeKey] ?? 1,
      onSetVolume: onSetPeerVolume
        ? (volume: number) => onSetPeerVolume(volumeKey, volume)
        : undefined,
      // Only while this person's share is actually carrying sound. A second
      // slider for a silent share is a knob that moves nothing.
      shareVolume: voiceState.screenVolumes[volumeKey] ?? 1,
      onSetShareVolume:
        onSetScreenVolume && peer.screenAudioStream != null
          ? (volume: number) => onSetScreenVolume(volumeKey, volume)
          : undefined,
      onRetry:
        failed && onRetryPeer ? () => onRetryPeer(peer.peerId) : undefined,
      quality: peer.quality ?? meshQuality[peer.peerId] ?? null,
    };
  });

  const advertisedTiles = collectScreenTiles({
    peerIds: voiceState.screenSharePeerIds,
    localPeerId: voiceState.peerId,
    localName: currentUser?.displayName ?? t("voice.share.someone"),
    localStream: voiceState.localScreenStream,
    remotePeers: voiceState.remotePeers,
    fallbackName: t("voice.share.someone"),
    liveStream: voiceState.liveStream,
  });
  const readyHlsUrls = useLiveHlsReady(
    advertisedTiles
      .map((tile) => tile.hlsUrl)
      .filter((url): url is string => Boolean(url)),
  );
  // `resolveScreenTileSources` (`screen-stage.tsx`) is the other half of
  // PR 551 ("the SFU screen share is the one and only picture once a seat is
  // held"): that fix stopped a seated participant's OWN room from landing in
  // cinema mode, but this is the same room's ordinary grid, and a peer's
  // tile here carried `hlsUrl` regardless of anyone's seat. Once seated in
  // this watch party, every tile plays over the real WebRTC connection, so
  // the HLS viewer chrome (the live badge, the quality menu, the holding
  // screen) never mounts without one: it only ever ships inside the same
  // `HlsWatchPlayer`, so refusing the HLS source here refuses the chrome too.
  const screenTiles = resolveScreenTileSources(
    advertisedTiles,
    readyHlsUrls,
    watchPartyChrome,
  );
  const watchingHls = screenTiles.some((tile) => Boolean(tile.hlsUrl));
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

  /**
   * The share-audio slider for a tile, or nothing when there is nothing to
   * move: our own share, a silent one, or a caller that did not wire the
   * setter. Keyed on userId so the setting survives a reconnect.
   */
  /** The decline control for a tile, or nothing when the caller did not wire it. */
  function shareDismissControl(tile: ScreenShareTile) {
    if (tile.isSelf || !onDismissShare || !onWatchShare) {
      return undefined;
    }
    const active = voiceState.dismissedSharePeerIds.includes(tile.peerId);
    return {
      active,
      onToggle: () =>
        active ? onWatchShare(tile.peerId) : onDismissShare(tile.peerId),
    };
  }

  function shareAudioControl(tile: ScreenShareTile) {
    if (tile.isSelf) {
      return undefined;
    }
    const key = tile.userId ?? tile.peerId;
    const presenter = remotes.find((person) => person.volumeKey === key);
    const voice =
      presenter?.onSetVolume && !presenter.failed
        ? {
            volume: presenter.volume ?? 1,
            onSetVolume: presenter.onSetVolume,
          }
        : undefined;
    const share =
      !tile.hlsUrl && tile.hasAudio && onSetScreenVolume
        ? {
            volume: voiceState.screenVolumes[key] ?? 1,
            onSetVolume: (volume: number) => onSetScreenVolume(key, volume),
          }
        : undefined;
    return voice || share ? { voice, share } : undefined;
  }
  const receivedShareHasAudio = useReceivedShareAudio(
    focusedIsLocal ? null : screenStream,
  );
  const focusedShareHasAudio = focusedIsLocal
    ? voiceState.isSharingScreenAudio
    : receivedShareHasAudio;
  const allPeople: StagePerson[] = [...(self ? [self] : []), ...remotes];
  const [pinnedTileId, setPinnedTileId] = useState(() =>
    stagePinnedKey(channelId),
  );
  // `audienceMode` used to be a landing view for a watch party's own seated
  // call: full-bleed HLS, no roster or mic controls. `shouldShowCinema`
  // refuses it outright once this IS that party's own room (see
  // `isWatchParty` there for the 2026-09-13 incident it caused — two
  // pictures, two soundtracks, two delays). The state and its effect stay in
  // case a non-watch-party room ever wants this landing view; they are inert
  // wherever a watch party channel is involved.
  const [audienceMode, setAudienceMode] = useState(watchingHls);
  useEffect(() => {
    if (watchingHls) {
      setAudienceMode(true);
    }
  }, [watchingHls]);
  const cinemaTile = screenTiles.find((tile) => Boolean(tile.hlsUrl));
  const showCinema = shouldShowCinema({
    live: Boolean(cinemaTile),
    audience: audienceMode,
    // See `seatedInWatchPartyRoom` and `isWatchPartyChannel`'s doc on
    // `CallStageProps`: `watchPartyChrome` alone can lag a fresh seat by a
    // render and briefly reopen "Entrar na chamada" for someone the party
    // bar's "Entrar no palco" already seated.
    isWatchParty: seatedInWatchPartyRoom(watchPartyChrome, isWatchPartyChannel),
  });
  const presenterPeerId = voiceState.liveStream?.presenterPeerId ?? null;
  const cinemaStagePeople = allPeople.map((person) => ({
    key: person.key,
    name: person.name,
    avatarUrl: person.avatarUrl,
    speaking: person.speaking,
    isHost:
      presenterPeerId != null &&
      (person.isSelf
        ? voiceState.peerId === presenterPeerId
        : person.key === presenterPeerId),
  }));
  // Whether the listener row is showing. Per device, and never reset by a
  // presenter change or a new share: see the preference module. It keeps the
  // storage key the rail used, because it is the same choice ("give the
  // picture the whole stage on this monitor") about the row that replaced it.
  // Read once on mount; the toggle is the only writer.
  const [stripOpen, setStripOpen] = useState(loadParticipantRailOpen);
  const toggleStrip = useCallback(() => {
    setStripOpen((open) => {
      saveParticipantRailOpen(!open);
      return !open;
    });
  }, []);
  useEffect(() => {
    setPinnedTileId(stagePinnedKey(channelId));
  }, [channelId]);
  /**
   * The whole layout, in one call: who is large, who is a chip, and whether
   * our own camera floats. See `stage-layout.ts` for the rules and for the
   * watch party that produced them.
   */
  const stage = planStage({
    screens: screenTiles.map((tile) => ({
      peerId: tile.peerId,
      isSelf: tile.isSelf,
    })),
    people: allPeople,
    pinnedTileId,
    // The grid is bounded, and the bound is the device's, not the room's: a
    // laptop draws twelve pictures and a phone six. Everything past it becomes
    // a chip in the strip, and its stream stops arriving a second later
    // because nothing is bound to it (`remote-video-delivery.ts`).
    tileLimit: wide ? STAGE_TILE_LIMIT_WIDE : STAGE_TILE_LIMIT_NARROW,
    speakingKeys: speaking,
  });
  const staged = insertMusicStageTile(stage.tiles, stage.featured, musicOnStage);
  const overflowKeys = useMemo(
    () => new Set(stage.overflowKeys),
    // The array is rebuilt on every render; only its contents decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stage.overflowKeys.join("|")],
  );
  const listeners = listenersOf(
    allPeople,
    screenTiles,
    voiceState.peerId,
    overflowKeys,
  );
  const gridColumns = stageGridColumns(staged.tiles.length, wide);
  const clickFullscreens = tileClickFullscreens(staged.tiles.length);
  const anyVideo = hasVideo || musicOnStage;
  /**
   * The row exists only when somebody is in it, and only beside a stage.
   *
   * It reserves its own height AND the control bar's band below it, so an
   * empty row is not a blank strip: it is a hundred pixels taken off the
   * picture in a 1:1 call where nobody was ever going to be listed.
   *
   * Music-only skips it: those faces already sit on the call bar.
   */
  const showStrip =
    listeners.length > 0 && staged.tiles.length > 0 && !musicPictureOnly;

  // --- elapsed timer ------------------------------------------------------
  // Starts when the call genuinely has two ends, not while it is still
  // ringing; survives collapse/expand and navigation via the module map.
  const timerKey = voiceState.peerId
    ? callStartKey(channelId, voiceState.peerId)
    : null;
  const timerRunning =
    voiceState.status === "connected" && remotes.length > 0 && timerKey !== null;
  useEffect(() => {
    if (!timerRunning || !timerKey) {
      return;
    }
    markCallStarted(timerKey, Date.now());
  }, [timerRunning, timerKey]);
  const startedAt = timerKey ? callStartedAt(timerKey) : null;

  // --- fullscreen ---------------------------------------------------------
  const stageRef = useRef<HTMLDivElement>(null);
  const cinemaStageRef = useRef<HTMLDivElement>(null);
  const watchFullscreen = useWatchFullscreen(cinemaStageRef);
  const primaryVideoRef = useRef<WebkitFullscreenVideo>(null);
  // Any large picture at all, which since the stage became a grid of
  // publishers is exactly "is anybody publishing". The iPhone native-player
  // path needs one <video> to hand over, and the first tile is it.
  const hasPrimaryVideo = staged.tiles.length > 0 || (self?.stream ?? null) !== null;
  const cameraSoloIds = allPeople
    .filter((person) => person.stream !== null)
    .map((person) => cameraSoloId(person.key));
  const fullscreen = useStageFullscreen(
    stageRef,
    primaryVideoRef,
    hasPrimaryVideo,
    [
      ...voiceState.screenSharePeerIds,
      ...cameraSoloIds,
      ...(musicOnStage ? [MUSIC_STAGE_TILE_ID] : []),
    ],
  );
  // What the pane around us is looking at. Only an expanded stage has a size
  // worth dragging, and only the stage knows whether it is one: `collapsed`
  // folds in a collapse this person toggled in here. `CallSplit` reads it to
  // decide whether to draw a divider at all.
  const shape: CallStageShape =
    fullscreen.isFullscreen || watchFullscreen.active
      ? "fullscreen"
      : collapsed
        ? "compact"
        : "expanded";
  useEffect(() => {
    onShapeChange?.(shape);
  }, [shape, onShapeChange]);
  useEffect(() => {
    // Leaving the call takes the stage with it, and a pane still holding a
    // height for a stage that is gone is a gap where the transcript should be.
    return () => onShapeChange?.("none");
  }, [onShapeChange]);
  useEffect(() => {
    if (!showCinema && watchFullscreen.active) {
      watchFullscreen.exit();
    }
  }, [showCinema, watchFullscreen]);
  // Phone held sideways with a share on: the shell's columns step aside.
  // Everything but the flag lives in the hook (`use-immersive-stage.ts`).
  const immersive = useImmersiveStage({
    shareFocused: screenStream !== null && chromeExpanded,
    fullscreen: fullscreen.isFullscreen,
  });
  // Overlay chrome vs composer dock. Music-only is a picture with the
  // dock kept; fullscreen still takes the overlay so hang-up is reachable
  // with the composer gone.
  const dockControls =
    !chromeExpanded &&
    !fullscreen.isFullscreen &&
    !watchFullscreen.active;
  const dockComposer = dockControls && dockPublish !== null;
  const soloMusic = fullscreen.soloPeerId === MUSIC_STAGE_TILE_ID;
  const soloTile =
    fullscreen.soloPeerId === null ||
    isCameraSoloId(fullscreen.soloPeerId) ||
    soloMusic
      ? null
      : (screenTiles.find((tile) => tile.peerId === fullscreen.soloPeerId) ??
        null);
  // The presenter's own share in a watch party, for `presenterStage`: the
  // ordinary (non-fullscreen) path renders the grid, and the grid is where
  // a lone local share lives, so the swap happens ahead of it.
  const localShare = screenTiles.find((tile) => tile.isSelf) ?? null;
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
    collapsed: collapsed || dockComposer,
  });
  // Cleared rather than merely ignored: a menu that was open when the camera
  // went off must not spring back open by itself when the camera returns.
  useEffect(() => {
    if (qualityMenuRequested && !qualityMenuOpen) {
      setQualityMenuRequested(false);
    }
  }, [qualityMenuRequested, qualityMenuOpen]);
  // --- video-player chrome -------------------------------------------------
  // With a share or a camera on stage the bar and the title overlay fade
  // after a few idle seconds and come back on any pointer move, key or touch;
  // a tap on the picture toggles them on a phone. Nothing hides while a menu
  // from the bar is open, the pointer rests on the bar, focus is inside it
  // (a keyboard user is on the way to hang up) or push-to-talk is held. An
  // audio-only call has nothing under the bar and keeps it put; so does a
  // collapsed stage. Rules and timing: `client/src/hooks/use-idle-chrome.ts`.
  const reducedMotion = usePrefersReducedMotion();
  const [barHovered, setBarHovered] = useState(false);
  const [barFocused, setBarFocused] = useState(false);
  const pushToTalkHeld =
    inputMode === "push-to-talk" &&
    voiceState.isTransmitting &&
    !voiceState.isMuted;
  const chrome = useIdleChrome(
    anyVideo && chromeExpanded,
    qualityMenuOpen || barHovered || barFocused || pushToTalkHeld,
  );
  const chromeClass = idleChromeClassName({
    hidden: chrome.hidden,
    reducedMotion,
  });
  // A touch tap is a down and an up that did not travel. Anything that moved
  // (a scroll on the listener row, a drag on the self preview) is activity.
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
  // The room as the roster describes it, which is where the hands are.
  const roomParticipants = voiceState.voiceChannelId
    ? (voiceState.occupancy[voiceState.voiceChannelId] ?? [])
    : [];
  const showMeshWarning =
    !voiceState.usingSfu && voiceState.remotePeers.length >= MESH_VOICE_WARNING;

  // A pin is now "make that tile the wide one", not a second layout: the
  // stage is a grid either way, and the pinned tile takes the whole first row.
  const togglePin = (tileId: string) => {
    const next = pinnedTileId === tileId ? null : tileId;
    setPinnedTileId(next);
    rememberStagePinnedKey(channelId, next);
  };
  const toggleCameraFullscreen = (key: string) => {
    fullscreen.toggleScreen(cameraSoloId(key));
  };

  // The people on the slim bar: faces, names, hands and the music dock. Built
  // here rather than in the collapsed branch because the control bar lays it
  // out as the leading cell of its own row (see `CallControls`, collapsed).
  const collapsedLeading = collapsed || dockComposer ? (
    (() => {
      const people =
        roster.length > 0
          ? roster.map((person) => {
              const remote = remotes.find((r) => r.key === person.peerId);
              const isSelf = person.peerId === voiceState.peerId;
              return {
                key: person.peerId,
                displayName: person.displayName,
                avatarUrl: person.avatarUrl,
                speaking: isSelf
                  ? Boolean(self?.speaking)
                  : speaking.has(person.peerId),
                volume: remote?.volume,
                onSetVolume: remote?.onSetVolume,
                shareVolume: remote?.shareVolume,
                onSetShareVolume: remote?.onSetShareVolume,
                failed: remote?.failed,
                onRetry: remote?.onRetry,
              };
            })
          : allPeople.map((person) => ({
              key: person.key,
              displayName: person.name,
              avatarUrl: person.avatarUrl,
              speaking: person.speaking,
              volume: person.volume,
              onSetVolume: person.onSetVolume,
              shareVolume: person.shareVolume,
              onSetShareVolume: person.onSetShareVolume,
              failed: person.failed,
              onRetry: person.onRetry,
            }));
      const peopleLine = collapsedPeopleLine({
        connected: voiceState.status === "connected",
        callingOut,
        statusLine,
        peopleLabel: collapsedPeopleLabel(
          people.map((person) => person.displayName),
          (count) => t("call.panel.inCall", { count }),
        ),
      });
      return (
        <div className="flex h-9 min-w-0 items-center gap-2">
          <OccupantFaces faces={people} />
          <p
            className="min-w-0 flex-1 truncate text-sm leading-none text-text"
            role="status"
          >
            {peopleLine}
            {declinedNames.map((name) => (
              <span key={name} className="ml-2 text-warning">
                {t("call.panel.declined", { name })}
              </span>
            ))}
            <CallDuration
              running={timerRunning}
              startedAt={startedAt}
              className="ml-2 tabular-nums text-text-tertiary"
            />
          </p>
          <RaisedHandQueue
            compact
            participants={roomParticipants}
            selfUserId={voiceState.self?.userId ?? null}
          />
        </div>
      );
    })()
  ) : null;

  const controls = (
    <CallControls
      voiceState={voiceState}
      collapsed={collapsed || dockComposer}
      leading={collapsedLeading}
      canExpand={hasVideo}
      userCollapsed={userCollapsed}
      fullscreenAvailable={fullscreen.available && chromeExpanded}
      isFullscreen={fullscreen.isFullscreen}
      onToggleFullscreen={fullscreen.toggle}
      onToggleMute={onToggleMute}
      onToggleCamera={onToggleCamera}
      videoQuality={videoQuality}
      screenFrameRate={screenFrameRate}
      onVideoQualityChange={onVideoQualityChange}
      onScreenFrameRateChange={onScreenFrameRateChange}
      qualityMenuOpen={qualityMenuOpen}
      onQualityMenuOpenChange={setQualityMenuRequested}
      watchingHls={watchingHls}
      hlsDelaySeconds={voiceState.liveStream?.delaySeconds ?? 20}
      onStartScreenShare={onStartScreenShare}
      onStopScreenShare={onStopScreenShare}
      onToggleCollapsed={() => onSetCollapsed(!userCollapsed)}
      onLeave={onLeave}
      pushToTalk={pushToTalk}
      pushToTalkBlocked={pushToTalkBlocked}
      isTransmitting={voiceState.isTransmitting}
      pushToTalkKeyLabel={pushToTalkKeyLabel}
      windowFocused={windowFocused}
      onPushToTalk={onPushToTalk}
      onToggleRaisedHand={onToggleRaisedHand}
      canLowerHands={canLowerHands}
      onLowerHand={onLowerHand}
    />
  );

  if (showCinema && cinemaTile?.hlsUrl) {
    return (
      <div
        ref={cinemaStageRef}
        data-testid="call-stage-cinema"
        className={cn(
          "relative shrink-0 overflow-hidden bg-black",
          fill || watchFullscreen.active
            ? "h-full min-h-0"
            : "h-[68svh] min-h-[280px]",
        )}
      >
        <CinemaStage
          hlsUrl={cinemaTile.hlsUrl}
          cameraHlsUrl={cinemaTile.cameraHlsUrl ?? null}
          cameraHasVideo={cinemaTile.cameraHasVideo}
          cameraHasVoiceAudio={cinemaTile.cameraHasVoiceAudio}
          delaySeconds={cinemaTile.delaySeconds ?? voiceState.liveStream?.delaySeconds}
          mode={
            cinemaTile.mode ??
            hlsModeOf(
              voiceState.liveStream,
            )
          }
          partTargetMs={
            cinemaTile.partTargetMs ??
            hlsPartTargetMs(
              voiceState.liveStream,
            )
          }
          mediaTitle={title}
          communityName={serverName}
          coverUrl={serverIconUrl}
          viewerCount={allPeople.length}
          audience={allPeople.map((person) => ({
            key: person.key,
            name: person.name,
            avatarUrl: person.avatarUrl,
          }))}
          stagePeople={cinemaStagePeople}
          canJoin
          onJoin={() => setAudienceMode(false)}
          fullscreen={{
            active: watchFullscreen.active,
            toggle: watchFullscreen.toggle,
            chatOverlay: watchFullscreen.chatOverlay,
            toggleChatOverlay: watchFullscreen.toggleChatOverlay,
          }}
        />
      </div>
    );
  }

  // `@container`: the bar breaks on its OWN width, not the window's. Inside
  // the composer it is as wide as the chat column, which at 1024px with the
  // member list open is about 450px, far too narrow for one row even though
  // the viewport is `lg`. The tiers are in `CallControls`.
  const dockedBar = (
    <div
      data-testid="call-stage-collapsed"
      className="@container flex flex-col gap-1.5"
    >
      {controls}
      <PttFocusHint
        show={pushToTalk && Boolean(pushToTalkKeyLabel) && !windowFocused}
        className="px-1"
      />
    </div>
  );
  const composerDock = dockPublish ? (
    <CallDockPortal channelId={channelId} publish={dockPublish}>
      {dockedBar}
    </CallDockPortal>
  ) : (
    <div className="border-b border-border bg-surface-0 px-3 py-2">
      <div className="rounded-[var(--radius-card)] border border-border-strong bg-surface-2 px-3 py-2.5">
        {dockedBar}
      </div>
    </div>
  );

  if (collapsed && watchPartyChrome) {
    return null;
  }
  if (collapsed) {
    return composerDock;
  }

  return (
    <div
      ref={stageRef}
      data-testid="call-stage"
      data-music-picture={musicPictureOnly ? "" : undefined}
      className={cn(
        "relative shrink-0 overflow-hidden border-b border-ink-4/60 bg-ink",
        fullscreen.isFullscreen
          ? fullscreen.mode === "element"
            ? "h-full max-h-none"
            : // In-page fullscreen. `fixed inset-0` rather than a viewport
              // height unit because on an iPhone those overshoot the visible
              // area and hide the exit control under Safari's toolbar, which
              // is how somebody gets stuck in a fullscreen they cannot leave.
              `fixed inset-0 ${STAGE_LAYER.fullscreen} h-auto max-h-none`
          : fill
            ? // The divider owns the number now. `min-h-0` rather than a
              // floor, because the floor is enforced in `clampSplit` against
              // the live pane: a second one here would fight it.
              "h-full min-h-0"
            : anyVideo
              ? "h-[68svh] min-h-[280px]"
              : "h-[38svh] max-h-[420px] min-h-[220px]",
      )}
      onPointerMove={(event) => {
        // Touch "moves" are scrolls and drags, answered on pointer up.
        if (event.pointerType !== "touch") {
          chrome.wake();
        }
      }}
      onPointerDown={onStagePointerDown}
      onPointerUp={onStagePointerUp}
      onPointerCancel={() => {
        touchDownRef.current = null;
      }}
      onKeyDownCapture={chrome.wake}
      onFocusCapture={chrome.wake}
    >
      {/* --- the stage's content -------------------------------------------
          One rule, whatever the transport carried it: a picture is a tile and
          a listener is a chip. `stage-layout.ts` decides which is which; this
          only draws it. Nothing is mounted twice, so the number of live
          `<video>` elements is exactly the number of pictures on screen, which
          is what the SFU's delivery rule reads (`remote-video-delivery.ts`).
      */}
      {showMeshWarning && (
        <p className={cn("absolute inset-x-0 top-0 bg-warning/10 px-3 py-1 text-center text-xs text-warning", STAGE_LAYER.badges)}>
          {t("voice.meshWarning")}
        </p>
      )}
      <div className="flex h-full w-full flex-col">
        <div className="relative min-h-0 flex-1">
          {soloPerson ? (
            /* One camera alone on the stage, from a click on its tile or from
               its own button. The stage is already fullscreen; this only
               decides what is on it. */
            <PrimaryTile
              person={soloPerson}
              videoRef={primaryVideoRef}
              isFullscreen
              onToggleFullscreen={() => toggleCameraFullscreen(soloPerson.key)}
              onPin={() => togglePin(cameraSoloId(soloPerson.key))}
              pinned={pinnedTileId === cameraSoloId(soloPerson.key)}
            />
          ) : soloMusic ? (
            <MusicStageTile
              title={musicPresence.title}
              addedByUserId={musicPresence.addedByUserId}
              addedByName={musicPresence.addedByName}
              voiceState={voiceState}
              isFullscreen
              onToggleFullscreen={() => fullscreen.toggleScreen(MUSIC_STAGE_TILE_ID)}
              className="h-full w-full bg-surface-0"
            />
          ) : soloTile && soloTile.isSelf && watchPartyChrome && presenterStage ? (
            presenterStage(soloTile.stream)
          ) : soloTile ? (
            /* The same for a share. Switching between the two costs no
               platform call, which is why they share one solo id. */
            <ScreenTileFrame
              tile={soloTile}
              videoRef={primaryVideoRef}
              isFullscreen
              /* The header overlay already names a lone presenter; a second
                 label on the picture is the same sentence twice. */
              showName={screenTiles.length > 1}
              onToggleFullscreen={() => fullscreen.toggleScreen(soloTile.peerId)}
              audio={shareAudioControl(soloTile)}
              dismissed={shareDismissControl(soloTile)}
              className="h-full w-full bg-black"
              mediaTitle={title}
              communityName={serverName}
              coverUrl={serverIconUrl}
            />
          ) : watchPartyChrome &&
            presenterStage &&
            localShare &&
            // ONLY WHEN OURS IS THE ONLY SHARE (Farol, 2026-09-14). This used
            // to fire on `localShare` alone, so a co-host or an invited guest
            // sharing at the same time as the host lost their picture off the
            // stage entirely the moment the host's own share substituted the
            // presenter's monitor-and-activity layout for the grid. A watch
            // party with more than one screen up is rare but not refused
            // anywhere upstream (guests, `docs/plans/WATCH_PARTY_GUESTS.md`),
            // so the grid — which already draws every tile, ours included —
            // is what a second share falls back to correctly.
            screenTiles.length === 1 ? (
            presenterStage(localShare.stream)
          ) : staged.tiles.length > 0 ? (
            <ul
              data-testid="stage-grid"
              data-columns={gridColumns}
              className={cn(
                "grid h-full w-full",
                // One publisher owns the stage edge to edge, the way a single
                // share always has. Padding is what separates tiles from each
                // other, so with nothing to separate it is only a border of
                // wasted picture.
                staged.tiles.length > 1 && "gap-2 p-2",
              )}
              style={{
                gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
                // The featured row (a pin, or the one screen a crowded room
                // is watching) gets twice the height of the rows under it.
                // Without it a share at the top of a three-row grid is a third
                // of the stage, which is not "featured" in any useful sense.
                gridTemplateRows: staged.featured ? "minmax(0, 2fr)" : undefined,
                // Equal rows for the rest. Without this they size to content,
                // and a tile whose picture is absolutely positioned has none.
                gridAutoRows: "minmax(0, 1fr)",
              }}
            >
              {staged.tiles.map((tile, index) => {
                const wideRow = staged.featured && index === 0 && gridColumns > 1;
                const videoRef = index === 0 ? primaryVideoRef : undefined;
                const pinned = pinnedTileId === tile.id;
                if (tile.kind === "music") {
                  return (
                    <li
                      key={tile.id}
                      className={cn(
                        "relative min-h-0 overflow-hidden bg-surface-0",
                        staged.tiles.length > 1 && "rounded-xl",
                        wideRow && "col-span-full",
                      )}
                    >
                      <MusicStageTile
                        title={musicPresence.title}
                        addedByUserId={musicPresence.addedByUserId}
                        addedByName={musicPresence.addedByName}
                        voiceState={voiceState}
                        clickToFullscreen={clickFullscreens}
                        onToggleFullscreen={() =>
                          fullscreen.toggleScreen(MUSIC_STAGE_TILE_ID)
                        }
                        className="h-full w-full"
                      />
                    </li>
                  );
                }
                if (tile.kind === "screen") {
                  const screenTile = screenTiles.find(
                    (candidate) => candidate.peerId === tile.key,
                  );
                  if (!screenTile) {
                    return null;
                  }
                  return (
                    <li
                      key={tile.id}
                      className={cn(
                        "relative min-h-0 overflow-hidden bg-black",
                        staged.tiles.length > 1 && "rounded-xl",
                        wideRow && "col-span-full",
                      )}
                    >
                      <ScreenTileFrame
                        tile={screenTile}
                        videoRef={videoRef}
                        isFullscreen={false}
                        showName={staged.tiles.length > 1}
                        clickToFullscreen={clickFullscreens}
                        onToggleFullscreen={() => {
                          // Keep the header's "X is presenting" line pointing
                          // at the share the person just acted on.
                          onFocusScreenShare?.(screenTile.peerId);
                          fullscreen.toggleScreen(screenTile.peerId);
                        }}
                        onPin={
                          staged.tiles.length > 1
                            ? () => togglePin(tile.id)
                            : undefined
                        }
                        pinned={pinned}
                        audio={shareAudioControl(screenTile)}
                        dismissed={shareDismissControl(screenTile)}
                        className="h-full w-full"
                        mediaTitle={title}
                        communityName={serverName}
                        coverUrl={serverIconUrl}
                      />
                    </li>
                  );
                }
                const person = allPeople.find(
                  (candidate) => candidate.key === tile.key,
                );
                if (!person) {
                  return null;
                }
                return (
                  <CameraTile
                    key={tile.id}
                    person={person}
                    videoRef={videoRef}
                    youLabel={t("voice.tile.you")}
                    wideRow={wideRow}
                    rounded={staged.tiles.length > 1}
                    clickToFullscreen={clickFullscreens}
                    onToggleFullscreen={() => toggleCameraFullscreen(person.key)}
                    onPin={
                      staged.tiles.length > 1
                        ? () => togglePin(tile.id)
                        : undefined
                    }
                    pinned={pinned}
                  />
                );
              })}
            </ul>
          ) : ringing ? (
            <RingView
              faces={ringFaces}
              joining={joining}
              label={statusLine ?? t("call.panel.calling")}
            />
          ) : (
            /* Nobody is publishing. Not an empty box: the people who ARE here,
               large, in the middle. It is the same room the strip describes,
               and the state a voice call spends most of its life in. */
            <RoomView people={listeners} youLabel={t("voice.tile.you")} />
          )}
        </div>
        {/* The strip: everybody the stage did not take. Skipped while one
            picture is alone on the stage (that is what "alone" means) and
            while nobody is publishing at all, because then the room view above
            is already showing these same faces, larger. */}
        {showStrip && !soloPerson && !soloTile && !soloMusic && (
          <>
          <ListenerStrip
            people={listeners.map((person) => ({
              key: person.key,
              name: person.name,
              avatarUrl: person.avatarUrl,
              speaking: person.speaking,
              muted: person.muted,
              serverMuted: person.serverMuted,
              isSelf: person.isSelf,
              volume: person.volume,
              onSetVolume: person.onSetVolume,
              failed: person.failed,
              onRetry: person.onRetry,
            }))}
            limit={wide ? STRIP_LIMIT_WIDE : STRIP_LIMIT_NARROW}
            open={stripOpen}
            onToggle={toggleStrip}
            youLabel={t("voice.tile.you")}
            compact={compactPeers}
            /* Above the control bar in the stacking order, because the bar is
               a full-width box that deliberately keeps its pointer events even
               while faded (`use-idle-chrome.ts`), and its gradient reaches up
               over this row. Without this a chip is drawn and cannot be
               pressed, which is the worst of both. */
            className={STAGE_LAYER.menus}
          />
          {/* The bar's own territory. The strip stops here so the hang-up
              button is never under a chip, and the chips are never under the
              bar's box. Grows with the home indicator, like the bar does. */}
          <div
            aria-hidden="true"
            className="h-[max(4rem,calc(env(safe-area-inset-bottom)+3.5rem))] shrink-0"
          />
          </>
        )}
      </div>

      {/* Self-preview: our own camera, floating, in the one shape that earns
          it — somebody else is publishing exactly one picture, so the stage
          belongs to them (`stage-layout.ts`). Hidden while our own camera is
          the thing blown up: a preview of the picture filling the screen. */}
      {stage.selfPreview && self && !soloPerson?.isSelf && (
        <div
          data-call-tile={self.name}
          data-call-pip=""
          role="group"
          aria-label={t("call.stage.selfPreview")}
          className={cn(
            "absolute touch-none overflow-hidden rounded-lg bg-ink-3 shadow-lg ring-1 ring-ink-4/80",
            STAGE_LAYER.tileControls,
            compactPeers ? "w-24 sm:w-32" : "w-28 sm:w-40",
            pipDrag ? "cursor-grabbing" : "cursor-grab",
            !pipDrag &&
              (showStrip
                ? PIP_CORNER_CLASS_WITH_STRIP
                : PIP_CORNER_CLASS)[pipCorner],
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
                className={cn("h-full w-full", videoFitClass(selfFit.fit))}
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
            <TileBadge
              name={t("voice.tile.you")}
              muted={self.muted}
              serverMuted={self.serverMuted}
            />
          </div>
        </div>
      )}

      {/* --- overlays -------------------------------------------------------- */}
      {voiceState.error && (
        <div
          role="alert"
          data-voice-error
          className={cn("absolute inset-x-0 top-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-danger/15 px-3 py-1.5 text-center text-xs text-danger", STAGE_LAYER.state)}
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
      {!voiceState.error && <VoiceNoticeBar notice={voiceState.notice} />}

      {dockComposer ? (
        composerDock
      ) : (
        <>
      <div
        data-call-chrome="overlay"
        data-chrome-hidden={chrome.hidden ? "true" : "false"}
        className={cn(
          STAGE_LAYER.chrome,
          "pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-ink/70 to-transparent pb-2 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))]",
          chromeClass,
          (voiceState.error || voiceState.notice) && "mt-7",
          // THE PRESENTER'S OWN SHARE IN A WATCH PARTY carries no overlay
          // (2026-09-13): the party header one row up already says the name,
          // the count and the uptime, and "watch-party · 1 na chamada" over
          // the host's own tab was the fifth strip between them and their
          // picture. A phone cannot share, so the landscape toggle this
          // overlay also holds is never wanted here.
          watchPartyChrome && focusedIsLocal && "hidden",
        )}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-paper">
            {title}
          </p>
          <p className="truncate text-xs text-paper-muted" role="status">
            {/* RingView already says Connecting/Calling at centre stage.
                A video-call ring puts our own camera on the stage instead, so
                the overlay still has to carry that line. */}
            {ringing && stage.tiles.length === 0
              ? null
              : (statusLine ??
                t("call.panel.inCall", { count: remotes.length + 1 }))}
            {!voiceState.canSpeak && (
              <span className="ml-2 text-warning">{t("voice.bar.listenOnly")}</span>
            )}
            {declinedNames.map((name) => (
              <span key={name} className="ml-2 text-warning">
                {t("call.panel.declined", { name })}
              </span>
            ))}
            {/* NOT FOR A WATCH PARTY (2026-09-13): the presenter dock one row
                up already says Trocar / Parar de compartilhar, which is this
                sentence as buttons. Duplicate status on a fading overlay is
                what the presenter-UI plan set out to remove. */}
            {presenterName && screenStream && !watchPartyChrome && (
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
                {/* Said while it is happening, so the presenter knows the
                    machine's output is going out. The call itself is kept
                    out of that tap (`restrictOwnAudio`). */}
                {voiceState.isSharingSystemAudio && (
                  <span className="ml-1 block text-paper-muted">
                    {t("voice.share.systemAudioLive")}
                  </span>
                )}
                {/* The honest half of the cursor preference. They asked for
                    the pointer to be left out, they picked a screen or a
                    window, and no browser can leave it out of one of those.
                    Said here rather than swallowed, with the surface that
                    genuinely has no pointer named: a tab, which the shell's
                    picker does not have, hence the desktop wording. */}
                {focusedIsLocal && voiceState.isShareCursorVisible && (
                  <span className="ml-1 block text-warning">
                    {t("voice.share.cursorLive", desktopContext())}
                  </span>
                )}
                {/* The answer to "a qualidade tá péssima", said to the one
                    person who can act on it and only when it is true. Not
                    `limitedBy` directly: the encoder calls our own maxBitrate
                    a bandwidth limit, so this would otherwise accuse the
                    connection of everybody who simply picked 480p. See
                    `useShareUplinkStrain` for the streak that keeps it off a
                    share that is merely ramping up. */}
                {focusedIsLocal && uplinkStrained && (
                  <span className="ml-1 block text-warning">
                    {t("voice.share.uplinkStrained")}
                  </span>
                )}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CallDuration
            running={timerRunning}
            startedAt={startedAt}
            className="rounded bg-ink/60 px-1.5 py-0.5 text-xs tabular-nums text-paper-muted"
          />
          {/* The way back from the landscape takeover, and the way into it
              again. Only on a phone held sideways with a share on. */}
          {(immersive.canDismiss || immersive.dismissed) && (
            <button
              type="button"
              data-testid="stage-immersive-toggle"
              aria-pressed={immersive.dismissed}
              aria-label={
                immersive.dismissed
                  ? t("voice.share.hideChat")
                  : t("voice.share.showChat")
              }
              className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full bg-ink/60 text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={immersive.dismissed ? immersive.restore : immersive.dismiss}
            >
              {immersive.dismissed ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeftOpen className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>

      <div
        data-call-chrome="bar"
        data-testid="call-controls-bar"
        data-chrome-hidden={chrome.hidden ? "true" : "false"}
        className={cn(
          // ON A WATCH PARTY CHANNEL THIS BAR STANDS DOWN A RUNG, so the
          // party's controls win any overlap whatever `watchPartyChrome`
          // believes. Keyed on the channel's own TYPE, which never lags the
          // party store. The whole account is on `callControlsLayer`.
          callControlsLayer(isWatchPartyChannel),
          // THE BAR KEEPS THE POINTER ON ITS WHOLE BOX, gradient included:
          // resting the pointer anywhere on it pins it open, which
          // `dm-call-screen-share.spec.ts` pins on purpose (a hand parked
          // at the bottom of the screen is how people watch). The player's
          // bars went inert on their gradients in pass 5; this one did not.
          // UNDER THE PARTY CHROME THIS BAR HAS NO BUTTONS (`controls` is
          // null below), so it must not paint or take the pointer either:
          // on staging it faded in on hover as a dark band over the party
          // bar and made Trocar / Parar / Áudio unclickable. It keeps only
          // the notices, which take their own clicks.
          watchPartyChrome
            ? "pointer-events-none [&>*]:pointer-events-auto"
            : "bg-gradient-to-t from-ink/80 to-transparent",
          "absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-8",
          chromeClass,
        )}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") {
            setBarHovered(true);
          }
        }}
        onPointerLeave={() => setBarHovered(false)}
        // A press on the bar while it is invisible only brings it back. The
        // mouse move before a click has already done that, so this is the
        // touch case: a thumb on the picture, right where the hang-up button
        // happens to be.
        onPointerDownCapture={swallowPressWhileHidden}
        onClickCapture={swallowPressWhileHidden}
        onFocusCapture={() => setBarFocused(true)}
        onBlurCapture={onBarBlur}
      >
        <MicFallbackNotice
          micFallback={voiceState.micFallback}
          visible={!chrome.hidden}
          onDismiss={onDismissMicFallbackNotice}
        />
        <CapacityNotice
          voiceChannelId={voiceState.voiceChannelId}
          transport={voiceState.roomTransport}
          roseFrom={voiceState.capacityRoseFrom}
          visible={!chrome.hidden}
        />
        <CinemaHint visible={screenStream !== null} />
        {watchPartyChrome ? null : controls}
      </div>
        </>
      )}
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

/**
 * The call clock. It ticks in this component so a speaking or roster update
 * does not have to republish the whole dock just to advance "0:07".
 */
function CallDuration({
  running,
  startedAt,
  className,
}: {
  running: boolean;
  startedAt: number | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === null) {
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);
  if (!running || startedAt === null) {
    return null;
  }
  return (
    <span className={className} aria-label={t("call.stage.duration")}>
      {formatCallDuration(now - startedAt)}
    </span>
  );
}

/**
 * The control bar under the stage. Exported for the unit test that pins the
 * audience rule below; `CallStage` is the only runtime caller.
 */
export function CallControls({
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
  screenFrameRate,
  onVideoQualityChange,
  onScreenFrameRateChange,
  qualityMenuOpen,
  onQualityMenuOpenChange,
  watchingHls = false,
  hlsDelaySeconds = 10,
  onStartScreenShare,
  onStopScreenShare,
  onToggleCollapsed,
  onLeave,
  pushToTalk = false,
  pushToTalkBlocked = false,
  isTransmitting = true,
  pushToTalkKeyLabel = null,
  windowFocused = true,
  onPushToTalk,
  onToggleRaisedHand,
  canLowerHands = false,
  onLowerHand,
  leading = null,
}: {
  voiceState: VoiceState;
  collapsed: boolean;
  /**
   * Collapsed only: the people cell (faces, names, hands, music) that the
   * bar lays out ahead of its controls. Owned by the row so the hold-to-talk
   * pill can take the space between the people and the tiles.
   */
  leading?: ReactNode;
  canExpand: boolean;
  userCollapsed: boolean;
  fullscreenAvailable: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  videoQuality: VideoQuality;
  screenFrameRate?: ScreenFrameRate;
  onVideoQualityChange: (quality: VideoQuality) => void;
  onScreenFrameRateChange?: (rate: ScreenFrameRate) => void;
  qualityMenuOpen: boolean;
  onQualityMenuOpenChange: (open: boolean) => void;
  watchingHls?: boolean;
  hlsDelaySeconds?: number;
  onStartScreenShare?: (
    intent?: { preferBrowserTab?: boolean },
  ) => void | Promise<void>;
  onStopScreenShare?: () => void;
  onToggleCollapsed: () => void;
  onLeave: () => void;
  pushToTalk?: boolean;
  pushToTalkBlocked?: boolean;
  isTransmitting?: boolean;
  pushToTalkKeyLabel?: string | null;
  windowFocused?: boolean;
  onPushToTalk?: (held: boolean) => void;
  /** Our own hand, up or down. Absent leaves the control off the bar. */
  onToggleRaisedHand?: () => void;
  /** `Permission.MUTE_MEMBERS` here: may lower somebody else's hand. */
  canLowerHands?: boolean;
  onLowerHand?: (userId: string) => void;
}) {
  const { t } = useTranslation();
  // Probed once per mount — whether the browser has getDisplayMedia never
  // changes mid-session. Same probe the channel voice panel uses.
  const canShare = useMemo(() => supportsScreenShare(), []);
  // Watch party is a Chrome tab plus that tab's sound. The shell picker
  // lists screens and windows only, so the same door there would start a
  // silent share and the prompt would be a lie.
  const canWatchParty = canShare && !isDesktopApp();
  // Remembered per person, so it is read from its own store rather than passed
  // down with the rest. Unlike the sound opt-in beside it, this one is only
  // still useful mid-share where the engine can change a live track, which is
  // nowhere today: see `lib/screen-capture-cursor.ts`.
  const shareCursor = useShareCursor();
  const hidePreviewPref = useHideScreenPreview();
  const joinLeaveAutoMute = useJoinLeaveAutoMuteEnabled();
  const cursorLiveControl = useMemo(() => canControlShareCursor(), []);
  const watchPartyHintEnabled = useFeatureHintEnabled("watchParty");
  // "The controls moved down here." Once, the first time the dock opens.
  // Pressing any control in the dock is proof enough that they were found,
  // so one capture handler on the row closes the card; the impression is
  // already recorded by then (`FeatureHint` remembers on first paint), so it
  // does not come back either way.
  const callDockHintEnabled = useFeatureHintEnabled("callDock");
  const [dockControlUsed, setDockControlUsed] = useState(false);
  const bringFriendsHintEnabled = useFeatureHintEnabled("bringFriends");
  const musicHintEnabled = useFeatureHintEnabled("music");
  const musicDock = useMusicDock();
  const [shareHint, setShareHint] = useState<string | null>(null);
  useEffect(() => {
    if (voiceState.isSharingScreen || voiceState.error) {
      setShareHint(null);
    }
  }, [voiceState.isSharingScreen, voiceState.error]);
  const meshLink = meshRoomLinkOf(voiceState);
  const shareAtCap = isScreenShareAtCap(
    voiceState.screenSharePeerIds,
    voiceState.peerId,
    voiceState.roomTransport,
    voiceState.canPromoteTransport,
    meshLink,
  );
  const shareLimit = videoLimitOf(voiceState, "screens");
  // The cap only bites somebody who is not already one of the shares.
  const shareCappedOut = shareAtCap && !voiceState.isSharingScreen;
  const cameraAtCap = isCameraAtCap(
    voiceState.cameraPeerIds,
    voiceState.peerId,
    voiceState.roomTransport,
    voiceState.canPromoteTransport,
    meshLink,
  );
  const cameraLimit = videoLimitOf(voiceState, "cameras");
  const cameraCappedOut = cameraAtCap && !voiceState.isCameraOn;
  const size = collapsed ? "h-9 w-9" : "h-10 w-10";
  const iconSize = collapsed ? "h-4 w-4" : "h-4 w-4";
  // SPEAK denied locks mute. STREAM denied hides camera and share. The two
  // bits are independent: a stage can let someone present without talking.
  // In a watch_party channel the server answers `canStream` from
  // START_WATCH_PARTY instead of STREAM (`canStartWatchPartyStream` in
  // @pqp/shared), so the audience gets neither the share button nor the
  // Watch party button below, and `set-sharing-screen` would be refused for
  // them anyway. One grant, read once, hides both.
  const listenOnly = !voiceState.canSpeak;
  const noVideo = !voiceState.canStream;
  // The room as the roster describes it, which is where the hands are. Self
  // included: your own hand is in the same queue as everybody else's.
  const roomParticipants = voiceState.voiceChannelId
    ? (voiceState.occupancy[voiceState.voiceChannelId] ?? [])
    : [];
  const handRaised = voiceState.handRaisedAt !== null;
  const handLabel = handRaised
    ? t("voice.hand.lower")
    : t("voice.hand.raise");

  const showMute = !collapsed || !pushToTalk;

  return (
    <div
      className={cn(
        "flex flex-col",
        collapsed ? "w-full gap-0" : "items-center gap-1.5",
      )}
    >
      <div data-call-hints>
        {collapsed && callDockHintEnabled && (
          <div className="pointer-events-auto mb-2">
            <FeatureHint
              id="callDock"
              enabled={!dockControlUsed}
              title={t("featureHint.callDock.title")}
              body={t("featureHint.callDock.body")}
            />
          </div>
        )}
        {watchPartyHintEnabled && canWatchParty && !listenOnly && !noVideo && (
          <div className="pointer-events-auto mb-1">
            <FeatureHint
              id="watchParty"
              enabled
              body={t("featureHint.watchParty.body")}
            />
          </div>
        )}
        {bringFriendsHintEnabled && voiceState.isSharingScreen && !collapsed && (
          <div className="pointer-events-auto mb-1">
            <BringFriendsHint enabled />
          </div>
        )}
        {musicHintEnabled && (
          <div className="pointer-events-auto mb-1">
            <FeatureHint
              id="music"
              enabled
              title={t("featureHint.music.title")}
              body={t("featureHint.music.body")}
            />
          </div>
        )}
      </div>

      {/* The queue sits above the bar, where the room is, rather than in a
          panel somebody has to go and open. Hidden on the slim bar, which has
          no room for a list: the hands are still on every person's row in the
          sidebar, and the raise button below survives the squeeze because
          unlike mute it has nowhere else to live. */}
      {!collapsed && (
        <RaisedHandQueue
          participants={roomParticipants}
          selfUserId={voiceState.self?.userId ?? null}
          canLowerHands={canLowerHands}
          onLowerHand={onLowerHand}
          className="mb-1.5"
        />
      )}
      {/* THE SLIM BAR IS ONE ROW WHEN IT FITS, AND FOLDS FROM THE LEFT.
          Its cells are the people, the hold-to-talk pill (push-to-talk only)
          and the tiles. Breakpoints are container queries against the bar's
          OWN width (`@container` on the collapsed root in `ActiveCall`),
          because inside the composer the bar is as wide as the chat column,
          not the window.

          - under 35rem: people / pill / tiles, one per line, tiles right.
          - 35rem and up: the pill sits beside the tiles and takes the space
            between; the people keep a line of their own. Without a pill the
            people and the tiles share one line already.
          - 48rem and up (`@3xl`): people, pill, tiles on one line.

          35rem is where the pt-BR pill ("Segura pra falar" plus its key
          chip, ~12rem) still fits beside the full set of tiles (~21.5rem).
          The pill is capped at 22rem so a 1440px window does not turn it
          into a slab; what it leaves goes to the people. */}
      <div
        className={cn(
          "flex items-center gap-2",
          collapsed
            ? "w-full flex-col @min-[35rem]:flex-row @min-[35rem]:flex-wrap @min-[35rem]:gap-x-3 @min-[35rem]:gap-y-2"
            : "flex-wrap justify-center",
        )}
        // Capture, so the pill's pointerdown and every tile's click count,
        // including the ones that open a menu and stop propagation.
        onPointerDownCapture={
          collapsed && callDockHintEnabled && !dockControlUsed
            ? (event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest("button")
                ) {
                  setDockControlUsed(true);
                }
              }
            : undefined
        }
      >
        {collapsed && leading && (
          <div
            className={cn(
              "flex h-9 min-w-0 items-center",
              // Sized to its content: what the row has spare goes to the
              // pill, and past the pill's cap to the gap before the tiles.
              pushToTalk
                ? "@min-[35rem]:basis-full @3xl:basis-auto"
                : "@min-[35rem]:basis-auto",
            )}
          >
            {leading}
          </div>
        )}
        {pushToTalk && (
          <PttHoldControl
            blocked={pushToTalkBlocked}
            listenOnly={listenOnly}
            isTransmitting={isTransmitting}
            keyLabel={pushToTalkKeyLabel}
            windowFocused={windowFocused}
            inBar={collapsed}
            onPushToTalk={onPushToTalk}
          />
        )}
    {/* The tile row wraps rather than clips. On a 360 phone the bar is
        ~238px wide and six 36px tiles fill it to the pixel (mute, hand,
        camera, share, music, leave; cursor, watch party and bell hide
        under 22rem). Anything the width budget did not foresee goes to a
        second line, where it can still be pressed, instead of off the edge. */}
    <div
      className={cn(
        "flex items-center gap-1",
        collapsed
          ? "w-full flex-wrap justify-end @min-[35rem]:ml-auto @min-[35rem]:w-auto @min-[35rem]:shrink-0"
          : "gap-2 rounded-full bg-ink-2/90 px-2.5 py-1.5 shadow-lg ring-1 ring-ink-4/60 backdrop-blur",
      )}
    >
      {/* Every control in this bar used to carry a `title` beside its
          `aria-label`: two copies of one string, a one-second wait, and
          nothing at all for a keyboard. The `Tooltip` is one copy, quicker,
          and it opens on focus. */}
      {/* Mute stays on the expanded stage, and on the slim bar when the
          input mode is voice activity. Push-to-talk owns the mic there. */}
      {showMute && (
        <Tooltip
          label={
            listenOnly
              ? t("voice.control.listenOnlyLocked")
              : voiceState.self?.serverMuted
                ? t("voice.control.serverMuted")
                : voiceState.isMuted
                  ? t("voice.control.unmute")
                  : t("voice.control.mute")
          }
          detail={
            !listenOnly && voiceState.self?.serverMuted
              ? t("voice.serverMuted.self")
              : undefined
          }
        >
          {/* Neither a listen-only lock nor a moderator's mute is this
              person's to lift, so the button says so and does nothing,
              rather than flicking to "unmuted" for a frame and snapping back
              on the next roster. The wrapper span is what the tooltip
              hovers, since a disabled button drops pointer events. */}
          <span className="inline-flex">
            <button
              type="button"
              aria-pressed={voiceState.isMuted}
              disabled={listenOnly || voiceState.self?.serverMuted === true}
              aria-label={
                listenOnly
                  ? t("voice.control.listenOnlyLocked")
                  : voiceState.self?.serverMuted
                    ? t("voice.control.serverMuted")
                    : voiceState.isMuted
                      ? t("voice.control.unmute")
                      : t("voice.control.mute")
              }
              className={cn(
                "flex items-center justify-center rounded-full disabled:cursor-not-allowed",
                size,
                !listenOnly && voiceState.self?.serverMuted
                  ? "bg-warning/20 text-warning"
                  : voiceState.isMuted
                    ? "bg-danger/20 text-danger"
                    : "bg-ink-3 text-paper hover:bg-ink-4",
                listenOnly && "opacity-60",
              )}
              onClick={onToggleMute}
            >
              {!listenOnly && voiceState.self?.serverMuted ? (
                <ShieldBan className={iconSize} />
              ) : voiceState.isMuted ? (
                <MicOff className={iconSize} />
              ) : (
                <Mic className={iconSize} />
              )}
            </button>
          </span>
        </Tooltip>
      )}
      {listenOnly && !collapsed && (
        <span
          data-listen-only
          className="shrink-0 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning"
        >
          {t("voice.bar.listenOnly")}
        </span>
      )}
      <CallControlGroup>
      {/* Raising a hand is the one control here that a listen-only seat needs
          MORE than anyone else, so it is never hidden by `listenOnly` and
          never disabled: lowering your own hand has to work whatever else the
          room has decided about you. It also survives the collapsed bar,
          because unlike mute it has no second home on the user panel. */}
      {onToggleRaisedHand && (
        <Tooltip label={handLabel}>
          <button
            type="button"
            aria-pressed={handRaised}
            aria-label={handLabel}
            data-raise-hand={handRaised ? "up" : "down"}
            className={cn(
              "flex items-center justify-center rounded-full",
              size,
              handRaised
                ? "bg-signal/20 text-signal"
                : "bg-ink-3 text-paper hover:bg-ink-4",
            )}
            onClick={onToggleRaisedHand}
          >
            <Hand className={iconSize} />
          </button>
        </Tooltip>
      )}
      </CallControlGroup>
      <CallControlDivider
        container={collapsed}
        className={collapsed ? "my-1" : "my-1.5"}
      />
      <CallControlGroup>
      {!noVideo && (
      <Tooltip
        label={
          voiceState.isCameraOn
            ? t("call.panel.cameraOn")
            : t("call.panel.cameraOff")
        }
        detail={
          cameraCappedOut
            ? t("voice.control.cameraLimit", { limit: cameraLimit ?? 0 })
            : undefined
        }
      >
        <button
          type="button"
          aria-pressed={voiceState.isCameraOn}
          aria-disabled={cameraCappedOut || undefined}
          aria-label={
            voiceState.isCameraOn
              ? t("call.panel.cameraOn")
              : t("call.panel.cameraOff")
          }
          className={cn(
            "flex items-center justify-center rounded-full",
            size,
            cameraCappedOut && "opacity-40",
            voiceState.isCameraOn
              ? "bg-signal/20 text-signal"
              : "bg-ink-3 text-paper hover:bg-ink-4",
          )}
          onClick={() => {
            if (cameraCappedOut) {
              return;
            }
            onToggleCamera();
          }}
        >
          {voiceState.isCameraOn ? (
            <Video className={iconSize} />
          ) : (
            <VideoOff className={iconSize} />
          )}
        </button>
      </Tooltip>
      )}
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
          screenFrameRate={screenFrameRate}
          onScreenFrameRateChange={onScreenFrameRateChange}
          isSendingVideo={voiceState.isCameraOn || voiceState.isSharingScreen}
          isSharingScreen={voiceState.isSharingScreen}
          usingSfu={voiceState.usingSfu}
          watchingHls={watchingHls}
          hlsLive={voiceState.liveStream !== null}
          hlsDelaySeconds={hlsDelaySeconds}
          participantCount={voiceState.remotePeers.length + 1}
          buttonClassName={size}
          iconClassName={iconSize}
        />
      )}
      {/* Whether your mouse pointer goes out with the share.
          THE REPORT (QG, 5 Sep 2026): a film shared from one window while the
          person plays a game in another, and the pointer drawn over the film
          every time it moves. Presenting wants the opposite: pointing at
          things IS the share. So it is a preference, and it is remembered,
          which a one-off audio opt-in deliberately is not.
          Armed before the share, like that one, and it stays put mid-share
          only where the engine can change a live track. Today no engine
          implements the constraint at all, so what a `hide` actually buys is
          the line under the share saying this surface carries the pointer and
          a tab does not. `lib/screen-capture-cursor.ts` has the measurements. */}
      {canShare &&
        !noVideo &&
        onStartScreenShare &&
        (!voiceState.isSharingScreen || cursorLiveControl) && (
          <Tooltip
            label={
              shareCursor === "hide"
                ? t("voice.control.showCursor")
                : t("voice.control.hideCursor")
            }
            detail={
              cursorLiveControl
                ? undefined
                : t("voice.control.hideCursorDetail")
            }
          >
            {/* KEEP THE LABEL SHORT AND FREE OF COMMON VERBS. A tooltip label
                becomes the control's accessible name, and Playwright's
                `getByRole("button", { name })` matches a name by SUBSTRING, so
                an English label reading "Leave your mouse out of what you
                share" made every `name: "Leave"` in the suite ambiguous and
                took the hang-up button down with it. */}
            <button
              type="button"
              data-testid="share-cursor-toggle"
              aria-pressed={shareCursor === "hide"}
              className={cn(
                "items-center justify-center rounded-full",
                // Under 22rem the slim bar keeps the tiles a phone can use
                // (22rem is what the full set of tiles needs). A phone has no
                // getDisplayMedia, so this one is already gone there; the
                // rule only bites a squeezed desktop pane.
                collapsed ? "hidden @min-[22rem]:flex" : "flex",
                size,
                shareCursor === "hide"
                  ? "bg-signal/20 text-signal"
                  : "bg-ink-3 text-paper hover:bg-ink-4",
              )}
              onClick={() =>
                setShareCursor(shareCursor === "hide" ? "show" : "hide")
              }
            >
              {shareCursor === "hide" ? (
                <MousePointerBan className={iconSize} />
              ) : (
                <MousePointer2 className={iconSize} />
              )}
            </button>
          </Tooltip>
        )}
      {!canShare && !noVideo && onStartScreenShare && (
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
      {canShare && !noVideo && (onStartScreenShare || onStopScreenShare) && (
        <Tooltip
          label={
            voiceState.isSharingScreen
              ? t("voice.control.stopShare")
              : t("voice.control.share")
          }
          detail={
            shareCappedOut
              ? t("voice.control.shareLimit", { limit: shareLimit ?? 0 })
              : !voiceState.isSharingScreen && canShareScreenAudio()
                ? t("voice.control.shareDetail", desktopContext())
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
      {canShare && !noVideo && voiceState.isSharingScreen && (
        <Tooltip
          label={
            hidePreviewPref
              ? t("voice.share.showPreview")
              : t("voice.share.hidePreview")
          }
        >
          <button
            type="button"
            data-testid="hide-screen-preview"
            aria-pressed={hidePreviewPref}
            className={cn(
              "flex items-center justify-center rounded-full bg-ink-3 text-paper hover:bg-ink-4",
              size,
            )}
            onClick={() => setHideScreenPreview(!hidePreviewPref)}
          >
            {hidePreviewPref ? (
              <Eye className={iconSize} />
            ) : (
              <EyeOff className={iconSize} />
            )}
          </button>
        </Tooltip>
      )}
      {canWatchParty &&
        !listenOnly &&
        !noVideo &&
        onStartScreenShare &&
        !voiceState.isSharingScreen && (
          <Tooltip
            label={t("voice.control.watchParty")}
            detail={t("voice.control.watchPartyHint")}
          >
            <button
              type="button"
              aria-label={t("voice.control.watchParty")}
              aria-disabled={shareCappedOut || undefined}
              className={cn(
                "items-center justify-center rounded-full",
                // Same rule as the cursor toggle: a watch party starts from
                // a Chrome tab, which no phone can share.
                collapsed ? "hidden @min-[22rem]:flex" : "flex",
                size,
                shareCappedOut && "opacity-40",
                "bg-ink-3 text-paper hover:bg-ink-4",
              )}
              onClick={() => {
                if (shareCappedOut) {
                  return;
                }
                // Paint the hint in this click, before getDisplayMedia opens
                // the picker and the rest of the page stops updating. Clear
                // once the picker settles: cancel, error, or a live share.
                flushSync(() => {
                  setShareHint(t("voice.control.watchPartyHint"));
                });
                void Promise.resolve(
                  onStartScreenShare({ preferBrowserTab: true }),
                ).finally(() => {
                  setShareHint(null);
                });
              }}
            >
              <MonitorPlay className={iconSize} />
            </button>
          </Tooltip>
        )}
      <Tooltip
        label={musicDock.open ? t("music.close") : t("music.open")}
      >
        <button
          type="button"
          aria-pressed={musicDock.open}
          aria-label={musicDock.open ? t("music.close") : t("music.open")}
          data-music-dock={musicDock.on ? "playing" : "idle"}
          className={cn(
            "flex items-center justify-center rounded-full",
            size,
            musicDock.open
              ? "bg-signal/20 text-signal"
              : "bg-ink-3 text-paper hover:bg-ink-4",
          )}
          onClick={toggleMusicOpen}
        >
          <Music className={iconSize} />
        </button>
      </Tooltip>
      {/* The grid / focus toggle used to sit here. It has no question left to
          answer: publishers are always a grid and everyone else is always a
          chip, so the only remaining "make this one big" is fullscreen, which
          every tile carries and a click on the picture reaches. */}
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
            data-testid="stage-fullscreen"
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
      </CallControlGroup>
      <CallControlDivider
        container={collapsed}
        className={collapsed ? "my-1" : "my-1.5"}
      />
      {/* The group hides with its only tile, or its gap would still be
          spent on a row where six tiles fill the width to the pixel. */}
      <CallControlGroup className={collapsed ? "hidden @min-[22rem]:flex" : "hidden sm:flex"}>
      {/* C2, docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md: a room past
          `LARGE_ROOM_SOUND_THRESHOLD` auto-mutes join/leave cues on its own
          (`lib/large-room-sounds.ts`); this is the visible way back to the
          cues for whoever wants them anyway. Always shown, not only in a
          large room, so the setting is findable before the room gets loud.
          Hidden below `sm` so a phone still reaches hang-up; on the slim bar
          the rule is the bar's own width, under 22rem, like the cursor and
          watch party tiles. */}
      <Tooltip
        label={
          joinLeaveAutoMute
            ? t("voice.control.enableJoinLeaveSounds")
            : t("voice.control.disableJoinLeaveSounds")
        }
        detail={t("voice.control.joinLeaveAutoMuteHint")}
      >
        <button
          type="button"
          data-testid="join-leave-auto-mute-toggle"
          aria-pressed={joinLeaveAutoMute}
          className={cn(
            "flex items-center justify-center rounded-full bg-ink-3 text-paper hover:bg-ink-4",
            size,
          )}
          onClick={() => setJoinLeaveAutoMuteEnabled(!joinLeaveAutoMute)}
        >
          {joinLeaveAutoMute ? (
            <Bell className={iconSize} />
          ) : (
            <BellOff className={iconSize} />
          )}
        </button>
      </Tooltip>
      </CallControlGroup>
      <CallControlDivider
        container={collapsed}
        className={cn("mx-0.5", collapsed ? "my-1" : "my-1.5")}
      />
      <Tooltip label={t("call.panel.leave")}>
        <button
          type="button"
          aria-label={t("call.panel.leave")}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full bg-danger/90 text-paper hover:bg-danger",
            collapsed ? size : "h-10 w-14",
          )}
          onClick={onLeave}
        >
          <PhoneOff className={iconSize} />
        </button>
      </Tooltip>
    </div>
      </div>
      {!collapsed && (
        <PttFocusHint
          show={pushToTalk && Boolean(pushToTalkKeyLabel) && !windowFocused}
          className="text-center"
        />
      )}
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

/**
 * Fill the tile and lose the edges, or fit inside it and keep them.
 *
 * ON THE PICTURE, not in the control bar and not in Settings, because that is
 * where the wish happens: somebody is looking at a cropped screen, cannot see
 * the tab bar, and wants it back. A row of call controls is about the call
 * itself, the mic and the camera and the way out; a Settings page is a second
 * place to go looking mid-share for something that is one press away from
 * where the eyes already are.
 *
 * IT CHANGES EVERY TILE OF THIS KIND, which is what the tooltip says, because
 * the alternative is a grid where seven faces are cropped and one is not. The
 * two kinds keep separate answers; see `lib/video-fit.ts` for why.
 */
function TileFitButton({
  fit,
  kind,
}: {
  fit: VideoFitControls;
  kind: "camera" | "screen";
}) {
  const { t } = useTranslation();
  const whole = fit.fit === "contain";
  return (
    <Tooltip
      label={whole ? t("call.fit.fill") : t("call.fit.whole")}
      detail={
        kind === "screen" ? t("call.fit.hintScreen") : t("call.fit.hintCamera")
      }
      side="bottom"
      align="start"
    >
      <button
        type="button"
        data-testid="tile-fit"
        data-tile-fit={fit.fit}
        aria-pressed={whole}
        // No `aria-label` here: `Tooltip` puts the accessible name on the
        // trigger, and a second one on the child is how the two drift apart.
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink/70 text-paper hover:bg-ink-4",
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
  );
}

function TileOverlay({
  isFullscreen = false,
  onToggleFullscreen,
  onPin,
  pinned = false,
  name,
  audio,
  fit,
}: {
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onPin?: () => void;
  pinned?: boolean;
  name: string;
  /**
   * Only passed once this tile is actually showing a picture. A tile drawing
   * an avatar has nothing to crop, and a control that does nothing visible is
   * how people stop trusting the row.
   */
  fit?: VideoFitControls;
  /**
   * This person's sound. A round button beside fullscreen and pin, opening the
   * one panel that carries their voice and their share. A button rather than a
   * slider parked on the picture, because that slider was revealed by hover,
   * and on a phone hover is no control at all.
   */
  audio?: { voice?: PeerAudioTrack; share?: PeerAudioTrack };
}) {
  const { t } = useTranslation();
  const menu = usePeerAudioMenu();
  const hasAudio = Boolean(audio?.voice || audio?.share);
  if (!onToggleFullscreen && !onPin && !hasAudio && !fit) {
    return null;
  }
  return (
    <div
      ref={menu.rootRef}
      className={cn(
        "absolute left-2 top-2 flex items-center gap-1",
        STAGE_LAYER.tileControls,
        // An open panel keeps its own chrome visible; otherwise the row
        // follows the tile's hover, and stays put on a touch screen.
        menu.open
          ? "opacity-100"
          : "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
      )}
    >
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
      {fit && <TileFitButton fit={fit} kind="camera" />}
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
      {hasAudio && (
        <div className="relative">
          <PeerAudioMenuButton
            name={name}
            open={menu.open}
            onToggle={menu.toggle}
            muted={audio?.voice?.volume === 0}
          />
          <PeerAudioMenu
            name={name}
            open={menu.open}
            voice={audio?.voice}
            share={audio?.share}
            side="bottom"
            align="start"
          />
        </div>
      )}
    </div>
  );
}

/**
 * The always-visible way back from a dead peer connection. Never inside the
 * audio panel: a tile that has failed is showing nothing, and the one control
 * that fixes it must not be one click further away than it used to be.
 */
function TileRetry({
  onRetry,
  className,
}: {
  onRetry: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("absolute", STAGE_LAYER.tileControls, className)}>
      <Button
        variant="secondary"
        size="sm"
        className="h-6 px-2 text-[10px]"
        onClick={onRetry}
      >
        {t("voice.tile.retry")}
      </Button>
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
  const fit = useVideoFit("camera");
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
          // The element is `h-full w-full` either way: only the painting
          // inside it changes, so `adaptiveStream` measures the same box and
          // asks the SFU for the same layer. See `lib/video-fit.ts`.
          className={cn("h-full w-full", videoFitClass(fit.fit))}
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
        audio={person.failed ? undefined : personAudioTracks(person)}
        fit={person.stream ? fit : undefined}
      />
      <TileBadge
        name={person.name}
        muted={person.muted}
        serverMuted={person.serverMuted}
        connecting={person.connecting}
        connectingLabel={t("voice.tile.connecting")}
        prominent
      />
      {!person.isSelf && (
        <VoiceQualityMeter
          quality={person.quality ?? null}
          className={cn("absolute right-2 top-2", STAGE_LAYER.tileControls)}
        />
      )}
      {person.failed && person.onRetry && (
        <TileRetry onRetry={person.onRetry} className="bottom-8 left-2" />
      )}
    </div>
  );
}

/**
 * One publisher's camera, large, as a cell of the stage grid.
 *
 * `object-cover` rather than `contain` by DEFAULT: a webcam is a face, and a
 * face is better cropped than letterboxed. A share is the opposite and
 * defaults to `object-contain` in `ScreenTileFrame`; that difference is the
 * only one between the two kinds of tile. Both are now a preference the
 * viewer can flip from the tile itself, remembered per kind and per device
 * (`lib/video-fit.ts`).
 */
export function CameraTile({
  person,
  videoRef,
  youLabel,
  wideRow = false,
  rounded = true,
  clickToFullscreen = false,
  onToggleFullscreen,
  onPin,
  pinned = false,
}: {
  person: StagePerson;
  videoRef?: RefObject<WebkitFullscreenVideo | null>;
  youLabel: string;
  /** The pinned tile: the whole first row of the grid. */
  wideRow?: boolean;
  /** False for the lone tile, which is flush with the stage's own edges. */
  rounded?: boolean;
  clickToFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onPin?: () => void;
  pinned?: boolean;
}) {
  const { t } = useTranslation();
  const fit = useVideoFit("camera");
  return (
    <li
      data-call-tile={person.name}
      className={cn(
        "group relative min-h-0 overflow-hidden bg-ink-2",
        rounded && "rounded-xl",
        wideRow && "col-span-full",
        person.speaking && "ring-2 ring-success",
        person.connecting && "opacity-70",
      )}
    >
      {person.stream ? (
        <StageVideo
          stream={person.stream}
          mirrored={person.isSelf}
          videoRef={videoRef}
          // The picture answers a double click only where a single click is
          // not already the gesture; otherwise the click would fire twice and
          // fullscreen would toggle straight back out.
          onDoubleClick={clickToFullscreen ? undefined : onToggleFullscreen}
          label={cameraLabel(t, person)}
          className={cn(
            "absolute inset-0 h-full w-full",
            videoFitClass(fit.fit),
          )}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <StageAvatar person={person} />
        </div>
      )}
      <TileClickTarget
        enabled={clickToFullscreen}
        label={t("call.stage.fullscreenTile", { name: person.name })}
        onClick={onToggleFullscreen}
      />
      <TileOverlay
        isFullscreen={false}
        onToggleFullscreen={onToggleFullscreen}
        onPin={onPin}
        pinned={pinned}
        name={person.name}
        audio={person.failed ? undefined : personAudioTracks(person)}
        fit={person.stream ? fit : undefined}
      />
      <TileBadge
        name={person.isSelf ? youLabel : person.name}
        muted={person.muted}
        serverMuted={person.serverMuted}
        connecting={person.connecting}
        connectingLabel={t("voice.tile.connecting")}
        prominent
      />
      {!person.isSelf && (
        <VoiceQualityMeter
          quality={person.quality ?? null}
          compact
          className={cn("absolute right-1.5 top-1.5", STAGE_LAYER.tileControls)}
        />
      )}
      {person.failed && person.onRetry && (
        <TileRetry onRetry={person.onRetry} className="bottom-8 left-2" />
      )}
    </li>
  );
}

/**
 * The transparent layer that makes a click anywhere on a tile mean "that one,
 * fullscreen".
 *
 * A real `<button>`, not an `onClick` on the tile: it has to be reachable from
 * a keyboard, it has to say what it does, and `tapIsOnStage` has to be able to
 * tell it apart from the picture so a thumb landing here is not also counted
 * as the tap that toggles the control chrome. It sits at the very bottom of
 * the tile's stack (`STAGE_LAYER.tileTarget`, `z-0`, and rendered before the
 * overlays) so every control drawn after it gets its clicks whether or not
 * it sets a z of its own; a control at the default z used to sit under this
 * and take none.
 */
function TileClickTarget({
  enabled,
  label,
  onClick,
}: {
  enabled: boolean;
  label: string;
  onClick?: () => void;
}) {
  if (!enabled || !onClick) {
    return null;
  }
  return (
    <button
      type="button"
      data-testid="tile-click-target"
      aria-label={label}
      className={cn("absolute inset-0 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signal", STAGE_LAYER.tileTarget)}
      onClick={onClick}
    />
  );
}

/**
 * Nobody is publishing: the room, drawn as the room.
 *
 * The stage is only expanded here because somebody just stopped a camera or
 * the call is settling, and an empty black box reads as a bug. So it shows the
 * same people the strip would, larger and centred, with the same overflow rule
 * so a lobby of 200 is still one screen.
 */
export function RoomView({
  people,
  youLabel,
}: {
  people: StagePerson[];
  youLabel: string;
}) {
  const { t } = useTranslation();
  const slots = listenerStripSlots(people, ROOM_VIEW_LIMIT);
  return (
    <div
      data-testid="stage-room"
      className="flex h-full w-full flex-col items-center justify-center gap-4 p-4"
    >
      <ul className="flex max-w-3xl flex-wrap items-center justify-center gap-x-5 gap-y-3">
        {slots.shown.map((person) => (
          <RoomFace key={person.key} person={person} youLabel={youLabel} />
        ))}
        {slots.overflow > 0 && (
          <li className="text-sm tabular-nums text-paper-muted">
            +{slots.overflow}
          </li>
        )}
      </ul>
      <p className="text-xs text-paper-muted" role="status">
        {t("voice.stage.noVideo")}
      </p>
    </div>
  );
}

/**
 * One face in the room view, and the way to that person's sound.
 *
 * THIS IS THE STATE A VOICE CALL SPENDS MOST OF ITS LIFE IN. Nobody has a
 * camera on, nobody is sharing, so there are no tiles and no listener strip,
 * and until now no volume control of any kind was reachable from here: the
 * room drew faces and nothing else. Clicking one now opens the same panel every
 * other surface opens.
 */
function RoomFace({
  person,
  youLabel,
}: {
  person: StagePerson;
  youLabel: string;
}) {
  const { t } = useTranslation();
  const menu = usePeerAudioMenu<HTMLLIElement>();
  const audio = person.failed ? undefined : personAudioTracks(person);
  const actionable = Boolean(audio || (person.failed && person.onRetry));
  return (
    <li
      ref={menu.rootRef}
      data-call-listener={person.name}
      className="relative flex w-20 flex-col items-center gap-1"
    >
      {actionable ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={menu.open}
          aria-label={t("voice.audio.title", { name: person.name })}
          onClick={menu.toggle}
          className="flex flex-col items-center gap-1 rounded-lg p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          <VoiceAvatar
            name={person.name}
            avatarUrl={person.avatarUrl}
            isSpeaking={person.speaking}
            muted={person.muted}
            size="lg"
          />
          <span className="max-w-[5rem] truncate text-[11px] text-paper-muted">
            {person.name}
          </span>
        </button>
      ) : (
        <>
          <VoiceAvatar
            name={person.name}
            avatarUrl={person.avatarUrl}
            isSpeaking={person.speaking}
            muted={person.muted}
            size="lg"
          />
          <span className="max-w-full truncate text-[11px] text-paper-muted">
            {person.isSelf ? `${person.name} ${youLabel}` : person.name}
          </span>
        </>
      )}
      <PeerAudioMenu
        name={person.name}
        open={menu.open}
        voice={audio?.voice}
        share={audio?.share}
        failed={person.failed}
        onRetry={person.onRetry}
        side="bottom"
        align="start"
        className="left-1/2 -translate-x-1/2"
      />
    </li>
  );
}

/** How many faces the empty-stage room view draws before it counts the rest. */
const ROOM_VIEW_LIMIT = 12;

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
  serverMuted = false,
  connecting = false,
  connectingLabel,
  prominent = false,
}: {
  name: string;
  muted: boolean;
  /** Muted by a moderator: a different glyph from a self-mute, on purpose. */
  serverMuted?: boolean;
  connecting?: boolean;
  connectingLabel?: string;
  prominent?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "absolute bottom-0 left-0 flex max-w-full items-center gap-1 truncate rounded-tr-md bg-ink/70 text-paper",
        STAGE_LAYER.labels,
        prominent ? "px-2 py-1 text-xs" : "px-1.5 py-0.5 text-[10px]",
      )}
    >
      {serverMuted ? (
        <ShieldBan
          className="h-3 w-3 shrink-0 text-warning"
          role="img"
          aria-label={t("voice.tile.serverMuted", { name })}
        />
      ) : (
        muted && <MicOff className="h-3 w-3 shrink-0 text-danger" />
      )}
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

export interface OccupantFace {
  key: string;
  displayName: string;
  avatarUrl: string | null;
  speaking?: boolean;
  volume?: number;
  onSetVolume?: (volume: number) => void;
  shareVolume?: number;
  onSetShareVolume?: (volume: number) => void;
  failed?: boolean;
  onRetry?: () => void;
}

/** Small overlapped avatar row for the banner states. */
export function OccupantFaces({ faces }: { faces: OccupantFace[] }) {
  const interactive = faces.some(
    (person) => person.onSetVolume || person.onRetry,
  );
  return (
    <span
      className="flex shrink-0 -space-x-2"
      aria-hidden={interactive ? undefined : true}
    >
      {faces.slice(0, 3).map((person) => (
        <BannerFace key={person.key} person={person} />
      ))}
    </span>
  );
}

/**
 * One of the three faces on the collapsed bar, and the way to that person's
 * sound while the stage is folded away. Pressed, not hovered: the collapsed
 * bar is what a phone sees for most of a call.
 */
function BannerFace({ person }: { person: OccupantFace }) {
  const { t } = useTranslation();
  const menu = usePeerAudioMenu<HTMLSpanElement>();
  const voice = person.onSetVolume
    ? { volume: person.volume ?? 1, onSetVolume: person.onSetVolume }
    : undefined;
  const share = person.onSetShareVolume
    ? { volume: person.shareVolume ?? 1, onSetVolume: person.onSetShareVolume }
    : undefined;
  const actionable = Boolean(voice || share || (person.failed && person.onRetry));
  const avatar = (
    <VoiceAvatar
      name={person.displayName}
      avatarUrl={person.avatarUrl}
      size="sm"
      isSpeaking={person.speaking}
    />
  );
  return (
    <span ref={menu.rootRef} className="relative inline-flex">
      {actionable ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={menu.open}
          aria-label={t("voice.audio.title", { name: person.displayName })}
          className="inline-flex rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          onClick={menu.toggle}
        >
          {avatar}
        </button>
      ) : (
        avatar
      )}
      <PeerAudioMenu
        name={person.displayName}
        open={menu.open}
        voice={voice}
        share={share}
        failed={person.failed}
        onRetry={person.onRetry}
        side="bottom"
        align="start"
      />
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
export function ScreenTileFrame({
  tile,
  videoRef,
  isFullscreen,
  showName = false,
  clickToFullscreen = false,
  onToggleFullscreen,
  onPin,
  pinned = false,
  audio,
  dismissed,
  className,
  mediaTitle,
  communityName,
  coverUrl,
}: {
  tile: ScreenShareTile;
  videoRef?: RefObject<WebkitFullscreenVideo | null>;
  isFullscreen: boolean;
  showName?: boolean;
  /** A click anywhere on the picture blows it up. See `TileClickTarget`. */
  clickToFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onPin?: () => void;
  pinned?: boolean;
  /**
   * The presenter's sound: their voice, and this share's audio when it carries
   * any. Both rows of one panel rather than a lone slider on the corner of the
   * picture, because "turn the film down but not him" and "turn him down but
   * not the film" are the same question about the same person, and the person
   * asking has to be able to find them together.
   */
  audio?: { voice?: PeerAudioTrack; share?: PeerAudioTrack };
  /**
   * The "not watching this one" state, and the way out of it.
   *
   * The tile is KEPT rather than removed, which is the whole trick: the layout
   * maths never change, and the person is told why the screen everybody is
   * talking about is not on their stage. Silently falling back to faces would
   * leave them to rediscover their own decision.
   */
  dismissed?: { active: boolean; onToggle: () => void };
  className?: string;
  /** Party/presenter title for the watch player's lock-screen metadata. */
  mediaTitle?: string;
  /** Server or community name, shown as the lock screen's subtitle. */
  communityName?: string | null;
  /** Server icon, used as lock-screen artwork. */
  coverUrl?: string | null;
}) {
  const { t } = useTranslation();
  const menu = usePeerAudioMenu();
  const fit = useVideoFit("screen");
  const hidePreviewPref = useHideScreenPreview();
  const hideSelfPreview = tile.isSelf && hidePreviewPref;
  const hasAudio = Boolean(audio?.voice || audio?.share);
  const label = isFullscreen
    ? t("voice.share.exitFullscreen")
    : tile.isSelf
      ? // Naming yourself in your own button reads like somebody else's screen.
        t("voice.share.fullscreen")
      : t("voice.share.fullscreenPeer", { name: tile.presenterName });
  if (dismissed?.active) {
    return (
      <div
        className={cn(
          "relative flex items-center justify-center bg-ink-2 p-4",
          className,
        )}
        data-share-dismissed
      >
        <div className="text-center">
          <p className="text-sm text-paper-muted">
            {t("voice.share.dismissed", { name: tile.presenterName })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={dismissed.onToggle}
          >
            {t("voice.share.watchAgain")}
          </Button>
        </div>
      </div>
    );
  }

  const useHls = Boolean(tile.hlsUrl) && !tile.isSelf;

  return (
    <div className={cn("group relative", className)}>
      {hideSelfPreview ? (
        <div
          data-self-preview-hidden=""
          className="flex h-full w-full items-center justify-center bg-ink-2 px-3"
        >
          <p className="text-sm text-paper-muted">
            {t("voice.share.youAreSharing")}
          </p>
        </div>
      ) : useHls && tile.hlsUrl ? (
        <HlsWatchPlayer
          src={tile.hlsUrl}
          delaySeconds={tile.delaySeconds}
          mode={tile.mode ? watchPlayerMode(tile.mode) : undefined}
          partTargetMs={tile.partTargetMs}
          videoRef={videoRef}
          onDoubleClick={clickToFullscreen ? undefined : onToggleFullscreen}
          className={cn("h-full w-full", videoFitClass(fit.fit))}
          mediaTitle={mediaTitle ?? tile.presenterName}
          communityName={communityName}
          coverUrl={coverUrl}
        />
      ) : (
        <StageVideo
          stream={tile.stream}
          videoRef={videoRef}
          onDoubleClick={clickToFullscreen ? undefined : onToggleFullscreen}
          // Contain by default: a crop on a shared screen eats a toolbar or a
          // margin, which is very often the thing being presented. Fill is one
          // press away for the ultrawide monitor letterboxed into a 16:9 tile.
          className={cn("h-full w-full", videoFitClass(fit.fit))}
        />
      )}
      <TileClickTarget
        enabled={Boolean(clickToFullscreen) && !hideSelfPreview}
        label={label}
        onClick={onToggleFullscreen}
      />
      {/* Top left, and out of the way until wanted: the stage's own title
          overlay lives in this corner, and a tile that keeps three buttons
          parked on top of it makes both unreadable. Same rule and the same
          classes as a camera tile's `TileOverlay`; a touch device, which has
          no hover to reveal anything, keeps them all the time. */}
      <div
        ref={menu.rootRef}
        className={cn(
          "absolute left-2 top-2 flex max-w-[80%] items-center gap-1.5",
          STAGE_LAYER.tileControls,
          menu.open || hideSelfPreview
            ? "opacity-100"
            : "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
        )}
      >
        {/* Only a peer's share can be declined. Declining our own would mean
            hiding the thing we are broadcasting, which is not a thing anyone
            wants and would read as having stopped. */}
        {dismissed && !tile.isSelf && (
          <Tooltip
            label={t("voice.share.dismiss", { name: tile.presenterName })}
            side="bottom"
            align="start"
          >
            <button
              type="button"
              data-share-dismiss
              aria-label={t("voice.share.dismiss", { name: tile.presenterName })}
              className="rounded-md bg-ink/70 p-1.5 text-paper-muted hover:bg-ink hover:text-paper"
              onClick={dismissed.onToggle}
            >
              <EyeOff aria-hidden="true" className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
        {tile.isSelf && (
          <Tooltip
            label={
              hideSelfPreview
                ? t("voice.share.showPreview")
                : t("voice.share.hidePreview")
            }
            side="bottom"
            align="start"
          >
            <button
              type="button"
              aria-pressed={hideSelfPreview}
              aria-label={
                hideSelfPreview
                  ? t("voice.share.showPreview")
                  : t("voice.share.hidePreview")
              }
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink/70 text-paper hover:bg-ink-4"
              onClick={() => setHideScreenPreview(!hidePreviewPref)}
            >
              {hideSelfPreview ? (
                <Eye className="h-3.5 w-3.5" />
              ) : (
                <EyeOff className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
        )}
        {!hideSelfPreview && onToggleFullscreen && (
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
        {!hideSelfPreview && <TileFitButton fit={fit} kind="screen" />}
        {onPin && (
          <Tooltip
            label={
              pinned
                ? t("call.stage.unpin")
                : t("call.stage.pin", { name: tile.presenterName })
            }
            side="bottom"
            align="start"
          >
            <button
              type="button"
              data-testid="share-pin"
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
        {hasAudio && (
          <div className="relative">
            <PeerAudioMenuButton
              name={tile.presenterName}
              open={menu.open}
              onToggle={menu.toggle}
              muted={audio?.share?.volume === 0}
            />
            <PeerAudioMenu
              name={tile.presenterName}
              open={menu.open}
              voice={audio?.voice}
              share={audio?.share}
              side="bottom"
              align="start"
            />
          </div>
        )}
      </div>
      {/* The name goes where every other tile keeps its name: the bottom left,
          always visible, out of the title overlay's corner. It names the
          picture rather than the act ("Sua tela"), because "X is presenting"
          is the overlay's sentence and saying it twice is how the two ended up
          stacked on each other. */}
      {showName && (
        <span className={cn("pointer-events-none absolute bottom-0 left-0 flex max-w-full items-center gap-1 truncate rounded-tr-md bg-ink/70 px-1.5 py-0.5 text-[10px] text-paper", STAGE_LAYER.labels)}>
          {tile.isSelf ? t("voice.share.yourScreen") : tile.presenterName}
        </span>
      )}
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
    // Through the binding rather than `srcObject` directly, so an SFU stream
    // gets its element measured for adaptive streaming. See
    // `lib/remote-video-binding.ts`; on the mesh it is the same two lines.
    return bindRemoteVideo(video, stream);
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
