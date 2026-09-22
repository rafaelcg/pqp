import type { VoiceState } from "@/hooks/use-voice";
import { useMusicPrefs } from "@/lib/music-prefs";
import { musicRelatedTracks } from "@/lib/music-related";
import {
  musicPrevious,
  setMusicOpen,
  setPlaying,
  useMusic,
  skipToNext,
} from "@/lib/music-store";
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
import { MusicNowPlaying } from "@/components/voice/music-now-playing";

/**
 * THE PLAYER, IN THE COMPOSER.
 *
 * The dock tile opens Fila. A track on draws the bar above the call dock.
 * The YouTube iframe stays in the sidebar dock.
 */
export function MusicComposer({ voiceState }: { voiceState: VoiceState }) {
  const music = useMusic();
  const prefs = useMusicPrefs();
  const local = useMusicLocalPlayback();
  const current = music.state?.current ?? null;
  const playing = music.state?.status === "playing";
  const canManage = effectiveCanManageMusic(voiceState, music.state);
  const canSetSwitches = canSetMusicSwitches(voiceState);

  if (!current && !music.open) {
    return null;
  }

  return (
    /*
     * ONE STEP UP THE SURFACE LADDER, AS ONE BLOCK.
     *
     * The queue and the player used to set no background at all, so they
     * inherited the column and the whole thing read as one flat slab with
     * a message box floating in it. In a dark theme elevation is
     * luminance, not shadow: a surface that sits ON something is lighter,
     * and a surface that sits IN it is darker. This panel is attached
     * above the composer, so it goes up one: surface-1 between the
     * column's surface-0 and the message box's surface-2, which keeps the
     * box the brightest thing in the composer and the field inside this
     * panel (an `Input`, surface-0) still reading as a well.
     *
     * One surface for both halves rather than one each: the queue and the
     * player are one feature, and three tones stacked in 200px reads as
     * stripes rather than hierarchy. The borders are the seams.
     *
     * The top corners are the well's, less its 1px border, because this is
     * the well's FIRST child and a square fill painted over a rounded box
     * squares it off. Matching here rather than clipping at the well: that
     * well holds a focus ring, a seek thumb and a marquee, none of which
     * should be cut to solve a corner.
     */
    <div
      data-music-composer=""
      className="@container rounded-t-[calc(var(--radius-card)-1px)] border-b border-border/60 bg-surface-1"
    >
      <MusicFila variant="sheet" voiceState={voiceState} />
      {current ? (
        <MusicNowPlaying
          tone="composer"
          current={current}
          music={music}
          voiceState={voiceState}
          canManage={canManage}
          canSetSwitches={canSetSwitches}
          playing={playing}
          needsTap={local.needsTap}
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
      ) : null}
    </div>
  );
}
