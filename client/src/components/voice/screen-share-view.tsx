import { useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2, ScreenShareOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

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
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerRef.current?.requestFullscreen();
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex shrink-0 flex-col border-b border-panel-hover bg-ink",
        isFullscreen
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
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onDoubleClick={toggleFullscreen}
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
