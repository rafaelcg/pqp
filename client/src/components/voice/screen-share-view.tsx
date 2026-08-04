import { useEffect, useRef } from "react";
import { ScreenShareOff } from "lucide-react";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="flex max-h-[45%] min-h-[160px] shrink-0 flex-col border-b border-panel-hover bg-ink">
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
        <span className="truncate text-xs text-paper-muted">
          {isSelf ? "You are presenting" : `${presenterName} is presenting`}
        </span>
        {isSelf && onStopSharing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-2 text-[10px]"
            onClick={onStopSharing}
          >
            <ScreenShareOff className="h-3 w-3" aria-hidden="true" />
            Stop sharing
          </Button>
        )}
      </div>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="min-h-0 w-full flex-1 bg-black object-contain"
      />
    </div>
  );
}
