import {
  ChevronDown,
  ChevronUp,
  ListMusic,
  Music,
  Pause,
  Play,
  SkipForward,
  Square,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MarqueeText } from "@/components/ui/marquee-text";
import { Tooltip } from "@/components/ui/tooltip";
import { MusicAddForm } from "@/components/voice/music-add-form";
import { useTranslation } from "@/lib/i18n";
import {
  advance,
  expectedPositionMs,
  reportPosition,
  setPlaying,
  setPositionProbe,
  stopMusic,
  toggleMusicOpen,
  useMusic,
  type MusicSnapshot,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";
import {
  loadYouTubeIframeApi,
  YT_STATE,
  type YTPlayer,
} from "@/lib/youtube-iframe";
import type { VoiceState } from "@/hooks/use-voice";

/**
 * THE PLAYER, AT THE BOTTOM OF THE SIDEBAR, ABOVE THE CALL CONTROLS.
 *
 * Where a browser puts its media controls: always in the same place, out of
 * the way of the conversation, and there for the whole call. Mounted while
 * this machine is in a call that has a track, whichever channel or
 * conversation the reader is looking at, because unmounting the embed is
 * what stops the sound.
 *
 * The video is folded away by default and the thumbnail stands in for it:
 * this is a music queue, and a sidebar is no place for a film. The embed
 * stays mounted at zero height while folded, which keeps the audio going.
 * The choice is remembered per browser.
 *
 * Sync (`lib/music-store.ts` holds the state; this file drives the player):
 * a change of track loads it at the room's expected position, a change of
 * status plays or pauses, and every two seconds the player's clock is
 * compared with the room's and nudged when it has drifted more than
 * `DRIFT_MS`. The person who last wrote the state samples their position
 * every `REPORT_MS` so a late joiner lands close; nobody else writes
 * unprompted, so a room of twenty is one writer, not twenty.
 */

const DRIFT_MS = 2_500;
const REPORT_MS = 10_000;
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

const controlClass =
  "flex h-8 w-8 items-center justify-center rounded-full bg-ink-3 text-paper transition-colors hover:bg-ink-4 disabled:opacity-40";

export function MusicMiniPlayer({ voiceState }: { voiceState: VoiceState }) {
  const { t } = useTranslation();
  const music = useMusic();
  const [volume, setVolume] = useState(readVolume);
  const [showVideo, setShowVideo] = useState(() => readStored(VIDEO_KEY) === "1");
  const [needsTap, setNeedsTap] = useState(false);
  const playerRef = useRef<YTPlayer | null>(null);
  const inCall =
    voiceState.status === "connected" && voiceState.voiceChannelId !== null;
  const state = music.state;
  const current = state?.current ?? null;
  const isActor = state?.actorId === voiceState.peerId;
  const playing = state?.status === "playing";

  if (!inCall || !current) {
    return null;
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
      className="border-t border-ink-4/60 bg-ink px-2 pb-2 pt-2 text-xs"
    >
      {/* The embed. Zero height while folded: still mounted, still audible. */}
      <div className={cn(showVideo ? "mb-2" : "h-0 overflow-hidden")}>
        <MusicPlayer
          music={music}
          isActor={isActor}
          volume={volume}
          playerRef={playerRef}
          onNeedsTap={setNeedsTap}
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-ink-3"
          aria-pressed={showVideo}
          aria-label={showVideo ? t("music.video.hide") : t("music.video.show")}
          onClick={toggleVideo}
        >
          {current.thumbnailUrl ? (
            <img
              src={current.thumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <Music className="m-auto h-4 w-4 text-signal" aria-hidden="true" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <MarqueeText text={current.title} className="font-medium text-paper" />
          <p className="truncate text-[11px] text-paper-muted">
            {t("music.addedBy", { name: current.addedByName })}
          </p>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        {needsTap ? (
          <button
            type="button"
            className="flex h-8 items-center gap-1 rounded-full bg-accent px-3 font-semibold text-on-accent"
            onClick={() => {
              playerRef.current?.playVideo();
              setNeedsTap(false);
            }}
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            {t("music.tapToPlay")}
          </button>
        ) : (
          <Tooltip label={playing ? t("music.pause") : t("music.play")}>
            <button
              type="button"
              className={cn(controlClass, playing && "bg-signal/20 text-signal")}
              aria-pressed={playing}
              onClick={() => setPlaying(!playing)}
            >
              {playing ? (
                <Pause className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Play className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        )}
        <Tooltip label={t("music.skip")}>
          <button type="button" className={controlClass} onClick={() => advance()}>
            <SkipForward className="h-4 w-4" aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label={t("music.open")}>
          <button
            type="button"
            className={cn(controlClass, music.open && "bg-signal/20 text-signal")}
            aria-pressed={music.open}
            onClick={() => toggleMusicOpen()}
          >
            <ListMusic className="h-4 w-4" aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label={showVideo ? t("music.video.hide") : t("music.video.show")}>
          <button
            type="button"
            className={cn(controlClass, showVideo && "bg-signal/20 text-signal")}
            aria-pressed={showVideo}
            onClick={toggleVideo}
          >
            {showVideo ? (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </Tooltip>
        <Tooltip label={t("music.stop")}>
          <button
            type="button"
            className={cn(controlClass, "text-paper-muted")}
            onClick={() => stopMusic()}
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      <label className="mt-2 flex items-center gap-2 text-paper-muted">
        <Volume2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">{t("music.volume")}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label={t("music.volume")}
          onChange={(event) => {
            const next = Number(event.target.value);
            setVolume(next);
            writeStored(VOLUME_KEY, String(next));
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-signal"
        />
      </label>

      <div className="mt-2">
        <MusicAddForm compact />
      </div>
    </div>
  );
}

/**
 * The embed, and the loop that keeps it where the room is.
 *
 * `music` is read through a ref inside the interval so the loop is created
 * once per player rather than once per frame; the effects below react to the
 * two things that need an immediate answer, a new track and a play/pause.
 */
function MusicPlayer({
  music,
  isActor,
  volume,
  playerRef,
  onNeedsTap,
}: {
  music: MusicSnapshot;
  isActor: boolean;
  volume: number;
  playerRef: React.MutableRefObject<YTPlayer | null>;
  onNeedsTap: (needs: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const musicRef = useRef(music);
  musicRef.current = music;
  const isActorRef = useRef(isActor);
  isActorRef.current = isActor;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const { t } = useTranslation();
  const videoId = music.state?.current?.videoId ?? null;
  const trackId = music.state?.current?.id ?? null;
  const status = music.state?.status ?? "paused";

  // Build the player once.
  useEffect(() => {
    let disposed = false;
    let player: YTPlayer | null = null;
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const mount = document.createElement("div");
    host.appendChild(mount);
    void loadYouTubeIframeApi()
      .then((YT) => {
        if (disposed) {
          return;
        }
        const initial = musicRef.current;
        player = new YT.Player(mount, {
          width: "100%",
          height: "100%",
          videoId: initial.state?.current?.videoId,
          playerVars: {
            autoplay: initial.state?.status === "playing" ? 1 : 0,
            start: Math.floor(expectedPositionMs(initial) / 1000),
            controls: 0,
            disablekb: 1,
            rel: 0,
            playsinline: 1,
            modestbranding: 1,
          },
          events: {
            onReady: (event) => {
              if (disposed) {
                return;
              }
              playerRef.current = event.target;
              event.target.setVolume(readVolume());
              setPositionProbe(() => event.target.getCurrentTime() * 1000);
              setReady(true);
            },
            onStateChange: (event) => {
              const snap = musicRef.current;
              if (event.data === YT_STATE.ENDED) {
                const ended = snap.state?.current?.id;
                if (ended) {
                  advance(ended);
                }
              } else if (event.data === YT_STATE.PLAYING) {
                onNeedsTap(false);
              }
            },
            onError: (event) => {
              // 100: removed or private. 101 / 150: the owner disabled
              // embedding, or it is blocked in THIS viewer's region. That
              // last case is why nothing here skips for the room: one
              // person's blocked embed is not everybody's, and a Brazilian
              // room must not lose a track because one viewer is abroad.
              // The failure shows on this screen, next to the Skip button.
              console.warn("[music] player error", event.data);
              setFailed(true);
            },
          },
        });
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      playerRef.current = null;
      setPositionProbe(null);
      try {
        player?.destroy();
      } catch {
        // already gone
      }
      mount.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new track: load it where the room is.
  useEffect(() => {
    const player = playerRef.current;
    if (!ready || !player || !videoId) {
      return;
    }
    setFailed(false);
    const seconds = expectedPositionMs(musicRef.current) / 1000;
    if (musicRef.current.state?.status === "playing") {
      player.loadVideoById(videoId, seconds);
    } else {
      player.cueVideoById(videoId, seconds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, videoId, trackId]);

  // Play or pause, and the drift loop.
  useEffect(() => {
    const player = playerRef.current;
    if (!ready || !player) {
      return;
    }
    if (status === "playing") {
      player.playVideo();
    } else {
      player.pauseVideo();
      const at = expectedPositionMs(musicRef.current) / 1000;
      if (Math.abs(player.getCurrentTime() - at) > DRIFT_MS / 1000) {
        player.seekTo(at, true);
      }
    }
    if (status !== "playing") {
      return;
    }
    // Autoplay can be refused until the page has a gesture. The button in
    // the panel is that gesture.
    const tapCheck = setTimeout(() => {
      const current = player.getPlayerState();
      if (current !== YT_STATE.PLAYING && current !== YT_STATE.BUFFERING) {
        onNeedsTap(true);
      }
    }, 2_000);
    let lastReport = Date.now();
    const timer = setInterval(() => {
      const snap = musicRef.current;
      if (!snap.state || snap.state.status !== "playing") {
        return;
      }
      let at = 0;
      try {
        at = player.getCurrentTime() * 1000;
      } catch {
        return;
      }
      const expected = expectedPositionMs(snap);
      if (Math.abs(at - expected) > DRIFT_MS && !isActorRef.current) {
        player.seekTo(expected / 1000, true);
      }
      if (isActorRef.current && Date.now() - lastReport >= REPORT_MS) {
        lastReport = Date.now();
        reportPosition(at);
      }
    }, 2_000);
    return () => {
      clearTimeout(tapCheck);
      clearInterval(timer);
    };
    // A fresh `receivedAt` (an echo, a seek from somebody else) restarts the
    // loop so its first tick measures against the newest sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, status, music.receivedAt]);

  useEffect(() => {
    playerRef.current?.setVolume(volume);
  }, [volume, playerRef, ready]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md bg-ink">
      <div ref={hostRef} className="absolute inset-0 [&>div]:h-full [&>div]:w-full [&_iframe]:h-full [&_iframe]:w-full" />
      {failed && (
        <p className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-paper-muted">
          {t("music.error.playback")}
        </p>
      )}
    </div>
  );
}
