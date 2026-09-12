import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ListMusic,
  Music,
  Pause,
  Play,
  SkipForward,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MusicTrack } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, resolveMusic } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import {
  addTrack,
  advance,
  expectedPositionMs,
  moveInQueue,
  removeFromQueue,
  reportPosition,
  setPlaying,
  setPositionProbe,
  stopMusic,
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
 * THE MUSIC QUEUE, ON THE CALL.
 *
 * One line on the strip (what is playing, a button to open the queue) and a
 * panel with the player, the controls and what is up next. The player is a
 * real, visible YouTube embed: the platform's terms want it seen, and a
 * thumbnail-sized one is what Discord's Watch Together shows too.
 *
 * The player is mounted whenever the room has a current track, whether the
 * panel is open or not, because unmounting it is what stops the sound.
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
const QUEUE_SHOWN = 8;

function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 40;
  } catch {
    return 40;
  }
}

function writeVolume(volume: number) {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // per-viewer convenience only
  }
}

export function MusicDock({
  voiceState,
  compact = false,
  className,
}: {
  voiceState: VoiceState;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const [open, setOpen] = useState(false);
  const inCall = voiceState.status === "connected" && voiceState.voiceChannelId !== null;
  const current = music.state?.current ?? null;
  const isActor = music.state?.actorId === voiceState.peerId;

  if (!inCall) {
    return null;
  }

  const strip = (
    <div
      data-music-dock={compact ? "compact" : "stage"}
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-[11px] text-paper-muted",
        className,
      )}
    >
      <Tooltip label={open ? t("music.close") : t("music.open")}>
        <button
          type="button"
          aria-pressed={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-ink-3/70",
            current ? "text-signal" : "text-paper-muted",
          )}
        >
          <Music className="h-3 w-3 shrink-0" aria-hidden="true" />
          {current ? (
            <span className="max-w-[12rem] truncate">{current.title}</span>
          ) : (
            <span>{t("music.title")}</span>
          )}
        </button>
      </Tooltip>
      {current && music.state && music.state.queue.length > 0 && (
        <span className="tabular-nums">
          {t("music.more", { count: music.state.queue.length })}
        </span>
      )}
    </div>
  );

  // A popover off the strip rather than a block inside it: the strip is one
  // line and the stage's bar has no room for a panel. Opens downward from
  // the strip and upward from the bar, so it never covers the controls.
  return (
    <div className="relative">
      {strip}
      {(open || current) && (
        <div
          hidden={!open}
          className={cn(
            "pointer-events-auto absolute right-0 z-30 w-80 rounded-lg bg-ink-2/95 p-2.5 text-xs shadow-lg ring-1 ring-ink-4/60 backdrop-blur",
            compact ? "top-full mt-1" : "bottom-full mb-1.5",
          )}
        >
          <MusicPanel
            music={music}
            isActor={isActor}
            selfUserId={voiceState.self?.userId ?? null}
          />
        </div>
      )}
    </div>
  );
}

