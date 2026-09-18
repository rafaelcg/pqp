import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Phone, X } from "lucide-react";
import { liveStateFromStream, type LiveHlsStream } from "@pqp/shared";
import type { ChannelLive, VoiceState } from "@/hooks/use-voice";
import type { CallStageShape } from "@/lib/call-split";
import { fetchChannelLive } from "@/lib/api";
import {
  hlsModeOf,
  hlsPartTargetMs,
  watchPlayerMode,
  type HlsMode,
} from "@/lib/hls-live-edge";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { isSeatedOnAnotherDevice } from "@/lib/dual-device-watch";
import { StreamStartingSoon } from "@/components/voice/stream-starting-soon";
import { WATCH_DOCK_BOX } from "@/components/voice/watch-dock";
import { useWatchFullscreen } from "@/components/voice/watch-fullscreen";
import { WatchPartyBarSlot } from "@/components/watch-party/watch-party-bar";

/**
 * Watch mode without a seat.
 *
 * A channel whose screen share is going out as HLS can be watched by anyone
 * who may view the channel, without joining its voice room: no mic, no peer
 * connection, no LiveKit participant, no seat on the roster. This is the
 * whole point of the egress. A 200-person watch party is not 200 WebRTC
 * subscriptions; it is one transcode and 200 playlist readers, and the room
 * stays a room for the people who actually want to talk.
 *
 * `WatchStage` is the picture and the two facts around it: how many people
 * are watching (room minus the presenter, plus the seatless watchers the
 * server counts) and the one primary action, joining the call, which is the
 * same join the sidebar row's Entrar performs. `WatchChannelStage` is the
 * mount that decides when it shows and keeps the server's count honest:
 * `watch-live true` while the stage is up, `false` when it goes.
 */
