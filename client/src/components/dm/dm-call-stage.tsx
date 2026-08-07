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
import type { DmSummary } from "@pqp/shared";
import type { VoiceState } from "@/hooks/use-voice";
import {
  detectFullscreenMode,
  supportsScreenShare,
  type FullscreenMode,
} from "@/components/voice/capabilities";
import { VoiceAvatar } from "@/components/voice/voice-avatar";
import { useTranslation } from "@/lib/i18n";
import { conversationTitle } from "@/lib/conversations";
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
 * Fullscreen for the stage container, with the iOS video-only fallback.
 *
 * Capability *detection* is `detectFullscreenMode` from
 * `components/voice/capabilities.ts` — not re-derived here. The event wiring
 * follows `screen-share-view.tsx`, including the reattach-on-exit fix: iOS's
 * native player detaches a MediaStream on the way out, so the same stream is
 * re-set and replayed, both no-ops anywhere the detach did not happen.
 */
function useStageFullscreen(
  containerRef: RefObject<HTMLDivElement | null>,
  videoRef: RefObject<WebkitFullscreenVideo | null>,
  hasPrimaryVideo: boolean,
) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mode, setMode] = useState<FullscreenMode>("none");

  useEffect(() => {
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
        webkitEnterFullscreen: videoRef.current?.webkitEnterFullscreen,
      }),
    );
    // Re-probed when the primary video element appears: the iOS path needs the
    // <video> itself, which does not exist while the call is audio-only.
  }, [containerRef, videoRef, hasPrimaryVideo]);

  useEffect(() => {
    const video = videoRef.current;
    const onFullscreenChange = () => {
      setIsFullscreen(currentFullscreenElement() === containerRef.current);
    };
    const onBegin = () => setIsFullscreen(true);
    const onEnd = () => {
      setIsFullscreen(false);
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

  const toggle = useCallback(() => {
    if (mode === "element") {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const active = currentFullscreenElement();
      const request = active
        ? exitDocumentFullscreen()
        : requestElementFullscreen(container);
      void request.catch((err: unknown) => {
        console.warn("[call] fullscreen refused", err);
      });
      return;
    }
    if (mode === "video") {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      try {
        if (video.webkitDisplayingFullscreen) {
          video.webkitExitFullscreen?.();
        } else {
          video.webkitEnterFullscreen?.();
        }
      } catch (err) {
        console.warn("[call] video fullscreen refused", err);
      }
    }
  }, [mode, containerRef, videoRef]);

  // The iOS mode can only fullscreen an actual <video>; without one the button
  // would silently no-op, which is worse than no button.
  const available = mode === "element" || (mode === "video" && hasPrimaryVideo);
  return { isFullscreen, mode, available, toggle };
}

export function DmCallStage({
  conversation,
  currentUser,
  voiceState,
  onJoinCall,
  onLeave,
  onToggleMute,
  onToggleCamera,
  onStartScreenShare,
  onStopScreenShare,
}: {
  conversation: DmSummary;
  currentUser: { id: string; displayName: string; avatarUrl: string | null } | null;
  voiceState: VoiceState;
  onJoinCall: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onStartScreenShare?: () => void;
  onStopScreenShare?: () => void;
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
      collapsed={collapsed}
      onSetCollapsed={setCollapsedRemembered}
      onLeave={onLeave}
      onToggleMute={onToggleMute}
      onToggleCamera={onToggleCamera}
      onStartScreenShare={onStartScreenShare}
      onStopScreenShare={onStopScreenShare}
    />
  );
}

function ActiveCall({
  conversation,
  currentUser,
  voiceState,
  collapsed,
  onSetCollapsed,
  onLeave,
  onToggleMute,
  onToggleCamera,
  onStartScreenShare,
  onStopScreenShare,
}: {
  conversation: DmSummary;
  currentUser: { id: string; displayName: string; avatarUrl: string | null } | null;
  voiceState: VoiceState;
  collapsed: boolean;
  onSetCollapsed: (collapsed: boolean) => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onStartScreenShare?: () => void;
  onStopScreenShare?: () => void;
}) {
  const { t } = useTranslation();
  const channelId = conversation.channelId;
  const joining = voiceState.status === "joining";
  // "Calling…" is a call we started that nobody has picked up: connected, but
  // alone in the room. (Everybody-left lands here too, which reads the same.)
  const callingOut =
    voiceState.status === "connected" && voiceState.remotePeers.length === 0;
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

  // Whose screen fills the stage, if anyone's.
  const screenStream = voiceState.isSharingScreen
    ? voiceState.localScreenStream
    : (voiceState.remotePeers.find(
        (peer) => peer.peerId === voiceState.screenSharePeerId,
      )?.screenStream ?? null);
  const presenterName = voiceState.isSharingScreen
    ? currentUser?.displayName
    : voiceState.remotePeers.find(
        (peer) => peer.peerId === voiceState.screenSharePeerId,
      )?.displayName;

  const layout = stageLayout(
    remotes.length,
    voiceState.screenSharePeerId !== null,
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
  );

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
  const shouldAutoHide = autoHide && anyVideo && !collapsed;
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
        fullscreen.isFullscreen && fullscreen.mode === "element"
          ? "h-full max-h-none"
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
          <StageVideo
            stream={screenStream}
            videoRef={primaryVideoRef}
            className="min-h-0 flex-1 object-contain"
          />
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

function CallControls({
  voiceState,
  collapsed,
  fullscreenAvailable,
  isFullscreen,
  onToggleFullscreen,
  onToggleMute,
  onToggleCamera,
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
  onStartScreenShare?: () => void;
  onStopScreenShare?: () => void;
  onToggleCollapsed: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  // Probed once per mount — whether the browser has getDisplayMedia never
  // changes mid-session. Same probe the channel voice panel uses.
  const canShare = useMemo(() => supportsScreenShare(), []);
  const someoneElseSharing =
    voiceState.screenSharePeerId !== null &&
    voiceState.screenSharePeerId !== voiceState.peerId;
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
      {!collapsed && canShare && (onStartScreenShare || onStopScreenShare) && (
        <button
          type="button"
          title={
            someoneElseSharing
              ? t("voice.control.shareTaken")
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
          disabled={someoneElseSharing}
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
            {person.avatarUrl ? (
              <img
                src={person.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                className="relative h-20 w-20 rounded-full object-cover ring-2 ring-ink-2 sm:h-24 sm:w-24"
              />
            ) : (
              <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-ink-4 text-2xl font-semibold text-paper ring-2 ring-ink-2 sm:h-24 sm:w-24">
                {person.displayName.slice(0, 1).toUpperCase()}
              </span>
            )}
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
      {faces.slice(0, 3).map((person) =>
        person.avatarUrl ? (
          <img
            key={person.key}
            src={person.avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-6 w-6 rounded-full object-cover ring-2 ring-ink-2"
          />
        ) : (
          <span
            key={person.key}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-4 text-[10px] font-semibold text-paper ring-2 ring-ink-2"
          >
            {person.displayName.slice(0, 1).toUpperCase()}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * A `<video>` bound to a MediaStream. Always muted: call audio already plays
 * through `VoiceAudioSinks` at the app root, and playing it here too would
 * double every voice.
 */
function StageVideo({
  stream,
  mirrored = false,
  className,
  videoRef,
}: {
  stream: MediaStream | null;
  mirrored?: boolean;
  className?: string;
  videoRef?: RefObject<WebkitFullscreenVideo | null>;
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
      className={cn(className, mirrored && "-scale-x-100")}
    />
  );
}
