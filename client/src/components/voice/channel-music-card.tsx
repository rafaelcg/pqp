import { Music, Pause, Play, SkipForward } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { ChannelMusicTrack } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { MarqueeText } from "@/components/ui/marquee-text";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import {
  advance,
  musicSkipVotesNeeded,
  setMusicOpen,
  setPlaying,
  useMusic,
  voteSkip,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";
import {
  getChannelMusicCardRights,
  subscribeChannelMusicCardRights,
} from "@/components/voice/channel-music-card-rights";

export type { ChannelMusicCardRights } from "@/components/voice/channel-music-card-rights";
export {
  getChannelMusicCardRights,
  resetChannelMusicCardRightsForTests,
  setChannelMusicCardRights,
} from "@/components/voice/channel-music-card-rights";

/**
 * What a voice channel is playing, as a small card under its occupants.
 *
 * Two audiences. Somebody IN this call who holds MANAGE_MUSIC gets
 * play/pause and skip. A seated member without that bit gets vote-skip.
 * Somebody outside it sees artwork, the title and an accent "Ouvir"
 * that joins the call.
 */

export function ChannelMusicCard({
  channelId,
  track,
  inCall,
  onJoin,
  canManageMusic,
  userId,
  roomSize,
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
  const music = useMusic();
  const published = useSyncExternalStore(
    subscribeChannelMusicCardRights,
    getChannelMusicCardRights,
    getChannelMusicCardRights,
  );
  const manage = canManageMusic ?? published.canManageMusic;
  const voterId = userId ?? published.userId;
  const size = roomSize ?? published.roomSize;
  const playing = inCall && music.channelId === channelId && music.state?.status === "playing";
  const skipVotes =
    music.channelId === channelId ? (music.state?.skipVotes ?? []) : [];
  const needed = musicSkipVotesNeeded(Math.max(1, size));
  const voted = voterId !== null && skipVotes.includes(voterId);
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
        <MarqueeText always text={track.title} className="w-full min-w-0 text-[11px] text-text" />
        {track.listeners != null && track.listeners > 0 ? (
          <span className="block truncate text-[10px] text-text-tertiary tabular-nums">
            {t("music.listening", { count: track.listeners })}
          </span>
        ) : null}
      </button>
      {inCall ? (
        manage ? (
          <>
            <Tooltip label={playing ? t("music.pause") : t("music.play")}>
              <button
                type="button"
                data-music-card-play=""
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
                data-music-card-skip=""
                className="rounded-[var(--radius-control)] p-0.5 text-text-secondary hover:bg-surface-3 hover:text-text"
                onClick={() => advance()}
              >
                <SkipForward className="h-3 w-3" aria-hidden="true" />
              </button>
            </Tooltip>
          </>
        ) : (
          <Tooltip
            label={t("music.voteSkip")}
            detail={t("music.voteSkip.hint", { needed })}
          >
            <button
              type="button"
              data-music-vote-skip=""
              className={cn(
                "rounded-[var(--radius-control)] p-0.5 text-text-secondary hover:bg-surface-3 hover:text-text",
                voted && "text-accent",
              )}
              disabled={voted || !voterId}
              aria-label={`${t("music.voteSkip")} ${t("music.voteSkip.count", { count: skipVotes.length, needed })}`}
              aria-pressed={voted}
              onClick={() => voteSkip(Math.max(1, size))}
            >
              <SkipForward className="h-3 w-3" aria-hidden="true" />
            </button>
          </Tooltip>
        )
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
