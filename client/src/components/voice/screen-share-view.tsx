import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2, ScreenShareOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  detectFullscreenMode,
  type FullscreenMode,
} from "@/components/voice/capabilities";
import { cn } from "@/lib/utils";

/**
 * iOS Safari has no Element.requestFullscreen; the only fullscreen it offers is
 * the video element's own webkit method. These are the non-standard members we
 * fall back to there.
 */
interface WebkitFullscreenVideo extends HTMLVideoElement {
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
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
  const videoRef = useRef<WebkitFullscreenVideo>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // "none" until the refs exist. Starting pessimistic means the control is
  // never rendered before we know it would do something.
  const [fullscreenMode, setFullscreenMode] = useState<FullscreenMode>("none");

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
    setFullscreenMode(
      detectFullscreenMode({
        documentFullscreenEnabled:
          typeof document === "undefined"
            ? undefined
            : document.fullscreenEnabled,
        requestFullscreen: containerRef.current?.requestFullscreen,
        webkitEnterFullscreen: videoRef.current?.webkitEnterFullscreen,
      }),
    );
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    const onBegin = () => setIsFullscreen(true);
    const onEnd = () => setIsFullscreen(false);

    document.addEventListener("fullscreenchange", onFullscreenChange);
    video?.addEventListener("webkitbeginfullscreen", onBegin);
    video?.addEventListener("webkitendfullscreen", onEnd);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      video?.removeEventListener("webkitbeginfullscreen", onBegin);
      video?.removeEventListener("webkitendfullscreen", onEnd);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (fullscreenMode === "element") {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void containerRef.current?.requestFullscreen();
      }
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
          // Throws if metadata has not loaded yet; the caller sees the frame
          // stay put rather than an error, and a second tap works.
          video.webkitEnterFullscreen?.();
        }
      } catch {
        // No fullscreen this time; nothing is broken.
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
          {isSelf ? "You are presenting" : `${presenterName} is presenting`}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {isSelf && onStopSharing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px]"
              onClick={onStopSharing}
            >
              <ScreenShareOff className="h-3 w-3" aria-hidden="true" />
              Stop sharing
            </Button>
          )}
          {/* Rendered only where it can actually do something — a button that
              silently no-ops is worse than no button. */}
          {fullscreenMode !== "none" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={isFullscreen ? "Exit fullscreen" : "View fullscreen"}
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
            <span className="text-xs">Connecting to presenter's screen…</span>
          </div>
        )}
      </div>
    </div>
  );
}
