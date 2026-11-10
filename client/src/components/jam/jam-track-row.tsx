import type { JamTrack } from "@pqp/shared";
import { CirclePlus, Ear, Headphones, MoreHorizontal, SlidersHorizontal, ThumbsUp, Trash2, Volume2, VolumeX, CircleMinus } from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";
import { Menu } from "@/components/ui/menu";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import type { JamClock, JamLaneMix } from "@/hooks/use-jam-playback";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { cn } from "@/lib/utils";
import { JamLaneWave, type JamTimeline } from "./jam-lane-wave";

/**
 * One lane of the band: who, on what, and their take as a clip on the song's
 * timeline, lined up with every other lane under one playhead. The lane head
 * carries the listener's own mute, solo and volume (never sent anywhere); a
 * take that competes with another for its instrument carries the vote and the
 * "ouvir no lugar" audition; the song's author gets "usar este take"; the
 * take's own author gets "Ajustar". Rarer actions sit in the lane's menu.
 */

export interface JamTrackRowProps {
  track: JamTrack;
  timeline: JamTimeline;
  clock: JamClock;
  lane: JamLaneMix;
  viewerId: string | null;
  index: number;
  /** More than one take exists for this instrument: show the vote. */
  competing: boolean;
  voted: boolean;
  canSwitchMix: boolean;
  canDelete: boolean;
  canVote: boolean;
  /** Being heard instead of the in-mix take of its instrument. */
  auditioning: boolean;
  failed?: boolean;
  loading?: boolean;
  /** The take that just arrived: drops into place. */
  fresh?: boolean;
  /** This viewer's own take: "Ajustar" is offered. */
  canAdjust: boolean;
  adjusting: boolean;
  onLane: (patch: Partial<JamLaneMix>) => void;
  onVote: () => void;
  onSwitchMix: () => void;
  onAdjust: () => void;
  onDelete: () => void;
  onAudition: () => void;
  onSeek: (fraction: number) => void;
  /** The take has a video in the mix: drawn at the lane head, kept on the audio clock. */
  attachVideo?: (trackId: string, element: HTMLVideoElement) => () => void;
}

const LANE_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-secondary outline-none transition-colors duration-[var(--duration-fast)] hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring";

