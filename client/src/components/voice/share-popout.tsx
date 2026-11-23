import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Expand,
  Maximize2,
  PictureInPicture2,
  ScreenShare,
  Video,
  Volume2,
  X,
} from "lucide-react";
import type { VoiceState } from "@/hooks/use-voice";
import { Button } from "@/components/ui/button";
import {
  popoutChoices,
  popoutTarget,
  type PopoutChoice,
} from "@/components/voice/popout-target";
import { bindRemoteVideo } from "@/lib/remote-video-binding";
import {
  clampToArea,
  cornerAfterArrow,
  nearestCorner,
  popoutRect,
  widthFractionFor,
  type PopoutArrowKey,
  type PopoutRect,
} from "@/lib/popout-geometry";
import {
  setSharePopoutPref,
  useSharePopoutPref,
} from "@/lib/share-popout-pref";
import { sharePopoutPlacement } from "@/lib/share-view-mode";
import { dispatchShareView, useShareViewMode } from "@/lib/share-view-store";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * THE SHARE POPOUT (issue 1736): one picture from the call, floating over the
 * conversation area, in every channel.
 *
 * Mounted ONCE at the root of the app, never inside `CallStage`. The stage only
 * exists while its own channel is open, and the point of the popout is that it
 * does not: somebody watching a friend's game walks off to read another
 * channel and the game comes with them. Because it never moves in the tree,
 * the `<video>` stays bound across every navigation and the SFU keeps
 * delivering (`lib/remote-video-delivery.ts` pauses only when the last element
 * bound to a publication goes away).
 *
 * WHAT IT SHOWS is `popoutTarget`: the person's pick, else what it already
 * shows, else the share being heard, then a share with sound, the last share,
 * a speaking camera. The share on the popout is also the one whose sound plays
 * (`voice.focusScreenShare`), because a picture of one game with the sound of
 * another is not a choice anybody makes on purpose.
 *
 * WHERE: a corner of the conversation area (the chat pane minus the composer),
 * stored per device. Dragged freely, snapped to the nearest corner on release,
 * resized from its inner corner, moved between corners with the arrow keys.
 */

export interface SharePopoutCall {
  /** The call's channel or DM, for the badge. */
  name: string;
  /** The server's name; null for a DM call. */
  serverName: string | null;
}

export interface SharePopoutProps {
  voiceState: VoiceState;
  /** `useShareOptInSync`'s answer: the popout applies to this call. */
  enabled: boolean;
  call: SharePopoutCall | null;
  /** The person is looking at the call's own channel or DM. */
  viewingCallChannel: boolean;
  onGoToCall: () => void;
  onFocusShare: (peerId: string) => void;
  onDismissShare: (peerId: string) => void;
}

/** How often the conversation area is re-read while nothing else moved it. */
const AREA_POLL_MS = 500;

