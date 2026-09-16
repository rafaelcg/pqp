import { Music } from "lucide-react";
import { MarqueeText } from "@/components/ui/marquee-text";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { toggleMusicOpen, useMusic } from "@/lib/music-store";
import { cn } from "@/lib/utils";
import type { VoiceState } from "@/hooks/use-voice";

/**
 * WHAT IS PLAYING, ON THE CALL STRIP.
 *
 * One line: a note and the title, and "+N" for the queue. Every control
 * lives in the player at the bottom of the sidebar, which is where a
 * browser keeps its media controls; this line only says what is on, and a
 * click on it unfolds the queue down there.
 */
export function MusicDock({
  voiceState,
  compact = false,
  className,
}: {
  voiceState: VoiceState;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const inCall = voiceState.status === "connected" && voiceState.voiceChannelId !== null;
  const current = music.state?.current ?? null;

  if (!inCall || !current) {
    return null;
  }

  return (
    <div
      data-music-dock={compact ? "compact" : "stage"}
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-[11px] text-text-secondary",
        compact ? "flex-1" : "max-w-[28rem] shrink-0",
        className,
      )}
    >
      <Tooltip label={t("music.open")}>
        <button
          type="button"
          aria-pressed={music.open}
          onClick={() => toggleMusicOpen()}
          className="group flex min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-0.5 text-accent hover:bg-surface-2"
        >
          <Music className="h-3 w-3 shrink-0" aria-hidden="true" />
          <MarqueeText
            text={current.title}
            always={compact}
            className="min-w-0 flex-1 text-[11px] text-accent"
          />
        </button>
      </Tooltip>
      {music.state && music.state.queue.length > 0 && (
        <span className="tabular-nums">
          {t("music.more", { count: music.state.queue.length })}
        </span>
      )}
    </div>
  );
}
