import { Expand, Headphones, Music, Pause, Play, RotateCcw, SkipForward, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { MusicTrack } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import { useMusicPrefs } from "@/lib/music-prefs";
import { musicRelatedTracks } from "@/lib/music-related";
import {
  clearParkedMusic,
  musicPrevious,
  readdFromHistory,
  setListening,
  setMusicOpen,
  setPlaying,
  skipToNext,
  useMusic,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";
import {
  canSetMusicSwitches,
  effectiveCanManageMusic,
} from "@/components/voice/music-extras";
import { MusicFila } from "@/components/voice/music-fila";
import {
  setMusicLocalVolume,
  tapMusicLocalToPlay,
  toggleMusicLocalMuted,
  useMusicLocalPlayback,
} from "@/components/voice/music-local-playback";
import {
  lookupAddedBy,
  musicRoomPeople,
  MusicNowPlaying,
} from "@/components/voice/music-now-playing";
import { claimStageMusicPanel } from "@/components/voice/music-stage-panel-store";

/**
 * Wide enough for the player beside the queue. The queue column is 340px;
 * from 820 the player keeps about 470px, room for a 16:9 cover over the
 * title and the full row of controls. The stage beside the chat (about
 * 640px) and beside the chat and the members (about 440px) are under it,
 * and there the player turns sideways over the queue.
 */
const SIDE_BY_SIDE_PX = 820;
/** A stage this wide gives the queue under the sideways card two columns. */
const TWO_COLUMNS_PX = 600;

/** A panel on the stage: the call tile's radius, an inset edge, its own surface. */
const PANEL =
  "min-w-0 overflow-hidden rounded-[var(--call-tile-radius)] bg-surface-1 shadow-[inset_0_0_0_1px_var(--card-border)]";

/**
 * THE PLAYER, ON THE ROOM STAGE (redesign).
 *
 * A server call with nobody publishing a picture is a room of cards, and with
 * one or two people most of that room was empty while the player sat squeezed
 * above the message box. Here the music takes the stage's top and the cards
 * shrink into the row under it (`RoomCards`' `stage` slot): the cover, the
 * whole title, the seek and the composer's controls, and the queue beside them
 * on a wide stage or under them on a narrow one.
 *
 * Built from the same parts as `MusicComposer`, so every action it has works
 * here too. It never mounts the YouTube embed: the only player is
 * `MusicMiniPlayer` in App, and two iframes would be two sounds.
 *
 * Mounted means drawn, so the mount claims the call in
 * `music-stage-panel-store.ts` and App leaves the composer's bar out.
 */
export function MusicStagePanel({
  channelId,
  voiceState,
  onToggleFullscreen,
  onShrink,
}: {
  channelId: string;
  voiceState: VoiceState;
  /** The video alone on the whole stage (the solo view the call stage owns). */
  onToggleFullscreen?: () => void;
  /** Give the stage back: the player becomes `MusicRoomCard` in the row. */
  onShrink?: () => void;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const prefs = useMusicPrefs();
  // "Ver no palco": the video takes the cover's place in this same panel, so
  // the controls stay under it instead of moving to the chat.
  const video = prefs.placement === "stage" && music.state?.current != null;
  const local = useMusicLocalPlayback();
  // Before paint, so the composer's bar never shows for a frame beside this.
  useLayoutEffect(() => claimStageMusicPanel(channelId), [channelId]);
  // The queue beside the player from SIDE_BY_SIDE_PX. Unmeasured (the first
  // paint, a test) reads as wide, the common case beside the chat.
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [slotWidth, setSlotWidth] = useState(0);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => setSlotWidth(slot.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    return () => observer.disconnect();
  }, []);
  const current = music.state?.current ?? null;
  const parked = music.parked;
  const queue = music.state?.queue ?? [];
  const wide = slotWidth === 0 || slotWidth >= SIDE_BY_SIDE_PX;
  const hasPlayer = current !== null || parked !== null;
  const side = music.open && hasPlayer && wide && music.listening;
  // Over the queue the cover turns sideways; the video cannot (YouTube's
  // player has to stay at least 200 by 200), so it stays full width with the
  // lines tight under it (`StagePlayer`).
  const overQueue = music.open && hasPlayer && !wide && music.listening;
  const playing = music.state?.status === "playing";
  const canManage = effectiveCanManageMusic(voiceState, music.state);
  const canSetSwitches = canSetMusicSwitches(voiceState);
  const next = queue[0] ?? null;
  const nextBy = next ? lookupAddedBy(voiceState, next.addedByUserId, next.addedByName) : null;
  /*
   * The queue closed: what plays next, as one line under the player, and
   * the whole line opens the queue. The queue's toggle itself is in the
   * player's header, beside "Ver no palco". Nothing waiting, no line.
   */
  const upNext =
    music.open || !(next && nextBy) ? undefined : (
      <button
        type="button"
        data-music-up-next=""
        className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2 text-left shadow-[inset_0_0_0_1px_var(--card-border)] transition-colors hover:bg-surface-3"
        onClick={() => setMusicOpen(true)}
      >
        <span className="shrink-0 text-[12px] text-text-tertiary">{t("music.queue")}</span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-text" title={next.title}>
          {next.title}
        </span>
        <span className="hidden shrink-0 items-center gap-1 text-[12px] text-text-secondary @min-[28rem]:flex">
          <UserAvatar
            name={nextBy.name}
            avatarUrl={nextBy.avatarUrl}
            className="h-4 w-4"
            fallbackClassName="bg-surface-3 text-[8px] text-text"
            rounded="full"
          />
          {nextBy.name}
        </span>
      </button>
    );
  // Not in the Rádio: the stage holds the invite, never the controls. The
  // room's music is somebody else's until this person joins it.
  const invite = current !== null && !music.listening;
  const player = invite ? (
    <MusicRadioInvite track={current} voiceState={voiceState} />
  ) : current ? (
    <MusicNowPlaying
      tone="stage"
      stageCompact={overQueue}
      stageVideo={video}
      onToggleFullscreen={onToggleFullscreen}
      stageFooter={upNext}
      onStageShrink={onShrink}
      current={current}
      music={music}
      voiceState={voiceState}
      canManage={canManage}
      canSetSwitches={canSetSwitches}
      playing={playing}
      needsTap={local.needsTap}
      playbackFailed={local.playbackFailed}
      listening={music.listening}
      volume={local.volume}
      muted={local.muted}
      ducking={prefs.ducking}
      onOpenFila={() => setMusicOpen(true)}
      onPlayPause={() => setPlaying(!playing)}
      onSkip={() => void skipToNext(musicRelatedTracks)}
      onPrevious={() => musicPrevious()}
      onTapToPlay={tapMusicLocalToPlay}
      onMute={toggleMusicLocalMuted}
      onVolume={setMusicLocalVolume}
    />
  ) : parked ? (
    <StageEnded
      track={parked}
      compact={overQueue}
      canAdd={voiceState.canSpeak}
      onPlayAgain={() => {
        readdFromHistory(parked.id);
      }}
      onDismiss={clearParkedMusic}
    />
  ) : null;

  return (
    /*
     * The stage slot, as a size container: the cover reads `100cqh` to stay
     * inside it. The panels fill the slot, so the people under them never
     * move when the queue grows or a song changes.
     */
    <div ref={slotRef} className="h-full w-full [container-type:size]">
      <section
        // `data-music-composer` marks the player for the composer sheet's
        // outside-press rule and for the split's measuring. This panel's own
        // queue does not close on an outside press at all.
        data-music-composer=""
        data-music-stage-panel=""
        data-music-stage-layout={side ? "side" : "stacked"}
        aria-label={t("music.title")}
        className={cn("flex h-full w-full min-w-0 gap-3", side ? "flex-row" : "flex-col")}
      >
        {/* Each panel is a container of its own, so the player's and the
            queue's width rules read their panel, not the whole stage. */}
        {player && (
          <div
            data-music-stage-player=""
            className={cn(
              PANEL,
              "flex min-h-0 flex-col",
              // A size container where it fills its share of the stage, so the
              // cover or video reads the panel's own height; a sideways card is
              // as tall as its lines and can only be a width container.
              overQueue ? "@container shrink-0" : "[container-type:size]",
              !overQueue && "flex-1",
            )}
          >
            {player}
          </div>
        )}
        {music.open && (music.listening || !hasPlayer) && (
          <div
            className={cn(
              PANEL,
              "@container flex min-h-0 flex-col",
              side ? "w-[340px] shrink-0" : "flex-1",
            )}
          >
            <MusicFila
              variant="stage"
              voiceState={voiceState}
              closeOnOutsidePress={false}
              columns={overQueue && slotWidth >= TWO_COLUMNS_PX ? 2 : 1}
              centered={!hasPlayer}
            />
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * THE RÁDIO, FOR SOMEBODY WHO HAS NOT JOINED IT.
 *
 * The Rádio is opt-in: sitting down in the call plays nothing. What is on,
 * who asked for it and who is in, with one lime button. The queue and the
 * transport belong to people who joined, so neither is here.
 */
function MusicRadioInvite({
  track,
  voiceState,
}: {
  track: MusicTrack;
  voiceState: VoiceState;
}) {
  const { t } = useTranslation();
  const selfPeerId = voiceState.self?.peerId ?? null;
  const listeners = musicRoomPeople(voiceState).filter(
    (person) => person.peerId !== selfPeerId && person.listeningMusic !== false,
  );
  const addedBy = lookupAddedBy(voiceState, track.addedByUserId, track.addedByName);
  return (
    <div
      data-music-radio-invite=""
      className="flex h-full w-full min-w-0 items-center justify-center p-4"
    >
      <div className="flex w-full max-w-[40rem] min-w-0 flex-col items-center gap-4 @min-[32rem]:flex-row @min-[32rem]:items-center">
        <span className="relative block aspect-video w-[clamp(9rem,42%,16rem)] shrink-0 overflow-hidden rounded-lg bg-surface-3">
          {track.thumbnailUrl ? (
            <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <Music className="absolute inset-0 m-auto h-8 w-8 text-text-tertiary" aria-hidden="true" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center @min-[32rem]:items-start @min-[32rem]:text-left">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden="true" />
            {t("music.stage.tag")}
          </span>
          <p
            data-music-radio-invite-title=""
            className="line-clamp-2 font-display text-lg font-semibold leading-snug text-text"
            title={track.title}
          >
            {track.title}
          </p>
          <p className="text-[13px] text-text-secondary">
            {t("music.requestedBy", { name: addedBy.name })}
          </p>
          <div className="flex min-w-0 items-center gap-2 text-[12px] text-text-secondary">
            {listeners.length > 0 ? (
              <>
                <span className="flex -space-x-1.5">
                  {listeners.slice(0, 4).map((person) => (
                    <UserAvatar
                      key={person.peerId}
                      name={person.displayName}
                      avatarUrl={person.avatarUrl}
                      className="h-5 w-5 ring-2 ring-surface-1"
                      fallbackClassName="bg-surface-3 text-[9px] text-text"
                      rounded="full"
                    />
                  ))}
                </span>
                {t("music.listening", { count: listeners.length })}
              </>
            ) : (
              t("music.invite.nobody")
            )}
          </div>
          <Button
            data-music-join=""
            className="mt-1 rounded-full px-4"
            onClick={() => setListening(true)}
          >
            <Headphones className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t("music.join")}
          </Button>
          <p className="text-[12px] text-text-tertiary">{t("music.invite.hint")}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * THE MUSIC AS A CARD IN THE ROW (redesign).
 *
 * Something else is the main tile (a pinned camera or share, or "Diminuir"),
 * so the player gives the stage back and sits among the people: the cover,
 * the title, play and skip. The card, or its expand button, puts it back on
 * the stage. The video never plays in here: YouTube's player needs 200 by 200,
 * so the embed rests hidden and keeps the sound going.
 *
 * Mounted means drawn, so it claims the call the same way the panel does and
 * App leaves the composer's bar out.
 */
export function MusicRoomCard({
  channelId,
  voiceState,
  style,
  className,
  onExpand,
}: {
  channelId: string;
  voiceState: VoiceState;
  style?: CSSProperties;
  className?: string;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const local = useMusicLocalPlayback();
  useLayoutEffect(() => claimStageMusicPanel(channelId), [channelId]);
  const current = music.state?.current ?? null;
  const track = current ?? music.parked;
  const playing = music.state?.status === "playing";
  const canManage = effectiveCanManageMusic(voiceState, music.state);
  const title = current
    ? current.title
    : music.parked
      ? t("music.ended.title")
      : t("music.title");
  const expandLabel = t("music.stage.expand");
  const control =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors";
  return (
    <li
      data-music-room-card=""
      style={style}
      className={cn(
        className,
        "group relative min-h-0 min-w-0 overflow-hidden rounded-[var(--call-tile-radius)] bg-surface-2 shadow-[inset_0_0_0_1px_var(--card-border)]",
      )}
    >
      {track?.thumbnailUrl ? (
        <img
          src={track.thumbnailUrl}
          alt=""
          className={cn("absolute inset-0 h-full w-full object-cover", current ? "opacity-70" : "opacity-40")}
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-text-tertiary">
          <Music className="h-8 w-8" aria-hidden="true" />
        </span>
      )}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
      {/* The whole card puts the music back on the stage. The controls sit
          above it, so a press on play is never also a press on the card. */}
      <button
        type="button"
        data-music-room-card-expand=""
        aria-label={expandLabel}
        className="absolute inset-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--color-focus-ring)]"
        onClick={onExpand}
      />
      <span className="pointer-events-none absolute left-2 top-2 inline-flex h-6 items-center gap-1 rounded-full bg-accent-soft px-2 text-[11px] font-semibold text-on-accent-soft">
        <Music className="h-3 w-3" aria-hidden="true" />
        {t("music.stage.tag")}
      </span>
      <Tooltip label={expandLabel}>
        <button
          type="button"
          aria-label={expandLabel}
          className={cn(
            control,
            "absolute right-1.5 top-1.5 bg-black/50 text-white hover:bg-black/70",
            "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
          )}
          onClick={onExpand}
        >
          <Expand className="h-4 w-4" aria-hidden="true" />
        </button>
      </Tooltip>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 p-2">
        <p
          data-music-room-card-title=""
          className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white"
          title={title}
        >
          {title}
        </p>
        {current && !music.listening ? (
          <button
            type="button"
            data-music-join=""
            className="pointer-events-auto flex h-8 shrink-0 items-center gap-1 rounded-full bg-accent px-3 text-[12px] font-semibold text-on-accent hover:bg-accent-hover"
            onClick={() => setListening(true)}
          >
            <Headphones className="h-3.5 w-3.5" aria-hidden="true" />
            {t("music.listen")}
          </button>
        ) : current && local.needsTap ? (
          <button
            type="button"
            aria-label={t("music.stage.tapToListen")}
            className={cn(control, "pointer-events-auto bg-accent text-on-accent hover:bg-accent-hover")}
            onClick={tapMusicLocalToPlay}
          >
            <Play className="ml-0.5 h-4 w-4" fill="currentColor" aria-hidden="true" />
          </button>
        ) : current && canManage ? (
          <>
            <button
              type="button"
              aria-label={playing ? t("music.pause") : t("music.play")}
              className={cn(control, "pointer-events-auto bg-accent text-on-accent hover:bg-accent-hover")}
              onClick={() => setPlaying(!playing)}
            >
              {playing ? (
                <Pause className="h-4 w-4" fill="currentColor" aria-hidden="true" />
              ) : (
                <Play className="ml-0.5 h-4 w-4" fill="currentColor" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              aria-label={t("music.skip")}
              className={cn(control, "pointer-events-auto text-white hover:bg-white/15")}
              onClick={() => void skipToNext(musicRelatedTracks)}
            >
              <SkipForward className="h-4 w-4" fill="currentColor" aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

/**
 * THE END OF THE QUEUE, ON THE STAGE.
 *
 * The last song stays where it played, dimmed, with the two things people
 * do next: put it on again, or put the player away. The field in the queue
 * is the third, for whoever has something else in mind.
 */
function StageEnded({
  track,
  compact,
  canAdd,
  onPlayAgain,
  onDismiss,
}: {
  track: MusicTrack;
  compact: boolean;
  canAdd: boolean;
  onPlayAgain: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const cover = (
    <span
      className={cn(
        "relative block aspect-video shrink-0 overflow-hidden bg-surface-3",
        compact
          ? "w-[clamp(7.5rem,36%,14.75rem)] rounded-[calc(var(--call-tile-radius)-6px)]"
          : "h-[clamp(5rem,calc(100cqh-14rem),18.25rem)] max-w-full rounded-lg",
      )}
    >
      {track.thumbnailUrl ? (
        <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover opacity-50" />
      ) : null}
    </span>
  );
  const actions = (
    <div className={cn("flex flex-wrap items-center gap-2", !compact && "justify-center")}>
      {canAdd ? (
        <Button size="sm" className="rounded-full px-3" onClick={onPlayAgain}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("music.playAgain")}
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" className="rounded-full px-3" onClick={onDismiss}>
        <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        {t("music.ended.dismiss")}
      </Button>
    </div>
  );
  const lines = (
    <div className={cn("min-w-0", !compact && "text-center")}>
      <p className="font-display text-lg font-semibold text-text">{t("music.ended.title")}</p>
      <p className="line-clamp-2 text-[13px] text-text-secondary" title={track.title}>
        {track.title}
      </p>
    </div>
  );
  return (
    <div
      data-music-ended=""
      className={cn(
        "flex w-full min-w-0",
        compact ? "items-center gap-3 p-1.5" : "h-full flex-col items-center justify-center gap-3 p-4",
      )}
    >
      {cover}
      {compact ? (
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-1 pr-1">
          {lines}
          {actions}
        </div>
      ) : (
        <>
          {lines}
          {actions}
        </>
      )}
    </div>
  );
}