export function SharePopout({
  voiceState,
  enabled,
  call,
  viewingCallChannel,
  onGoToCall,
  onFocusShare,
  onDismissShare,
}: SharePopoutProps) {
  const { t } = useTranslation();
  const inCall =
    enabled &&
    voiceState.status !== "idle" &&
    voiceState.voiceChannelId !== null;

  // The mode is this call's: a new call starts as a popout again. Shared with
  // the app shell, which draws the theater (`lib/share-view-store.ts`).
  const mode = useShareViewMode();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const currentRef = useRef<string | null>(null);
  const callId = voiceState.voiceChannelId;
  useEffect(() => {
    dispatchShareView({ type: "call-changed" });
    setPickedId(null);
    currentRef.current = null;
  }, [callId]);
  const dispatch = dispatchShareView;

  const peers = voiceState.remotePeers;
  const screens = useMemo(
    () =>
      voiceState.screenSharePeerIds.map((peerId) => {
        const peer = peers.find((one) => one.peerId === peerId);
        return {
          peerId,
          isSelf: peerId === voiceState.peerId,
          hasAudio: (peer?.screenAudioStream?.getAudioTracks().length ?? 0) > 0,
        };
      }),
    [voiceState.screenSharePeerIds, voiceState.peerId, peers],
  );
  const cameras = useMemo(
    () =>
      peers
        .filter(
          (peer) =>
            peer.cameraStream !== null &&
            !voiceState.dismissedCameraPeerIds.includes(peer.peerId),
        )
        .map((peer) => ({ key: peer.peerId, isSelf: false })),
    [peers, voiceState.dismissedCameraPeerIds],
  );
  const speakingKeys = useMemo(
    () => new Set(voiceState.speakingPeerIds),
    [voiceState.speakingPeerIds],
  );
  const choiceInput = {
    screens,
    dismissedScreenIds: voiceState.dismissedSharePeerIds,
    cameras,
  };
  const choices = popoutChoices(choiceInput);
  const targetId = inCall
    ? popoutTarget({
        ...choiceInput,
        pickedId,
        currentId: currentRef.current,
        focusedScreenPeerId: voiceState.focusedScreenPeerId,
        speakingKeys,
      })
    : null;
  currentRef.current = targetId;
  const target = choices.find((choice) => choice.id === targetId) ?? null;

  // A share the person just chose to watch ("Assistir" in the bar) comes onto
  // the popout and reopens it if they had closed it. Detected here, from the
  // state, so every way of watching a share does it and none has to remember.
  const watchedRef = useRef<Set<string>>(new Set());
  const watchedKey = choices
    .filter((choice) => choice.kind === "screen")
    .map((choice) => choice.id)
    .join(",");
  // A pick made outside the popout's own switcher ("Assistir", coming back
  // from the theater) reaches `target` one render later. Until it does, the
  // focus effect below must not pull the sound back to the share being
  // replaced: that tug of war between "the share I am told to show" and "the
  // share I was showing" is exactly what looped forever when Bob was watched
  // while Alice was on the popout (Electron test, 2026-11-23).
  const pendingPick = useRef<string | null>(null);
  const choose = useCallback((id: string) => {
    pendingPick.current = id;
    setPickedId(id);
  }, []);

  useEffect(() => {
    const now = new Set(watchedKey ? watchedKey.split(",") : []);
    // With opt-in on (which is whenever the popout is), a share only becomes
    // watched because the person asked for it, so every newcomer here is a
    // choice: the last one wins.
    const newly = [...now].filter((id) => !watchedRef.current.has(id));
    watchedRef.current = now;
    const chosen = newly[newly.length - 1];
    if (chosen) {
      choose(chosen);
      dispatch({ type: "watch" });
    }
  }, [watchedKey, dispatch, choose]);

  const placement = sharePopoutPlacement({
    mode,
    viewingCallChannel,
    hasTarget: target !== null,
  });

  // Back from the theater, the popout shows the share the person was
  // watching there (a tile put in fullscreen focuses its share). Only on that
  // transition: while the popout floats, it alone decides the focus.
  const focused = voiceState.focusedScreenPeerId;
  const placementBefore = useRef(placement);
  useEffect(() => {
    const was = placementBefore.current;
    placementBefore.current = placement;
    if (was !== "theater" || placement !== "floating" || focused === null) {
      return;
    }
    const watched = watchedKey ? watchedKey.split(",") : [];
    if (watched.includes(focused)) {
      choose(focused);
    }
  }, [placement, focused, watchedKey, choose]);

  // The share on the popout is the one heard, while the popout is what is on
  // screen. Not in the theater: the stage owns focus there, and pulling it
  // back here would leave the person looking at one share and hearing another.
  useEffect(() => {
    const pending = pendingPick.current;
    if (pending !== null) {
      const watched = watchedKey ? watchedKey.split(",") : [];
      if (target?.id !== pending && watched.includes(pending)) {
        return;
      }
      pendingPick.current = null;
    }
    if (
      placement === "floating" &&
      target?.kind === "screen" &&
      focused !== target.id
    ) {
      onFocusShare(target.id);
    }
  }, [placement, target?.kind, target?.id, focused, watchedKey, onFocusShare]);

  // The theater is the call stage, drawn by the shell; nothing floats over it.
  if (!inCall || placement !== "floating" || target === null) {
    return null;
  }
  return (
    <FloatingPopout
      target={target}
      choices={choices}
      voiceState={voiceState}
      call={call}
      viewingCallChannel={viewingCallChannel}
      onGoToCall={onGoToCall}
      onPick={choose}
      onMaximize={() => {
        dispatch({ type: "maximize" });
        // The theater fills the call's own conversation area, so from
        // anywhere else maximizing is also going back to the call.
        if (!viewingCallChannel) {
          onGoToCall();
        }
      }}
      onClose={() => {
        setPickedId(null);
        if (target.kind === "screen") {
          onDismissShare(target.id);
          // Another share still being watched takes its place. Hiding the
          // popout here would leave that one playing its sound with nothing
          // on screen and no switcher to reach it.
          const next = choices.find(
            (choice) => choice.kind === "screen" && choice.id !== target.id,
          );
          if (next) {
            choose(next.id);
            return;
          }
        }
        dispatch({ type: "close" });
      }}
      t={t}
    />
  );
}

type T = ReturnType<typeof useTranslation>["t"];

