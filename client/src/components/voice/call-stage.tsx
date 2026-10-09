import {
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  Crop,
  Eye,
  EyeOff,
  Hand,
  Info,
  LayoutGrid,
  Loader2,
  Maximize2,
  MonitorPlay,
  PanelLeftClose,
  PanelLeftOpen,
  Mic,
  MicOff,
  MoreHorizontal,
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
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type ReactElement,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
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
import { LinuxShareAudioHint } from "@/components/voice/linux-share-audio-hint";
import { ShareSoundIndicator } from "@/components/voice/share-sound-indicator";
import { CapacityNotice } from "@/components/voice/capacity-notice";
import { MicFallbackNotice } from "@/components/voice/mic-fallback-notice";
import { ShareGameCaptureNotice } from "@/components/voice/share-game-capture-notice";
import { RaisedHandQueue } from "@/components/voice/raised-hand-queue";
import {
  AudienceModeStrip,
  AudienceModeToggle,
  type AudienceModeHostControls,
} from "@/components/voice/audience-mode";
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
  escapeExitsExpandedFullscreen,
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
  useCallDockHintHost,
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
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import {
  isKeyboardFocus,
  stageChromeAttentionKey,
  stageChromeHold,
  stageChromeMayHide,
} from "@/components/voice/stage-chrome";
import { useAutoHideStageControls } from "@/lib/stage-controls-pref";
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
import { Menu } from "@/components/ui/menu";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { SoundboardControl } from "@/components/voice/soundboard-control";
import { SoundboardFloat } from "@/components/voice/soundboard-float";
import { shouldSuppressHints } from "@/lib/hints";
import { shouldShowMusicPip, useMusicPipSpent } from "@/lib/music-pip";
import { STAGE_LAYER, callControlsLayer } from "@/lib/stage-layers";
import { Button } from "@/components/ui/button";
import { VoiceNoticeBar } from "@/components/voice/voice-notice-bar";
import {
  callStartKey,
  callStartedAt,
  cameraSoloId,
  formatCallDuration,
  hasWatchableVideo,
  sharePeerIdsIncludingLocal,
  isCameraSoloId,
  isMusicPictureOnlyStage,
  stageHeightClass,
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
  userId?: string;
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
 * it rather than on top of the last few chips. The strip rises with every
 * line the control row folds onto (`--call-row-extra`), so the preview does.
 */
const PIP_CORNER_CLASS_WITH_STRIP: Record<PipCorner, string> = {
  tl: "left-3 top-3",
  tr: "right-3 top-3",
  bl: "bottom-[calc(7rem+var(--call-row-extra,0px))] left-3",
  br: "bottom-[calc(7rem+var(--call-row-extra,0px))] right-3",
};

/**
 * No strip, and the control row folded onto more than one line: the pill is
 * then as wide as the stage, so a bottom corner is on top of hang-up. The
 * preview sits on the bar's reserve instead, the same height the strip
 * would stop at.
 */
const PIP_CORNER_CLASS_ABOVE_FOLDED_BAR: Record<PipCorner, string> = {
  tl: "left-3 top-3",
  tr: "right-3 top-3",
  bl: "bottom-[calc(max(4rem,calc(env(safe-area-inset-bottom)+3.5rem))+var(--call-row-extra,0px))] left-3",
  br: "bottom-[calc(max(4rem,calc(env(safe-area-inset-bottom)+3.5rem))+var(--call-row-extra,0px))] right-3",
};

/**
 * What fades a tile's own corner controls (fit, volume, shrink to grid, ...)
 * with the rest of the stage's overlay. They already reveal on hover, which is
 * no help to somebody who parked the pointer on the picture: it IS hovering,
 * so they sat on the film for as long as the pointer did. The stage carries
 * `data-chrome-hidden`; while it is "true" these go too, unless keyboard focus
 * is inside them (a Tab reveals everything first, and has to keep what it
 * reached). Resting the pointer on one pins the stage through
 * `tileControlsHovered`.
 */
const TILE_CONTROLS_FADE =
  "transition-opacity duration-200 motion-reduce:transition-none [[data-chrome-hidden=true]_&:not(:has(:focus-visible))]:!opacity-0";

/**
 * A tile's own panel (audio, fit) is open. The stage cannot see it, because the
 * panel belongs to the tile, and a panel left open while the pointer wandered
 * off would otherwise be faded out from under the person using it.
 */
const TileMenuHoldContext = createContext<((open: boolean) => void) | null>(
  null,
);

function useReportTileMenu(open: boolean): void {
  const report = useContext(TileMenuHoldContext);
  useEffect(() => {
    if (!open || !report) {
      return;
    }
    report(true);
    return () => report(false);
  }, [open, report]);
}

/** Whether a pointer event's element is inside a tile's own corner controls. */
function isInsideTileControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-call-chrome="tile"]') !== null
  );
}

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

  // ESCAPE HAS TO WORK IN `expand` TOO — see `escapeExitsExpandedFullscreen`.
  // `element` and `video` are covered above and by the platform itself; a
  // person stuck in an in-page solo picture with no keyboard escape and a
  // hard-to-find corner button is exactly the report this fixes.
  useEffect(() => {
    if (mode !== "expand") {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        !escapeExitsExpandedFullscreen(mode, stateRef.current.active)
      ) {
        return;
      }
      apply({ next: NO_SCREEN_FULLSCREEN, request: "exit" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, mode]);

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
  /** Set on a server voice channel. A DM has no soundboard. */
  serverId?: string | null;
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
  /**
   * Audience mode controls for somebody who runs the stage here
   * (`docs/plans/AUDIENCE_MODE.md`). Absent for everybody else, and always in
   * a conversation call.
   */
  audienceHost?: AudienceModeHostControls | null;
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
  serverId = null,
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
  audienceHost = null,
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

  const sharePeerIds = sharePeerIdsIncludingLocal(
    voiceState.screenSharePeerIds,
    voiceState.peerId,
    voiceState.localScreenStream !== null,
  );
  const hasVideo = hasWatchableVideo({
    localCameraOn:
      voiceState.isCameraOn || voiceState.localCameraStream !== null,
    remoteHasCamera: voiceState.remotePeers.some(
      (peer) => peer.cameraStream !== null,
    ),
    screenShareCount: sharePeerIds.length,
  });

  return (
    <ActiveCall
      channelId={channelId}
      serverId={serverId}
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
      audienceHost={audienceHost}
      compactPeers={compactPeers}
      ringWhenAlone={ringWhenAlone}
      fill={fill}
      onShapeChange={onShapeChange}
    />
  );
}

function ActiveCall({
  channelId,
  serverId = null,
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
  audienceHost = null,
  compactPeers = false,
  ringWhenAlone = true,
  fill = false,
  onShapeChange,
}: {
  channelId: string;
  serverId?: string | null;
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
  audienceHost?: AudienceModeHostControls | null;
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
        userId: currentUser.id,
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
      userId: peer.userId,
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

  const sharePeerIds = sharePeerIdsIncludingLocal(
    voiceState.screenSharePeerIds,
    voiceState.peerId,
    voiceState.localScreenStream !== null,
  );
  const advertisedTiles = collectScreenTiles({
    peerIds: sharePeerIds,
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
  // With a stream on the stage (one picture alone, or a share in the grid) the
  // bar, the title overlay, the way back to the grid and each tile's corner
  // controls fade after a few idle seconds and come back on any pointer move,
  // key or touch; a tap on the picture toggles them on a phone. A grid of
  // cameras, an audio-only call, a collapsed stage and a presenter's own
  // picture keep the controls put, and so does anything in
  // `stageChromeHold` (a menu, the pointer on a control, keyboard focus on
  // one, a call that is not connected). Timing: `hooks/use-idle-chrome.ts`;
  // the rules: `stage-chrome.ts`.
  const reducedMotion = usePrefersReducedMotion();
  const autoHideSetting = useAutoHideStageControls();
  const [barHovered, setBarHovered] = useState(false);
  const [tileControlsHovered, setTileControlsHovered] = useState(false);
  const [tileFocused, setTileFocused] = useState(false);
  const [tileMenusOpen, setTileMenusOpen] = useState(0);
  const reportTileMenu = useCallback((open: boolean) => {
    setTileMenusOpen((count) => Math.max(0, count + (open ? 1 : -1)));
  }, []);
  const [barFocused, setBarFocused] = useState(false);
  const [sharePickerOpen, setSharePickerOpen] = useState(false);
  const pushToTalkHeld =
    inputMode === "push-to-talk" &&
    voiceState.isTransmitting &&
    !voiceState.isMuted;
  // A stream owns the stage: one picture alone (focused, or the only one), or
  // a screen share anywhere on it. A grid of cameras with no share is people,
  // and people keep their controls.
  const streamOnStage =
    soloPerson !== null ||
    soloTile !== null ||
    soloMusic ||
    staged.tiles.length === 1 ||
    staged.tiles.some((tile) => tile.kind === "screen");
  const ownPictureOnly = soloPerson
    ? soloPerson.isSelf
    : soloTile
      ? soloTile.isSelf
      : focusedIsLocal ||
        (!soloMusic &&
          !musicOnStage &&
          staged.tiles.length === 1 &&
          stage.tiles[0]?.isSelf === true);
  const chromeMayHide = stageChromeMayHide({
    autoHideSetting,
    expanded: chromeExpanded && anyVideo,
    streamOnStage,
    ownPictureOnly,
  });
  const chromeHold = stageChromeHold({
    menuOpen: qualityMenuOpen || tileMenusOpen > 0,
    sharePickerOpen,
    pointerOverControls: barHovered || tileControlsHovered,
    keyboardFocusInControls: barFocused || tileFocused,
    pushToTalkHeld,
    connected: voiceState.status === "connected",
    error: Boolean(voiceState.error),
    notice: Boolean(voiceState.notice),
    peerFailed: remotes.some((person) => person.failed),
  });
  const chrome = useIdleChrome(chromeMayHide, chromeHold !== null);
  const wakeChrome = chrome.wake;
  const chromeClass = idleChromeClassName({
    hidden: chrome.hidden,
    reducedMotion,
  });
  // Something a person has to notice happened (muted by a moderator, somebody
  // arrived, a hand went up, a hotkey mute): show the controls for one idle
  // period rather than letting it change nothing anywhere on screen.
  const attentionKey = stageChromeAttentionKey({
    isMuted: voiceState.isMuted,
    isDeafened: voiceState.isDeafened,
    serverMuted: voiceState.self?.serverMuted === true,
    canSpeak: voiceState.canSpeak,
    peerCount: voiceState.remotePeers.length,
    handsUp: (voiceState.voiceChannelId
      ? (voiceState.occupancy[voiceState.voiceChannelId] ?? [])
      : []
    ).filter((person) => person.handRaisedAt != null).length,
  });
  const attentionSeen = useRef(attentionKey);
  useEffect(() => {
    if (attentionSeen.current !== attentionKey) {
      attentionSeen.current = attentionKey;
      wakeChrome();
    }
  }, [attentionKey, wakeChrome]);
  // In real fullscreen focus can sit on the body, outside the stage's own key
  // handler, so a key press there would reveal nothing.
  useEffect(() => {
    if (!fullscreen.isFullscreen || !chromeMayHide) {
      return;
    }
    window.addEventListener("keydown", wakeChrome);
    return () => window.removeEventListener("keydown", wakeChrome);
  }, [fullscreen.isFullscreen, chromeMayHide, wakeChrome]);
  // The screen picker is the browser's, and it takes the pointer with it: a
  // bar that hid while it was up would still be gone on the way back.
  const startScreenShareWithPicker = useMemo(
    () =>
      onStartScreenShare
        ? async (intent?: { preferBrowserTab?: boolean }) => {
            setSharePickerOpen(true);
            try {
              await onStartScreenShare(intent);
            } finally {
              setSharePickerOpen(false);
            }
          }
        : undefined,
    [onStartScreenShare],
  );
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
  const swallowPressWhileHidden = (event: SyntheticEvent) => {
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
                userId: person.userId,
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
              userId: person.userId,
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
            audience={
              audienceHost && voiceState.audience
                ? { busy: audienceHost.busy, onAllow: audienceHost.onAllow }
                : null
            }
          />
        </div>
      );
    })()
  ) : null;

  // How far the stage's control row stands above its one-line height: zero
  // until a narrow stage folds the pill onto a second line (see the pill in
  // `CallControls`). The strip's reserve for the bar grows by this much,
  // because the strip is stacked above the bar and would otherwise cover the
  // pill's top line, which is where mute and raise hand go; so does the
  // self-preview's bottom corner, for the same reason.
  const [controlRowExtraPx, setControlRowExtraPx] = useState(0);
  const controlRowRef = useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const rem =
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
        16;
      setControlRowExtraPx(
        Math.max(0, Math.round(node.offsetHeight - STAGE_CONTROL_ROW_REM * rem)),
      );
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      setControlRowExtraPx(0);
    };
  }, []);

  const controls = (
    <CallControls
      voiceState={voiceState}
      serverId={serverId}
      rowRef={controlRowRef}
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
      onStartScreenShare={startScreenShareWithPicker}
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
      audienceHost={audienceHost}
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
    <div data-testid="call-stage-collapsed" className="@container">
      {controls}
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
    <TileMenuHoldContext.Provider value={reportTileMenu}>
    <div
      ref={stageRef}
      data-testid="call-stage"
      data-music-picture={musicPictureOnly ? "" : undefined}
      data-chrome-hidden={chrome.hidden ? "true" : "false"}
      className={cn(
        "relative shrink-0 overflow-hidden border-b border-ink-4/60 bg-ink",
        // The pointer goes with the controls, as in every player. `!` and the
        // descendant selector because the tiles set their own cursors, and the
        // pointer has to be gone over the picture whoever owns that element.
        chrome.hidden && "cursor-none [&_*]:!cursor-none",
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
            : stageHeightClass({ anyVideo, musicPictureOnly }),
      )}
      onPointerMove={(event) => {
        // Touch "moves" are scrolls and drags, answered on pointer up.
        if (event.pointerType !== "touch") {
          chrome.wake();
        }
      }}
      onPointerOver={(event) => {
        if (
          event.pointerType !== "touch" &&
          isInsideTileControls(event.target)
        ) {
          setTileControlsHovered(true);
        }
      }}
      onPointerOut={(event) => {
        if (
          isInsideTileControls(event.target) &&
          !isInsideTileControls(event.relatedTarget)
        ) {
          setTileControlsHovered(false);
        }
      }}
      onPointerDown={onStagePointerDown}
      onPointerUp={onStagePointerUp}
      onPointerCancel={() => {
        touchDownRef.current = null;
      }}
      onKeyDownCapture={chrome.wake}
      onFocusCapture={(event) => {
        chrome.wake();
        // Keyboard focus on a tile's own control holds the stage like focus on
        // the bar does; a mouse press on one does not.
        if (isInsideTileControls(event.target)) {
          setTileFocused(isKeyboardFocus(event.target));
        }
      }}
      onBlurCapture={(event) => {
        if (
          isInsideTileControls(event.target) &&
          !isInsideTileControls(event.relatedTarget)
        ) {
          setTileFocused(false);
        }
      }}
      // Read by the strip's reserve and the self-preview's bottom corners.
      style={{ "--call-row-extra": `${controlRowExtraPx}px` } as CSSProperties}
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
          {/* Picking one stream and clicking away from it used to leave no
              obvious way back — reported verbatim, 2026-09-27, as counter-
              intuitive and even obscure. The corner minimize button and
              Escape (above) both still work; this is the same exit spelled
              out in words, drawn every time one picture is alone on the
              stage rather than only on hover, so it survives an idle mouse,
              a touch device and a person who never noticed the small icon. */}
          {(soloPerson || soloTile) && (
            <button
              type="button"
              data-testid="stage-show-all-streams"
              data-call-chrome="back"
              data-chrome-hidden={chrome.hidden ? "true" : "false"}
              className={cn(
                "absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink/80 px-3 py-1.5 text-xs font-medium text-paper shadow-lg ring-1 ring-ink-4/60 hover:bg-ink-2",
                STAGE_LAYER.badges,
                // Fades with the rest of the overlay (it is the same group:
                // a stream alone on the stage with a pill across its top is
                // the bar problem again). Still pressable while faded, and a
                // press then only brings it back, like the bar.
                chromeClass,
              )}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") {
                  setBarHovered(true);
                }
              }}
              onPointerLeave={() => setBarHovered(false)}
              onFocus={(event) => setBarFocused(isKeyboardFocus(event.target))}
              onBlur={() => setBarFocused(false)}
              onPointerDownCapture={swallowPressWhileHidden}
              onClickCapture={swallowPressWhileHidden}
              onClick={() => {
                if (fullscreen.soloPeerId !== null) {
                  fullscreen.toggleScreen(fullscreen.soloPeerId);
                }
              }}
            >
              <LayoutGrid aria-hidden="true" className="h-3.5 w-3.5" />
              {t("voice.stage.showAllStreams")}
            </button>
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
              bar's box. Grows with the home indicator, like the bar does, and
              with every line the control row folds onto past its first. */}
          <div
            aria-hidden="true"
            data-testid="call-stage-bar-reserve"
            className="h-[calc(max(4rem,calc(env(safe-area-inset-bottom)+3.5rem))+var(--call-row-extra,0px))] shrink-0"
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
                : controlRowExtraPx > 0
                  ? PIP_CORNER_CLASS_ABOVE_FOLDED_BAR
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
        // The overlay itself passes the pointer through; its few buttons take
        // it back, and resting on one holds the whole group like the bar.
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") {
            setBarHovered(true);
          }
        }}
        onPointerLeave={() => setBarHovered(false)}
        onFocusCapture={(event) =>
          setBarFocused(isKeyboardFocus(event.target))
        }
        onBlurCapture={onBarBlur}
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
              <span className="ml-2 text-warning">
                {voiceState.speakReason === "audience"
                  ? t("voice.audience.badge")
                  : t("voice.bar.listenOnly")}
              </span>
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
                {/* OUR OWN share: a small indicator with the state in words
                    ("Sound shared: on" / "No sound"), so a silent share is
                    known by the person sharing it before anybody tells them.
                    It also says, for the screen reader, that the machine's
                    output is what is going out (the call itself is kept out
                    of that tap, `restrictOwnAudio`). */}
                {focusedIsLocal && (
                  <ShareSoundIndicator on={focusedShareHasAudio} />
                )}
                {focusedIsLocal &&
                  focusedShareHasAudio &&
                  voiceState.isSharingSystemAudio && (
                    <span className="sr-only">
                      {t("voice.share.systemAudioLive")}
                    </span>
                  )}
                {!focusedIsLocal && !focusedShareHasAudio && (
                  <span className="ml-1 inline-flex items-center gap-1 text-paper-muted">
                    <span>({t("voice.share.noAudioShort")})</span>
                    {/* A one-line "not a bug" for whoever is watching, so
                        "sem som" reads as a platform fact rather than
                        something broken on their end. Kept to an icon
                        because the overlay is already crowded, and the
                        Tooltip's own contract is hover/keyboard focus, not a
                        tap: see `components/ui/tooltip.tsx`. */}
                    <Tooltip label={t("voice.share.noAudioTooltip")}>
                      <button
                        type="button"
                        aria-label={t("voice.share.noAudioTooltip")}
                        className="pointer-events-auto inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-paper-muted/70 hover:text-paper-muted focus-visible:outline focus-visible:outline-1"
                      >
                        <Info className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </Tooltip>
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
          // `@container`: the controls fold on the STAGE's width, which on a
          // phone is the screen minus the server rail and on a tablet or a
          // narrow desktop pane is less than the window says. See the pill
          // in `CallControls`.
          "@container absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-8",
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
        // KEYBOARD focus holds the bar, a mouse click does not. A button
        // keeps focus after a click for as long as nothing else takes it, so
        // holding the bar for plain focus meant one press of mute left it up
        // for the rest of the stream (`isKeyboardFocus`).
        onFocusCapture={(event) => setBarFocused(isKeyboardFocus(event.target))}
        onBlurCapture={onBarBlur}
      >
        <MicFallbackNotice
          micFallback={voiceState.micFallback}
          visible={!chrome.hidden}
          onDismiss={onDismissMicFallbackNotice}
        />
        <ShareGameCaptureNotice
          hint={voiceState.shareCaptureHint}
          visible={!chrome.hidden}
        />
        <CapacityNotice
          voiceChannelId={voiceState.voiceChannelId}
          transport={voiceState.roomTransport}
          roseFrom={voiceState.capacityRoseFrom}
          visible={!chrome.hidden}
        />
        <CinemaHint visible={screenStream !== null} />
        {/* Linux only (see `lib/linux-share-audio-hint.ts`): next to the
            share button, before the picker opens, since that is where the
            question actually gets asked. Gone once the share is already
            running, since by then the picker has already been answered. */}
        <LinuxShareAudioHint
          visible={
            !chrome.hidden &&
            Boolean(onStartScreenShare) &&
            !voiceState.isSharingScreen
          }
          isDesktopShell={isDesktopApp()}
        />
        {watchPartyChrome ? null : controls}
      </div>
        </>
      )}
    </div>
    </TileMenuHoldContext.Provider>
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
    // A track the presenter stops mid-share fires `ended` on the track itself
    // and nothing on the stream, so the stream listeners alone would miss it.
    // Tracks that arrive later (a late audio track, or one replaced) are
    // listened to as they land, or a label that turned "with sound" would
    // never turn back.
    const watched = new Set<MediaStreamTrack>();
    const watch = () => {
      for (const track of stream.getAudioTracks()) {
        if (!watched.has(track)) {
          watched.add(track);
          track.addEventListener("ended", sync);
        }
      }
    };
    const onTrackChange = () => {
      watch();
      sync();
    };
    stream.addEventListener("addtrack", onTrackChange);
    stream.addEventListener("removetrack", onTrackChange);
    watch();
    return () => {
      stream.removeEventListener("addtrack", onTrackChange);
      stream.removeEventListener("removetrack", onTrackChange);
      for (const track of watched) {
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
 * Draw the call's coachmarks where they cannot move anything.
 *
 * Docked, that is a host the outlet hangs above its own clipped row (see
 * `useCallDockHintHost`); on the expanded stage there is no host and the
 * node positions itself. Kept as a function so both branches render the
 * SAME element, which is what stops a card remounting (and asking for its
 * slot again) when a call is docked or undocked mid-session.
 */
function renderCallHints(
  host: HTMLElement | null,
  node: ReactElement,
): ReactNode {
  return host === null ? node : createPortal(node, host);
}

/**
 * One line of the stage's control row: a 2.5rem tile inside the pill's 0.375rem
 * padding, top and bottom. What the row measures past this is extra lines.
 */
const STAGE_CONTROL_ROW_REM = 3.25;

/**
 * The control bar under the stage. Exported for the unit test that pins the
 * audience rule below; `CallStage` is the only runtime caller.
 */
export function CallControls({
  voiceState,
  serverId = null,
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
  audienceHost = null,
  leading = null,
  rowRef,
}: {
  voiceState: VoiceState;
  serverId?: string | null;
  collapsed: boolean;
  /**
   * Expanded only: the row of tiles, so the stage can see it fold onto a
   * second line on a narrow screen and keep the strip clear of it.
   */
  rowRef?: Ref<HTMLDivElement>;
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
  /** Audience mode, for somebody who runs the stage. See `audience-mode.tsx`. */
  audienceHost?: AudienceModeHostControls | null;
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
  const hintHost = useCallDockHintHost();
  const [dockControlUsed, setDockControlUsed] = useState(false);
  const bringFriendsHintEnabled = useFeatureHintEnabled("bringFriends");
  const musicHintEnabled = useFeatureHintEnabled("music");
  const musicDock = useMusicDock();
  // The pip outlives the card: it is spent by opening the panel, which the
  // card's own impression never waits for. `lib/music-pip.ts` says why the
  // two do not share a key, and why "spent" is a store rather than a read.
  const musicPip = shouldShowMusicPip({
    seen: useMusicPipSpent(),
    automated: shouldSuppressHints(),
    canSpeak: voiceState.canSpeak,
    playing: musicDock.on,
  });
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
  // On a narrow stage a cluster is not a unit: its tiles fold into the pill's
  // wrapping row one by one. The bell's group keeps its own rule (hidden
  // below `sm`), which a `contents` here would override.
  const stageGroup = collapsed ? undefined : "@max-[40rem]:contents";
  // SPEAK denied locks mute. STREAM denied hides camera and share. The two
  // bits are independent: a stage can let someone present without talking.
  // In a watch_party channel the server answers `canStream` from
  // START_WATCH_PARTY instead of STREAM (`canStartWatchPartyStream` in
  // @pqp/shared), so the audience gets neither the share button nor the
  // Watch party button below, and `set-sharing-screen` would be refused for
  // them anyway. One grant, read once, hides both.
  const listenOnly = !voiceState.canSpeak;
  // Locked by audience mode rather than by the channel: the mic says so in
  // those words, and the hand becomes the way to ask.
  const audienceLocked = listenOnly && voiceState.speakReason === "audience";
  const noVideo = !voiceState.canStream;
  // The room as the roster describes it, which is where the hands are. Self
  // included: your own hand is in the same queue as everybody else's.
  const roomParticipants = voiceState.voiceChannelId
    ? (voiceState.occupancy[voiceState.voiceChannelId] ?? [])
    : [];
  const handRaised = voiceState.handRaisedAt !== null;
  const handLabel = handRaised
    ? t("voice.hand.lower")
    : audienceLocked
      ? t("voice.hand.ask")
      : t("voice.hand.raise");
  // The toggle is offered to a host where the operator turned the feature on,
  // and ALWAYS while it is on, so the off switch can never be hidden by a
  // flag that changed mid-call.
  const showAudienceToggle =
    audienceHost !== null && (audienceHost.available || voiceState.audience !== null);

  const showWatchParty =
    canWatchParty &&
    !listenOnly &&
    !noVideo &&
    Boolean(onStartScreenShare) &&
    !voiceState.isSharingScreen;
  const showCursorPref =
    canShare &&
    !noVideo &&
    Boolean(onStartScreenShare) &&
    (!voiceState.isSharingScreen || cursorLiveControl);
  const moreItems: ContextMenuItemDef[] = [];
  if (showWatchParty) {
    moreItems.push({
      id: "watch-party",
      label: t("voice.control.watchParty"),
      icon: MonitorPlay,
      disabled: shareCappedOut,
      onSelect: () => {
        if (shareCappedOut || !onStartScreenShare) {
          return;
        }
        flushSync(() => {
          setShareHint(t("voice.control.watchPartyHint"));
        });
        void Promise.resolve(
          onStartScreenShare({ preferBrowserTab: true }),
        ).finally(() => {
          setShareHint(null);
        });
      },
    });
  }
  if (showCursorPref) {
    moreItems.push({
      id: "share-cursor",
      label:
        shareCursor === "hide"
          ? t("voice.control.showCursor")
          : t("voice.control.hideCursor"),
      icon: shareCursor === "hide" ? MousePointerBan : MousePointer2,
      checked: shareCursor === "hide",
      onSelect: () =>
        setShareCursor(shareCursor === "hide" ? "show" : "hide"),
    });
  }
  moreItems.push({
    id: "join-leave-sounds",
    label: joinLeaveAutoMute
      ? t("voice.control.enableJoinLeaveSounds")
      : t("voice.control.disableJoinLeaveSounds"),
    icon: joinLeaveAutoMute ? Bell : BellOff,
    checked: joinLeaveAutoMute,
    onSelect: () => setJoinLeaveAutoMuteEnabled(!joinLeaveAutoMute),
  });

  const showMute = !collapsed || !pushToTalk;

  return (
    <div
      className={cn(
        "relative flex flex-col",
        collapsed ? "w-full gap-0" : "items-center gap-1.5",
      )}
    >
      {/* ABOVE THE BAR, OUT OF THE FLOW.
          These sat in the column and pushed the bar (and with it the whole
          composer) down by the height of whichever card was up, so the
          controls moved the moment a card explaining them appeared. Docked,
          they go through `useCallDockHintHost` into a host the outlet hangs
          above its own clipped row; on the expanded stage there is no dock
          and nothing clips, so the same markup is anchored here. Either way
          the wrapper passes pointer events through, so the row underneath
          still takes the click that spends the call dock card. */}
      {renderCallHints(
        hintHost,
        <div
          data-call-hints
          className={cn(
            "flex flex-col",
            hintHost === null &&
              "pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-full [&>*]:pointer-events-auto",
          )}
        >
        {collapsed && callDockHintEnabled && (
          <div className="mb-1">
            <FeatureHint
              id="callDock"
              enabled={!dockControlUsed}
              title={t("featureHint.callDock.title")}
              body={t("featureHint.callDock.body")}
            />
          </div>
        )}
        {watchPartyHintEnabled && canWatchParty && !listenOnly && !noVideo && (
          <div className="mb-1">
            <FeatureHint
              id="watchParty"
              enabled
              body={t("featureHint.watchParty.body")}
            />
          </div>
        )}
        {bringFriendsHintEnabled && voiceState.isSharingScreen && !collapsed && (
          <div className="mb-1">
            <BringFriendsHint enabled />
          </div>
        )}
        {/* Mounted whether or not it wins, so the card can tell "the gate
            turned off" (a track started, the panel opened) from "the strip
            swapped under me". The first spends it; the second must not. */}
        <div className={cn(musicHintEnabled && "mb-1")}>
          <FeatureHint
            id="music"
            enabled={musicHintEnabled}
            title={t("featureHint.music.title")}
            body={t("featureHint.music.body")}
          />
        </div>
        <PttFocusHint
          show={pushToTalk && Boolean(pushToTalkKeyLabel) && !windowFocused}
          className="text-center"
        />
        </div>,
      )}

      {/* The queue sits above the bar, where the room is, rather than in a
          panel somebody has to go and open. Hidden on the slim bar, which has
          no room for a list: the hands are still on every person's row in the
          sidebar, and the raise button below survives the squeeze because
          unlike mute it has nowhere else to live. */}
      {/* Audience mode's line: why the mic is locked, who may talk, what
          the media server has not confirmed yet, and what just changed. On
          the slim bar too, since most calls never expand. */}
      <AudienceModeStrip
        audience={voiceState.audience}
        change={voiceState.audienceChange}
        speakReason={voiceState.speakReason}
        participants={roomParticipants}
        selfUserId={voiceState.self?.userId ?? null}
        host={audienceHost}
        compact={collapsed}
        className={collapsed ? "mb-1.5 px-1" : "mb-1.5"}
      />
      {!collapsed && (
        <RaisedHandQueue
          participants={roomParticipants}
          selfUserId={voiceState.self?.userId ?? null}
          canLowerHands={canLowerHands}
          onLowerHand={onLowerHand}
          audience={
            audienceHost && voiceState.audience
              ? { busy: audienceHost.busy, onAllow: audienceHost.onAllow }
              : null
          }
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
          - 35rem and up: the pill sits beside the tiles. The people keep a
            line of their own. Without a pill the people and the tiles share
            one line already.
          - 48rem and up (`@3xl`): people, pill, tiles on one line.

          The pill is only as wide as "PTT" and its key. It does not grow
          into the spare space: that turned it into a slab, and the spare
          stays empty beside the tiles. */}
      <div
        ref={collapsed ? undefined : rowRef}
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
            data-call-dock-people=""
            className={cn(
              "flex h-9 min-w-0 items-center",
              // Under 35rem the bar is a COLUMN, and a column centres what it
              // holds: the name drifted to the middle of its own line while
              // the tiles under it stayed right. Full width here puts it back
              // against the same left edge as the message below it.
              "w-full @min-[35rem]:w-auto",
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
        second line, where it can still be pressed, instead of off the edge.

        The stage's pill wraps too. It used to be one unbreakable row of
        ~33rem centred in a stage that is ~20rem on a 390 phone, and the
        stage clips, so mute and raise hand sat under the server rail and
        hang-up past the right edge of the screen. Under 40rem of bar (the
        whole desktop set with the bell and the hairlines, and some to
        spare) the clusters dissolve into the pill (`contents` on each
        `CallControlGroup`), so the tiles fold one at a time rather than a
        cluster at a time, at the clusters' own 4px gap. The radius is half
        the one-row height, not `rounded-full`: identical on one row, and a
        rounded box rather than a stadium that the corner tiles poke out of
        on two. */}
    <div
      className={cn(
        "flex items-center gap-1",
        collapsed
          ? "w-full flex-wrap justify-end @min-[35rem]:ml-auto @min-[35rem]:w-auto @min-[35rem]:shrink-0"
          : "max-w-full flex-wrap justify-center gap-2 rounded-[1.625rem] bg-ink-2/90 px-2.5 py-1.5 shadow-lg ring-1 ring-ink-4/60 backdrop-blur @max-[40rem]:gap-1",
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
            audienceLocked
              ? t("voice.audience.locked")
              : listenOnly
                ? t("voice.control.listenOnlyLocked")
                : voiceState.self?.serverMuted
                  ? t("voice.control.serverMuted")
                  : voiceState.isMuted
                    ? t("voice.control.unmute")
                    : t("voice.control.mute")
          }
          detail={
            audienceLocked
              ? t("voice.audience.lockedDetail")
              : !listenOnly && voiceState.self?.serverMuted
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
              data-mic-toggle=""
              data-speak-locked={
                listenOnly ? (voiceState.speakReason ?? "permission") : undefined
              }
              aria-label={
                audienceLocked
                  ? t("voice.audience.locked")
                  : listenOnly
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
      {listenOnly && !collapsed && !audienceLocked && (
        <span
          data-listen-only
          className="shrink-0 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning"
        >
          {t("voice.bar.listenOnly")}
        </span>
      )}
      <CallControlGroup className={stageGroup}>
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
            data-primary={audienceLocked && !handRaised ? "" : undefined}
            className={cn(
              "flex items-center justify-center rounded-full",
              size,
              handRaised
                ? "bg-signal/20 text-signal"
                : audienceLocked
                  ? // THE AUDIENCE'S ONE ACTION. The mic beside it is locked
                    // and says why; this is how to ask, so it is the button
                    // that looks like a button.
                    "bg-accent text-on-accent ring-2 ring-accent/40 hover:bg-accent-hover"
                  : "bg-ink-3 text-paper hover:bg-ink-4",
            )}
            onClick={onToggleRaisedHand}
          >
            <Hand className={iconSize} />
          </button>
        </Tooltip>
      )}
      {showAudienceToggle && audienceHost && (
        <AudienceModeToggle
          on={voiceState.audience !== null}
          busy={audienceHost.busy}
          onToggle={audienceHost.onToggle}
          size={size}
          iconSize={iconSize}
        />
      )}
      </CallControlGroup>
      <CallControlDivider
        container={collapsed}
        className={collapsed ? "my-1" : "my-1.5"}
      />
      <CallControlGroup className={stageGroup}>
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
      <SoundboardControl
        serverId={serverId}
        canUse={voiceState.canUseSoundboard}
        canManage={voiceState.canManageSoundboard}
        size={size}
        iconSize={iconSize}
      />
      <Tooltip
        label={musicDock.open ? t("music.close") : t("music.open")}
      >
        <button
          type="button"
          aria-pressed={musicDock.open}
          aria-label={musicDock.open ? t("music.close") : t("music.open")}
          data-music-dock={musicDock.on ? "playing" : "idle"}
          className={cn(
            "relative flex items-center justify-center rounded-full",
            size,
            musicDock.open
              ? "bg-signal/20 text-signal"
              : "bg-ink-3 text-paper hover:bg-ink-4",
          )}
          onClick={toggleMusicOpen}
        >
          <Music className={iconSize} />
          {/* NOVO, until the panel has been opened once. Never beside the
              dot below: that one needs a track on and this one needs none. */}
          {musicPip ? (
            <span
              data-music-pip=""
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-signal ring-2 ring-ink"
            />
          ) : null}
          {/* The room has music and this machine is not hearing it. Nothing
              else on this tile can say that with the panel shut. */}
          {musicDock.on && !musicDock.listening ? (
            <span
              data-music-dock-dot=""
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-signal ring-2 ring-ink"
            />
          ) : null}
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
      {/* Watch party, the share cursor, and join/leave sounds. They used to
          be their own tiles and filled the slim bar. A phone still hides
          this whole control under 22rem, the same width those tiles used. */}
      <CallControlGroup className={collapsed ? "hidden @min-[22rem]:flex" : "flex"}>
        <Menu items={moreItems} side="top" align="end">
          <button
            type="button"
            data-testid="call-dock-more"
            data-call-more={moreItems.map((item) => item.id).join(" ")}
            aria-label={t("voice.control.more")}
            className={cn(
              "flex items-center justify-center rounded-full bg-ink-3 text-paper hover:bg-ink-4",
              size,
            )}
          >
            <MoreHorizontal className={iconSize} />
          </button>
        </Menu>
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
  useReportTileMenu(menu.open);
  const hasAudio = Boolean(audio?.voice || audio?.share);
  if (!onToggleFullscreen && !onPin && !hasAudio && !fit) {
    return null;
  }
  return (
    <div
      ref={menu.rootRef}
      data-call-chrome="tile"
      className={cn(
        "absolute left-2 top-2 flex items-center gap-1",
        STAGE_LAYER.tileControls,
        // An open panel keeps its own chrome visible; otherwise the row
        // follows the tile's hover, and stays put on a touch screen.
        menu.open
          ? "opacity-100"
          : cn(
              "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
              TILE_CONTROLS_FADE,
            ),
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
      <SoundboardFloat userId={person.userId} />
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
      <SoundboardFloat userId={person.userId} />
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
      <SoundboardFloat userId={person.userId} />
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
  userId?: string;
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
      <SoundboardFloat userId={person.userId} />
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
  useReportTileMenu(menu.open);
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
        data-call-chrome="tile"
        className={cn(
          "absolute left-2 top-2 flex max-w-[80%] items-center gap-1.5",
          STAGE_LAYER.tileControls,
          menu.open || hideSelfPreview
            ? "opacity-100"
            : cn(
                "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
                TILE_CONTROLS_FADE,
              ),
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
