import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "@/lib/i18n";
import {
  MUSIC_DUCK_TICK_MS,
  musicShouldDuck,
  stepDuckGain,
} from "@/lib/music-duck";
import { relatedMusic } from "@/lib/api";
import {
  expectedPositionMs,
  fillAutoplayBuffer,
  markCurrentEnded,
  onTrackEnded,
  reportPosition,
  setPositionProbe,
  setSeekApply,
  shouldFillAutoplayBuffer,
  type MusicSnapshot,
} from "@/lib/music-store";
import {
  loadYouTubeIframeApi,
  YT_STATE,
  type YTPlayer,
} from "@/lib/youtube-iframe";
import { getMusicEmbedHost } from "@/components/voice/music-embed-host";

/**
 * The embed, and the loop that keeps it where the room is.
 *
 * `music` is read through a ref inside the interval so the loop is created
 * once per player rather than once per frame; the effects below react to the
 * two things that need an immediate answer, a new track and a play/pause.
 */

const DRIFT_MS = 2_500;
const REPORT_MS = 10_000;
const VOLUME_KEY = "pqp:music-volume";

/** Actor fills duration as soon as YouTube starts, not on the 10 s sample. */
export function shouldReportUnknownDuration(args: {
  isActor: boolean;
  trackId: string | null | undefined;
  durationMs: number | null | undefined;
  reportedTrackId: string | null;
}): boolean {
  return Boolean(
    args.isActor &&
      args.trackId &&
      args.durationMs == null &&
      args.reportedTrackId !== args.trackId,
  );
}

/**
 * Whether the embed should jump to the room's clock. A new snapshot
 * (a seek, an echo) uses this for everyone, including the person who
 * wrote it: they are the actor, and the 2 s tick otherwise leaves
 * their player where it was.
 */
export function playerNeedsRoomSeek(
  playerMs: number,
  expectedMs: number,
  driftMs = DRIFT_MS,
): boolean {
  return Math.abs(playerMs - expectedMs) > driftMs;
}

/**
 * What the mounted embed should do when the room's current track changes.
 * Stopping, not destroying, is how a second queue can start: tearing the
 * iframe down at the end of the first one is why YouTube sometimes never
 * calls onReady for the next player.
 */
export function musicEmbedCommand(
  videoId: string | null,
  status: "playing" | "paused",
): "stop" | "load" | "cue" {
  if (!videoId) {
    return "stop";
  }
  return status === "playing" ? "load" : "cue";
}

/**
 * Whether the drift/play effect should call `playVideo()`. YouTube replays
 * from the start when the player is ENDED; that is only correct for
 * repeat-one. A loaded id that is not the room's is the load effect's job.
 */
export function shouldCallPlayVideo(args: {
  status: "playing" | "paused";
  roomVideoId: string | null;
  loadedVideoId: string | null | undefined;
  playerState: number;
  repeat: "off" | "one" | "all";
}): boolean {
  if (args.status !== "playing" || !args.roomVideoId) {
    return false;
  }
  if (args.loadedVideoId && args.loadedVideoId !== args.roomVideoId) {
    return false;
  }
  if (args.playerState === YT_STATE.PLAYING || args.playerState === YT_STATE.BUFFERING) {
    return false;
  }
  if (args.playerState === YT_STATE.ENDED) {
    return args.repeat === "one";
  }
  return true;
}

/** ENDED for a video the room is not on, or with no id yet, must not advance. */
export function shouldAdvanceOnEnded(
  playingVideoId: string | undefined,
  roomVideoId: string | null | undefined,
): boolean {
  return Boolean(playingVideoId && roomVideoId && playingVideoId === roomVideoId);
}

export function shouldReportPositionSample(playerState: number): boolean {
  return playerState !== YT_STATE.ENDED;
}

/**
 * Whether MiniPlayer should keep `MusicPlayer` in the tree. Once a track
 * has mounted the iframe, an empty queue must not take it out: that
 * destroy/recreate is the start-end-start miss. Leaving the call or
 * "Parar de ouvir" still unmounts it.
 */