function choiceName(choice: PopoutChoice, voiceState: VoiceState, t: T): string {
  const peer = voiceState.remotePeers.find((one) => one.peerId === choice.key);
  return peer?.displayName ?? t("voice.share.someone");
}

function choiceStream(choice: PopoutChoice, voiceState: VoiceState): MediaStream | null {
  const peer = voiceState.remotePeers.find((one) => one.peerId === choice.key);
  if (!peer) {
    return null;
  }
  return choice.kind === "screen" ? peer.screenStream : peer.cameraStream;
}

/**
 * The conversation area the popout lives in: the chat pane, minus the
 * composer at its foot. Anywhere without a chat pane (a page that is not a
 * conversation), the window minus the same margin a composer would take.
 */
export function readPopoutArea(doc: Document, win: Window): PopoutRect {
  const chat = doc.querySelector<HTMLElement>(
    "[data-call-split-chat]:not([hidden])",
  );
  if (chat) {
    const rect = chat.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const composer = chat.querySelector<HTMLElement>("[data-chat-composer]");
      const bottom = composer
        ? Math.min(rect.bottom, composer.getBoundingClientRect().top)
        : rect.bottom;
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: Math.max(0, bottom - rect.top),
      };
    }
  }
  return {
    left: 0,
    top: 0,
    width: win.innerWidth,
    height: Math.max(0, win.innerHeight - 96),
  };
}

function sameRect(a: PopoutRect, b: PopoutRect): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

function usePopoutArea(): PopoutRect {
  const [area, setArea] = useState<PopoutRect>(() =>
    readPopoutArea(document, window),
  );
  useLayoutEffect(() => {
    const read = () => {
      const next = readPopoutArea(document, window);
      setArea((previous) => (sameRect(previous, next) ? previous : next));
    };
    read();
    // The chat pane is replaced on every navigation and resized by the call
    // split, the member list and the app column, none of which tells us. A
    // cheap poll catches all of them; a resize answers at once.
    const timer = window.setInterval(read, AREA_POLL_MS);
    window.addEventListener("resize", read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", read);
    };
  }, []);
  return area;
}

interface Drag {
  pointerId: number;
  kind: "move" | "resize";
  startX: number;
  startY: number;
  origin: PopoutRect;
}

