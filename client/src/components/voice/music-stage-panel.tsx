import { useLayoutEffect, useRef, useState } from "react";
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
import { MusicEndedBar } from "@/components/voice/music-ended-bar";
import { MusicFila } from "@/components/voice/music-fila";
import {
  setMusicLocalVolume,
  tapMusicLocalToPlay,
  toggleMusicLocalMuted,
  useMusicLocalPlayback,
} from "@/components/voice/music-local-playback";
import { MusicNowPlaying } from "@/components/voice/music-now-playing";
import { claimStageMusicPanel } from "@/components/voice/music-stage-panel-store";

/**
 * Wide enough for the cover and the queue side by side. 576px leaves the
 * queue its 22rem column (the drawer's 15rem is the narrowest it is drawn
 * anywhere) and the player about 300px, room for a 16:9 cover and the
 * transport, so the usual stage beside the chat (about 630px) gets both.
 */
const SIDE_BY_SIDE_PX = 576;

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
}: {
  channelId: string;
  voiceState: VoiceState;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const prefs = useMusicPrefs();
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
  const side =
    music.open &&
    (current !== null || parked !== null) &&
    (slotWidth === 0 || slotWidth >= SIDE_BY_SIDE_PX);
  const playing = music.state?.status === "playing";
  const canManage = effectiveCanManageMusic(voiceState, music.state);
  const canSetSwitches = canSetMusicSwitches(voiceState);
  const player = current ? (
    <MusicNowPlaying
      tone="stage"
      stageCompact={music.open && !side}
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
    <div className="flex w-full justify-center py-2">
      <div className="w-full max-w-md">
        <MusicEndedBar
          track={parked}
          canAdd={voiceState.canSpeak}
          onPlayAgain={() => {
            readdFromHistory(parked.id);
          }}
          onDismiss={clearParkedMusic}
        />
      </div>
    </div>
  ) : null;

  return (
    /*
     * The stage slot, as a size container: the cover reads `100cqh` to stay
     * inside it, and the panel is a block centred in it, as tall as what it
     * holds. A queue with two songs is a short list, not a stage-tall box.
     */
    <div
      ref={slotRef}
      className="flex h-full w-full items-center justify-center [container-type:size]"
    >
      <section
        // `data-music-composer` marks the player for the composer sheet's
        // outside-press rule and for the split's measuring. This panel's own
        // queue does not close on an outside press at all.
        data-music-composer=""
        data-music-stage-panel=""
        data-music-stage-layout={side ? "side" : "stacked"}
        aria-label={t("music.title")}
        className={cn(
          "flex max-h-full w-full min-w-0 overflow-hidden rounded-[var(--call-tile-radius)] bg-surface-1",
          side ? "flex-row" : "flex-col",
        )}
      >
        {/* Each column is a container of its own, so the player's and the
            queue's width rules read their column, not the whole panel. */}
        {player && (
          <div
            className={cn(
              "@container flex min-h-0 min-w-0 shrink-0 flex-col justify-center",
              side && "flex-1",
            )}
          >
            {player}
          </div>
        )}
        {music.open && (
          <div
            className={cn(
              // The sheet keeps its own ceiling (28rem) and scrolls past it;
              // cut shorter by the stage, it gives way before the player.
              "@container flex min-h-0 min-w-0 flex-col",
              side ? "w-[min(22rem,45%)] shrink-0" : "flex-1",
              player &&
                (side
                  ? "border-l border-[color:var(--card-border)]"
                  : "border-t border-[color:var(--card-border)]"),
            )}
          >
            <MusicFila
              variant="sheet"
              voiceState={voiceState}
              closeOnOutsidePress={false}
            />
          </div>
        )}
      </section>
    </div>
  );
}
