import { Music } from "lucide-react";
import { useRef, useState } from "react";
import { FeatureHint, useFeatureHintEnabled } from "@/components/layout/feature-hint";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import {
  advance,
  setListening,
  setPlaying,
  toggleMusicOpen,
  useMusic,
} from "@/lib/music-store";
import { MusicNowPlaying } from "@/components/voice/music-now-playing";
import { MusicPanel } from "@/components/voice/music-panel";
import { MusicPlayer } from "@/components/voice/music-player-embed";
import { MusicSearchPicker } from "@/components/voice/music-search-picker";
import type { YTPlayer } from "@/lib/youtube-iframe";

/**
 * THE PLAYER, AT THE BOTTOM OF THE SIDEBAR, ABOVE THE CALL CONTROLS.
 *
 * At rest it is one card: artwork, title, who added it, a thin progress
 * bar, play/pause and skip. The card opens (the chevron, artwork, title,
 * or the button on the call bar) into the panel: scrubber, volume, search
 * results, the queue, and two text actions at the bottom.
 *
 * "PARAR DE OUVIR" IS PERSONAL. It unmounts this machine's embed, which is
 * what silences it, and leaves a one-line pill with the way back. The
 * room's queue is untouched. "Parar para todos" is the room-wide stop,
 * behind a confirm.
 *
 * The video is folded by default; this is a music queue. The embed stays
 * mounted at zero height while folded, which keeps the audio going. The
 * choice is remembered per browser.
 */

const VOLUME_KEY = "pqp:music-volume";
const VIDEO_KEY = "pqp:music-video";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
}

function readVolume(): number {
  const parsed = Number(readStored(VOLUME_KEY) ?? NaN);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 40;
}

export function MusicMiniPlayer({
  voiceState,
  compact = false,
}: {
  voiceState: VoiceState;
  /** The icons-only sidebar: nothing drawn, but the embed stays mounted so the sound does not stop. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const [volume, setVolume] = useState(readVolume);
  const [muted, setMuted] = useState(false);
  const [showVideo, setShowVideo] = useState(() => readStored(VIDEO_KEY) === "1");
  const [needsTap, setNeedsTap] = useState(false);
  const playerRef = useRef<YTPlayer | null>(null);
  const inCall =
    voiceState.status === "connected" && voiceState.voiceChannelId !== null;
  const state = music.state;
  const current = state?.current ?? null;
  const isActor = state?.actorId === voiceState.peerId;
  const playing = state?.status === "playing";
  const canManage = voiceState.canManageMusic;
  const musicHintEnabled = useFeatureHintEnabled("music");

  if (!inCall) {
    return null;
  }

  const embed =
    current && music.listening ? (
      <MusicPlayer
        music={music}
        isActor={isActor}
        volume={muted ? 0 : volume}
        playerRef={playerRef}
        onNeedsTap={setNeedsTap}
      />
    ) : null;

  if (compact) {
    return current && music.listening ? (
      <div data-music-mini-player="compact" className="h-0 overflow-hidden">
        {embed}
      </div>
    ) : null;
  }

  if (!current) {
    return (
      <div
        data-music-mini-player="empty"
        className="border-t border-border bg-surface-0 px-3 py-3"
      >
        {musicHintEnabled && (
          <div className="mb-2">
            <FeatureHint
              id="music"
              enabled
              title={t("featureHint.music.title")}
              body={t("featureHint.music.body")}
            />
          </div>
        )}
        <div className="flex flex-col items-center gap-2 text-center">
          <Music className="h-6 w-6 text-accent" aria-hidden="true" />
          <p className="text-sm font-medium text-text">{t("music.empty.title")}</p>
          <div className="w-full text-left">
            <MusicSearchPicker compact variant="start" canManage={canManage} />
          </div>
          <p className="text-[11px] text-text-tertiary">{t("music.empty.hint")}</p>
        </div>
      </div>
    );
  }

  if (!music.listening) {
    return (
      <div
        data-music-mini-player="dismissed"
        className="flex items-center gap-2 border-t border-border bg-surface-0 px-3 py-2 text-[11px] text-text-secondary"
      >
        <Music className="h-3 w-3 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" title={current.title}>
          {current.title}
        </span>
        <button
          type="button"
          className="shrink-0 font-semibold text-accent hover:underline"
          onClick={() => setListening(true)}
        >
          {t("music.listen")}
        </button>
      </div>
    );
  }

  const toggleVideo = () => {
    setShowVideo((value) => {
      writeStored(VIDEO_KEY, value ? "0" : "1");
      return !value;
    });
  };

  return (
    <div
      data-music-mini-player=""
      data-video={showVideo ? "shown" : "folded"}
      className="border-t border-border bg-surface-0 text-xs"
    >
      <div className={music.open && showVideo ? "px-2 pt-2" : "h-0 overflow-hidden"}>
        {embed}
      </div>

      {music.open ? (
        <MusicPanel
          current={current}
          music={music}
          voiceState={voiceState}
          canManage={canManage}
          playing={playing}
          needsTap={needsTap}
          showArtwork={!showVideo}
          showVideo={showVideo}
          volume={volume}
          muted={muted}
          onPlayPause={() => setPlaying(!playing)}
          onSkip={() => advance()}
          onTapToPlay={() => {
            playerRef.current?.playVideo();
            setNeedsTap(false);
          }}
          onMute={() => setMuted((value) => !value)}
          onVolume={(next) => {
            setMuted(false);
            setVolume(next);
            writeStored(VOLUME_KEY, String(next));
          }}
          onToggleVideo={toggleVideo}
        />
      ) : (
        <MusicNowPlaying
          current={current}
          music={music}
          voiceState={voiceState}
          canManage={canManage}
          playing={playing}
          needsTap={needsTap}
          onExpand={() => toggleMusicOpen()}
          onPlayPause={() => setPlaying(!playing)}
          onSkip={() => advance()}
          onTapToPlay={() => {
            playerRef.current?.playVideo();
            setNeedsTap(false);
          }}
        />
      )}
    </div>
  );
}
