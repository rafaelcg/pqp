import { Music } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { Button } from "@/components/ui/button";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import { useMusicJoinGate, useMusicPrefs } from "@/lib/music-prefs";
import { musicRelatedTracks } from "@/lib/music-related";
import {
  setMusicOpen,
  setPlaying,
  useMusic,
  skipToNext,
} from "@/lib/music-store";
import { setChannelMusicCardRights } from "@/components/voice/channel-music-card-rights";
import {
  canSetMusicSwitches,
  effectiveCanManageMusic,
} from "@/components/voice/music-extras";
import { MusicFila } from "@/components/voice/music-fila";
import {
  setMusicLocalNeedsTap,
  setMusicLocalPlayer,
  setMusicLocalVolume,
  tapMusicLocalToPlay,
  toggleMusicLocalMuted,
  useMusicLocalPlayback,
} from "@/components/voice/music-local-playback";
import { MusicNowPlaying } from "@/components/voice/music-now-playing";
import {
  MusicPlayer,
  shouldKeepMusicEmbed,
} from "@/components/voice/music-player-embed";
import { useMusicEmbedDock } from "@/components/voice/music-embed-host";
import type { YTPlayer } from "@/lib/youtube-iframe";

/**
 * THE EMBED, AND THE SIDEBAR RADIO WHEN THE COMPOSER IS NOT THIS CALL.
 *
 * The iframe stays here for the whole listen so hiding the chrome does not
 * stop the sound. When this call's composer is on screen, chrome is false
 * and the bar lives there. Opening another channel brings the compact radio
 * back, with Fila as a drawer over members.
 */

export function MusicMiniPlayer({
  voiceState,
  compact = false,
  chrome = true,
  embed = true,
}: {
  voiceState: VoiceState;
  /** The icons-only sidebar: nothing drawn, but the chrome still decides. */
  compact?: boolean;
  /**
   * False while the call's composer is drawing the bar.
   */
  chrome?: boolean;
  /**
   * Whether THIS instance carries the YouTube iframe. Exactly one mount may,
   * and it is the one in `App` that never unmounts. The footer renders this
   * component up to twice at once, because the sidebar stays mounted but
   * hidden under Novidades while Novidades renders a footer of its own; two
   * carriers would portal two iframes into the one singleton host, play the
   * track twice, and leave the survivor's position probe pointing at the
   * player that unmounted first.
   */
  embed?: boolean;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const prefs = useMusicPrefs();
  const local = useMusicLocalPlayback();
  useMusicJoinGate();
  const dockRef = useMusicEmbedDock();
  const playerRef = useMemo((): MutableRefObject<YTPlayer | null> => {
    let inner: YTPlayer | null = null;
    return {
      get current() {
        return inner;
      },
      set current(value) {
        inner = value;
        setMusicLocalPlayer(value);
      },
    };
  }, []);
  const inCall =
    voiceState.status === "connected" && voiceState.voiceChannelId !== null;
  const state = music.state;
  const current = state?.current ?? null;
  const isActor = state?.actorId === voiceState.peerId;
  const playing = state?.status === "playing";
  const canManage = effectiveCanManageMusic(voiceState, state);
  const canSetSwitches = canSetMusicSwitches(voiceState);
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

  useLayoutEffect(() => {
    return () => setMusicLocalPlayer(null);
  }, []);

  if (!inCall) {
    return null;
  }

  const keepEmbed = embed && embedHeldRef.current;
  const player = keepEmbed ? (
    <MusicPlayer
      music={music}
      isActor={isActor}
      volume={local.volume}
      muted={local.muted}
      playerRef={playerRef}
      onNeedsTap={setMusicLocalNeedsTap}
      duckEnabled={prefs.ducking}
      speakingPeerCount={voiceState.speakingPeerIds.length}
      transmitting={voiceState.isTransmitting}
      deafened={voiceState.isDeafened}
    />
  ) : null;
  const dock = embed ? (
    <div
      ref={dockRef}
      data-music-embed-dock=""
      className="h-0 overflow-hidden"
    >
      {player}
    </div>
  ) : null;

  if (!chrome) {
    if (!embed) {
      return null;
    }
    return (
      <div
        data-music-mini-player={current ? (music.listening ? "dock" : "dismissed") : "idle"}
        className="h-0 overflow-hidden"
      >
        {dock}
      </div>
    );
  }

  const fila = <MusicFila variant="drawer" voiceState={voiceState} />;
  const nowPlaying = current ? (
    <MusicNowPlaying
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
      onTapToPlay={tapMusicLocalToPlay}
      onMute={toggleMusicLocalMuted}
      onVolume={setMusicLocalVolume}
    />
  ) : null;

  if (compact) {
    if (!current) {
      return (
        <div
          data-music-mini-player="idle"
          className="flex flex-col items-center border-t border-ink-4/60 bg-ink py-2"
        >
          {dock}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={t("music.bar.start")}
            onClick={() => setMusicOpen(true)}
          >
            <Music className="h-4 w-4" aria-hidden="true" />
          </Button>
          {fila}
        </div>
      );
    }
    return (
      <div data-music-mini-player="compact" className="h-0 overflow-hidden">
        {dock}
        {fila}
      </div>
    );
  }

  if (!current) {
    return (
      <div
        data-music-mini-player="idle"
        className="border-t border-ink-4/60 bg-ink"
      >
        {dock}
        <button
          type="button"
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-paper hover:bg-ink-3"
          onClick={() => setMusicOpen(true)}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink-3 text-paper-muted">
            <Music className="h-4 w-4" aria-hidden="true" />
          </span>
          {t("music.bar.start")}
        </button>
        {fila}
      </div>
    );
  }

  return (
    <div
      data-music-mini-player={music.listening ? "" : "dismissed"}
      className="border-t border-ink-4/60 bg-ink text-xs"
    >
      {dock}
      {nowPlaying}
      {fila}
    </div>
  );
}
