import { Music, Pause, Play, SkipForward } from "lucide-react";
import type { ChannelMusicTrack } from "@pqp/shared";
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
 * (the same writes the popover makes) and a click on the title opens the
 * queue. Somebody outside it sees the title and a click joins the call,
 * because "they're listening to Legião" is the reason to walk in.
 *
 * A title longer than the card scrolls (`MarqueeText`).
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
      className="ml-2 mt-0.5 flex items-center gap-1.5 rounded-md bg-ink-2/80 py-1 pl-2 pr-1 text-[11px] text-signal ring-1 ring-ink-4/60"
    >
      <Music className="h-3 w-3 shrink-0" aria-hidden="true" />
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        aria-label={inCall ? t("music.open") : t("music.sidebar.join", { title: track.title })}
        onClick={onTitleClick}
      >
        <MarqueeText text={track.title} />
      </button>
      {inCall && (
        <>
          <Tooltip label={playing ? t("music.pause") : t("music.play")}>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-ink-3/70"
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
              className="rounded p-0.5 hover:bg-ink-3/70"
              onClick={() => advance()}
            >
              <SkipForward className="h-3 w-3" aria-hidden="true" />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}
