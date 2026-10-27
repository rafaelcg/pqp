import { MusicNotes } from "@phosphor-icons/react";
import { Music } from "lucide-react";
import type { ChannelMusicTrack } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { MarqueeText } from "@/components/ui/marquee-text";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
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
      className={cn(
        "group ml-2 mt-0.5 flex min-w-0 items-center gap-1.5 rounded-[var(--radius-card)] bg-surface-2 py-1 pl-1.5 pr-1 text-[11px] text-text ring-1 ring-border redesign:ml-5 redesign:gap-2 redesign:rounded-[var(--sidebar-card-radius)] redesign:bg-[color:var(--card-bg)] redesign:py-1.5 redesign:pl-1.5 redesign:pr-1.5 redesign:text-xs redesign:ring-[color:var(--card-border)]",
        // Keyboard focus on the title rings the whole card, as on a row.
        "redesign:has-[button:focus-visible]:ring-2 redesign:has-[button:focus-visible]:ring-inset redesign:has-[button:focus-visible]:ring-[color:var(--list-row-ring)]",
        // In the call the card opens the music, so it answers the pointer.
        inCall && "redesign:cursor-pointer redesign:hover:bg-[color:var(--card-row-hover)]",
      )}
    >
      <span className="relative h-6 w-6 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-3 redesign:flex redesign:h-7 redesign:w-7 redesign:items-center redesign:rounded-lg">
        {track.thumbnailUrl ? (
          <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <>
            <Music className="m-auto h-3 w-3 text-accent redesign:hidden" aria-hidden="true" />
            <Icon icon={MusicNotes} className="m-auto hidden h-3.5 w-3.5 text-accent-text redesign:block" />
          </>
        )}
      </span>
      <button
        type="button"
        className="min-w-0 flex-1 text-left redesign:focus-visible:outline-none"
        aria-label={inCall ? t("music.open") : t("music.sidebar.join", { title: track.title })}
        onClick={onTitleClick}
      >
        {/* A title that does not fit fades at the edge instead of cutting mid-letter. */}
        <MarqueeText text={track.title} className="w-full min-w-0 text-[11px] text-text redesign:text-xs redesign:font-medium redesign:data-[overflows]:[mask-image:linear-gradient(90deg,#000_85%,transparent)]" />
        {track.listeners != null && track.listeners > 0 ? (
          <span className="block truncate text-[10px] text-text-tertiary tabular-nums redesign:text-[11px]">
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
