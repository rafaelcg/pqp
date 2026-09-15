import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  advance,
  expectedPositionMs,
  reportPosition,
  setPositionProbe,
  type MusicSnapshot,
} from "@/lib/music-store";
import {
  loadYouTubeIframeApi,
  YT_STATE,
  type YTPlayer,
} from "@/lib/youtube-iframe";

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
}: {
  music: MusicSnapshot;
  isActor: boolean;
  volume: number;
  playerRef: MutableRefObject<YTPlayer | null>;
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
                // Only the video the room is on. A late "ended" from the
                // video this player just left must not skip the new one.
                const current = snap.state?.current;
                let playing: string | undefined;
                try {
                  playing = event.target.getVideoData().video_id;
                } catch {
                  playing = undefined;
                }
                if (current && (playing === undefined || playing === current.videoId)) {
                  advance(current.id);
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

  useEffect(() => {
    playerRef.current?.setVolume(volume);
  }, [volume, playerRef, ready]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-card)] bg-surface-0">
      <div ref={hostRef} className="absolute inset-0 [&>div]:h-full [&>div]:w-full [&_iframe]:h-full [&_iframe]:w-full" />
      {failed && (
        <p className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-text-tertiary">
          {t("music.error.playback")}
        </p>
      )}
    </div>
  );
}
