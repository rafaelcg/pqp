import { Music } from "lucide-react";
import type { ChannelMusicTrack } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { MarqueeText } from "@/components/ui/marquee-text";
import { useTranslation } from "@/lib/i18n";
import { setMusicOpen } from "@/lib/music-store";

export type { ChannelMusicCardRights } from "@/components/voice/channel-music-card-rights";
export {
  getChannelMusicCardRights,
  resetChannelMusicCardRightsForTests,
  setChannelMusicCardRights,
} from "@/components/voice/channel-music-card-rights";

/**
 * What a voice channel is playing, as a small card under its occupants.
 *
 * In the call: title and a note. Transport lives on the radio and in
 * Fila. Outside the call: artwork, title, and Ouvir to join.
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
  canManageMusic?: boolean;
  userId?: string | null;
  roomSize?: number;
}) {
  const { t } = useTranslation();
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
      className="group ml-2 mt-0.5 flex min-w-0 items-center gap-1.5 rounded-[var(--radius-card)] bg-surface-2 py-1 pl-1.5 pr-1 text-[11px] text-text ring-1 ring-border"
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
        <MarqueeText text={track.title} className="w-full min-w-0 text-[11px] text-text" />
        {track.listeners != null && track.listeners > 0 ? (
          <span className="block truncate text-[10px] text-text-tertiary tabular-nums">
            {t("music.listening", { count: track.listeners })}
          </span>
        ) : null}
      </button>
      {inCall ? null : (
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