export function shouldKeepMusicEmbed(args: {
  inCall: boolean;
  listening: boolean;
  hasCurrent: boolean;
  previouslyHeld: boolean;
}): boolean {
  if (!args.inCall || !args.listening) {
    return false;
  }
  return args.hasCurrent || args.previouslyHeld;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readVolume(): number {
  const parsed = Number(readStored(VOLUME_KEY) ?? NaN);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 40;
}

export function MusicPlayer({
  music,
  isActor,
  volume,
  playerRef,
  onNeedsTap,
  duckEnabled = false,
  speakingPeerCount = 0,
  transmitting = false,
  deafened = false,
}: {
  music: MusicSnapshot;
  isActor: boolean;
  volume: number;
  playerRef: MutableRefObject<YTPlayer | null>;
  onNeedsTap: (needs: boolean) => void;
  duckEnabled?: boolean;
  speakingPeerCount?: number;
  transmitting?: boolean;
  deafened?: boolean;
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
  const durationReportedFor = useRef<string | null>(null);

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
              event.target.unMute();
              setPositionProbe(() => event.target.getCurrentTime() * 1000);
              setSeekApply((positionMs) => {
                event.target.unMute();
                event.target.seekTo(positionMs / 1000, true);
              });
              setReady(true);
            },
            onStateChange: (event) => {
              const snap = musicRef.current;
              if (event.data === YT_STATE.ENDED) {
                // Only the video the room is on. A late "ended" from the
                // video this player just left, or a transition with no id
                // yet, must not skip the new one.
                const current = snap.state?.current;
                let playing: string | undefined;
                try {
                  playing = event.target.getVideoData().video_id;
                } catch {
                  playing = undefined;
                }
                if (current && shouldAdvanceOnEnded(playing, current.videoId)) {
                  markCurrentEnded(current.id);
                  void onTrackEnded(current.id, isActorRef.current, async (id) => {
                    const { tracks } = await relatedMusic(id);
                    return tracks;
                  });
                }
              } else if (event.data === YT_STATE.PLAYING) {
                onNeedsTap(false);
                const current = snap.state?.current;
                if (
                  shouldReportUnknownDuration({
                    isActor: isActorRef.current,
                    trackId: current?.id,
                    durationMs: current?.durationMs,
                    reportedTrackId: durationReportedFor.current,
                  })
                ) {
                  let at = 0;
                  let duration = 0;
                  try {
                    at = event.target.getCurrentTime() * 1000;
                    duration = event.target.getDuration() * 1000;
                  } catch {
                    duration = 0;
                  }
                  if (duration > 0 && current) {
                    durationReportedFor.current = current.id;
                    reportPosition(at, duration);
                  }
                }
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
      setSeekApply(null);
      try {
        player?.destroy();
      } catch {
        // already gone
      }
      mount.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new track: load it where the room is. An empty queue stops this
  // iframe rather than unmounting it (`musicEmbedCommand`).
  useEffect(() => {
    const player = playerRef.current;
    if (!ready || !player) {
      return;
    }
    const command = musicEmbedCommand(videoId, status);
    if (command === "stop") {
      try {
        player.stopVideo();
      } catch {
        // empty player, already stopped
      }
      return;
    }
    setFailed(false);
    const seconds = expectedPositionMs(musicRef.current) / 1000;
    if (command === "load") {
      player.loadVideoById(videoId!, seconds);
    } else {
      player.cueVideoById(videoId!, seconds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, videoId, trackId]);

  const autoplayedQueued = music.state?.queue.filter((track) => track.autoplayed).length ?? 0;
  const autoplayOn = music.state?.autoplay === true;
  const repeatMode = music.state?.repeat ?? "off";
  const queueLength = music.state?.queue.length ?? 0;
  useEffect(() => {
    // Only the actor prefetches. Non-actors waiting 1.5s would stampede
    // InnerTube if the actor is slow or gone; ENDED still has that fallback.
    if (!isActor || !shouldFillAutoplayBuffer(musicRef.current.state)) {
      return;
    }
    void fillAutoplayBuffer(true, async (id) => {
      const { tracks } = await relatedMusic(id);
      return tracks;
    });
  }, [isActor, autoplayOn, repeatMode, trackId, autoplayedQueued, queueLength]);

  // Play or pause, and the drift loop.
  useEffect(() => {
    const player = playerRef.current;
    if (!ready || !player) {
      return;
    }
    let loaded: string | undefined;
    let ytState: number = YT_STATE.UNSTARTED;
    try {
      loaded = player.getVideoData().video_id;
      ytState = player.getPlayerState();
    } catch {
      // player not ready to read
    }
    const repeat = musicRef.current.state?.repeat ?? "off";
    if (
      shouldCallPlayVideo({
        status,
        roomVideoId: videoId,
        loadedVideoId: loaded,
        playerState: ytState,
        repeat,
      })
    ) {
      try {
        if (player.getVolume() > 0 && player.isMuted()) {
          player.unMute();
        }
      } catch {
        // volume read is best-effort
      }
      player.playVideo();
    } else if (status !== "playing" || !videoId) {
      try {
        player.pauseVideo();
      } catch {
        // empty player after stopVideo
      }
      try {
        const at = expectedPositionMs(musicRef.current);
        if (playerNeedsRoomSeek(player.getCurrentTime() * 1000, at)) {
          player.seekTo(at / 1000, true);
        }
      } catch {
        // player not ready to seek
      }
    }
    if (status !== "playing" || !videoId) {
      return;
    }
    // Autoplay can be refused until the page has a gesture. The button in
    // the panel is that gesture.
    const tapCheck = setTimeout(() => {
      const current = player.getPlayerState();
      if (current === YT_STATE.ENDED) {
        return;
      }
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
      let ytState: number = YT_STATE.UNSTARTED;
      try {
        ytState = player.getPlayerState();
      } catch {
        return;
      }
      if (!shouldReportPositionSample(ytState)) {
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
        let duration = 0;
        try {
          duration = player.getDuration() * 1000;
        } catch {
          duration = 0;
        }
        reportPosition(at, duration);
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

  const duckSpeech = musicShouldDuck({
    duckEnabled,
    deafened,
    speakingPeerCount,
    transmitting,
  });
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const speechRef = useRef(duckSpeech);
  speechRef.current = duckSpeech;
  const gainRef = useRef(1);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const apply = () => {
      playerRef.current?.setVolume(volumeRef.current * gainRef.current);
    };
    if (!duckEnabled) {
      gainRef.current = 1;
      apply();
      return;
    }
    const idle = !speechRef.current && gainRef.current >= 1;
    if (idle) {
      apply();
      return;
    }
    let last = Date.now();
    apply();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      gainRef.current = stepDuckGain(gainRef.current, speechRef.current, dt);
      apply();
      if (!speechRef.current && gainRef.current >= 1) {
        window.clearInterval(timer);
      }
    }, MUSIC_DUCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [ready, duckEnabled, duckSpeech, volume, playerRef]);

  const frame = (
    <div className="relative h-full w-full overflow-hidden bg-surface-0">
      <div
        ref={hostRef}
        className="absolute inset-0 [&>div]:h-full [&>div]:w-full [&_iframe]:h-full [&_iframe]:w-full"
      />
      {failed && (
        <p className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-text-tertiary">
          {t("music.error.playback")}
        </p>
      )}
    </div>
  );

  if (typeof document === "undefined") {
    return frame;
  }
  return createPortal(frame, getMusicEmbedHost());
}
