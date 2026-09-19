import { ChevronDown, Music } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import {
  musicPictureMode,
  setMusicDucking,
  setMusicPlacement,
  setMusicShowVideo,
  useMusicJoinGate,
  useMusicPrefs,
} from "@/lib/music-prefs";
import {
  advance,
  setListening,
  setMusicOpen,
  setPlaying,
  toggleMusicOpen,
  useMusic,
} from "@/lib/music-store";
import { setChannelMusicCardRights } from "@/components/voice/channel-music-card-rights";
import { effectiveCanManageMusic } from "@/components/voice/music-extras";
import {
  ghostIconButton,
  MusicNowPlaying,
} from "@/components/voice/music-now-playing";
import { MusicPanel } from "@/components/voice/music-panel";
import {
  MusicPlayer,
  readMusicVolume,
  shouldKeepMusicEmbed,
  writeMusicVolume,
} from "@/components/voice/music-player-embed";
import { MusicSearchPicker } from "@/components/voice/music-search-picker";
import {
  useMusicEmbedDock,
  useMusicEmbedOverlay,
} from "@/components/voice/music-embed-host";
import { cn } from "@/lib/utils";
import type { YTPlayer } from "@/lib/youtube-iframe";

/**
 * THE PLAYER, AT THE BOTTOM OF THE SIDEBAR, ABOVE THE CALL CONTROLS.
 *
 * Nothing playing: a "Tocar música" row above the call status. That opens
 * the add box (the sheet). A track on is the compact bar by default; adding
 * a song or tapping art/title/chevron opens the sheet. "Parar de ouvir"
 * leaves a one-line pill. The embed stays mounted after the queue is
 * cleared (the iframe is stopped, not destroyed). Show/hide video overlays
 * the body paint dock onto this sizer. "Assistir na tela" overlays that
 * same dock on the stage slot. The sizer is the first child of every
 * listening branch, so React does not throw the player away when the idle
 * row comes back.
 */

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
  const showPanelVideo =
    music.open &&
    musicPictureMode(prefs) === "panel" &&
    Boolean(music.state?.current) &&
    music.listening;
  useMusicEmbedOverlay(dockRef, showPanelVideo);
  const [volume, setVolume] = useState(readMusicVolume);
  const [muted, setMuted] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const playerRef = useRef<YTPlayer | null>(null);
  const inCall =
    voiceState.status === "connected" && voiceState.voiceChannelId !== null;
  const state = music.state;
  const current = state?.current ?? null;
  const isActor = state?.actorId === voiceState.peerId;
  const playing = state?.status === "playing";
  const canManage = effectiveCanManageMusic(voiceState, state);
  const picture = musicPictureMode(prefs);
  const onStage =
    picture === "stage" && Boolean(current) && music.listening;
  const embedHeldRef = useRef(false);
  embedHeldRef.current = shouldKeepMusicEmbed({
    inCall,
    listening: music.listening,
    hasCurrent: current !== null,
    previouslyHeld: embedHeldRef.current,
  });

  useLayoutEffect(() => {
    if (voiceState.status !== "connected" || !voiceState.voiceChannelId) {
      return;
    }
    const channelId = voiceState.voiceChannelId;
    const seated = voiceState.occupancy[channelId] ?? [];
    const self = voiceState.self;
    const room =
      self && !seated.some((person) => person.peerId === self.peerId)
        ? [...seated, self]
        : seated;
    setChannelMusicCardRights({
      canManageMusic: voiceState.canManageMusic,
      userId: self?.userId ?? null,
      roomSize: room.length,
    });
  }, [
    voiceState.status,
    voiceState.voiceChannelId,
    voiceState.canManageMusic,
    voiceState.occupancy,
    voiceState.self,
  ]);

  if (!inCall) {
    return null;
  }

  const keepEmbed = embedHeldRef.current;
  const embed = keepEmbed ? (
    <MusicPlayer
      music={music}
      isActor={isActor}
      volume={volume}
      muted={muted}
      playerRef={playerRef}
      onNeedsTap={setNeedsTap}
      duckEnabled={prefs.ducking}
      speakingPeerCount={voiceState.speakingPeerIds.length}
      transmitting={voiceState.isTransmitting}
      deafened={voiceState.isDeafened}
    />
  ) : null;
  const dock = (
    <div
      ref={dockRef}
      data-music-embed-dock=""
      className={
        showPanelVideo
          ? "mx-2 mt-2 aspect-video overflow-hidden rounded-[var(--radius-card)] bg-surface-0"
          : "h-0 overflow-hidden"
      }
    >
      {embed}
    </div>
  );

  if (!current) {
    if (!music.open) {
      if (compact) {
        return (
          <div
            data-music-mini-player="idle"
            className="flex flex-col items-center border-t border-border bg-surface-0 py-2"
          >
            {dock}
            <button
              type="button"
              aria-label={t("music.bar.start")}
              className="flex h-9 w-9 items-center justify-center rounded-full text-text hover:bg-surface-2"
              onClick={() => setMusicOpen(true)}
            >
              <Music className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      }
      return (
        <div
          data-music-mini-player="idle"
          className="border-t border-border bg-surface-0"
        >
          {dock}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text hover:bg-surface-2"
            onClick={() => setMusicOpen(true)}
          >
            <Music className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            {t("music.bar.start")}
          </button>
        </div>
      );
    }
    return (
      <div
        data-music-mini-player="start"
        className="border-t border-border bg-surface-0 px-3 py-2"
      >
        {dock}
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
        {dock}
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

  const toggleVideo = () => setMusicShowVideo(!prefs.showVideo);

  return (
    <div
      data-music-mini-player=""
      data-video={showPanelVideo ? "shown" : "folded"}
      data-music-placement={prefs.placement}
      className="border-t border-border bg-surface-0 text-xs"
    >
      {dock}
      {onStage && (
        <p
          data-music-stage-placeholder=""
          className="px-3 pt-2 text-[11px] text-text-secondary"
        >
          {t("music.stage.playing")}
        </p>
      )}

      {music.open ? (
        <MusicPanel
          current={current}
          music={music}
          voiceState={voiceState}
          canManage={canManage}
          playing={playing}
          needsTap={needsTap}
          showVideo={prefs.showVideo}
          volume={volume}
          muted={muted}
          onStage={onStage}
          ducking={prefs.ducking}
          onPlayPause={() => setPlaying(!playing)}
          onSkip={() => advance()}
          onTapToPlay={() => {
            const player = playerRef.current;
            if (player && !muted) {
              player.unMute();
            }
            player?.playVideo();
            setNeedsTap(false);
          }}
          onMute={() => setMuted((value) => !value)}
          onVolume={(next) => {
            setMuted(false);
            setVolume(next);
            writeMusicVolume(next);
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
            const player = playerRef.current;
            if (player && !muted) {
              player.unMute();
            }
            player?.playVideo();
            setNeedsTap(false);
          }}
        />
      )}
    </div>
  );
}
