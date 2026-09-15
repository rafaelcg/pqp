import { Maximize2, Minimize2 } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { setMusicPlacement } from "@/lib/music-prefs";
import { cn } from "@/lib/utils";
import { MusicEmbedOutlet } from "@/components/voice/music-embed-host";
import { lookupAddedBy } from "@/components/voice/music-now-playing";
import type { VoiceState } from "@/hooks/use-voice";

export const MUSIC_STAGE_TILE_ID = "music-stage";

export type MusicStageTileKind = { kind: "music"; id: typeof MUSIC_STAGE_TILE_ID };

/**
 * Put the music tile in the featured/solo slot unless something else is
 * already featured (a pin, or the one screen a crowded room is watching).
 */
export function insertMusicStageTile<T extends { id: string }>(
  tiles: T[],
  featured: boolean,
  on: boolean,
): { tiles: Array<T | MusicStageTileKind>; featured: boolean } {
  if (!on) {
    return { tiles, featured };
  }
  const music: MusicStageTileKind = {
    kind: "music",
    id: MUSIC_STAGE_TILE_ID,
  };
  if (tiles.length === 0) {
    return { tiles: [music], featured: false };
  }
  if (featured) {
    return { tiles: [tiles[0]!, music, ...tiles.slice(1)], featured: true };
  }
  return { tiles: [music, ...tiles], featured: true };
}

export function MusicStageTile({
  title,
  addedByUserId,
  addedByName,
  voiceState,
  home,
  isFullscreen,
  clickToFullscreen,
  onToggleFullscreen,
  className,
}: {
  title: string;
  addedByUserId: string;
  addedByName: string;
  voiceState: VoiceState;
  home?: RefObject<HTMLElement | null>;
  isFullscreen?: boolean;
  clickToFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const addedBy = lookupAddedBy(voiceState, addedByUserId, addedByName);
  const fullscreenLabel = isFullscreen
    ? t("voice.share.exitFullscreen")
    : t("voice.share.fullscreen");

  return (
    <div
      data-music-stage-tile=""
      className={cn(
        "group relative flex h-full w-full items-center justify-center overflow-hidden bg-surface-0",
        className,
      )}
    >
      <div className="relative aspect-video max-h-full w-full overflow-hidden bg-surface-1">
        <MusicEmbedOutlet home={home} />
        {clickToFullscreen && onToggleFullscreen ? (
          <button
            type="button"
            data-testid="tile-click-target"
            aria-label={fullscreenLabel}
            className="absolute inset-0 z-[1] cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
            onClick={onToggleFullscreen}
          />
        ) : null}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-2 bg-gradient-to-t from-surface-0/90 to-transparent p-2">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-text">{title}</p>
            <p className="truncate text-[11px] text-text-secondary">
              {t("music.addedBy", { name: addedBy.name })}
            </p>
          </div>
          <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setMusicPlacement("panel")}
            >
              {t("music.stage.dock")}
            </Button>
            {onToggleFullscreen ? (
              <Tooltip label={fullscreenLabel} side="top">
                <button
                  type="button"
                  data-testid="music-stage-fullscreen"
                  aria-pressed={isFullscreen}
                  aria-label={fullscreenLabel}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-0/80 text-text hover:bg-surface-2"
                  onClick={onToggleFullscreen}
                >
                  {isFullscreen ? (
                    <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