function FloatingPopout({
  target,
  choices,
  voiceState,
  call,
  viewingCallChannel,
  onGoToCall,
  onPick,
  onMaximize,
  onClose,
  t,
}: {
  target: PopoutChoice;
  choices: PopoutChoice[];
  voiceState: VoiceState;
  call: SharePopoutCall | null;
  viewingCallChannel: boolean;
  onGoToCall: () => void;
  onPick: (id: string) => void;
  onMaximize: () => void;
  onClose: () => void;
  t: T;
}) {
  const area = usePopoutArea();
  const pref = useSharePopoutPref();
  const rest = popoutRect(area, pref.corner, pref.widthFraction);
  const [dragRect, setDragRect] = useState<PopoutRect | null>(null);
  const drag = useRef<Drag | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rect = dragRect ?? rest;
  const name = choiceName(target, voiceState, t);
  const stream = choiceStream(target, voiceState);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    return bindRemoteVideo(video, stream);
  }, [stream]);

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    kind: Drag["kind"],
  ) => {
    if (event.button !== 0) {
      return;
    }
    // A press on a control is a click, not a drag.
    if (kind === "move" && (event.target as HTMLElement).closest("button, select")) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      kind,
      startX: event.clientX,
      startY: event.clientY,
      origin: rect,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.kind === "move") {
      setDragRect(
        clampToArea(area, {
          ...current.origin,
          left: current.origin.left + dx,
          top: current.origin.top + dy,
        }),
      );
      return;
    }
    // The resize handle sits on the corner facing the middle of the area, so
    // dragging it away from the anchored corner grows the picture.
    const growsLeft = pref.corner.endsWith("right");
    const width = Math.max(
      1,
      current.origin.width + (growsLeft ? -dx : dx),
    );
    const sized = popoutRect(area, pref.corner, widthFractionFor(area, width));
    setDragRect(sized);
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    drag.current = null;
    const final = dragRect;
    setDragRect(null);
    if (!final) {
      return;
    }
    if (current.kind === "move") {
      setSharePopoutPref({ corner: nearestCorner(area, final) });
    } else {
      setSharePopoutPref({ widthFraction: widthFractionFor(area, final.width) });
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight"
    ) {
      event.preventDefault();
      setSharePopoutPref({
        corner: cornerAfterArrow(pref.corner, event.key as PopoutArrowKey),
      });
    }
  };

  // The value, not the property: a policy that disables picture-in-picture
  // leaves `pictureInPictureEnabled` defined and false.
  const pipSupported =
    typeof document !== "undefined" && document.pictureInPictureEnabled === true;
  const togglePip = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture().catch(() => {});
      return;
    }
    void video.requestPictureInPicture?.().catch(() => {});
  };
  const toggleFullscreen = () => {
    const box = boxRef.current;
    if (!box) {
      return;
    }
    if (document.fullscreenElement === box) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    void box.requestFullscreen?.().catch(() => {});
  };

  const resizeCorner = pref.corner.endsWith("right")
    ? pref.corner.startsWith("top")
      ? "bottom-0 left-0 cursor-nesw-resize"
      : "top-0 left-0 cursor-nwse-resize"
    : pref.corner.startsWith("top")
      ? "bottom-0 right-0 cursor-nwse-resize"
      : "top-0 right-0 cursor-nesw-resize";
  const label =
    target.kind === "screen"
      ? t("voice.popout.label", { name })
      : t("voice.popout.cameraLabel", { name });

  return (
    <div
      ref={boxRef}
      data-testid="share-popout"
      data-share-popout={target.id}
      role="region"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        "group fixed z-40 overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-paper/20",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
        dragRect === null && "transition-[left,top,width,height] duration-150 motion-reduce:transition-none",
      )}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        aria-label={label}
        onDoubleClick={onMaximize}
        className="h-full w-full object-contain"
      />
      <div
        data-share-popout-handle=""
        onPointerDown={(event) => startDrag(event, "move")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          "on-media-scope absolute inset-x-0 top-0 flex cursor-grab items-center gap-1 bg-gradient-to-b from-black/80 to-transparent p-1.5 text-on-media active:cursor-grabbing",
          "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none",
        )}
      >
        <button
          type="button"
          data-testid="share-popout-call"
          onClick={onGoToCall}
          disabled={viewingCallChannel}
          title={viewingCallChannel ? undefined : t("voice.popout.goToCall")}
          className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <Volume2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {call
              ? call.serverName
                ? `${call.name} · ${call.serverName}`
                : call.name
              : name}
          </span>
        </button>
        <span className="flex-1" />
        {choices.length > 1 && (
          <select
            data-testid="share-popout-switch"
            aria-label={t("voice.popout.switch")}
            value={target.id}
            onChange={(event) => onPick(event.target.value)}
            className="max-w-[10rem] truncate rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-on-media"
          >
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.kind === "screen"
                  ? t("voice.popout.choiceScreen", {
                      name: choiceName(choice, voiceState, t),
                    })
                  : t("voice.popout.choiceCamera", {
                      name: choiceName(choice, voiceState, t),
                    })}
              </option>
            ))}
          </select>
        )}
        {pipSupported && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-on-media hover:bg-white/10 hover:text-on-media"
            aria-label={t("voice.popout.pip")}
            title={t("voice.popout.pip")}
            onClick={togglePip}
          >
            <PictureInPicture2 aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="share-popout-maximize"
          className="h-7 w-7 text-on-media hover:bg-white/10 hover:text-on-media"
          aria-label={t("voice.popout.maximize")}
          title={t("voice.popout.maximize")}
          onClick={onMaximize}
        >
          <Expand aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-on-media hover:bg-white/10 hover:text-on-media"
          aria-label={t("voice.share.fullscreen")}
          title={t("voice.share.fullscreen")}
          onClick={toggleFullscreen}
        >
          <Maximize2 aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="share-popout-close"
          className="h-7 w-7 text-on-media hover:bg-white/10 hover:text-on-media"
          aria-label={
            target.kind === "screen"
              ? t("voice.share.dismiss", { name })
              : t("voice.popout.close")
          }
          title={
            target.kind === "screen"
              ? t("voice.share.dismiss", { name })
              : t("voice.popout.close")
          }
          onClick={onClose}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
      <span className="on-media-scope pointer-events-none absolute bottom-1.5 left-1.5 flex max-w-[80%] items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs text-on-media">
        {target.kind === "screen" ? (
          <ScreenShare aria-hidden="true" className="h-3 w-3 shrink-0 text-signal" />
        ) : (
          <Video aria-hidden="true" className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{name}</span>
      </span>
      <div
        data-share-popout-resize=""
        aria-hidden="true"
        onPointerDown={(event) => startDrag(event, "resize")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          "absolute h-4 w-4 opacity-0 group-hover:opacity-100",
          resizeCorner,
        )}
      />
    </div>
  );
}