export function JamTrackRow({
  track,
  timeline,
  clock,
  lane,
  viewerId,
  index,
  competing,
  voted,
  canSwitchMix,
  canDelete,
  canVote,
  auditioning,
  failed,
  loading,
  fresh,
  canAdjust,
  adjusting,
  onLane,
  onVote,
  onSwitchMix,
  onAdjust,
  onDelete,
  onAudition,
  onSeek,
  attachVideo,
}: JamTrackRowProps) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[track.instrument];
  const Icon = look.icon;
  const instrumentName = t(look.nameKey as MessageKey);
  const mine = viewerId !== null && track.authorId === viewerId;
  const person = mine ? t("jam.lane.you") : (track.authorName ?? t("jam.tile.anonymous"));
  const name = `${instrumentName}, ${person}`;
  const outOfMix = !track.inMix;
  const heard = track.inMix || auditioning;

  const menu: ContextMenuItemDef[] = [
    ...(canSwitchMix && track.inMix
      ? [{ id: "take-out", label: t("jam.take.takeOut"), icon: CircleMinus, onSelect: onSwitchMix }]
      : []),
    ...(canDelete ? [{ id: "delete", label: t("jam.take.delete"), icon: Trash2, danger: true, onSelect: onDelete }] : []),
  ];

  return (
    <li
      data-jam-track={track.id}
      data-in-mix={track.inMix ? "true" : "false"}
      style={{ "--jam-l": index } as CSSProperties}
      className={cn(
        "group/lane flex flex-col gap-2 sm:grid sm:grid-cols-[var(--lane-head)_minmax(0,1fr)] sm:items-center sm:gap-3 rounded-[var(--radius-card)] p-1.5 transition-colors duration-[var(--duration-fast)] hover:bg-surface-2/60",
        fresh ? "jam-drop-in" : "jam-lane-in",
        adjusting && "bg-surface-2/60",
      )}
    >
      {/* the lane head */}
      <div className="flex min-w-0 items-center justify-between gap-2 sm:flex-col sm:items-stretch sm:justify-start sm:gap-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative shrink-0">
            {attachVideo && track.videoUrl ? (
              <LaneVideo track={track} attach={attachVideo} muted={lane.muted} label={name} />
            ) : (
              <UserAvatar
                name={track.authorName ?? t("jam.tile.anonymous")}
                avatarUrl={track.authorAvatarUrl}
                rounded="full"
                className={cn("h-9 w-9", outOfMix && !auditioning && "opacity-60")}
              />
            )}
            <span
              aria-hidden="true"
              className={cn("absolute -bottom-1 -right-1 grid h-[18px] w-[18px] place-items-center rounded-full ring-2 ring-surface-1", look.fill)}
            >
              <Icon className="h-2.5 w-2.5" />
            </span>
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("truncate text-sm font-extrabold", outOfMix && !auditioning ? "text-text-secondary" : "text-text")}>
                {instrumentName}
              </span>
              {outOfMix && (
                <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-px text-[10px] font-bold text-text-secondary">
                  {t("jam.take.out")}
                </span>
              )}
            </span>
            <span className="truncate text-xs text-text-secondary">
              {person}
              {track.label ? ` · ${track.label}` : ""}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {heard && (
            <>
              <Tooltip label={lane.muted ? t("jam.lane.unmute", { name }) : t("jam.lane.mute", { name })}>
                <button
                  type="button"
                  aria-pressed={lane.muted}
                  onClick={() => onLane({ muted: !lane.muted })}
                  data-jam-mute=""
                  className={cn(LANE_BUTTON, lane.muted && "bg-warning-soft text-on-warning-soft hover:bg-warning-soft hover:text-on-warning-soft")}
                >
                  {lane.muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
                </button>
              </Tooltip>
              <Tooltip label={lane.solo ? t("jam.lane.unsolo", { name }) : t("jam.lane.solo", { name })}>
                <button
                  type="button"
                  aria-pressed={lane.solo}
                  onClick={() => onLane({ solo: !lane.solo })}
                  data-jam-solo=""
                  className={cn(LANE_BUTTON, lane.solo && "bg-accent text-on-accent hover:bg-accent hover:text-on-accent")}
                >
                  <Headphones className="h-4 w-4" aria-hidden />
                </button>
              </Tooltip>
              <Slider
                variant="volume"
                min={0}
                max={150}
                step={1}
                value={Math.round(lane.volume * 100)}
                onValueChange={(value) => onLane({ volume: value / 100 })}
                aria-label={t("jam.lane.volume", { name })}
                className="mx-1 min-w-0 flex-1 max-sm:hidden"
              />
            </>
          )}
          {outOfMix && (
            <Tooltip label={auditioning ? t("jam.take.stopListening") : t("jam.take.listen")}>
              <button
                type="button"
                aria-pressed={auditioning}
                onClick={onAudition}
                className={cn(LANE_BUTTON, auditioning && "bg-accent text-on-accent hover:bg-accent hover:text-on-accent")}
              >
                <Ear className="h-4 w-4" aria-hidden />
              </button>
            </Tooltip>
          )}
          {competing && (
            <Tooltip label={voted ? t("jam.take.unvote") : t("jam.take.vote")}>
              <button
                type="button"
                aria-pressed={voted}
                disabled={!canVote}
                onClick={onVote}
                data-jam-vote=""
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-bold tabular-nums outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50",
                  voted ? "bg-accent-soft text-on-accent-soft" : "text-text-secondary",
                )}
              >
                <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
                <span>{track.voteCount}</span>
              </button>
            </Tooltip>
          )}
          {menu.length > 0 && (
            <Menu items={menu} align="start">
              <button type="button" aria-label={t("jam.lane.more", { name })} data-jam-lane-menu="" className={cn(LANE_BUTTON, "ml-auto")}>
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
            </Menu>
          )}
        </div>
      </div>

      {/* the take on the song's timeline */}
      <div className="relative min-w-0">
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="block w-full cursor-pointer"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onSeek((event.clientX - box.left) / Math.max(1, box.width));
          }}
        >
          <JamLaneWave
            instrument={track.instrument}
            peaks={track.peaks}
            timing={track}
            timeline={timeline}
            clock={heard ? clock : undefined}
            seed={track.id}
            dimmed={lane.muted || (outOfMix && !auditioning)}
            className="h-14"
          />
        </button>
        {(loading || failed) && (
          <span
            role={failed ? "alert" : "status"}
            className="absolute inset-0 grid place-items-center rounded-[var(--radius-control)] bg-surface-0/70 text-xs font-semibold text-text"
          >
            {failed ? t("jam.song.stemError") : t("jam.song.loadingTrack")}
          </span>
        )}
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-1">
          {canSwitchMix && outOfMix && (
            <button
              type="button"
              onClick={onSwitchMix}
              data-jam-mix-switch=""
              aria-pressed={false}
              className="pointer-events-auto flex h-8 items-center gap-1 rounded-full bg-accent px-3 text-xs font-bold text-on-accent shadow-[var(--shadow-2)] outline-none transition-[background,transform] hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-[0.96]"
            >
              <CirclePlus className="h-3.5 w-3.5" aria-hidden />
              {t("jam.take.useThis")}
            </button>
          )}
          {canAdjust && !adjusting && (
            <button
              type="button"
              onClick={onAdjust}
              data-jam-adjust-open={track.id}
              className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full bg-on-inst px-3 text-xs font-bold text-on-media shadow-[var(--shadow-2)] outline-none transition-[opacity,transform] duration-[var(--duration-fast)] hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
              {t("jam.take.adjust")}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** A take's video at its lane head: small, muted, kept on the audio clock by the engine. */
function LaneVideo({
  track,
  attach,
  muted,
  label,
}: {
  track: JamTrack;
  attach: (trackId: string, element: HTMLVideoElement) => () => void;
  muted: boolean;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    return attach(track.id, element);
  }, [attach, track.id]);
  return (
    <video
      ref={ref}
      src={track.videoUrl ?? undefined}
      muted
      playsInline
      preload="metadata"
      aria-label={label}
      data-jam-lane-video=""
      className={cn(
        "h-9 w-16 rounded-[var(--radius-control)] bg-surface-0 object-cover ring-1 ring-inset ring-border transition-opacity duration-[var(--duration-base)]",
        muted && "opacity-40",
      )}
    />
  );
}
