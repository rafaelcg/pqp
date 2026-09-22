/**
 * The YouTube IFrame Player API, loaded once.
 *
 * The script is the only external code the music dock needs; the video and
 * audio stream from YouTube to each participant directly. There is no CSP
 * on the SPA today (see `docs/DISCORD_GAPS.md` on the theme boot script), so
 * this is a plain script tag; if one is added, `www.youtube.com` needs
 * `script-src` and `frame-src`.
 */

export interface YTPlayer {
  loadVideoById(videoId: string, startSeconds?: number): void;
  cueVideoById(videoId: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(volume: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  /**
   * `isLive` is not in YouTube's documented surface but every current embed
   * answers it, and a 24/7 mix's `getDuration()` is its stream uptime
   * rather than a track length. Optional on purpose: the bound in
   * `reportableDurationMs` is what holds when it is missing.
   */
  getVideoData(): { video_id?: string; isLive?: boolean };
  destroy(): void;
}

export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId?: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YTPlayer }) => void;
        onStateChange?: (event: { data: number; target: YTPlayer }) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;

export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (loading) {
    return loading;
  }
  loading = new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) {
        resolve(window.YT);
      } else {
        loading = null;
        reject(new Error("YouTube IFrame API did not initialise"));
      }
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error("YouTube IFrame API failed to load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}
