import { useEffect, useRef } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Per-peer playback volume and a Retry when the connection has failed.
 *
 * Same control the old lobby tiles carried. Hover-revealed at 100% so a quiet
 * tile stays a face; stays put when the slider is not at unity, because a
 * silenced person is a state you need to see without hunting.
 */
export function PeerTileControls({
  name,
  volume,
  onSetVolume,
  failed = false,
  onRetry,
  alwaysOpen = false,
  className,
}: {
  name: string;
  volume?: number;
  onSetVolume?: (volume: number) => void;
  failed?: boolean;
  onRetry?: () => void;
  /** Skip the hover-collapse; the parent already hides this until needed. */
  alwaysOpen?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const silenced = volume === 0;
  const restoreRef = useRef(1);

  useEffect(() => {
    if (volume !== undefined && volume > 0) {
      restoreRef.current = volume;
    }
  }, [volume]);

  if (failed && onRetry) {
    return (
      <div className={cn("relative z-20", className)}>
        <Button
          variant="secondary"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={onRetry}
        >
          {t("voice.tile.retry")}
        </Button>
      </div>
    );
  }

  if (!onSetVolume || volume === undefined || failed) {
    return null;
  }

  return (
    <div
      className={cn(
        "relative z-20 grid w-full min-w-[7rem] transition-[grid-template-rows] duration-150",
        volume === 1 && !alwaysOpen
          ? "grid-rows-[0fr] group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr]"
          : "grid-rows-[1fr]",
        className,
      )}
    >
      <div className="overflow-hidden">
        <div className="flex items-center gap-1 pt-1">
          <Tooltip
            label={
              silenced
                ? t("voice.tile.unmutePeer", { name })
                : t("voice.tile.mutePeer", { name })
            }
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              aria-pressed={silenced}
              onClick={() => onSetVolume(silenced ? restoreRef.current : 0)}
            >
              {silenced ? (
                <VolumeX className="h-3.5 w-3.5 text-danger" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </Tooltip>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            aria-label={t("voice.tile.volumeFor", { name })}
            aria-valuetext={t("voice.tile.volumePercent", {
              percent: Math.round(volume * 100),
            })}
            onChange={(event) => onSetVolume(Number(event.target.value))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-signal"
          />
        </div>
      </div>
    </div>
  );
}
