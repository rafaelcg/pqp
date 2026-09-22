import type { VoiceState } from "@/hooks/use-voice";
import { setMusicDucking, useMusicPrefs } from "@/lib/music-prefs";
import {
  advance,
  musicPrevious,
  setMusicOpen,
  setPlaying,
  useMusic,
} from "@/lib/music-store";
import { effectiveCanManageMusic } from "@/components/voice/music-extras";
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

  if (!current && !music.open) {
    return null;
  }

  return (
    <div data-music-composer="" className="@container border-b border-border/60">
      <MusicFila variant="sheet" voiceState={voiceState} />
      {current ? (
        <MusicNowPlaying
          tone="composer"
          current={current}
          music={music}
          voiceState={voiceState}
          canManage={canManage}
          playing={playing}
          needsTap={local.needsTap}
          listening={music.listening}
          volume={local.volume}
          muted={local.muted}
          ducking={prefs.ducking}
          onOpenFila={() => setMusicOpen(true)}
          onPlayPause={() => setPlaying(!playing)}
          onSkip={() => advance()}
          onPrevious={() => musicPrevious()}
          onTapToPlay={tapMusicLocalToPlay}
          onMute={toggleMusicLocalMuted}
          onVolume={setMusicLocalVolume}
          onToggleDucking={setMusicDucking}
        />
      ) : null}
    </div>
  );
}
