import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2, ScreenShareOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  detectFullscreenMode,
  type FullscreenMode,
} from "@/components/voice/capabilities";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The Fullscreen API, spelled both ways.
 *
 * Safari only shipped the unprefixed names in 16.4; every Safari before that
 * has the whole thing under `webkit`, including the *event name*. Reading only
 * the standard names is what made the fullscreen button do nothing on a Mac:
 * `requestFullscreen` looked absent, so `detectFullscreenMode` fell through to
 * the iOS video-only path, and `webkitEnterFullscreen()` on a MediaStream-backed
 * <video> throws — into a `catch` that said nothing.
 *
 * iOS Safari has no Element.requestFullscreen under either name; the only
 * fullscreen it offers is the video element's own webkit method, which is what
 * the `video` mode below is for.
 */
interface WebkitFullscreenVideo extends HTMLVideoElement {
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
}

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface WebkitFullscreenDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

function fullscreenDocument(): WebkitFullscreenDocument {
  return document as WebkitFullscreenDocument;
}

/** Whatever is fullscreen right now, under either spelling. */
function currentFullscreenElement(): Element | null {
  const doc = fullscreenDocument();
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * Ask for fullscreen and *report the answer*.
 *
 * Both spellings return a promise that rejects when the browser refuses —
 * permissions policy, an iframe without `allowfullscreen`, a gesture the
 * browser did not count. The previous version threw that promise away with
 * `void`, which is the difference between "fullscreen is blocked here" and a
 * button that appears broken.
 */
async function requestElementFullscreen(element: HTMLElement): Promise<void> {
  const webkit = element as WebkitFullscreenElement;
  if (typeof element.requestFullscreen === "function") {
    await element.requestFullscreen();
    return;
  }
  if (typeof webkit.webkitRequestFullscreen === "function") {
    await webkit.webkitRequestFullscreen();
    return;
  }
  throw new Error("no element fullscreen API");
}

async function exitDocumentFullscreen(): Promise<void> {
  const doc = fullscreenDocument();
  if (typeof doc.exitFullscreen === "function") {
    await doc.exitFullscreen();
    return;
  }
  await doc.webkitExitFullscreen?.();
}

interface ScreenShareViewProps {
  stream: MediaStream | null;
  presenterName: string;
  isSelf: boolean;
  onStopSharing?: () => void;
}

export function ScreenShareView({
  stream,
  presenterName,
  isSelf,
  onStopSharing,
}: ScreenShareViewProps) {
  const { t } = useTranslation();
  const videoRef = useRef<WebkitFullscreenVideo>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // "none" until the refs exist. Starting pessimistic means the control is
  // never rendered before we know it would do something.
  const [fullscreenMode, setFullscreenMode] = useState<FullscreenMode>("none");
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    if (stream) {
      void video.play().catch(() => {
        // Autoplay can be blocked until the page has been interacted with;
        // sharing/joining is itself an interaction, so this is rare.
      });
    }
  }, [stream]);

  useEffect(() => {
    const doc = fullscreenDocument();
    setFullscreenMode(
      detectFullscreenMode({
        // Safari before 16.4 answers only to the prefixed name; `undefined`
        // here means "unknown", which the probe treats as permitted.
        documentFullscreenEnabled:
          typeof document === "undefined"
            ? undefined
            : (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled),
        requestFullscreen: containerRef.current?.requestFullscreen,
        webkitRequestFullscreen: (
          containerRef.current as WebkitFullscreenElement | null
        )?.webkitRequestFullscreen,
        webkitEnterFullscreen: videoRef.current?.webkitEnterFullscreen,
      }),
    );
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const onFullscreenChange = () => {
      setIsFullscreen(currentFullscreenElement() === containerRef.current);
    };
    const onBegin = () => setIsFullscreen(true);
    const onEnd = () => {
      setIsFullscreen(false);
      // iOS's native player detaches a MediaStream on the way out, leaving the
      // inline element rendering nothing — the reported "blank video after
      // coming back from fullscreen". Reattaching the same stream and playing
      // again is the documented recovery, and both calls are no-ops anywhere
      // the detach did not happen, so this is safe to run unconditionally.
      const video = videoRef.current;
      if (video && video.srcObject) {
        const current = video.srcObject;
        video.srcObject = null;
        video.srcObject = current;
        void video.play().catch(() => {
          // The user can tap the frame; the stream itself is intact.
        });
      }
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    // Safari before 16.4 fires only the prefixed event. Without this the
    // component never learns it is fullscreen, so the button keeps offering to
    // enter and the second click re-requests instead of exiting.
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    video?.addEventListener("webkitbeginfullscreen", onBegin);
    video?.addEventListener("webkitendfullscreen", onEnd);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener(
        "webkitfullscreenchange",
        onFullscreenChange,
      );
      video?.removeEventListener("webkitbeginfullscreen", onBegin);
      video?.removeEventListener("webkitendfullscreen", onEnd);
    };
  }, []);

  // A refusal is an answer, and the user has to get one. Cleared on the next
  // attempt so a browser that recovers stops apologising.
  useEffect(() => {
    if (!blocked) {
      return;
    }
    const timer = setTimeout(() => setBlocked(false), 6000);
    return () => clearTimeout(timer);
  }, [blocked]);

  const toggleFullscreen = useCallback(() => {
    setBlocked(false);
    if (fullscreenMode === "element") {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const active = currentFullscreenElement();
      const request = active
        ? exitDocumentFullscreen()
        : requestElementFullscreen(container);
      void request.catch((err: unknown) => {
        // The whole point of the change: a refused request used to be silent,
        // and "I clicked it and nothing happened" is not a report anyone can
        // act on.
        console.warn("[voice] fullscreen refused", err);
        setBlocked(true);
      });
      return;
    }
    if (fullscreenMode === "video") {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      try {
        if (video.webkitDisplayingFullscreen) {
          video.webkitExitFullscreen?.();
        } else {
          // Throws if metadata has not loaded yet, and on any <video> whose
          // `webkitSupportsFullscreen` is false — a MediaStream source is
          // exactly that case on some builds.
          video.webkitEnterFullscreen?.();
        }
      } catch (err) {
        console.warn("[voice] video fullscreen refused", err);
        setBlocked(true);
      }
    }
  }, [fullscreenMode]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex shrink-0 flex-col border-b border-panel-hover bg-ink",
        isFullscreen && fullscreenMode === "element"
          ? "h-screen max-h-none w-screen"
          : "max-h-[45%] min-h-[160px]",
      )}
    >
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
        <span className="truncate text-xs text-paper-muted">
          {isSelf
            ? t("voice.share.youPresenting")
            : t("voice.share.peerPresenting", { name: presenterName })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {blocked && (
            <span role="status" className="truncate text-[11px] text-paper-muted">
              {t("voice.share.fullscreenBlocked")}
            </span>
          )}
          {isSelf && onStopSharing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px]"
              onClick={onStopSharing}
            >
              <ScreenShareOff className="h-3 w-3" aria-hidden="true" />
              {t("voice.share.stop")}
            </Button>
          )}
          {/* Rendered only where it can actually do something — a button that
              silently no-ops is worse than no button. */}
          {fullscreenMode !== "none" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={
                isFullscreen
                  ? t("voice.share.exitFullscreen")
                  : t("voice.share.fullscreen")
              }
              aria-pressed={isFullscreen}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onDoubleClick={
            fullscreenMode === "none" ? undefined : toggleFullscreen
          }
          className="h-full w-full object-contain"
        />
        {!stream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-paper-muted">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            <span className="text-xs">{t("voice.share.waiting")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
