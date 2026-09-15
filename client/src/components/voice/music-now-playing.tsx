import { Music, Pause, Play, SkipForward } from "lucide-react";
import { useEffect, useState } from "react";
import type { MusicTrack, VoiceParticipant } from "@pqp/shared";
import { MarqueeText } from "@/components/ui/marquee-text";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import { expectedPositionMs, type MusicSnapshot } from "@/lib/music-store";
import { cn } from "@/lib/utils";

export const ghostIconButton =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text";

export function formatMusicClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

export function musicRoomPeople(voiceState: VoiceState): VoiceParticipant[] {
  const channelId = voiceState.voiceChannelId;
  const room = channelId ? (voiceState.occupancy[channelId] ?? []) : [];
  const self = voiceState.self;
  if (self && !room.some((person) => person.peerId === self.peerId)) {
    return [...room, self];
  }
  return room;
}

export function lookupAddedBy(
  voiceState: VoiceState,
  userId: string,
  fallbackName: string,
): { name: string; avatarUrl: string | null } {
  const person = musicRoomPeople(voiceState).find((entry) => entry.userId === userId);
  return {
    name: person?.displayName ?? fallbackName,
    avatarUrl: person?.avatarUrl ?? null,
  };
}

export function lookupActorName(voiceState: VoiceState, peerId: string | null): string | null {
  if (!peerId) {
    return null;
  }
  return musicRoomPeople(voiceState).find((entry) => entry.peerId === peerId)?.displayName ?? null;
}

export function formatMusicClockOrUnknown(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) {
    return "–:––";
  }
  return formatMusicClock(ms);
}

/** ~4 fps while playing. Elapsed still ticks when duration is unknown. */
export function usePlaybackProgress(music: MusicSnapshot, durationMs: number | null) {
  const playing = music.state?.status === "playing";
  const known = durationMs !== null && durationMs > 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = 0;
    let last = 0;
    const tick = (stamp: number) => {
      if (stamp - last >= 250) {
        last = stamp;
        setNow(Date.now());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, music.receivedAt]);

  const position = Math.max(0, expectedPositionMs(music, now));
  const capped = known ? Math.min(position, durationMs) : position;
  const ratio = known ? Math.min(1, capped / durationMs) : 0;
  return { position: capped, durationMs, ratio, known };
}

export function MusicNowPlaying({
  current,
  music,
  voiceState,
  canManage,
  playing,
  needsTap,
  onExpand,
  onPlayPause,
  onSkip,
  onTapToPlay,
}: {
  current: MusicTrack;
  music: MusicSnapshot;
  voiceState: VoiceState;
  canManage: boolean;
  playing: boolean;
  needsTap: boolean;
  onExpand: () => void;
  onPlayPause: () => void;
  onSkip: () => void;
  onTapToPlay: () => void;
}) {
  const { t } = useTranslation();
  const addedBy = lookupAddedBy(voiceState, current.addedByUserId, current.addedByName);
  const progress = usePlaybackProgress(music, current.durationMs);
  const expandLabel = music.open ? t("music.collapse") : t("music.expand");

  return (
    <div data-music-now-playing="" className="relative flex items-center gap-2.5 px-2 py-2">
      {progress.known && (
        <div
          className="absolute inset-x-0 top-0 z-10 h-0.5 bg-accent/30"
          role="progressbar"
          aria-label={t("music.progress")}
          aria-valuemin={0}
          aria-valuemax={Math.round(progress.durationMs ?? 0)}
          aria-valuenow={Math.round(progress.position)}
        >
          <div className="h-full bg-accent" style={{ width: `${progress.ratio * 100}%` }} />
        </div>
      )}
      <button
        type="button"
        className="relative h-11 w-11 shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-surface-2"
        aria-expanded={music.open}
        aria-label={expandLabel}
        onClick={onExpand}
      >
        {current.thumbnailUrl ? (
          <img src={current.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Music className="m-auto h-4 w-4 text-accent" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        aria-expanded={music.open}
        aria-label={expandLabel}
        onClick={onExpand}
      >
        <MarqueeText text={current.title} className="text-[13px] font-medium leading-tight text-text" />
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-tight text-text-secondary">
          <UserAvatar
            name={addedBy.name}
            avatarUrl={addedBy.avatarUrl}
            className="h-3.5 w-3.5"
            fallbackClassName="bg-accent-soft text-[9px] text-on-accent-soft"
            rounded="full"
          />
          <span className="truncate">{addedBy.name}</span>
        </span>
      </button>
      {needsTap ? (
        <button
          type="button"
          className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-accent px-3 text-[11px] font-semibold text-on-accent"
          onClick={onTapToPlay}
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          {t("music.tapToPlay")}
        </button>
      ) : (
        <Tooltip
          label={playing ? t("music.pause") : t("music.play")}
          detail={canManage ? undefined : t("music.noManage")}
        >
          <button
            type="button"
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent",
              canManage ? "hover:bg-accent-hover" : "opacity-40",
            )}
            aria-pressed={playing}
            aria-disabled={!canManage || undefined}
            onClick={() => {
              if (canManage) {
                onPlayPause();
              }
            }}
          >
            {playing ? (
              <Pause className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Play className="ml-0.5 h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </Tooltip>
      )}
      <Tooltip label={t("music.skip")} detail={canManage ? undefined : t("music.noManage")}>
        <button
          type="button"
          className={cn(ghostIconButton, !canManage && "opacity-40")}
          aria-disabled={!canManage || undefined}
          onClick={() => {
            if (canManage) {
              onSkip();
            }
          }}
        >
          <SkipForward className="h-4 w-4" aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}
