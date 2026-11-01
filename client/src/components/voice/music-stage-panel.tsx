import { useLayoutEffect } from "react";
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
  const current = music.state?.current ?? null;
  const parked = music.parked;
  const playing = music.state?.status === "playing";
  const canManage = effectiveCanManageMusic(voiceState, music.state);
  const canSetSwitches = canSetMusicSwitches(voiceState);
  const player = current ? (
    <MusicNowPlaying
      tone="stage"
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
    <div className="flex h-full w-full items-center justify-center">
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
    <section
      // `data-music-composer` keeps a press inside this panel from closing
      // the queue (`MusicFila` closes its sheet on a press anywhere else).
      data-music-composer=""
      data-music-stage-panel=""
      aria-label={t("music.title")}
      className={cn(
        "@container flex h-full w-full min-w-0 overflow-hidden rounded-[var(--call-tile-radius)] bg-surface-1",
        // The sheet caps itself for the composer, where it shares the
        // column with the chat; here it is the panel's height.
        "[&_[data-music-fila='sheet']]:h-full [&_[data-music-fila='sheet']]:max-h-full",
      )}
    >
      {/* Each column is a container of its own, so the player's and the
          queue's width rules read their column, not the whole panel. */}
      <div className="flex h-full w-full min-w-0 flex-col @min-[40rem]:flex-row">
        {player && (
          <div
            className={cn(
              "@container min-h-0 min-w-0 flex-1",
              // Stacked under a narrow stage the queue needs the height more
              // than the cover does: the player gives up the picture.
              music.open &&
                "@max-[40rem]:max-h-[50%] @max-[40rem]:flex-none @max-[40rem]:[&_[data-music-art]]:hidden",
            )}
          >
            {player}
          </div>
        )}
        {music.open && (
          <div
            className={cn(
              "@container flex min-h-0 min-w-0 flex-1 flex-col",
              player &&
                "border-t border-[color:var(--card-border)] @min-[40rem]:w-[min(24rem,45%)] @min-[40rem]:flex-none @min-[40rem]:border-l @min-[40rem]:border-t-0",
            )}
          >
            <MusicFila variant="sheet" voiceState={voiceState} />
          </div>
        )}
      </div>
    </section>
  );
}
