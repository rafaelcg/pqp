import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  ListMusic,
  Music,
  Pause,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MusicTrack } from "@pqp/shared";
import { MarqueeText } from "@/components/ui/marquee-text";
import { Tooltip } from "@/components/ui/tooltip";
import { MusicAddForm } from "@/components/voice/music-add-form";
import { useTranslation } from "@/lib/i18n";
import {
  advance,
  expectedPositionMs,
  moveInQueue,
  moveTrackTo,
  removeFromQueue,
  reportPosition,
  setListening,
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
 * Shaped like a music app's mini player. AT REST it is one card: artwork,
 * title, who added it, play/pause and skip. Nothing else competes for the
 * eye, because most of the time the only thing a person wants is to pause
 * or move on. THE CARD OPENS (the chevron, or the button on the call bar)
 * into the rest: the video, the volume, the add box, the queue, and two
 * quiet text actions at the bottom.
 *
 * "PARAR DE OUVIR" IS PERSONAL. It unmounts this machine's embed, which is
 * what silences it, and leaves a one-line pill with the way back. The
 * room's queue is untouched: one person not wanting the music is not the
 * room not wanting it. "Parar para todos" is the room-wide stop, and it is
 * deliberately text at the bottom rather than a button beside play.
 *
 * The video is folded by default; this is a music queue. The embed stays
 * mounted at zero height while folded, which keeps the audio going. The
 * choice is remembered per browser.
 *
 * Sync (`lib/music-store.ts` holds the state; `MusicPlayer` below drives
 * the embed): a change of track loads it at the room's expected position, a
 * change of status plays or pauses, and every two seconds the player's
 * clock is compared with the room's and nudged when it has drifted more
 * than `DRIFT_MS`. The person who last wrote the state samples their
 * position every `REPORT_MS` so a late joiner lands close; nobody else
 * writes unprompted, so a room of twenty is one writer, not twenty.
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

const ghostButton =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper";

export function MusicMiniPlayer({ voiceState }: { voiceState: VoiceState }) {
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

  if (!inCall) {
    return null;
  }

  // Nothing on: one line, the way to put something on.
  if (!current) {
    return (
      <div
        data-music-mini-player="empty"
        className="border-t border-ink-4/60 bg-ink px-2 py-2"
      >
        <MusicAddForm compact variant="start" />
      </div>
    );
  }

  // Not listening: a pill, and the way back.
  if (!music.listening) {
    return (
      <div
        data-music-mini-player="dismissed"
        className="flex items-center gap-2 border-t border-ink-4/60 bg-ink px-3 py-2 text-[11px] text-paper-muted"
      >
        <Music className="h-3 w-3 shrink-0 text-signal" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" title={current.title}>
          {current.title}
        </span>
        <button
          type="button"
          className="shrink-0 font-semibold text-signal hover:underline"
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
  const effectiveVolume = muted ? 0 : volume;

  return (
    <div
      data-music-mini-player=""
      data-video={showVideo ? "shown" : "folded"}
      className="border-t border-ink-4/60 bg-ink text-xs"
    >
      {/* The embed. Zero height while folded: still mounted, still audible. */}
      <div className={cn(music.open && showVideo ? "px-2 pt-2" : "h-0 overflow-hidden")}>
        <MusicPlayer
          music={music}
          isActor={isActor}
          volume={effectiveVolume}
          playerRef={playerRef}
          onNeedsTap={setNeedsTap}
        />
      </div>

      {/* The card. */}
      <div className="group flex items-center gap-2.5 px-2 py-2">
        <button
          type="button"
          className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-ink-3"
          aria-expanded={music.open}
          aria-label={music.open ? t("music.collapse") : t("music.expand")}
          onClick={() => toggleMusicOpen()}
        >
          {current.thumbnailUrl ? (
            <img src={current.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <Music className="m-auto h-4 w-4 text-signal" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-expanded={music.open}
          aria-label={music.open ? t("music.collapse") : t("music.expand")}
          onClick={() => toggleMusicOpen()}
        >
          <MarqueeText text={current.title} className="text-[13px] font-medium leading-tight text-paper" />
          <span className="block truncate text-[11px] leading-tight text-paper-muted">
            {t("music.addedBy", { name: current.addedByName })}
          </span>
        </button>
        {needsTap ? (
          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-accent px-3 text-[11px] font-semibold text-on-accent"
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
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper text-ink transition-transform hover:scale-105"
              aria-pressed={playing}
              onClick={() => setPlaying(!playing)}
            >
              {playing ? (
                <Pause className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Play className="ml-0.5 h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        )}
        <Tooltip label={t("music.skip")}>
          <button type="button" className={ghostButton} onClick={() => advance()}>
            <SkipForward className="h-4 w-4" aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label={music.open ? t("music.collapse") : t("music.expand")}>
          <button
            type="button"
            className={cn(ghostButton, "h-7 w-7")}
            aria-expanded={music.open}
            onClick={() => toggleMusicOpen()}
          >
            {music.open ? (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </Tooltip>
      </div>

      {music.open && (
        <div className="space-y-2.5 px-2 pb-2.5">
          <div className="flex items-center gap-2">
            <Tooltip label={muted ? t("music.unmute") : t("music.mute")}>
              <button
                type="button"
                className={cn(ghostButton, "h-7 w-7")}
                aria-pressed={muted}
                onClick={() => setMuted((value) => !value)}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Volume2 className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </Tooltip>
            <input
              type="range"
              min={0}
              max={100}
              value={effectiveVolume}
              aria-label={t("music.volume")}
              onChange={(event) => {
                const next = Number(event.target.value);
                setMuted(false);
                setVolume(next);
                writeStored(VOLUME_KEY, String(next));
              }}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-signal"
            />
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-[11px] text-paper-muted hover:bg-ink-3 hover:text-paper"
              aria-pressed={showVideo}
              onClick={toggleVideo}
            >
              {showVideo ? t("music.video.hide") : t("music.video.show")}
            </button>
          </div>

          <MusicAddForm compact />

          {state && state.queue.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-paper-muted">
                <ListMusic className="h-3 w-3" aria-hidden="true" />
                {t("music.queue")}
                <span className="tabular-nums">{state.queue.length}</span>
              </p>
              <QueueList
                queue={state.queue}
                selfUserId={voiceState.self?.userId ?? null}
              />
            </div>
          )}

          <div className="flex items-center justify-between text-[11px]">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={() => setListening(false)}
            >
              {t("music.dismiss")}
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-paper-muted hover:bg-danger-soft hover:text-on-danger-soft"
              onClick={() => stopMusic()}
            >
              {t("music.stopAll")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The queue: scrolls past six rows, and reorders by drag.
 *
 * Native HTML5 drag, like the sidebar's voice occupants
 * (`lib/voice-occupant-dnd.ts`). While a row is dragged, the pointer's
 * position over each row decides whether it would land before or after it,
 * and a line is drawn there: the "drop preview". The write is one
 * `moveTrackTo` on drop, so the room sees one reorder and not a scrub.
 * The up/down buttons stay for the keyboard.
 */
function QueueList({
  queue,
  selfUserId,
}: {
  queue: MusicTrack[];
  selfUserId: string | null;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const finish = () => {
    setDragId(null);
    setDropIndex(null);
  };

  return (
    <ol
      data-music-queue=""
      className="max-h-52 space-y-0.5 overflow-y-auto pr-0.5"
      onDragOver={(event) => {
        if (dragId) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (dragId && dropIndex !== null) {
          moveTrackTo(dragId, dropIndex);
        }
        finish();
      }}
      onDragLeave={(event) => {
        // Leaving the list entirely, not moving between its rows.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropIndex(null);
        }
      }}
    >
      {queue.map((track, index) => (
        <QueueRow
          key={track.id}
          track={track}
          index={index}
          last={index === queue.length - 1}
          mine={track.addedByUserId === selfUserId}
          dragging={dragId === track.id}
          dropBefore={dropIndex === index}
          dropAfter={dropIndex === index + 1 && index === queue.length - 1}
          onDragStart={(event) => {
            setDragId(track.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", track.id);
          }}
          onDragEnd={finish}
          onDragOver={(event) => {
            if (!dragId) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            setDropIndex(after ? index + 1 : index);
          }}
        />
      ))}
    </ol>
  );
}

function QueueRow({
  track,
  index,
  last,
  mine,
  dragging,
  dropBefore,
  dropAfter,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  track: MusicTrack;
  index: number;
  last: boolean;
  mine: boolean;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onDragStart: (event: React.DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent<HTMLLIElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      draggable
      data-queue-row={track.id}
      data-drop={dropBefore ? "before" : dropAfter ? "after" : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      className={cn(
        "group/row relative flex cursor-grab items-center gap-1 rounded-md px-1 py-1 hover:bg-ink-3/50 active:cursor-grabbing",
        mine && "bg-ink-3/30",
        dragging && "opacity-40",
        // The drop preview: a line where the row would land.
        dropBefore &&
          "before:absolute before:inset-x-1 before:-top-[2px] before:h-[2px] before:rounded-full before:bg-signal",
        dropAfter &&
          "after:absolute after:inset-x-1 after:-bottom-[2px] after:h-[2px] after:rounded-full after:bg-signal",
      )}
    >
      <GripVertical
        className="h-3 w-3 shrink-0 text-paper-muted/60 opacity-0 group-hover/row:opacity-100"
        aria-hidden="true"
      />
      <span className="w-4 shrink-0 text-right tabular-nums text-paper-muted">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate" title={track.title}>
        {track.title}
        <span className="ml-1 text-paper-muted">{track.addedByName}</span>
      </span>
      <Tooltip label={t("music.moveUp")}>
        <button
          type="button"
          disabled={index === 0}
          onClick={() => moveInQueue(track.id, -1)}
          className="rounded p-0.5 text-paper-muted opacity-0 hover:bg-ink-3/70 hover:text-paper focus-visible:opacity-100 disabled:opacity-30 group-hover/row:opacity-100"
        >
          <ChevronUp className="h-3 w-3" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={t("music.moveDown")}>
        <button
          type="button"
          disabled={last}
          onClick={() => moveInQueue(track.id, 1)}
          className="rounded p-0.5 text-paper-muted opacity-0 hover:bg-ink-3/70 hover:text-paper focus-visible:opacity-100 disabled:opacity-30 group-hover/row:opacity-100"
        >
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={t("music.remove")}>
        <button
          type="button"
          onClick={() => removeFromQueue(track.id)}
          className="rounded p-0.5 text-paper-muted opacity-0 hover:bg-ink-3/70 hover:text-paper focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </Tooltip>
    </li>
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
