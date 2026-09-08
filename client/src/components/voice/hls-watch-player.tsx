import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { PictureInPicture2, Radio } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import {
  chooseHlsEngine,
  isAutoplayRefusal,
  isOwnHlsPlaylistProxyUrl,
  setHlsPlaybackStats,
} from "@/lib/hls-playback";
import {
  buildMediaSessionMetadata,
  hasSafariPresentationMode,
  isBehindLive,
  isPipAvailable,
} from "@/lib/hls-live-edge";
import { getAuthToken } from "@/lib/api";
import { cn } from "@/lib/utils";

/** hls.js instance shape this file actually touches. */
interface HlsHandle {
  destroy: () => void;
  liveSyncPosition: number | null;
  media: HTMLMediaElement | null;
}

/** Safari's non-standard presentation-mode video element. */
interface SafariPipVideo extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture") => void;
  webkitPresentationMode?: "inline" | "picture-in-picture" | "fullscreen";
}

/**
 * HLS playlist for a LiveKit egress screen share.
 *
 * Safari plays MPEG-TS natively. Everyone else uses hls.js. The picture is
 * 8–12 s behind the presenter; that is the product, not a bug, and the
 * badge says so.
 */
export function HlsWatchPlayer({
  src,
  delaySeconds = 10,
  className,
  videoRef,
  onDoubleClick,
  mediaTitle,
  communityName,
  coverUrl,
}: {
  src: string;
  delaySeconds?: number;
  className?: string;
  videoRef?: RefObject<HTMLVideoElement | null>;
  onDoubleClick?: () => void;
  /** Party/presenter title for the lock screen and the tab. */
  mediaTitle?: string;
  /** Server or community name, shown as the lock screen's subtitle. */
  communityName?: string | null;
  /** Server icon, used as lock-screen artwork when nothing better exists. */
  coverUrl?: string | null;
}) {
  const { t } = useTranslation();
  const innerRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<HlsHandle | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  // Autoplay with sound was refused (a tab that resumed the call without a
  // click, Safari's default). The picture runs muted and one tap fixes it.
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [pipAvailable, setPipAvailable] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [behindLive, setBehindLive] = useState(false);

  useEffect(() => {
    setHasFrame(false);
    setNeedsUnmute(false);
    setHlsPlaybackStats(null);
  }, [src]);

  const getVideo = useCallback(
    () => videoRef?.current ?? innerRef.current,
    [videoRef],
  );

  const jumpToLive = useCallback(() => {
    const video = getVideo();
    if (!video) {
      return;
    }
    const hls = hlsRef.current;
    const liveEdge = hls?.liveSyncPosition ?? video.duration;
    if (Number.isFinite(liveEdge)) {
      video.currentTime = liveEdge as number;
    }
  }, [getVideo]);

  // Behind-live polling. `timeupdate` fires roughly 4x/s, which is plenty
  // for a badge nobody needs to the millisecond.
  useEffect(() => {
    const video = getVideo();
    if (!video) {
      return;
    }
    const check = () => {
      const hls = hlsRef.current;
      const liveEdge = hls?.liveSyncPosition ?? video.duration;
      if (!Number.isFinite(liveEdge)) {
        setBehindLive(false);
        return;
      }
      setBehindLive(isBehindLive(video.currentTime, liveEdge as number));
    };
    video.addEventListener("timeupdate", check);
    check();
    return () => video.removeEventListener("timeupdate", check);
  }, [getVideo, src]);

  // Picture-in-Picture: standard API where it exists, Safari's
  // presentation-mode fallback otherwise. Neither is relied on to
  // auto-trigger; both are a single explicit tap.
  useEffect(() => {
    const video = getVideo() as SafariPipVideo | null;
    if (!video) {
      setPipAvailable(false);
      return;
    }
    const standard = isPipAvailable({
      pictureInPictureEnabled: Boolean(document.pictureInPictureEnabled),
      disablePictureInPicture: video.disablePictureInPicture,
    });
    const safari = hasSafariPresentationMode(video);
    setPipAvailable(standard || safari);

    const onEnterPip = () => setIsPip(true);
    const onLeavePip = () => setIsPip(false);
    const onPresentationChange = () => {
      setIsPip(video.webkitPresentationMode === "picture-in-picture");
    };
    video.addEventListener("enterpictureinpicture", onEnterPip);
    video.addEventListener("leavepictureinpicture", onLeavePip);
    video.addEventListener(
      "webkitpresentationmodechanged",
      onPresentationChange,
    );
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnterPip);
      video.removeEventListener("leavepictureinpicture", onLeavePip);
      video.removeEventListener(
        "webkitpresentationmodechanged",
        onPresentationChange,
      );
    };
  }, [getVideo, src, hasFrame]);

  const togglePip = useCallback(async () => {
    const video = getVideo() as SafariPipVideo | null;
    if (!video) {
      return;
    }
    try {
      if (
        document.pictureInPictureEnabled &&
        !video.disablePictureInPicture
      ) {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
        return;
      }
      if (video.webkitSetPresentationMode) {
        const next =
          video.webkitPresentationMode === "picture-in-picture"
            ? "inline"
            : "picture-in-picture";
        video.webkitSetPresentationMode(next);
      }
    } catch {
      // A refused PiP request (no user gesture reached it, or the platform
      // said no) leaves the inline picture playing, which is fine.
    }
  }, [getVideo]);

  // Media Session: what the lock screen and hardware media keys show and
  // do. Only meaningful once we actually have a frame, so a dead stream
  // never claims to be "playing pqp" on someone's lock screen.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !hasFrame) {
      return;
    }
    const video = getVideo();
    navigator.mediaSession.metadata = new MediaMetadata(
      buildMediaSessionMetadata({
        title: mediaTitle ?? "pqp",
        communityName,
        coverUrl,
      }),
    );
    navigator.mediaSession.setActionHandler("play", () => {
      void video?.play();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      video?.pause();
    });
    try {
      // Not in every TS lib.dom version; guarded by the try/catch and the
      // `"seektolive" in` style check isn't reliable across browsers, so we
      // just swallow an unsupported-action exception.
      navigator.mediaSession.setActionHandler(
        // @ts-expect-error -- "seektolive" is a valid MediaSessionAction the
        // TS DOM lib does not list yet.
        "seektolive",
        jumpToLive,
      );
    } catch {
      // Not supported here; the on-screen "Pular pro ao vivo" button covers it.
    }
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      try {
        // @ts-expect-error -- see above.
        navigator.mediaSession.setActionHandler("seektolive", null);
      } catch {
        // ignore
      }
    };
  }, [hasFrame, mediaTitle, communityName, coverUrl, getVideo, jumpToLive]);

  useEffect(() => {
    const el = videoRef?.current ?? innerRef.current;
    if (!el) {
      return;
    }
    const video: HTMLVideoElement = el;
    let cancelled = false;
    let hls: HlsHandle | null = null;

    // `xhrSetup` runs synchronously (hls.js calls it, then `xhr.send()`,
    // with no await in between), so the token has to already be in hand --
    // an async read inside `xhrSetup` would set the header after the
    // request already went out. Kept fresh by polling well inside a Clerk
    // token's usual lifetime; a request that lands right after an unnoticed
    // expiry gets a 401 and the manifest retry policy above tries again.
    let authToken: string | null = null;
    const refreshAuthToken = () => {
      void getAuthToken().then((token) => {
        if (!cancelled) {
          authToken = token;
        }
      });
    };
    refreshAuthToken();
    const authTokenTimer = window.setInterval(refreshAuthToken, 30_000);

    const reportSize = () => {
      if (cancelled || video.videoWidth === 0 || video.videoHeight === 0) {
        return;
      }
      setHlsPlaybackStats({
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    const onPlaying = () => {
      if (!cancelled) {
        setHasFrame(true);
        reportSize();
      }
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("loadedmetadata", reportSize);

    // A refused play() is a paused element behind the "loading" overlay
    // forever, not an error event. Retry muted so the picture at least
    // shows, and offer the sound back with a tap.
    async function play() {
      try {
        await video.play();
      } catch (error) {
        if (cancelled || !isAutoplayRefusal(error)) {
          return;
        }
        video.muted = true;
        try {
          await video.play();
          if (!cancelled) {
            setNeedsUnmute(true);
          }
        } catch {
          // Still refused even muted; the user can tap the frame.
        }
      }
    }

    async function attach() {
      // hls.js first, whenever MSE exists. Chrome answers "maybe" to the
      // native probe and then never plays; see `chooseHlsEngine`.
      const { default: Hls } = await import("hls.js");
      if (cancelled) {
        return;
      }
      const engine = chooseHlsEngine({
        nativeHls: video.canPlayType("application/vnd.apple.mpegurl"),
        mseSupported: Hls.isSupported(),
      });
      if (engine === "native") {
        video.src = src;
        void play();
        return;
      }
      if (engine === "none") {
        return;
      }
      const player = new Hls({
        liveSyncDurationCount: 3,
        enableWorker: true,
        // Playlist is written after the first 2 s segment. Retry the
        // initial 404 instead of giving up while egress is still starting.
        manifestLoadingMaxRetry: 12,
        manifestLoadingRetryDelay: 1000,
        manifestLoadingMaxRetryTimeout: 8000,
        // Every segment/media URL hls.js loads is already an absolute,
        // presigned bucket URL (the signed playlist proxy rewrites them
        // that way) -- only the playlist request itself is our own API,
        // and only that one gets a Bearer header. Attaching it to every
        // request would leak the token to R2. hls.js calls this
        // synchronously per XHR; the token is read from the in-memory
        // Clerk-backed cache `getAuthToken` keeps, not fetched fresh here.
        //
        // The header is belt and braces now: the playlist URL carries its
        // own per-viewer token (`?t=`, see `hls-viewer-token.ts` on the
        // server) which authorizes the request on its own. That is what
        // lets the native `<video src>` path below and `useLiveHlsReady`'s
        // plain `fetch` work, since neither can set a header.
        xhrSetup: (xhr, url) => {
          if (isOwnHlsPlaylistProxyUrl(url) && authToken) {
            xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
          }
        },
      });
      hls = player as unknown as HlsHandle;
      hlsRef.current = hls;
      player.loadSource(src);
      player.attachMedia(video);
      player.on(Hls.Events.MANIFEST_PARSED, () => {
        void play();
      });
    }

    void attach();
    return () => {
      cancelled = true;
      window.clearInterval(authTokenTimer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("loadedmetadata", reportSize);
      hls?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
      setHlsPlaybackStats(null);
    };
  }, [src, videoRef]);

  return (
    <div className={cn("relative h-full w-full bg-black", className)}>
      <video
        ref={(node) => {
          innerRef.current = node;
          if (videoRef) {
            (videoRef as MutableRefObject<HTMLVideoElement | null>).current =
              node;
          }
        }}
        className="h-full w-full"
        autoPlay
        playsInline
        onDoubleClick={onDoubleClick}
      />
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5">
        {behindLive ? (
          <button
            type="button"
            className="pointer-events-auto flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-paper hover:bg-black/90"
            onClick={jumpToLive}
          >
            <Radio className="h-3 w-3" />
            {t("voice.hls.jumpToLive")}
          </button>
        ) : (
          <span className="flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-paper">
            <Radio className="h-3 w-3 text-red-400" />
            {t("voice.hls.live")}
          </span>
        )}
        <span className="rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-paper">
          {t("voice.hls.delay", { seconds: delaySeconds })}
        </span>
      </div>
      {pipAvailable && hasFrame ? (
        <button
          type="button"
          aria-label={t("voice.hls.pip")}
          aria-pressed={isPip}
          className="absolute right-2 top-2 rounded bg-black/70 p-1 text-paper opacity-0 transition-opacity hover:bg-black/90 focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
          onClick={() => void togglePip()}
        >
          <PictureInPicture2 className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {!hasFrame ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-paper-muted">
          {t("voice.hls.buffering")}
        </div>
      ) : null}
      {hasFrame && needsUnmute ? (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-sm font-medium text-paper hover:bg-black/90"
          onClick={() => {
            const el = videoRef?.current ?? innerRef.current;
            if (el) {
              el.muted = false;
            }
            setNeedsUnmute(false);
          }}
        >
          {t("voice.hls.unmute")}
        </button>
      ) : null}
    </div>
  );
}