export function WatchStage({
  hlsUrl,
  cameraHlsUrl = null,
  cameraHasVideo = true,
  cameraHasVoiceAudio = false,
  delaySeconds,
  mode,
  partTargetMs,
  audienceCount,
  ended,
  onJoin,
  fullscreen,
  onLeaveParty,
  onBarSlot,
  mediaTitle,
  communityName,
  coverUrl,
  className,
  docked = false,
  onReturn,
  onDismiss,
  dualDeviceWarning = false,
}: {
  /** Playable playlist URL; null while nothing is live. */
  hlsUrl: string | null;
  /**
   * The presenter's camera, as its own playlist. Null unless the server is
   * running a camera transcode beside the ladder; the player floats it in a
   * corner. See `docs/WATCH_PARTY.md`, "The presenter's camera, floating over
   * the film".
   */
  cameraHlsUrl?: string | null;
  /**
   * Whether `cameraHlsUrl` actually carries a picture. False is
   * `LIVE_HLS_VOICE_TRACK`'s "separada" mode with no camera published: the
   * playlist is audio-only, and the corner box should not render a black
   * video frame for it. Defaults true, the shape every camera ever had
   * before that flag.
   */
  cameraHasVideo?: boolean;
  /**
   * Whether `cameraHlsUrl` carries the presenter's MICROPHONE, separately
   * from the film (`LIVE_HLS_VOICE_TRACK`, "separada" — see
   * `docs/plans/WATCH_PARTY_SEPARATE_TRACKS.md`). Defaults false, which
   * keeps every camera before that flag silent, exactly as it always was.
   */
  cameraHasVoiceAudio?: boolean;
  delaySeconds?: number;
  /** `LiveHlsStream.mode` (`docs/plans/LL_HLS.md`). Absent means conventional. */
  mode?: HlsMode;
  /** `LiveHlsStream.partTargetMs`, read only when `mode === "ll"`. */
  partTargetMs?: number;
  /** Everybody watching, seated or not, presenter excluded. */
  audienceCount: number;
  /** The stream this person was watching went away. Said, not just blank. */
  ended: boolean;
  /**
   * Join the call, or NOTHING AT ALL when somebody else is already offering
   * it.
   *
   * Optional because of what a viewer counted on production, on one screen,
   * with a party running: the channel header's green Entre na call, the party
   * bar's Entrar na call, and this one, also green. Three targets for the one
   * action the seatless path exists to avoid, two of them in the app's
   * primary colour. Watching costs a socket; joining costs a seat, a LiveKit
   * participant and forwarded streams, and the measured envelope is about 600
   * interactive users against an effectively unbounded HLS audience. A
   * fraction of a 500-person Saturday pressing the most prominent thing on
   * screen is the load the egress was built to avoid, in the first minute.
   *
   * So a watch party channel passes nothing here and the party bar owns the
   * join. A plain voice channel with a share going out has no party bar, and
   * there this is still the only way in.
   */
  onJoin?: () => void;
  /** The film taking the screen, and the way back out. */
  fullscreen?: {
    active: boolean;
    toggle: () => void;
    chatOverlay?: boolean;
    toggleChatOverlay?: () => void;
  };
  /** How to stop watching, when leaving the room is a thing this person can do. */
  onLeaveParty?: () => void;
  /**
   * Where the watch party's bar goes while this person has a picture (see
   * `WatchPartyBarSlot`): a span in the player's bottom bar. Omitted when
   * docked, where a 240px box has no room for it.
   */
  onBarSlot?: (element: HTMLDivElement | null) => void;
  mediaTitle?: string;
  communityName?: string | null;
  coverUrl?: string | null;
  className?: string;
  /**
   * The mini player, carried into another channel. Same component, same
   * `HlsWatchPlayer` at the same place in the tree, so switching between the
   * two is a prop change and NOT a remount: the `<video>` and the hls.js
   * instance behind it survive. See `watch-dock.tsx`.
   */
  docked?: boolean;
  /** Back to the channel the stream belongs to. Docked only. */
  onReturn?: () => void;
  /** Stop watching without leaving whatever channel is open. Docked only. */
  onDismiss?: () => void;
  /**
   * This account already holds a seat in this channel's call, on some other
   * device or tab (`lib/dual-device-watch.ts`). See `HlsWatchPlayer`.
   */
  dualDeviceWarning?: boolean;
}) {
  const { t } = useTranslation();
  const live = hlsUrl !== null;
  const miniActions = docked ? (
    <>
      <button
        type="button"
        data-testid="watch-mini-return"
        aria-label={t("voice.watch.mini.return")}
        title={t("voice.watch.mini.return")}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-paper hover:bg-black/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
        onClick={onReturn}
      >
        <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="watch-mini-close"
        aria-label={t("voice.watch.mini.close")}
        title={t("voice.watch.mini.close")}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-paper hover:bg-black/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </>
  ) : null;
  const overlayActions = (
    <>
      {onLeaveParty ? (
        <button
          type="button"
          data-testid="watch-stage-leave"
          className="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium text-paper/80 hover:bg-paper/15 hover:text-paper"
          onClick={onLeaveParty}
        >
          {t("voice.watch.leave")}
        </button>
      ) : null}
      {onJoin ? (
        <button
          type="button"
          data-testid="watch-stage-join"
          title={t("voice.watch.joinHint")}
          className="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-paper/20 px-2.5 py-1.5 text-xs font-medium text-paper/80 hover:bg-paper/15 hover:text-paper"
          onClick={onJoin}
        >
          <Phone className="h-3.5 w-3.5" aria-hidden="true" />
          {t("voice.watch.join")}
        </button>
      ) : null}
    </>
  );
  const audienceMeta = (
    <p
      data-testid="watch-stage-state"
      className="truncate text-[11px] font-medium text-paper/80"
    >
      {t("voice.watch.audience", { count: audienceCount })}
    </p>
  );

  return (
    <div
      data-testid="watch-stage"
      className={cn("relative h-full w-full bg-black", className)}
    >
      {live ? (
        <HlsWatchPlayer
          src={hlsUrl}
          cameraSrc={cameraHlsUrl}
          cameraHasVideo={cameraHasVideo}
          cameraHasVoiceAudio={cameraHasVoiceAudio}
          delaySeconds={delaySeconds}
          mode={mode ? watchPlayerMode(mode) : undefined}
          partTargetMs={partTargetMs}
          mediaTitle={mediaTitle}
          communityName={communityName}
          coverUrl={coverUrl}
          className="h-full w-full"
          layout={docked ? "mini" : "cinema"}
          onDoubleClick={docked ? onReturn : fullscreen?.toggle}
          fullscreen={
            !docked && fullscreen
              ? { active: fullscreen.active, toggle: fullscreen.toggle }
              : undefined
          }
          chatOverlay={
            !docked && fullscreen?.active && fullscreen.toggleChatOverlay
              ? {
                  active: Boolean(fullscreen.chatOverlay),
                  toggle: fullscreen.toggleChatOverlay,
                }
              : undefined
          }
          meta={docked ? null : audienceMeta}
          /* PARAR DE ASSISTIR IS ON THE BOTTOM BAR NOW (pass 2), beside the
             party's own controls, so the viewer has one row to read. The
             top overlay keeps the audience count and, docked, the mini
             chrome. */
          actions={docked ? miniActions : undefined}
          bottomActions={
            docked ? undefined : (
              <>
                {onBarSlot ? (
                  <WatchPartyBarSlot placement="player" onElement={onBarSlot} />
                ) : null}
                {overlayActions}
              </>
            )
          }
          dualDeviceWarning={dualDeviceWarning}
        />
      ) : (
        <EndedWatchStage
          ended={ended}
          audienceMeta={audienceMeta}
          actions={overlayActions}
        />
      )}
      {docked && live ? (
        /* The picture IS the way back, which is what a person tries first.
           Hidden from the accessibility tree because the button above says
           the same thing with a name on it: this is the pointer shortcut, not
           a second control. z-20 keeps it under the mini chrome, so mute and
           close still take their own clicks. */
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          data-testid="watch-mini-picture"
          className="absolute inset-0 z-20 cursor-pointer"
          onClick={onReturn}
        />
      ) : null}
    </div>
  );
}

