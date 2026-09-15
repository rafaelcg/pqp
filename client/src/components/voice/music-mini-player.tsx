import { ChevronDown, Music } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import {
  setMusicDucking,
  setMusicPlacement,
  useMusicJoinGate,
  useMusicPrefs,
} from "@/lib/music-prefs";
import {
  advance,
  setListening,
  setPlaying,
  toggleMusicOpen,
  useMusic,
} from "@/lib/music-store";
import { effectiveCanManageMusic } from "@/components/voice/music-extras";
import {
  ghostIconButton,
  MusicNowPlaying,
} from "@/components/voice/music-now-playing";
import { MusicPanel } from "@/components/voice/music-panel";
import { MusicPlayer } from "@/components/voice/music-player-embed";
import { MusicSearchPicker } from "@/components/voice/music-search-picker";
import { MusicEmbedOutlet, useMusicEmbedDock } from "@/components/voice/music-embed-host";
import { cn } from "@/lib/utils";
import type { YTPlayer } from "@/lib/youtube-iframe";

/**
 * THE PLAYER, AT THE BOTTOM OF THE SIDEBAR, ABOVE THE CALL CONTROLS.
 *
 * Nothing playing: the footer is empty. The note on the call bar opens this
 * panel with the add box focused. A track on, and "parar de ouvir", leaves
 * a one-line pill. The embed is mounted once and portalled between this
 * dock, the panel's video slot, and the call-stage tile.
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
  const prefs = useMusicPrefs();
  useMusicJoinGate();
  const dockRef = useMusicEmbedDock();
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
  const canManage = effectiveCanManageMusic(voiceState, state);
  const onStage = prefs.placement === "stage" && Boolean(current) && music.listening;

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
        duckEnabled={prefs.ducking}
        speakingPeerCount={voiceState.speakingPeerIds.length}
        transmitting={voiceState.isTransmitting}
        deafened={voiceState.isDeafened}
      />
    ) : null;

  if (!current) {
    if (!music.open) {
      return compact ? (
        <div data-music-mini-player="compact" className="h-0 overflow-hidden">
          <div ref={dockRef} data-music-embed-dock="" />
        </div>
      ) : null;
    }
    return (
      <div
        data-music-mini-player="start"
        className="border-t border-border bg-surface-0 px-3 py-2"
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-text">{t("music.empty.title")}</p>
          <button
            type="button"
            className={cn(ghostIconButton, "h-7 w-7")}
            aria-expanded
            aria-label={t("music.collapse")}
            onClick={() => toggleMusicOpen()}
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <MusicSearchPicker compact variant="start" canManage={canManage} autoFocus />
      </div>
    );
  }

  if (compact) {
    return (
      <div data-music-mini-player="compact" className="h-0 overflow-hidden">
        <div ref={dockRef} data-music-embed-dock="" />
        {embed}
      </div>
    );
  }

  if (!music.listening) {
    return (
      <div
        data-music-mini-player="dismissed"
        className="flex items-center gap-2 border-t border-border bg-surface-0 px-3 py-2"
      >
        <span className="relative h-5 w-5 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-2">
          {current.thumbnailUrl ? (
            <img src={current.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <Music className="m-auto h-3 w-3 text-accent" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary" title={current.title}>
          {t("music.pill.playing", { title: current.title })}
        </span>
        <Button size="sm" onClick={() => setListening(true)}>
          {t("music.listen")}
        </Button>
      </div>
    );
  }

  const toggleVideo = () => {
    setShowVideo((value) => {
      writeStored(VIDEO_KEY, value ? "0" : "1");
      return !value;
    });
  };

  const showPanelVideo = music.open && showVideo && !onStage;
  const showStagePlaceholder = music.open && onStage;

  return (
    <div
      data-music-mini-player=""
      data-video={showPanelVideo ? "shown" : "folded"}
      data-music-placement={prefs.placement}
      className="border-t border-border bg-surface-0 text-xs"
    >
      <div ref={dockRef} data-music-embed-dock="" className="h-0 overflow-hidden">
        {embed}
      </div>
      {showStagePlaceholder && (
        <p
          data-music-stage-placeholder=""
          className="px-3 pt-2 text-[11px] text-text-secondary"
        >
          {t("music.stage.playing")}
        </p>
      )}
      <div
        className={
          showPanelVideo
            ? "max-h-[135px] overflow-hidden px-2 pt-2"
            : "h-0 overflow-hidden"
        }
      >
        <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-card)] bg-surface-0">
          {showPanelVideo ? <MusicEmbedOutlet home={dockRef} /> : null}
        </div>
      </div>

      {music.open ? (
        <MusicPanel
          current={current}
          music={music}
          voiceState={voiceState}
          canManage={canManage}
          playing={playing}
          needsTap={needsTap}
          showVideo={showVideo}
          volume={volume}
          muted={muted}
          onStage={onStage}
          ducking={prefs.ducking}
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
          onWatchOnStage={() => setMusicPlacement(onStage ? "panel" : "stage")}
          onToggleDucking={setMusicDucking}
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
