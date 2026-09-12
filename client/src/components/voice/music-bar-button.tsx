import { Music } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { toggleMusicOpen, useMusic } from "@/lib/music-store";
import { cn } from "@/lib/utils";

/**
 * The music control on the call bar, beside camera and screen share: the
 * place people already look for "do something in this call". Lit while the
 * room has a track. Opens the queue popover that `MusicDock` draws.
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
          "flex items-center justify-center rounded-full",
          size,
          current || music.open
            ? "bg-signal/20 text-signal"
            : "bg-ink-3 text-paper hover:bg-ink-4",
        )}
        onClick={() => toggleMusicOpen()}
      >
        <Music className={iconSize} />
      </button>
    </Tooltip>
  );
}
