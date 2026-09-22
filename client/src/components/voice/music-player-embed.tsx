import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { MUSIC_MAX_DURATION_MS } from "@pqp/shared";
import { createPortal } from "react-dom";
import { useTranslation } from "@/lib/i18n";
import {
  MUSIC_DUCK_TICK_MS,
  duckedMusicVolume,
  musicShouldDuck,
  stepDuckGain,
} from "@/lib/music-duck";
import { musicRelatedTracks } from "@/lib/music-related";
import {
  expectedPositionMs,
  fillAutoplayBuffer,
  clearCurrentEnded,
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
export const MUSIC_VOLUME_KEY = "pqp:music-volume";

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

/** One parser for the slider and for onReady. Default 40. */
export function readMusicVolume(): number {
  const parsed = Number(readStored(MUSIC_VOLUME_KEY) ?? NaN);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 40;
}

export function writeMusicVolume(value: number): void {
  const next = Math.min(100, Math.max(0, value));
  writeStored(MUSIC_VOLUME_KEY, String(next));
}

type VolumeTarget = {
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
};

/**
 * Duck with `setVolume` only. Mute is YouTube `mute()`, never volume 0.
 * This function does not `unMute`: ads and the play loop must not lift it.
 */
export function applyYouTubeVolume(
  player: VolumeTarget | null | undefined,
  args: { volume: number; muted: boolean; duckGain: number },
): void {
  if (!player) {
    return;
  }
  const volume = Math.min(100, Math.max(0, args.volume));
  if (args.muted) {
    player.setVolume(volume);
    player.mute();
    return;
  }
  player.setVolume(duckedMusicVolume(volume, args.duckGain));
}

/** Actor fills duration as soon as YouTube starts, not on the 10 s sample. */
/**
 * `getVideoData().isLive` is undocumented and absent on older embeds, so
 * this answers `undefined` rather than guessing, and the ceiling in
 * `reportableDurationMs` is what actually holds the line.
 */
function playerIsLive(player: YTPlayer): boolean | undefined {
  try {
    return player.getVideoData?.()?.isLive;
  } catch {
    return undefined;
  }
}

/**
 * WHAT THE PLAYER SAYS THE TRACK IS, WHEN IT IS A TRACK AT ALL.
 *
 * `getDuration()` on a 24/7 live mix answers with how long the STREAM has
 * been up. One of those reached a room as 1209:42:45 and the bar drew a
 * seek against fifty days; the same number is the other operand of the
 * end-of-track gate, so nothing would ever have advanced on its own
 * either. `isLive` comes off `getVideoData()`, which is not part of the
 * documented iframe API, so the ceiling backs it up rather than trusting
 * it. Null means "still unknown", which is what the room already knows how
 * to draw.
 */
export function reportableDurationMs(
  rawMs: number,
  isLive: boolean | undefined,
): number | null {
  if (isLive) {
    return null;
  }
  if (!Number.isFinite(rawMs) || rawMs <= 0 || rawMs > MUSIC_MAX_DURATION_MS) {
    return null;
  }
  return rawMs;
}

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
 * THE PLAYER IS ON A VIDEO THE ROOM IS NOT ON.
 *
 * The load effect fires on a change of track, and a change it misses (a
 * frame this client dropped, a `loadVideoById` YouTube swallowed, an error
 * mid-load) used to last for the rest of the session: the tick read the
 * loaded id, `shouldCallPlayVideo` returned false because it disagreed, and
 * nothing put it right, while the drift loop went on seeking the WRONG
 * video to the room's clock. On 22 Sep 2026 the bar read Toto and the
 * picture was another song, in sync, for as long as anybody watched.
 *
 * So the check is also a repair: see `reloadRoomTrack`. An unloaded player
 * (no id yet) is not wrong, and a room with nothing on is the stop path.
 */
export function playerIsOnWrongVideo(
  loadedVideoId: string | null | undefined,
  roomVideoId: string | null,
): boolean {
  if (!loadedVideoId || !roomVideoId) {
    return false;
  }
  return loadedVideoId !== roomVideoId;
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

export function MusicPlayer({
  music,
  isActor,
  volume,
  muted = false,
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
  muted?: boolean;
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
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
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
              applyYouTubeVolume(event.target, {
                volume: readMusicVolume(),
                muted: mutedRef.current,
                duckGain: 1,
              });
              setPositionProbe(() => event.target.getCurrentTime() * 1000);
              setSeekApply((positionMs) => {
                event.target.seekTo(positionMs / 1000, true);
              });
              setReady(true);
            },
            onStateChange: (event) => {
              const snap = musicRef.current;
              if (
                event.data === YT_STATE.BUFFERING ||
                event.data === YT_STATE.CUED
              ) {
                clearCurrentEnded(snap.state?.current?.id);
              }
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
                  void onTrackEnded(
                    current.id,
                    isActorRef.current,
                    musicRelatedTracks,
                  );
                }
              } else if (event.data === YT_STATE.PLAYING) {
                onNeedsTap(false);
                /*
                 * Out of ENDED, so this machine's player is not at the end
                 * any more and the mark is stale. The store clears it when
                 * the ROOM restarts a track; this clears it when only the
                 * player did, which the room never announces.
                 */
                clearCurrentEnded(snap.state?.current?.id);
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
                  let duration: number | null = null;
                  try {
                    at = event.target.getCurrentTime() * 1000;
                    duration = reportableDurationMs(
                      event.target.getDuration() * 1000,
                      playerIsLive(event.target),
                    );
                  } catch {
                    duration = null;
                  }
                  if (duration !== null && current) {
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

  /**
   * Put this iframe on the room's track, at the room's position.
   *
   * Called on a change of track, and again by the tick whenever the player
   * is found on something else (`playerIsOnWrongVideo`). The second caller
   * is the repair: a missed edge used to last the whole session.
   */
  const loadRoomTrack = useCallback(
    (player: YTPlayer, id: string, playing: boolean) => {
      setFailed(false);
      const seconds = expectedPositionMs(musicRef.current) / 1000;
      if (playing) {
        player.loadVideoById(id, seconds);
      } else {
        player.cueVideoById(id, seconds);
      }
    },
    [],
  );

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
    loadRoomTrack(player, videoId!, command === "load");
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
    void fillAutoplayBuffer(true, musicRelatedTracks);
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
    if (playerIsOnWrongVideo(loaded, videoId)) {
      // The room moved on and this iframe did not. Put it back before the
      // drift loop below starts seeking the wrong song to the room's clock.
      loadRoomTrack(player, videoId!, status === "playing");
      return;
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
      // The one check that makes this loop self-healing: seeking a video
      // the room is not on is worse than doing nothing.
      let playing: string | undefined;
      try {
        playing = player.getVideoData().video_id;
      } catch {
        playing = undefined;
      }
      const roomVideoId = snap.state?.current?.videoId ?? null;
      if (playerIsOnWrongVideo(playing, roomVideoId)) {
        loadRoomTrack(player, roomVideoId!, true);
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
        let duration: number | null = null;
        try {
          duration = reportableDurationMs(
            player.getDuration() * 1000,
            playerIsLive(player),
          );
        } catch {
          duration = null;
        }
        reportPosition(at, duration ?? undefined);
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
    const player = playerRef.current;
    if (!ready || !player) {
      return;
    }
    if (muted) {
      player.mute();
    } else {
      player.unMute();
    }
  }, [ready, muted, playerRef]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const apply = () => {
      applyYouTubeVolume(playerRef.current, {
        volume: volumeRef.current,
        muted: mutedRef.current,
        duckGain: gainRef.current,
      });
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
  }, [ready, duckEnabled, duckSpeech, volume, muted, playerRef]);

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
