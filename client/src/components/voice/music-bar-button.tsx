import { Music } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { toggleMusicOpen, useMusic } from "@/lib/music-store";
import { cn } from "@/lib/utils";

/**
 * The music control on the call bar, beside camera and screen share: the
 * place people already look for "do something in this call". Lit while the
 * room has a track. A three-bar equaliser plays inside the button while
 * the room is playing.
 */
export function MusicBarButton({
  size,
  iconSize,
}: {
  size: string;
  iconSize: string;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const current = music.state?.current ?? null;
  const playing = music.state?.status === "playing";
  const label = current
    ? t("music.bar.playing", { title: current.title })
    : t("music.bar.start");
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-pressed={music.open}
        aria-label={label}
        data-music-bar-button=""
        className={cn(
          "relative flex items-center justify-center rounded-full",
          size,
          current || music.open
            ? "bg-accent-soft text-accent"
            : "bg-surface-2 text-text hover:bg-surface-3",
        )}
        onClick={() => toggleMusicOpen()}
      >
        {playing ? (
          <span className="music-eq" data-music-eq="" aria-hidden="true">
            <span className="music-eq-bar" />
            <span className="music-eq-bar" />
            <span className="music-eq-bar" />
          </span>
        ) : (
          <Music className={iconSize} />
        )}
      </button>
    </Tooltip>
  );
}
