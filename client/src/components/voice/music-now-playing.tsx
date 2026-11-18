import {
  HeadphoneOff,
  ListMusic,
  Lock,
  Maximize2,
  MonitorPlay,
  Music,
  Pause,
  Play,
  Shrink,
  SkipBack,
  SkipForward,
  Tv,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { MusicNotes } from "@phosphor-icons/react";
import { MUSIC_MAX_DURATION_MS } from "@pqp/shared";
import type { MusicTrack, VoiceParticipant } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { MarqueeText } from "@/components/ui/marquee-text";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import { setMusicPlacement, useMusicPlacement } from "@/lib/music-prefs";
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
  MusicAutoplayButton,
  MusicVoteSkipButton,
} from "@/components/voice/music-extras";
import { MusicSpeakerControl } from "@/components/voice/music-speaker-control";
import { MusicCaptionsButton } from "@/components/voice/music-captions-button";
import { MusicEmbedOutlet } from "@/components/voice/music-embed-host";

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
  playbackFailed = false,
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
  stageCompact = false,
  stageVideo = false,
  onToggleFullscreen,
  stageFooter,
  onStageShrink,
}: {
  current: MusicTrack;
  music: MusicSnapshot;
  voiceState: VoiceState;
  canManage: boolean;
  /** A real MANAGE_MUSIC. The three room switches are not promoted. */
  canSetSwitches: boolean;
  playing: boolean;
  needsTap: boolean;
  /** YouTube refused this video on this machine (error 100, 101, 150). */
  playbackFailed?: boolean;
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
  /**
   * `stage` is the room stage's panel (`MusicStagePanel`): the composer's
   * controls, laid out around a large cover with the whole title.
   */
  tone?: "rail" | "composer" | "stage";
  /** The stage tone over its queue: a sideways card, the cover beside the lines. */
  stageCompact?: boolean;
  /** The stage tone with the YouTube video where the cover was ("Ver no palco"). */
  stageVideo?: boolean;
  /** The stage tone's video, alone on the whole stage. */
  onToggleFullscreen?: () => void;
  /** The stage tone with the queue closed: what plays next, under the player. */
  stageFooter?: ReactNode;
  /** The stage tone: give the stage back and become a card in the row. */
  onStageShrink?: () => void;
}) {
  const { t } = useTranslation();
  const onStage = useMusicPlacement() === "stage";
  const addedBy = lookupAddedBy(voiceState, current.addedByUserId, current.addedByName);
  const progress = usePlaybackProgress(music, current.durationMs);
  const scrub = useScrub((value) => seekTo(value));
  const expandLabel = t("music.open");
  const stageTone = tone === "stage";
  // The panel has the room to say it in words; the bar only has the name.
  const secondary = current.autoplayed
    ? t("music.autoplayed")
    : stageTone
      ? t("music.addedBy", { name: addedBy.name })
      : addedBy.name;
  // The stage panel sits on the same surface tokens as the composer and
  // carries every one of its controls; only the layout differs.
  const composer = tone === "composer" || stageTone;
  const lineText = stageTone ? "text-[13px]" : "text-[11px]";
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

  /** Who put it on, or why this machine is not playing it. */
  const subline = stopped ? (
    /* The room did not stop, this machine did. Saying so is the whole
       job of this line: a player that only goes quiet reads as broken. */
    <span
      data-music-stopped=""
      className={cn(`mt-0.5 block truncate ${lineText} leading-tight`, mutedText)}
    >
      {listenerCount > 0
        ? t("music.stopped.playing", { count: listenerCount })
        : t("music.stopped.alone")}
    </span>
  ) : playbackFailed ? (
    /* This machine cannot play the video, the room is fine. Without
       this line the bar reads as playing while nothing sounds. */
    <span
      data-music-unplayable=""
      className={cn(`mt-0.5 block truncate ${lineText} leading-tight`, mutedText)}
    >
      {t("music.error.playback")}
    </span>
  ) : current.autoplayed ? (
    <span
      data-music-autoplayed=""
      className={cn(`mt-0.5 flex min-w-0 items-center gap-1 ${lineText} leading-tight`, mutedText)}
    >
      <span className="truncate">{secondary}</span>
      {listeners}
    </span>
  ) : (
    <span className={cn(`mt-0.5 flex min-w-0 items-center gap-1 ${lineText} leading-tight`, mutedText)}>
      <UserAvatar
        name={addedBy.name}
        avatarUrl={addedBy.avatarUrl}
        className={stageTone ? "h-5 w-5" : "h-3.5 w-3.5"}
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
  );

  const identity = (
    <>
      <button
        /*
         * Keyed on the track, so a change REMOUNTS this and the fade plays
         * again; swapping the image in place reads as a flicker on an
         * automatic advance rather than as the room moving on. Prefixed
         * because these two are siblings in one fragment, which React
         * reconciles as an array: the same key on both is a duplicate, and
         * a duplicate key is matched once and reused rather than replaced.
         */
        key={`art-${current.id}`}
        data-music-art=""
        type="button"
        className={cn(
          "relative shrink-0 overflow-hidden rounded-md animate-fade-in",
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
        // Keyed with the art, and for the same reason: the title is the
        // other half of "the room moved on". Its own prefix, see above.
        key={`title-${current.id}`}
        data-music-title=""
        type="button"
        className="min-w-0 flex-1 animate-fade-in text-left"
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
        {subline}
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
          data-music-play=""
          className={cn(
            composer
              ? "h-10 w-10 shrink-0 rounded-full"
              : "h-8 w-8 shrink-0",
            /*
             * The one control everybody aims at, and the only one that gave
             * no sign it could be pressed until it was. Spotify's answer:
             * a small scale under the pointer, a smaller one on the press.
             */
            "transition-transform duration-150 ease-out hover:scale-[1.06] active:scale-95",
            "motion-reduce:transition-none motion-reduce:transform-none",
          )}
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
      seatedUserIds={musicRoomPeople(voiceState).map((person) => person.userId)}
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
      queueLength={music.state?.queue.length ?? 0}
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

  /*
   * The video on the call's stage, beside the queue rather than inside it:
   * it used to sit in the queue's header, two clicks away from the bar.
   * A toggle, like Spotify's now-playing view, so the same button puts the
   * video away again.
   */
  const stageLabel = onStage ? t("music.stage.hide") : t("music.stage.watch");
  const stageButton = composer ? (
    <Tooltip label={stageLabel}>
      <button
        type="button"
        data-music-stage-watch=""
        aria-pressed={onStage}
        aria-label={stageLabel}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
          onStage
            ? "bg-accent-soft text-on-accent-soft"
            : "text-text-tertiary hover:bg-surface-2 hover:text-text",
        )}
        onClick={() => setMusicPlacement(onStage ? "hidden" : "stage")}
      >
        <MonitorPlay className="h-4 w-4" aria-hidden="true" />
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

  if (stageTone) {
    return (
      <StagePlayer
        current={current}
        music={music}
        voiceState={voiceState}
        canManage={canManage}
        canSetSwitches={canSetSwitches}
        playing={playing}
        needsTap={needsTap}
        playbackFailed={playbackFailed}
        listening={listening}
        listenerCount={listenerCount}
        addedBy={addedBy}
        compact={stageCompact}
        video={stageVideo}
        onToggleFullscreen={onToggleFullscreen}
        onShrink={onStageShrink}
        seekBar={seekBar}
        overflow={
          <MusicOverflowMenu
            canManage={canManage}
            canSetSwitches={canSetSwitches}
            listening={listening}
            ducking={ducking}
            openControls={music.state?.openControls === true}
            autoplay={music.state?.autoplay === true}
            repeat={music.state?.repeat ?? "off"}
            queueLength={music.state?.queue.length ?? 0}
            modes="menu"
            side="bottom"
            triggerClassName={overflowTrigger}
          />
        }
        speaker={
          listening ? (
            <MusicSpeakerControl
              volume={volume}
              muted={muted}
              slider={!stageCompact}
              onMute={onMute}
              onVolume={onVolume}
            />
          ) : null
        }
        footer={stageFooter}
        onOpenFila={onOpenFila}
        onPlayPause={onPlayPause}
        onSkip={onSkip}
        onPrevious={onPrevious}
        onTapToPlay={onTapToPlay}
      />
    );
  }

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
              <MusicAutoplayButton
                autoplay={music.state?.autoplay === true}
                className={modeHide}
                disabled={!canSetSwitches}
              />
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
              {stageButton}
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

/**
 * A CONTROL THIS PERSON MAY NOT USE, SAID WITH A LOCK.
 *
 * A dimmed button reads as broken or loading. A small lock on its corner,
 * at full opacity, reads as "not for you", and the tooltip says what would
 * open it.
 */
function Locked({ locked, children }: { locked: boolean; children: ReactNode }) {
  return (
    <span className="relative inline-flex" data-music-locked={locked ? "" : undefined}>
      {children}
      {locked ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface-2 text-text-tertiary shadow-[inset_0_0_0_1px_var(--card-border)]"
        >
          <Lock className="h-2 w-2" strokeWidth={3} />
        </span>
      ) : null}
    </span>
  );
}

/** Disabled stays legible: tertiary text, full opacity, the lock does the rest. */
const LOCKED_BUTTON = "disabled:opacity-100 disabled:text-text-tertiary";

/**
 * THE PLAYER ON THE CALL STAGE.
 *
 * Laid out the way every music app lays out its now playing view: a line
 * that says this plays for the whole call, the cover as large as the stage
 * allows, the whole title, who asked for it, the seek, and one row of
 * controls with the play button in the middle. A state that is not "playing
 * here" (paused by somebody, stopped on this machine, waiting for a tap, a
 * video this machine cannot play) is a bar under the cover, never a mark
 * over it.
 *
 * `compact` is the sideways card over the queue on a narrow stage: the
 * cover beside the lines, nested in the card's corner.
 */
function StagePlayer({
  current,
  music,
  voiceState,
  canManage,
  canSetSwitches,
  playing,
  needsTap,
  playbackFailed,
  listening,
  listenerCount,
  addedBy,
  compact,
  video,
  onToggleFullscreen,
  onShrink,
  seekBar,
  overflow,
  speaker,
  footer,
  onOpenFila,
  onPlayPause,
  onSkip,
  onPrevious,
  onTapToPlay,
}: {
  current: MusicTrack;
  music: MusicSnapshot;
  voiceState: VoiceState;
  canManage: boolean;
  canSetSwitches: boolean;
  playing: boolean;
  needsTap: boolean;
  playbackFailed: boolean;
  listening: boolean;
  listenerCount: number;
  addedBy: { name: string; avatarUrl: string | null };
  compact: boolean;
  video: boolean;
  onToggleFullscreen?: () => void;
  onShrink?: () => void;
  seekBar: ReactNode;
  overflow: ReactNode;
  speaker: ReactNode;
  footer?: ReactNode;
  onOpenFila: () => void;
  onPlayPause: () => void;
  onSkip: () => void;
  onPrevious?: () => void;
  onTapToPlay: () => void;
}) {
  const { t } = useTranslation();
  const onStage = useMusicPlacement() === "stage";
  const stopped = !listening;
  const room = musicRoomPeople(voiceState);
  const paused = music.state?.status === "paused";
  const pausedBy = paused ? lookupActorName(voiceState, music.state?.actorId ?? null) : null;
  const lockDetail = `${t("music.noManage")}. ${t("music.stage.lockedHint")}`;

  const listeners =
    listenerCount > 1
      ? t("music.listening", { count: listenerCount })
      : listening
        ? t("music.stage.alone")
        : null;

  /* One bar, the most urgent fact first: this machine before the room. */
  const state: { kind: string; text: string; action?: ReactNode } | null = stopped
    ? {
        kind: "stopped",
        text:
          listenerCount > 0
            ? t("music.stage.stopped", { count: listenerCount })
            : t("music.stage.stoppedAlone"),
        action: (
          <button
            type="button"
            data-music-listen=""
            className="flex h-7 shrink-0 items-center rounded-full bg-accent px-3 text-[12px] font-semibold text-on-accent"
            onClick={() => setListening(true)}
          >
            {t("music.listen")}
          </button>
        ),
      }
    : playbackFailed
      ? { kind: "unplayable", text: t("music.stage.unplayable") }
      : needsTap
        ? {
            kind: "tap",
            text: t("music.stage.needsTap"),
            action: (
              <button
                type="button"
                data-music-tap=""
                className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-accent px-3 text-[12px] font-semibold text-on-accent"
                onClick={onTapToPlay}
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                {t("music.stage.tapToListen")}
              </button>
            ),
          }
        : paused
          ? {
              kind: "paused",
              text: pausedBy
                ? t("music.stage.pausedBy", { name: pausedBy })
                : t("music.stage.paused"),
            }
          : null;

  /*
   * "Fulano pausou pra todo mundo" is a fact about the room, and it comes and
   * goes with every press of play: as a bar between the picture and the
   * title it shrank the video and pulled it back each time. It takes the
   * header's listener line instead, which has the room. The other states
   * carry a button and stay a bar.
   */
  const headerState = state?.kind === "paused" ? state : null;
  const barState = headerState ? null : state;
  const stateBarFor = (shown: typeof state) => shown ? (
    <div
      data-music-state={shown.kind}
      data-music-stopped={shown.kind === "stopped" ? "" : undefined}
      data-music-unplayable={shown.kind === "unplayable" ? "" : undefined}
      role="status"
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg bg-surface-2 py-1 pl-3 pr-1 text-left text-[12px] leading-snug text-text-secondary",
        !shown.action && "py-1.5 pr-3",
        shown.kind === "unplayable" && "text-danger",
      )}
    >
      <span className="min-w-0 flex-1">{shown.text}</span>
      {shown.action}
    </div>
  ) : null;
  const stateBar = stateBarFor(barState);

  const stageLabel = onStage ? t("music.stage.hide") : t("music.stage.watch");
  const watch = (
    <Tooltip label={stageLabel}>
      <button
        type="button"
        data-music-stage-watch=""
        aria-pressed={onStage}
        aria-label={stageLabel}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-full text-[12px] font-medium text-text-secondary transition-colors hover:bg-[color:var(--button-ghost-hover)] hover:text-text",
          compact ? "w-8 justify-center" : "px-2.5",
        )}
        onClick={() => setMusicPlacement(onStage ? "hidden" : "stage")}
      >
        <Tv className="h-4 w-4" aria-hidden="true" />
        {compact ? null : <span>{stageLabel}</span>}
      </button>
    </Tooltip>
  );

  /*
   * The two ways to change what the stage shows, side by side: the video
   * and the queue. The queue's used to live in a strip at the panel's
   * bottom, the other end of the panel from the video's.
   */
  const queueCount = music.state?.queue.length ?? 0;
  const queueLabel = music.open ? t("music.stage.hideQueue") : t("music.stage.showQueue");
  const queueToggle = (
    <Tooltip label={queueLabel}>
      <button
        type="button"
        data-music-queue-toggle=""
        aria-expanded={music.open}
        aria-label={queueLabel}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-full text-[12px] font-medium transition-colors",
          compact ? "px-2" : "px-2.5",
          music.open
            ? "bg-accent-soft text-on-accent-soft"
            : "text-text-secondary hover:bg-[color:var(--button-ghost-hover)] hover:text-text",
        )}
        onClick={toggleMusicOpen}
      >
        <ListMusic className="h-4 w-4" aria-hidden="true" />
        {compact ? null : <span>{t("music.fila")}</span>}
        {queueCount > 0 ? (
          <span data-music-queue-count="" className="tabular-nums">
            {queueCount}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );

  // Gives the stage back: the player becomes a card in the row under it, the
  // way a pinned camera or share does (`planRoomFocus`).
  const shrink = onShrink ? (
    <Tooltip label={t("music.stage.shrink")}>
      <button
        type="button"
        data-music-stage-shrink=""
        aria-label={t("music.stage.shrink")}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-[color:var(--button-ghost-hover)] hover:text-text"
        onClick={onShrink}
      >
        <Shrink className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  ) : null;

  const header = (
    <div className="flex h-8 w-full min-w-0 items-center gap-2">
      <span
        data-music-stage-tag=""
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 text-[12px] font-semibold text-on-accent-soft"
      >
        <Music className="h-3 w-3" aria-hidden="true" />
        {t("music.stage.tag")}
      </span>
      {headerState ? (
        <span
          data-music-state={headerState.kind}
          role="status"
          className="flex min-w-0 items-center gap-1 truncate text-[12px] text-text-secondary"
        >
          <Pause className="h-3 w-3 shrink-0" fill="currentColor" aria-hidden="true" />
          <span className="truncate">{headerState.text}</span>
        </span>
      ) : listeners ? (
        <span
          data-music-listeners=""
          className="hidden min-w-0 truncate text-[12px] text-text-tertiary @min-[20rem]:inline"
        >
          {listeners}
        </span>
      ) : null}
      <span className="flex-1" />
      {watch}
      {queueToggle}
      {overflow}
      {shrink}
    </div>
  );

  // As tall as the panel leaves once the lines around it are drawn, and no
  // taller than its width allows at 16:9 (`cq*` is the player's panel,
  // `MusicStagePanel`). The cover and the video share the one rule, so
  // "Ver no palco" swaps the picture in place without the player moving.
  // 12.5rem is YouTube's 200px floor for its player.
  const coverHeight = `clamp(12.5rem, min(calc(100cqh - ${17 + (barState ? 2.75 : 0) + (footer ? 3.75 : 0)}rem), calc((100cqw - 2rem) * 0.5625)), 100cqh)`;
  const art = video ? (
    /*
     * The real video, where the cover was. The iframe lives in App and is
     * laid over this box (`MusicEmbedOutlet`), so moving between the cover
     * and the video never reloads it. Nothing is drawn over it: YouTube's
     * terms want its player unobstructed, and its captions sit at the
     * bottom of the frame.
     */
    <div
      data-music-stage-video=""
      className={cn(
        "relative aspect-video max-w-full shrink-0 overflow-hidden rounded-[calc(var(--call-tile-radius)-6px)] bg-black",
        compact && "w-full",
      )}
      style={compact ? undefined : { height: coverHeight }}
    >
      <MusicEmbedOutlet />
    </div>
  ) : (
    <button
      // Keyed on the track, so a change remounts it and the fade plays again.
      key={`stage-art-${current.id}`}
      data-music-art=""
      type="button"
      className={cn(
        "relative flex shrink-0 animate-fade-in items-center justify-center overflow-hidden bg-surface-3",
        compact
          ? "aspect-video w-[clamp(7.5rem,36%,14.75rem)] self-start rounded-[calc(var(--call-tile-radius)-6px)]"
          : "aspect-video max-w-full rounded-lg",
      )}
      style={compact ? undefined : { height: coverHeight }}
      aria-label={t("music.open")}
      onClick={onOpenFila}
    >
      {current.thumbnailUrl ? (
        <img
          src={current.thumbnailUrl}
          alt=""
          className={cn("h-full w-full object-cover", stopped && "opacity-50")}
        />
      ) : (
        <Icon icon={MusicNotes} size="lg" className="text-text-tertiary" />
      )}
    </button>
  );

  const heading = (
    <div className={cn("w-full min-w-0", compact ? "text-left" : "max-w-[40rem] text-center")}>
      <p
        key={`stage-title-${current.id}`}
        data-music-title=""
        title={current.title}
        className={cn(
          "line-clamp-2 animate-fade-in break-words font-semibold leading-snug",
          compact ? "text-[15px]" : "text-lg",
          stopped ? "text-text-secondary" : "text-text",
        )}
      >
        {current.title}
      </p>
      <p
        className={cn(
          "mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-text-secondary",
          !compact && "justify-center",
        )}
      >
        {current.autoplayed ? (
          <span data-music-autoplayed="" className="truncate">
            {t("music.autoplayed")}
          </span>
        ) : (
          <>
            <UserAvatar
              name={addedBy.name}
              avatarUrl={addedBy.avatarUrl}
              className="h-4 w-4"
              fallbackClassName="bg-surface-3 text-[8px] text-text"
              rounded="full"
            />
            <span className="truncate">
              {t("music.requestedBy", { name: addedBy.name })} · YouTube
            </span>
          </>
        )}
      </p>
    </div>
  );

  const play = (
    <Tooltip
      label={playing ? t("music.pause") : t("music.play")}
      detail={canManage ? undefined : lockDetail}
    >
      <span className="inline-flex">
        <Locked locked={!canManage}>
          <Button
            type="button"
            variant="default"
            size="icon"
            data-music-play=""
            className={cn(
              "shrink-0 rounded-full",
              compact ? "h-10 w-10" : "h-12 w-12",
              "transition-transform duration-150 ease-out hover:scale-[1.06] active:scale-95",
              "motion-reduce:transition-none motion-reduce:transform-none",
              "disabled:bg-surface-2 disabled:opacity-100 disabled:text-text-tertiary",
            )}
            aria-pressed={playing}
            aria-label={playing ? t("music.pause") : t("music.play")}
            disabled={!canManage}
            onClick={onPlayPause}
          >
            {playing ? (
              <Pause className={compact ? "h-4 w-4" : "h-5 w-5"} fill="currentColor" aria-hidden="true" />
            ) : (
              <Play className={cn("ml-0.5", compact ? "h-4 w-4" : "h-5 w-5")} fill="currentColor" aria-hidden="true" />
            )}
          </Button>
        </Locked>
      </span>
    </Tooltip>
  );

  const transportIcon = cn("shrink-0 rounded-full", compact ? "h-8 w-8" : "h-10 w-10", LOCKED_BUTTON);
  const previous = (
    <Tooltip label={t("music.previous")} detail={canManage ? undefined : lockDetail}>
      <span className="inline-flex">
        <Locked locked={!canManage}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-music-previous=""
            className={transportIcon}
            aria-label={t("music.previous")}
            disabled={!canManage || !onPrevious}
            onClick={onPrevious}
          >
            <SkipBack className="h-5 w-5" fill="currentColor" aria-hidden="true" />
          </Button>
        </Locked>
      </span>
    </Tooltip>
  );
  const next = canManage ? (
    <Tooltip label={t("music.skip")}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-music-next=""
        className={transportIcon}
        aria-label={t("music.skip")}
        onClick={onSkip}
      >
        <SkipForward className="h-5 w-5" fill="currentColor" aria-hidden="true" />
      </Button>
    </Tooltip>
  ) : (
    <MusicVoteSkipButton
      skipVotes={music.state?.skipVotes ?? []}
      userId={voiceState.self?.userId ?? null}
      roomSize={room.length}
      seatedUserIds={room.map((person) => person.userId)}
    />
  );
  const mode = cn("h-8 w-8", LOCKED_BUTTON);
  const repeat = (
    <Locked locked={!canSetSwitches}>
      <MusicRepeatButton
        repeat={music.state?.repeat ?? "off"}
        className={mode}
        disabled={!canSetSwitches}
      />
    </Locked>
  );
  const autoplay = (
    <Locked locked={!canSetSwitches}>
      <MusicAutoplayButton
        autoplay={music.state?.autoplay === true}
        className={mode}
        disabled={!canSetSwitches}
      />
    </Locked>
  );

  const bar = (
    <div
      data-music-stage-bar=""
      className={cn(
        "grid w-full min-w-0 grid-cols-[1fr_auto_1fr] items-center gap-2",
        !compact && "max-w-[40rem]",
      )}
    >
      <div className="flex min-w-0 items-center justify-start">{repeat}</div>
      <div className="flex items-center gap-1">
        {previous}
        {play}
        {next}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1">
        {autoplay}
        {speaker}
        {video ? <MusicCaptionsButton /> : null}
        {video && onToggleFullscreen ? (
          <Tooltip label={t("voice.share.fullscreen")}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-music-stage-fullscreen=""
              className="h-8 w-8 shrink-0 rounded-full"
              aria-label={t("voice.share.fullscreen")}
              onClick={onToggleFullscreen}
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );

  if (compact && video) {
    /*
     * The video over the queue: full width in the card's corner, then one
     * row with the title and the two header buttons, the seek, the controls.
     * The tag and the listener count give way; the chat strip already says
     * this plays for the call.
     */
    return (
      <div
        data-music-now-playing="stage"
        data-music-stage-compact=""
        data-music-listening={stopped ? "off" : undefined}
        className="@container flex w-full min-w-0 flex-col gap-1.5 p-1.5"
      >
        {art}
        <div className="flex min-w-0 flex-col gap-1 px-1.5 pb-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <p
                key={`stage-title-${current.id}`}
                data-music-title=""
                title={current.title}
                className="truncate text-[14px] font-semibold leading-snug text-text"
              >
                {current.title}
              </p>
              <p className="truncate text-[12px] text-text-secondary">
                {current.autoplayed
                  ? t("music.autoplayed")
                  : `${t("music.requestedBy", { name: addedBy.name })} · YouTube`}
              </p>
            </div>
            {watch}
            {queueToggle}
            {overflow}
            {shrink}
          </div>
          {stateBarFor(state)}
          <div className="w-full min-w-0">{seekBar}</div>
          {bar}
        </div>
      </div>
    );
  }

  if (compact) {
    return (
      <div
        data-music-now-playing="stage"
        data-music-stage-compact=""
        data-music-listening={stopped ? "off" : undefined}
        className="flex w-full min-w-0 items-stretch gap-3 p-1.5"
      >
        {art}
        <div className="@container flex min-w-0 flex-1 flex-col gap-1 py-0.5 pr-1">
          {header}
          {heading}
          {stateBar}
          <div className="w-full min-w-0">{seekBar}</div>
          {bar}
        </div>
      </div>
    );
  }

  return (
    <div
      data-music-now-playing="stage"
      data-music-listening={stopped ? "off" : undefined}
      className="@container flex h-full w-full min-w-0 flex-col gap-3 p-4"
    >
      {header}
      {/* The picture and its title float in the middle; the seek and the
          controls stay pinned to the bottom, so they never move when the
          cover turns into the video or a title wraps. */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3">
        {art}
        {stateBar ? <div className="w-full max-w-[40rem]">{stateBar}</div> : null}
        {heading}
      </div>
      <div data-music-stage-controls="" className="flex w-full shrink-0 flex-col items-center gap-1">
        <div className="w-full min-w-0 max-w-[40rem]">{seekBar}</div>
        {bar}
      </div>
      {footer}
    </div>
  );
}
