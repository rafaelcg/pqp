import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Phone, Radio } from "lucide-react";
import { liveStateFromStream } from "@pqp/shared";
import type { ChannelLive, VoiceState } from "@/hooks/use-voice";
import type { CallStageShape } from "@/lib/call-split";
import { fetchChannelLive } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { useWatchFullscreen } from "@/components/voice/watch-fullscreen";

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
  delaySeconds,
  audienceCount,
  ended,
  onJoin,
  fullscreen,
  onLeaveParty,
  mediaTitle,
  communityName,
  coverUrl,
  className,
}: {
  /** Playable playlist URL; null while nothing is live. */
  hlsUrl: string | null;
  delaySeconds?: number;
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
  fullscreen?: { active: boolean; toggle: () => void };
  /** How to stop watching, when leaving the room is a thing this person can do. */
  onLeaveParty?: () => void;
  mediaTitle?: string;
  communityName?: string | null;
  coverUrl?: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const live = hlsUrl !== null;

  return (
    <div
      data-testid="watch-stage"
      className={cn("flex h-full w-full flex-col bg-ink", className)}
    >
      <div className="relative min-h-0 w-full flex-1 bg-black">
        {live ? (
          <HlsWatchPlayer
            src={hlsUrl}
            delaySeconds={delaySeconds}
            mediaTitle={mediaTitle}
            communityName={communityName}
            coverUrl={coverUrl}
            className="group h-full w-full"
          />
        ) : (
          <div
            data-testid="watch-stage-ended"
            className="flex h-full w-full flex-col items-center justify-center gap-1 px-6 text-center"
          >
            <p className="text-sm font-semibold text-paper">
              {ended ? t("voice.watch.ended") : t("voice.hls.buffering")}
            </p>
            {ended && (
              <p className="text-xs text-paper-muted">
                {t("voice.watch.endedHint")}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-4/60 px-3 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {live && (
              <span
                data-testid="watch-stage-live"
                className="flex shrink-0 items-center gap-1 rounded bg-danger/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-danger"
              >
                <Radio className="h-3 w-3" aria-hidden="true" />
                {t("voice.hls.live")}
              </span>
            )}
            {/* THE LABEL IS GONE, AND NOTHING REPLACED IT.

                It said "Assistindo sem entrar na call", and Rafael's reply is
                the whole argument: "'Watching without joining the call' how's
                that even a thing in watch party lol." He is right. That
                sentence describes the IMPLEMENTATION, which is a voice room
                with an HLS audience attached, and it frames the thing
                everybody came for as an abstention from the thing almost
                nobody wants. Nobody arriving at a film thinks of themselves
                as being in a call they have declined to join.

                A playing film is unusually good evidence that somebody is
                watching a film, so the state does not need announcing. What
                is left on this row is two things that are true and useful on
                their own: how many people are here, and how far behind live
                they are. */}
          </div>
          <p
            data-testid="watch-stage-state"
            className="truncate text-xs text-paper-muted"
          >
            {t("voice.watch.audience", { count: audienceCount })}
            {live && delaySeconds !== undefined
              ? ` · ${t("voice.hls.delay", { seconds: delaySeconds })}`
              : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* A WAY TO STOP. Watching starts by itself when the channel is
              opened, and that is the right default: it is the cheap path and
              the one almost everyone should be on, so putting a click in
              front of it while three buttons offered the expensive one would
              be exactly backwards. What was missing is the other half. The
              state line to the left says what this person is doing; this says
              how to stop, and it is honest about what stopping is, which is
              leaving the room. */}
          {onLeaveParty ? (
            <button
              type="button"
              data-testid="watch-stage-leave"
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-text-tertiary hover:bg-surface-2 hover:text-text"
              onClick={onLeaveParty}
            >
              {t("voice.watch.leave")}
            </button>
          ) : null}
          {/* DEMOTED, AND ONLY WHERE IT IS THE ONLY ONE. It was `bg-success`,
              the app's primary fill, which made joining a call the loudest
              thing on a screen whose whole point is that you do not have to.
              Watching is the default and the correct state for almost
              everybody, so the button that leaves it is a quiet one. */}
          {onJoin ? (
            <button
              type="button"
              data-testid="watch-stage-join"
              title={t("voice.watch.joinHint")}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2 hover:text-text"
              onClick={onJoin}
            >
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
              {t("voice.watch.join")}
            </button>
          ) : null}
          {/* THE ONE CONTROL THIS PLAYER NEVER HAD. A watch party is a film,
              and a film in a pane between a sidebar and a chat column is not
              what anybody came for. It takes the whole SPLIT PANE rather than
              the video, so the chat comes with it; see
              `voice/watch-fullscreen.ts`. */}
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
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-2 hover:text-text"
              onClick={fullscreen.toggle}
            >
              {fullscreen.active ? (
                <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>
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
  onSetWatchingLive,
  onSeedChannelLive,
  fill = false,
  onShapeChange,
}: {
  channelId: string;
  channelName: string;
  serverName?: string | null;
  serverIconUrl?: string | null;
  voiceState: VoiceState;
  /** Omitted where another surface already offers it. See `WatchStage`. */
  onJoin?: () => void;
  /**
   * Stop watching. Watching is automatic on opening the channel, so stopping
   * means leaving the room, which only the caller knows how to do.
   */
  onLeaveParty?: () => void;
  onSetWatchingLive: (channelId: string, watching: boolean) => void;
  /** Where the one-time `GET /api/channels/:id/live` answer goes. */
  onSeedChannelLive: (channelId: string, live: ChannelLive) => void;
  /** The pane's divider owns the stage's height. See `CallSplit`. */
  fill?: boolean;
  onShapeChange?: (shape: CallStageShape) => void;
}) {
  const inThisCall =
    voiceState.voiceChannelId === channelId && voiceState.status !== "idle";
  const live = voiceState.channelLive[channelId];
  const known = live !== undefined;
  const stream = inThisCall ? null : (live?.stream ?? null);
  const hasStream = stream !== null;

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

  const visible = !inThisCall && (hasStream || ended);
  const stageRef = useRef<HTMLDivElement>(null);
  const fullscreen = useWatchFullscreen(stageRef);
  // A stage that goes away must not leave the pane pinned to the window: the
  // party ended, the person joined the call, they changed channel. The hook
  // cleans up its own attribute on unmount; this is the case where the mount
  // survives and only the picture goes.
  useEffect(() => {
    if (!visible && fullscreen.active) {
      fullscreen.exit();
    }
  }, [visible, fullscreen]);
  // Only ever speaks about its own stage. `CallStage` owns the shape while
  // the person is in the call, and this mount stays alive (rendering
  // nothing) through that, so an unconditional "none" here would fight it.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible) {
      wasVisibleRef.current = true;
      onShapeChange?.("expanded");
      return;
    }
    if (wasVisibleRef.current) {
      wasVisibleRef.current = false;
      onShapeChange?.("none");
    }
  }, [visible, onShapeChange]);
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
        "relative shrink-0 overflow-hidden border-b border-ink-4/60 bg-ink",
        // FULLSCREEN NEEDS NOTHING HERE, and that is the point of taking the
        // pane rather than the video. `svh` is the viewport, and in element
        // fullscreen the viewport IS the screen, so the same `68svh` rule
        // that gives the film two thirds of a window gives it two thirds of a
        // screen, with the chat in the third the person already had. The
        // divider still drags inside it, and putting the chat away still
        // gives the film everything. One layout, two sizes of viewport.
        fill ? "h-full min-h-0" : "h-[68svh] min-h-[280px]",
      )}
    >
      <WatchStage
        hlsUrl={stream?.hlsUrl ?? null}
        delaySeconds={stream?.delaySeconds}
        audienceCount={watchAudienceCount(
          live,
          voiceState.occupancy[channelId],
        )}
        ended={ended}
        onJoin={onJoin}
        onLeaveParty={onLeaveParty}
        fullscreen={{ active: fullscreen.active, toggle: fullscreen.toggle }}
        mediaTitle={channelName}
        communityName={serverName}
        coverUrl={serverIconUrl}
      />
    </div>
  );
}