function EndedWatchStage({
  ended,
  audienceMeta,
  actions,
}: {
  ended: boolean;
  audienceMeta: ReactNode;
  actions: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full w-full flex-col bg-black">
      <div
        data-testid="watch-stage-ended"
        className={cn(
          "relative flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-1 px-6 text-center",
          !ended && "overflow-hidden",
        )}
      >
        {ended ? (
          <>
            <p className="text-sm font-semibold text-paper">
              {t("voice.watch.ended")}
            </p>
            <p className="text-xs text-paper-muted">
              {t("voice.watch.endedHint")}
            </p>
          </>
        ) : (
          // Announced/live, still no playable frame: the same holding screen
          // the player shows once it has a URL to buffer, so a viewer who
          // opens the channel before the egress has one sees the same "on
          // its way" screen rather than a bare loading sentence.
          //
          // C3 (post-mortem item): the rotating lines are deliberately vague
          // ("hang tight, it's coming") because this state covers both a
          // few-second egress warm-up AND a presenter who has not pressed
          // share yet, which can last indefinitely. The caption underneath
          // says the second half in words, so a long wait here reads as "the
          // show has not started" rather than as something stuck.
          <StreamStartingSoon caption={t("voice.watch.notStartedCaption")} />
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">{audienceMeta}</div>
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      </div>
    </div>
  );
}

/**
 * How many people a `channel-live` plus the roster say are watching. The
 * same sum the sidebar row shows (`liveStateFromStream`), so the two never
 * disagree.
 */
export function watchAudienceCount(
  live: ChannelLive | undefined,
  participants: readonly { peerId: string; sharingScreen: boolean }[] | undefined,
): number {
  if (!live) {
    return 0;
  }
  return liveStateFromStream(live.stream, participants, live.watching)
    .viewerCount;
}

/**
 * Server voice channel mount of the watch stage.
 *
 * Mounted for every voice room the person has open without being in it, so
 * it can (a) ask the API once what the channel's stream is, for a socket that
 * arrived after the last `channel-live`, and (b) render nothing at all in the
 * common case of a room with no egress. While a stream is showing it holds a
 * `watch-live true` with the server, and drops it on unmount, channel change
 * or join. Never touches the mic or the room's media.
 */
export function WatchChannelStage({
  channelId,
  channelName,
  serverName = null,
  serverIconUrl = null,
  voiceState,
  onJoin,
  onLeaveParty,
  onBarSlot,
  onSetWatchingLive,
  onSeedChannelLive,
  fill = false,
  onShapeChange,
  docked = false,
  onReturn,
  onDismiss,
  isWatchParty = false,
  meUserId = null,
}: {
  channelId: string;
  channelName: string;
  serverName?: string | null;
  serverIconUrl?: string | null;
  voiceState: VoiceState;
  /**
   * This account's own user id, for the "you are also seated elsewhere" hint
   * (`lib/dual-device-watch.ts`). Null while auth has not resolved yet, which
   * just means the hint stays off until it has.
   */
  meUserId?: string | null;
  /** Omitted where another surface already offers it. See `WatchStage`. */
  onJoin?: () => void;
  /**
   * Stop watching. Watching is automatic on opening the channel, so stopping
   * means leaving the room, which only the caller knows how to do.
   */
  onLeaveParty?: () => void;
  /** See `WatchStage`'s `onBarSlot`. */
  onBarSlot?: (element: HTMLDivElement | null) => void;
  onSetWatchingLive: (channelId: string, watching: boolean) => void;
  /** Where the one-time `GET /api/channels/:id/live` answer goes. */
  onSeedChannelLive: (
    channelId: string,
    live: { stream: LiveHlsStream | null; watching: number; ended?: boolean },
  ) => void;
  /** The pane's divider owns the stage's height. See `CallSplit`. */
  fill?: boolean;
  onShapeChange?: (shape: CallStageShape) => void;
  /**
   * Drawn as the corner mini player instead of the channel stage, because the
   * person is reading another channel. The mount is the same one either way:
   * `watch-dock.tsx` moves the DOM rather than remounting it, which is what
   * keeps the stream from rebuffering on every click in the sidebar.
   */
  docked?: boolean;
  onReturn?: () => void;
  onDismiss?: () => void;
  /**
   * A watch party channel already has somewhere to say "nothing is on air":
   * `WatchPartyPanel`'s surface slot, which `watchPartySurface` puts back to
   * `empty`/`none` the moment the stream is gone, in the same render the
   * party's own `state` turns `ended`. This mount's "the stream ended" card
   * was built for a plain voice channel's bare share, which has no other
   * surface at all. On a watch party channel the two used to show at once:
   * the party bar's empty state on top, this card filling the rest of the
   * pane, chat and the composer pushed out of view. So on a watch party
   * channel this card stays out of the ended case entirely and leaves the
   * pane to the panel; the live picture above is unaffected.
   */
  isWatchParty?: boolean;
}) {
  const inThisCall =
    voiceState.voiceChannelId === channelId && voiceState.status !== "idle";
  const live = voiceState.channelLive[channelId];
  // DESCRIBED, not merely present. An entry whose null the server could not
  // vouch for is "we have not been told" (`streamEnded`), and cancelling the
  // one-time GET on it would throw away the only authoritative answer this
  // pane is ever going to get: the viewer would sit on "Preparando" until
  // some later frame happened along.
  const known =
    live !== undefined && (live.stream !== null || live.streamEnded === true);
  const stream = inThisCall ? null : (live?.stream ?? null);
  const hasStream = stream !== null;
  const dualDeviceWarning = isSeatedOnAnotherDevice(
    voiceState.occupancy[channelId],
    meUserId,
    inThisCall,
  );

  // A socket that opened this channel after the last `channel-live` knows
  // nothing yet. Ask once; the socket keeps it current from then on.
  useEffect(() => {
    if (known || inThisCall) {
      return;
    }
    let cancelled = false;
    void fetchChannelLive(channelId)
      .then((answer) => {
        if (!cancelled) {
          onSeedChannelLive(channelId, {
            stream: answer.stream,
            watching: answer.watching,
            ended: answer.ended,
          });
        }
      })
      .catch(() => {
        // No answer is the same as "nothing live": the frame will say
        // otherwise the moment the egress starts.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, known, inThisCall]);

  // The count the server keeps is per socket and per channel; say so for as
  // long as the picture is up and take it back the moment it is not.
  useEffect(() => {
    if (!hasStream) {
      return;
    }
    onSetWatchingLive(channelId, true);
    return () => onSetWatchingLive(channelId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, hasStream]);

  // "The stream ended" is only true for a stream this person was watching.
  // Tracked per channel so switching to a quiet room does not say it ended.
  const seenRef = useRef<string | null>(null);
  const [endedFor, setEndedFor] = useState<string | null>(null);
  useEffect(() => {
    if (hasStream) {
      seenRef.current = channelId;
      setEndedFor(null);
      return;
    }
    if (seenRef.current === channelId && !inThisCall) {
      setEndedFor(channelId);
    }
  }, [channelId, hasStream, inThisCall]);
  const ended = endedFor === channelId && !hasStream && !inThisCall;

  // The ended card belongs to the channel, not to the corner: a mini player
  // whose stream stopped goes away rather than sitting there saying so. On a
  // watch party channel it also does not belong here: `WatchPartyPanel`'s own
  // surface already owns "nothing is on air" the moment the stream drops
  // (see `isWatchParty` above), so drawing this too doubled up the pane.
  const visible = !inThisCall && (hasStream || (ended && !docked && !isWatchParty));
  const stageRef = useRef<HTMLDivElement>(null);
  const fullscreen = useWatchFullscreen(stageRef);
  // A stage that goes away must not leave the pane pinned to the window: the
  // party ended, the person joined the call, they changed channel. The hook
  // cleans up its own attribute on unmount; this is the case where the mount
  // survives and only the picture goes.
  useEffect(() => {
    if ((!visible || docked) && fullscreen.active) {
      fullscreen.exit();
    }
  }, [visible, docked, fullscreen]);
  // Only ever speaks about its own stage. `CallStage` owns the shape while
  // the person is in the call, and this mount stays alive (rendering
  // nothing) through that, so an unconditional "none" here would fight it.
  const wasVisibleRef = useRef(false);
  const stageShape: CallStageShape = fullscreen.active
    ? "fullscreen"
    : "expanded";
  // A docked player is not in the pane at all, so the split must hear "none"
  // about it: leaving the shape at `expanded` would reserve a band of empty
  // stage above the transcript of whatever channel the person walked into.
  useEffect(() => {
    if (visible && !docked) {
      wasVisibleRef.current = true;
      onShapeChange?.(stageShape);
      return;
    }
    if (wasVisibleRef.current) {
      wasVisibleRef.current = false;
      onShapeChange?.("none");
    }
  }, [visible, docked, stageShape, onShapeChange]);
  useEffect(() => {
    return () => {
      if (wasVisibleRef.current) {
        wasVisibleRef.current = false;
        onShapeChange?.("none");
      }
    };
  }, [onShapeChange]);

  if (!visible) {
    return null;
  }

  return (
    <div
      ref={stageRef}
      data-testid="watch-channel-stage"
      className={cn(
        docked
          ? WATCH_DOCK_BOX
          : cn(
              "relative shrink-0 overflow-hidden bg-black",
              // Cinema fullscreen fills whatever box it is in: native
              // fullscreen makes that box the screen, expand pins the pane to
              // the window. `fill` is the divider owning the height in the
              // ordinary split.
              fill || fullscreen.active
                ? "h-full min-h-0"
                : "h-[68svh] min-h-[280px]",
            ),
      )}
      data-docked={docked ? "" : undefined}
    >
      <WatchStage
        hlsUrl={stream?.hlsUrl ?? null}
        cameraHlsUrl={stream?.cameraHlsUrl ?? null}
        cameraHasVideo={stream?.cameraHasVideo ?? true}
        cameraHasVoiceAudio={stream?.cameraHasVoiceAudio ?? false}
        delaySeconds={stream?.delaySeconds}
        mode={hlsModeOf(stream)}
        partTargetMs={hlsPartTargetMs(stream)}
        audienceCount={watchAudienceCount(
          live,
          voiceState.occupancy[channelId],
        )}
        ended={ended}
        onJoin={docked ? undefined : onJoin}
        onLeaveParty={docked ? undefined : onLeaveParty}
        onBarSlot={docked ? undefined : onBarSlot}
        docked={docked}
        onReturn={onReturn}
        onDismiss={onDismiss}
        fullscreen={
          docked
            ? undefined
            : {
                active: fullscreen.active,
                toggle: fullscreen.toggle,
                chatOverlay: fullscreen.chatOverlay,
                toggleChatOverlay: fullscreen.toggleChatOverlay,
              }
        }
        mediaTitle={channelName}
        communityName={serverName}
        coverUrl={serverIconUrl}
        dualDeviceWarning={dualDeviceWarning}
      />
    </div>
  );
}
