import { Music, Pause, Play, SkipForward } from "lucide-react";
import type { ChannelMusicTrack } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { MarqueeText } from "@/components/ui/marquee-text";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import {
  advance,
  setMusicOpen,
  setPlaying,
  useMusic,
} from "@/lib/music-store";

/**
 * What a voice channel is playing, as a small card under its occupants.
 *
 * Two audiences. Somebody IN this call gets play/pause and skip on the card
 * (the same writes the panel makes) and a click on the title opens the
 * queue. Somebody outside it sees artwork, the title and an accent "Ouvir"
 * that joins the call.
 */
export function ChannelMusicCard({
  channelId,
  track,
  inCall,
  onJoin,
}: {
  channelId: string;
  track: ChannelMusicTrack;
  inCall: boolean;
  onJoin?: () => void;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const playing = inCall && music.channelId === channelId && music.state?.status === "playing";
  const onTitleClick = () => {
    if (inCall) {
      setMusicOpen(true);
    } else {
      onJoin?.();
    }
  };

  return (
    <div
      data-channel-music={channelId}
      className="ml-2 mt-0.5 flex items-center gap-1.5 rounded-[var(--radius-card)] bg-surface-2 py-1 pl-1.5 pr-1 text-[11px] text-text ring-1 ring-border"
    >
      <span className="relative h-6 w-6 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-3">
        {track.thumbnailUrl ? (
          <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Music className="m-auto h-3 w-3 text-accent" aria-hidden="true" />
        )}
      </span>
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        aria-label={inCall ? t("music.open") : t("music.sidebar.join", { title: track.title })}
        onClick={onTitleClick}
      >
        <MarqueeText text={track.title} always />
      </button>
      {inCall ? (
        <>
          <Tooltip label={playing ? t("music.pause") : t("music.play")}>
            <button
              type="button"
              className="rounded-[var(--radius-control)] p-0.5 text-text-secondary hover:bg-surface-3 hover:text-text"
              onClick={() => setPlaying(!playing)}
            >
              {playing ? (
                <Pause className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Play className="h-3 w-3" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
          <Tooltip label={t("music.skip")}>
            <button
              type="button"
              className="rounded-[var(--radius-control)] p-0.5 text-text-secondary hover:bg-surface-3 hover:text-text"
              onClick={() => advance()}
            >
              <SkipForward className="h-3 w-3" aria-hidden="true" />
            </button>
          </Tooltip>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          className="h-6 shrink-0 px-2 text-[11px]"
          onClick={() => onJoin?.()}
        >
          {t("music.listen")}
        </Button>
      )}
    </div>
  );
}
