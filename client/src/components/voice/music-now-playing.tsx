import {
  HeadphoneOff,
  ListMusic,
  Music,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { MUSIC_MAX_DURATION_MS } from "@pqp/shared";
import type { MusicTrack, VoiceParticipant } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { MarqueeText } from "@/components/ui/marquee-text";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import {
  expectedPositionMs,
  seekTo,
  setListening,
  toggleMusicOpen,
  type MusicSnapshot,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";
import { useScrub, type Scrub } from "@/components/voice/use-scrub";
import {
  MusicOverflowMenu,
  MusicRepeatButton,
  MusicShuffleButton,
  MusicSpeakerControl,
  MusicVoteSkipButton,
} from "@/components/voice/music-extras";

export function formatMusicClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

export function musicRoomPeople(voiceState: VoiceState): VoiceParticipant[] {
  const channelId = voiceState.voiceChannelId;
  const room = channelId ? (voiceState.occupancy[channelId] ?? []) : [];
  const self = voiceState.self;
  if (self && !room.some((person) => person.peerId === self.peerId)) {
    return [...room, self];
  }
  return room;
}

export function lookupAddedBy(
  voiceState: VoiceState,
  userId: string,
  fallbackName: string,
): { name: string; avatarUrl: string | null } {
  const person = musicRoomPeople(voiceState).find((entry) => entry.userId === userId);
  return {
    name: person?.displayName ?? fallbackName,
    avatarUrl: person?.avatarUrl ?? null,
  };
}

/**
 * How many seats in this room have the music on, this machine included.
 *
 * `listeningMusic` is absent on a client that predates `set-music-listening`,
 * and absent reads as on, the same way the roster schema says. The local
 * machine is not on its own roster row for this, so the caller's own state
 * decides it.
 */
export function musicListenerCount(voiceState: VoiceState, listening: boolean): number {
  const selfPeerId = voiceState.self?.peerId ?? null;
  return musicRoomPeople(voiceState).filter((person) =>
    person.peerId === selfPeerId ? listening : person.listeningMusic !== false,
  ).length;
}

export function lookupActorName(voiceState: VoiceState, peerId: string | null): string | null {
  if (!peerId) {
    return null;
  }
  return musicRoomPeople(voiceState).find((entry) => entry.peerId === peerId)?.displayName ?? null;
}

/**
 * A STREAM, NOT A TRACK.
 *
 * The room's clock is a position sample from whoever is running the music,
 * and on a 24/7 mix the player answers with how long the STREAM has been
 * up. With the duration refused (see `MUSIC_MAX_DURATION_MS`) the elapsed
 * kept counting on its own and read 598:52:31 beside a seek bar measured
 * against nothing. An elapsed past that same ceiling with no duration is
 * not a track playing, so the bar says so instead of counting. A duration
 * the room does know always wins: a long mix is still a mix.
 */
export function isLivePlayback(
  positionMs: number,
  durationMs: number | null | undefined,
): boolean {
  if (durationMs != null && durationMs > 0) {
    return false;
  }
  return positionMs > MUSIC_MAX_DURATION_MS;
}

export function formatMusicClockOrUnknown(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) {
    return "–:––";
  }
  return formatMusicClock(ms);
}

/** ~4 fps while playing. Elapsed still ticks when duration is unknown. */
export function usePlaybackProgress(music: MusicSnapshot, durationMs: number | null) {
  const playing = music.state?.status === "playing";
  const known = durationMs !== null && durationMs > 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = 0;
    let last = 0;
    const tick = (stamp: number) => {
      if (stamp - last >= 250) {
        last = stamp;
        setNow(Date.now());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, music.receivedAt]);

  const position = Math.max(0, expectedPositionMs(music, now));
  const capped = known ? Math.min(position, durationMs) : position;
  const ratio = known ? Math.min(1, capped / durationMs) : 0;
  return { position: capped, durationMs, ratio, known };
}

export function MusicNowPlaying({
  current,
  music,
  voiceState,
  canManage,
  canSetSwitches,
  playing,
  needsTap,
  listening,
  volume,
  muted,
  ducking,
  onOpenFila,
  onPlayPause,
  onSkip,
  onPrevious,
  onTapToPlay,
  onMute,
  onVolume,
  tone = "rail",
}: {
  current: MusicTrack;
  music: MusicSnapshot;
  voiceState: VoiceState;
  canManage: boolean;
  /** A real MANAGE_MUSIC. The three room switches are not promoted. */
  canSetSwitches: boolean;
  playing: boolean;
  needsTap: boolean;
  listening: boolean;
  volume: number;
  muted: boolean;
  ducking: boolean;
  onOpenFila: () => void;
  onPlayPause: () => void;
  onSkip: () => void;
  onPrevious?: () => void;
  onTapToPlay: () => void;
  onMute: () => void;
  onVolume: (value: number) => void;
  tone?: "rail" | "composer";
}) {
  const { t } = useTranslation();
  const addedBy = lookupAddedBy(voiceState, current.addedByUserId, current.addedByName);
  const progress = usePlaybackProgress(music, current.durationMs);
  const scrub = useScrub((value) => seekTo(value));
  const expandLabel = t("music.open");
  const secondary = current.autoplayed ? t("music.autoplayed") : addedBy.name;
  const composer = tone === "composer";
  const mutedText = composer ? "text-text-secondary" : "text-paper-muted";
  const titleText = music.open
    ? composer
      ? "text-accent"
      : "text-signal"
    : composer
      ? "text-text"
      : "text-paper";
  const duration = progress.durationMs ?? 0;
  const durationKnown = progress.known;
  const position = scrub.preview ?? progress.position;
  const queue = music.state?.queue ?? [];
  /* Alone with your own music is not a fact worth a line. */
  const listenerCount = musicListenerCount(voiceState, listening);
  /** A track is on and this machine is not hearing it. */
  const stopped = !listening;
  const listenersLabel =
    listenerCount > 1 ? t("music.listening", { count: listenerCount }) : null;

  const listeners = listenersLabel ? (
    <span data-music-listeners="" className="shrink-0">
      {`· ${listenersLabel}`}
    </span>
  ) : null;

  const identity = (
    <>
      <button
        type="button"
        className={cn(
          "relative shrink-0 overflow-hidden rounded-md",
          composer ? "h-14 w-14 bg-surface-3" : "h-8 w-8 bg-ink-3",
          music.open && "ring-2 ring-accent",
        )}
        aria-expanded={music.open}
        aria-label={expandLabel}
        onClick={onOpenFila}
      >
        {stopped ? (
          <HeadphoneOff
            className={cn("m-auto", composer ? "h-5 w-5" : "h-4 w-4", mutedText)}
            aria-hidden="true"
          />
        ) : current.thumbnailUrl ? (
          <img src={current.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Music
            className={cn("m-auto", composer ? "h-5 w-5" : "h-4 w-4", mutedText)}
            aria-hidden="true"
          />
        )}
      </button>
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        aria-expanded={music.open}
        aria-label={expandLabel}
        onClick={onOpenFila}
      >
        <MarqueeText
          text={current.title}
          className={cn(
            "text-[13px] font-medium leading-tight",
            stopped ? mutedText : titleText,
          )}
        />
        {stopped ? (
          /* The room did not stop, this machine did. Saying so is the whole
             job of this line: a player that only goes quiet reads as broken. */
          <span
            data-music-stopped=""
            className={cn("mt-0.5 block truncate text-[11px] leading-tight", mutedText)}
          >
            {listenerCount > 0
              ? t("music.stopped.playing", { count: listenerCount })
              : t("music.stopped.alone")}
          </span>
        ) : current.autoplayed ? (
          <span
            data-music-autoplayed=""
            className={cn("mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-tight", mutedText)}
          >
            <span className="truncate">{secondary}</span>
            {listeners}
          </span>
        ) : (
          <span className={cn("mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-tight", mutedText)}>
            <UserAvatar
              name={addedBy.name}
              avatarUrl={addedBy.avatarUrl}
              className="h-3.5 w-3.5"
              fallbackClassName={
                composer
                  ? "bg-surface-3 text-[9px] text-text"
                  : "bg-ink-3 text-[9px] text-paper"
              }
              rounded="full"
            />
            <span className="truncate">{secondary}</span>
            {listeners}
          </span>
        )}
      </button>
    </>
  );

  const playControl = !listening ? (
    <button
      type="button"
      className="flex h-8 shrink-0 items-center rounded-full bg-accent px-3 text-[11px] font-semibold text-on-accent"
      onClick={() => setListening(true)}
    >
      {t("music.listen")}
    </button>
  ) : needsTap ? (
    <button
      type="button"
      className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-accent px-3 text-[11px] font-semibold text-on-accent"
      onClick={onTapToPlay}
    >
      <Play className="h-3.5 w-3.5" aria-hidden="true" />
      {t("music.tapToPlay")}
    </button>
  ) : (
    <Tooltip
      label={playing ? t("music.pause") : t("music.play")}
      detail={canManage ? undefined : t("music.noManage")}
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant={composer ? "default" : "ghost"}
          size="icon"
          className={
            composer
              ? "h-10 w-10 shrink-0 rounded-full"
              : "h-8 w-8 shrink-0"
          }
          aria-pressed={playing}
          // Its own name, not the tooltip's: `Tooltip` merges `aria-label`
          // onto its immediate child, and that is the span this button
          // needs so the bubble still opens while it is disabled.
          aria-label={playing ? t("music.pause") : t("music.play")}
          disabled={!canManage}
          onClick={onPlayPause}
        >
          {playing ? (
            <Pause className={composer ? "h-4 w-4" : "h-4 w-4 text-accent"} aria-hidden="true" />
          ) : (
            <Play className="ml-0.5 h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </span>
    </Tooltip>
  );

  const skipControl = canManage ? (
    <Tooltip label={t("music.skip")}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label={t("music.skip")}
        onClick={onSkip}
      >
        <SkipForward className="h-4 w-4" aria-hidden="true" />
      </Button>
    </Tooltip>
  ) : (
    <MusicVoteSkipButton
      skipVotes={music.state?.skipVotes ?? []}
      userId={voiceState.self?.userId ?? null}
      roomSize={musicRoomPeople(voiceState).length}
    />
  );

  const previousControl = composer ? (
    <Tooltip
      label={t("music.previous")}
      detail={canManage ? undefined : t("music.noManage")}
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t("music.previous")}
          disabled={!canManage}
          onClick={onPrevious}
        >
          <SkipBack className="h-4 w-4" aria-hidden="true" />
        </Button>
      </span>
    </Tooltip>
  ) : null;

  const extras = listening ? (
    <MusicSpeakerControl
      volume={volume}
      muted={muted}
      slider={composer}
      onMute={onMute}
      onVolume={onVolume}
    />
  ) : null;

  const modeHide = "hidden @min-[28rem]:inline-flex";
  const overflowTrigger =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text";
  /*
   * One menu for both stops. A member's has a single row, Parar de ouvir,
   * which is why the trigger is live for them rather than a dimmed shape.
   */
  const overflow = composer ? (
    <MusicOverflowMenu
      canManage={canManage}
      canSetSwitches={canSetSwitches}
      listening={listening}
      ducking={ducking}
      openControls={music.state?.openControls === true}
      autoplay={music.state?.autoplay === true}
      repeat={music.state?.repeat ?? "off"}
      modes="menu"
      side="top"
      triggerClassName={overflowTrigger}
    />
  ) : null;

  /*
   * THE QUEUE, WHERE SPOTIFY KEEPS IT: an icon in the right cluster that
   * opens the panel, carrying the count so the room is legible without it.
   * It replaced a full-width "A seguir <track>" line, which said more but
   * cost the bar a third row and has no equivalent in the layout this bar
   * is copying.
   */
  const queueButton = composer ? (
    <Tooltip label={music.open ? t("music.close") : t("music.open")}>
      <button
        type="button"
        data-music-queue-toggle=""
        aria-expanded={music.open}
        aria-label={music.open ? t("music.close") : t("music.open")}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1 rounded-full px-2 transition-colors",
          music.open
            ? "bg-accent-soft text-on-accent-soft"
            : "text-text-tertiary hover:bg-surface-2 hover:text-text",
        )}
        onClick={toggleMusicOpen}
      >
        <ListMusic className="h-4 w-4" aria-hidden="true" />
        {queue.length > 0 ? (
          <span data-music-queue-count="" className="text-[11px] font-medium tabular-nums">
            {queue.length}
          </span>
        ) : null}
      </button>
    </Tooltip>
  ) : null;

  const seekBar = (
    <MusicSeekBar
      canManage={canManage}
      durationKnown={durationKnown}
      duration={duration}
      position={position}
      scrub={scrub}
    />
  );

  if (composer && stopped) {
    /* One decision, one button. The transport and the seek belong to sound
       that is playing here, and neither is true right now. */
    return (
      <div
        data-music-now-playing="composer"
        data-music-listening="off"
        className="px-3 py-2"
      >
        <div className="flex min-w-0 items-center gap-3">
          {identity}
          <button
            type="button"
            data-music-listen=""
            className="flex h-8 shrink-0 items-center rounded-full bg-accent px-3 text-[11px] font-semibold text-on-accent"
            onClick={() => setListening(true)}
          >
            {t("music.listen")}
          </button>
          {queueButton}
          {overflow}
        </div>
      </div>
    );
  }

  if (composer) {
    return (
      <div data-music-now-playing="composer" className="px-3 py-2">
        {/*
          SPOTIFY'S BAR. Three columns: the track on the left, the transport
          with the seek under it in the middle, the icons on the right. One
          row of chrome, two lines tall, everything vertically centred.

          It is copied rather than derived because it is the player every
          person in these rooms already uses, and because every layout this
          bar tried on the way here was a number tuned by eye.

          Below 48rem the three parts stack in one column: the transport
          alone is wider than a narrow bar, so nothing shares a line with it.
        */}
        <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1.5 @min-[48rem]:grid-cols-3">
          <div className="flex min-w-0 items-center gap-3">
            {identity}
          </div>
          <div className="flex items-center justify-end gap-1 @min-[48rem]:contents">
            <div className="flex items-center justify-center gap-1">
              <MusicShuffleButton className={modeHide} disabled={!canManage} />
              {previousControl}
              {playControl}
              {skipControl}
              <MusicRepeatButton
                repeat={music.state?.repeat ?? "off"}
                className={modeHide}
                disabled={!canSetSwitches}
              />
            </div>
            {/* Spans both lines, so it centres against the pair rather than
                sitting on the transport's line. */}
            <div className="flex items-center justify-end gap-1 @min-[48rem]:row-span-2">
              {queueButton}
              {overflow}
              {extras}
            </div>
          </div>
          <div className="min-w-0 @min-[48rem]:col-start-2 @min-[48rem]:row-start-2">
            {seekBar}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-music-now-playing="" className="group relative flex flex-col py-1.5">
      <div className="flex min-w-0 items-center gap-1 px-2">
        {identity}
        {playControl}
        {skipControl}
        {extras}
      </div>
      {progress.known && (
        <Slider
          variant="edge"
          readOnly
          value={progress.position}
          min={0}
          max={progress.durationMs ?? 1}
          className="absolute inset-x-0 bottom-0 min-w-0 translate-y-px"
          aria-label={t("music.progress")}
        />
      )}
    </div>
  );
}

function MusicSeekBar({
  canManage,
  durationKnown,
  duration,
  position,
  scrub,
}: {
  canManage: boolean;
  durationKnown: boolean;
  duration: number;
  position: number;
  scrub: Scrub;
}): ReactNode {
  const { t } = useTranslation();
  const live = isLivePlayback(position, durationKnown ? duration : null);
  if (live) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-danger">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-danger"
          />
          {t("music.live")}
        </span>
        <Slider
          variant="scrub"
          readOnly
          indeterminate
          value={1}
          min={0}
          max={1}
          className="min-w-0 flex-1 px-1"
          aria-label={t("music.live")}
        />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-left text-[11px] tabular-nums text-text-secondary">
        {formatMusicClock(position)}
      </span>
      <Slider
        variant="scrub"
        readOnly={!canManage || !durationKnown}
        indeterminate={!durationKnown}
        value={position}
        min={0}
        max={durationKnown ? duration : 1}
        step={250}
        className="min-w-0 flex-1 px-1"
        aria-label={canManage && durationKnown ? t("music.seek") : t("music.progress")}
        {...scrub.rootProps}
        onValueChange={(value) => {
          if (canManage && durationKnown) {
            scrub.onValueChange(value);
          }
        }}
        onValueCommit={(value) => {
          if (canManage && durationKnown) {
            scrub.onValueCommit(value);
          }
        }}
      />
      <span className="shrink-0 text-right text-[11px] tabular-nums text-text-secondary">
        {formatMusicClockOrUnknown(durationKnown ? duration : null)}
      </span>
    </div>
  );
}