function MusicPanel({
  music,
  isActor,
  selfUserId,
}: {
  music: MusicSnapshot;
  isActor: boolean;
  selfUserId: string | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [volume, setVolume] = useState(readVolume);
  const state = music.state;
  const current = state?.current ?? null;
  const playerRef = useRef<YTPlayer | null>(null);
  const [needsTap, setNeedsTap] = useState(false);

  const submit = useCallback(async () => {
    const text = query.trim();
    if (!text || busy) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const { track } = await resolveMusic(text);
      const outcome = addTrack(track);
      if (outcome === "queued") {
        setNotice(t("music.queued"));
      } else if (outcome === "full") {
        setNotice(t("music.full"));
      }
      if (outcome !== "full") {
        setQuery("");
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 404) {
          setNotice(t("music.error.notFound"));
        } else if (error.status === 400) {
          setNotice(t("music.error.unsupported"));
        } else {
          setNotice(t("music.error.upstream"));
        }
      } else {
        setNotice(t("music.error.upstream"));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, query, t]);

  const playerTimeMs = () => {
    const player = playerRef.current;
    if (!player) {
      return expectedPositionMs(music);
    }
    try {
      return Math.round(player.getCurrentTime() * 1000);
    } catch {
      return expectedPositionMs(music);
    }
  };

  return (
    <div className="space-y-2">
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("music.placeholder")}
          aria-label={t("music.placeholder")}
          className="h-8 text-xs"
          disabled={busy}
          onKeyDown={(event) => {
            // The window-level shortcut handlers run in the capture phase;
            // submitting here keeps Enter meaning "add" whatever they do.
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <Button type="submit" size="sm" disabled={busy || !query.trim()}>
          {t("music.add")}
        </Button>
      </form>
      {notice && (
        <p role="status" className="text-[11px] text-paper-muted">
          {notice}
        </p>
      )}

      {current ? (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-paper-muted">
            <Music className="h-3 w-3 text-signal" aria-hidden="true" />
            {t("music.nowPlaying")}
          </p>
          <MusicPlayer
            music={music}
            isActor={isActor}
            volume={volume}
            playerRef={playerRef}
            onNeedsTap={setNeedsTap}
          />
          <p className="truncate font-medium text-paper" title={current.title}>
            {current.title}
          </p>
          <p className="truncate text-[11px] text-paper-muted">
            {t("music.addedBy", { name: current.addedByName })}
          </p>
          <div className="flex items-center gap-1">
            {needsTap ? (
              <Button
                size="sm"
                onClick={() => {
                  playerRef.current?.playVideo();
                  setNeedsTap(false);
                }}
              >
                <Play className="mr-1 h-3 w-3" aria-hidden="true" />
                {t("music.tapToPlay")}
              </Button>
            ) : (
              <Tooltip label={state?.status === "playing" ? t("music.pause") : t("music.play")}>
                <Button
                  size="icon"
                  variant="secondary"
                  className="h-7 w-7"
                  onClick={() => setPlaying(state?.status !== "playing", playerTimeMs())}
                >
                  {state?.status === "playing" ? (
                    <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </Button>
              </Tooltip>
            )}
            <Tooltip label={t("music.skip")}>
              <Button
                size="icon"
                variant="secondary"
                className="h-7 w-7"
                onClick={() => advance()}
              >
                <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip label={t("music.stop")}>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => stopMusic()}
              >
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </Tooltip>
            {current.sourceUrl?.includes("spotify") && (
              <Tooltip label={t("music.openSource")}>
                <a
                  href={current.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-paper-muted hover:bg-ink-3/70 hover:text-paper"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </Tooltip>
            )}
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-paper-muted">
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
                  writeVolume(next);
                }}
                className="h-1 w-20 cursor-pointer accent-signal"
              />
            </label>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-paper-muted">{t("music.empty")}</p>
      )}

      {state && state.queue.length > 0 && (
        <div>
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-paper-muted">
            <ListMusic className="h-3 w-3" aria-hidden="true" />
            {t("music.queue")}
          </p>
          <ol className="mt-1 space-y-0.5">
            {state.queue.slice(0, QUEUE_SHOWN).map((track, index) => (
              <QueueRow
                key={track.id}
                track={track}
                index={index}
                last={index === state.queue.length - 1}
                mine={track.addedByUserId === selfUserId}
              />
            ))}
          </ol>
          {state.queue.length > QUEUE_SHOWN && (
            <p className="mt-1 text-[11px] text-paper-muted">
              {t("music.more", { count: state.queue.length - QUEUE_SHOWN })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function QueueRow({
  track,
  index,
  last,
  mine,
}: {
  track: MusicTrack;
  index: number;
  last: boolean;
  mine: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={cn(
        "flex items-center gap-1.5 rounded-md px-1 py-0.5",
        mine && "bg-ink-3/40",
      )}
    >
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
          className="rounded p-0.5 text-paper-muted hover:bg-ink-3/70 hover:text-paper disabled:opacity-30"
        >
          <ChevronUp className="h-3 w-3" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={t("music.moveDown")}>
        <button
          type="button"
          disabled={last}
          onClick={() => moveInQueue(track.id, 1)}
          className="rounded p-0.5 text-paper-muted hover:bg-ink-3/70 hover:text-paper disabled:opacity-30"
        >
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={t("music.remove")}>
        <button
          type="button"
          onClick={() => removeFromQueue(track.id)}
          className="rounded p-0.5 text-paper-muted hover:bg-ink-3/70 hover:text-paper"
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
