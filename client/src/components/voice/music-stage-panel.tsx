import { ListMusic, RotateCcw, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { MusicTrack } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import { useMusicPrefs } from "@/lib/music-prefs";
import { musicRelatedTracks } from "@/lib/music-related";
import {
  clearParkedMusic,
  musicPrevious,
  readdFromHistory,
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
import { lookupAddedBy, MusicNowPlaying } from "@/components/voice/music-now-playing";
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
}: {
  channelId: string;
  voiceState: VoiceState;
  /** The video alone on the whole stage (the solo view the call stage owns). */
  onToggleFullscreen?: () => void;
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
  const side = music.open && hasPlayer && wide;
  // Over the queue the cover turns sideways; the video cannot (YouTube's
  // player has to stay at least 200 by 200), so it stays full width with the
  // lines tight under it (`StagePlayer`).
  const overQueue = music.open && hasPlayer && !wide;
  const playing = music.state?.status === "playing";
  const canManage = effectiveCanManageMusic(voiceState, music.state);
  const canSetSwitches = canSetMusicSwitches(voiceState);
  const next = queue[0] ?? null;
  const nextBy = next ? lookupAddedBy(voiceState, next.addedByUserId, next.addedByName) : null;
  /*
   * The queue closed: what plays next, and the way back to the list. Without
   * it, closing the queue hid the one thing people open it to check.
   */
  const upNext = music.open ? undefined : (
    <div
      data-music-up-next=""
      className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-lg bg-surface-2 p-1 pl-3 shadow-[inset_0_0_0_1px_var(--card-border)]"
    >
      {next && nextBy ? (
        <>
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
        </>
      ) : music.state?.autoplay ? (
        <span className="min-w-0 truncate text-[12px] text-text-secondary">{t("music.autoplay.next")}</span>
      ) : null}
      <span className="flex-1" />
      <button
        type="button"
        data-music-queue-toggle=""
        aria-expanded={false}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-surface-3 px-2.5 text-[12px] font-medium text-text transition-colors hover:bg-[color:var(--button-ghost-hover)]"
        onClick={() => setMusicOpen(true)}
      >
        <ListMusic className="h-4 w-4" aria-hidden="true" />
        {t("music.stage.showQueue")}
        {queue.length > 0 ? (
          <span className="rounded-full bg-surface-1 px-1.5 text-[11px] font-semibold leading-4 tabular-nums text-text-secondary">
            {queue.length}
          </span>
        ) : null}
      </button>
    </div>
  );
  const player = current ? (
    <MusicNowPlaying
      tone="stage"
      stageCompact={overQueue}
      stageVideo={video}
      onToggleFullscreen={onToggleFullscreen}
      stageFooter={upNext}
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
        {music.open && (
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
