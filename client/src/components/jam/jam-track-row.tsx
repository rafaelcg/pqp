import type { JamTrack } from "@pqp/shared";
import { CircleMinus, CirclePlus, Ear, ThumbsUp, Trash2, Volume2, VolumeX } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { JamClock, JamLaneMix } from "@/hooks/use-jam-playback";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { cn } from "@/lib/utils";
import type { JamEngine } from "@/lib/jam";
import type { TrackPatch } from "@/lib/jam-take-edit";
import { JamLaneWave, type JamTimeline } from "./jam-lane-wave";
import { TrackAdjust } from "./jam-track-adjust";

/**
 * One track of an open song: who, on what, the waveform on the song's timeline,
 * and the listener's own mute, solo and volume (never sent anywhere). A take
 * that is one of several for its instrument also carries the vote, and the
 * song's author or a moderator gets the switch that puts it in or out of the
 * mix.
 */

export interface JamTrackRowProps {
  track: JamTrack;
  timeline: JamTimeline;
  clock: JamClock;
  lane: JamLaneMix;
  viewerId: string | null;
  /** More than one take exists for this instrument: show the vote. */
  competing: boolean;
  voted: boolean;
  canSwitchMix: boolean;
  canDelete: boolean;
  canVote: boolean;
  /** Being heard instead of the in-mix take of its instrument. */
  auditioning: boolean;
  /** This track's stem failed to load. */
  failed?: boolean;
  loading?: boolean;
  /** The take that just arrived: drops into place. */
  fresh?: boolean;
  onLane: (patch: Partial<JamLaneMix>) => void;
  onVote: () => void;
  onSwitchMix: () => void;
  /** The author's own track: "Ajustar" is drawn, and saves through this. */
  adjust?: { engine: JamEngine | null; onSave: (patch: TrackPatch) => Promise<void> };
  onDelete: () => void;
  onAudition: () => void;
}

export function JamTrackRow({
  track,
  timeline,
  clock,
  lane,
  viewerId,
  competing,
  voted,
  canSwitchMix,
  canDelete,
  canVote,
  auditioning,
  failed,
  loading,
  fresh,
  onLane,
  onVote,
  onSwitchMix,
  adjust,
  onDelete,
  onAudition,
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

  return (
    <li
      data-jam-track={track.id}
      data-in-mix={track.inMix ? "true" : "false"}
      className={cn(
        "@container flex flex-col gap-1 rounded-[var(--radius-card)] bg-surface-1 p-2.5",
        fresh && "jam-drop-in",
        outOfMix && !auditioning && "bg-transparent ring-1 ring-inset ring-border",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="relative shrink-0">
          <UserAvatar
            name={track.authorName ?? t("jam.tile.anonymous")}
            avatarUrl={track.authorAvatarUrl}
            rounded="full"
            className="h-8 w-8"
          />
          <span
            aria-hidden="true"
            className={cn(
              "absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center rounded-full ring-2 ring-surface-1",
              look.fill,
            )}
          >
            <Icon className="h-2.5 w-2.5" />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-bold text-text">
              {instrumentName}
              {track.label ? <span className="font-medium text-text-secondary"> · {track.label}</span> : null}
            </span>
            {outOfMix && (
              <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-px text-[10px] font-semibold text-text-tertiary">
                {t("jam.take.out")}
              </span>
            )}
          </span>
          <span className="truncate text-xs text-text-secondary">{person}</span>
        </span>

        {outOfMix && (
          <Tooltip label={auditioning ? t("jam.take.stopListening") : t("jam.take.listen")}>
            <button
              type="button"
              aria-pressed={auditioning}
              onClick={onAudition}
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus-ring",
                auditioning ? "bg-accent text-on-accent" : "text-text-secondary",
              )}
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
                "flex h-10 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-bold tabular-nums outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50",
                voted ? "bg-accent-soft text-on-accent-soft" : "text-text-secondary",
              )}
            >
              <ThumbsUp className="h-4 w-4" aria-hidden />
              <span>{track.voteCount}</span>
            </button>
          </Tooltip>
        )}

        {canSwitchMix && (
          <Tooltip label={track.inMix ? t("jam.take.takeOut") : t("jam.take.useThis")}>
            <button
              type="button"
              onClick={onSwitchMix}
              data-jam-mix-switch=""
              aria-pressed={track.inMix}
              className={cn(
                "flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring @max-[22rem]:w-10 @max-[22rem]:px-0",
                track.inMix
                  ? "bg-surface-2 text-text hover:bg-border"
                  : "bg-accent text-on-accent hover:bg-accent-hover",
              )}
            >
              {track.inMix ? <CircleMinus className="h-4 w-4 @[22rem]:hidden" aria-hidden /> : <CirclePlus className="h-4 w-4 @[22rem]:hidden" aria-hidden />}
              <span className="@max-[22rem]:hidden">{track.inMix ? t("jam.take.takeOut") : t("jam.take.useThis")}</span>
            </button>
          </Tooltip>
        )}

        {canDelete && (
          <Tooltip label={t("jam.take.delete")}>
            <button
              type="button"
              onClick={onDelete}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-tertiary outline-none transition-colors hover:bg-surface-2 hover:text-danger focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="relative mb-0.5">
        <JamLaneWave
          instrument={track.instrument}
          peaks={track.peaks}
          timing={track}
          timeline={timeline}
          clock={heard ? clock : undefined}
          seed={track.id}
          dimmed={lane.muted || (outOfMix && !auditioning)}
        />
        {(loading || failed) && (
          <span
            role={failed ? "alert" : "status"}
            className="absolute inset-0 grid place-items-center rounded-[var(--radius-control)] bg-surface-0/70 text-xs font-semibold text-text"
          >
            {failed ? t("jam.song.stemError") : t("jam.song.loadingTrack")}
          </span>
        )}
      </div>
      {heard && (
        <div className="flex items-center gap-1.5">
          <Tooltip label={lane.muted ? t("jam.lane.unmute", { name }) : t("jam.lane.mute", { name })}>
            <button
              type="button"
              aria-pressed={lane.muted}
              onClick={() => onLane({ muted: !lane.muted })}
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus-ring",
                lane.muted ? "bg-surface-2 text-warning" : "text-text-secondary",
              )}
            >
              {lane.muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
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
            className="min-w-0 flex-1"
          />
          <Tooltip label={lane.solo ? t("jam.lane.unsolo", { name }) : t("jam.lane.solo", { name })}>
            <button
              type="button"
              aria-pressed={lane.solo}
              onClick={() => onLane({ solo: !lane.solo })}
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] text-xs font-extrabold outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus-ring",
                lane.solo ? "bg-accent text-on-accent" : "text-text-secondary",
              )}
            >
              <span aria-hidden>S</span>
            </button>
          </Tooltip>
        </div>
      )}
      {adjust && <TrackAdjust track={track} engine={adjust.engine} onSave={adjust.onSave} />}
    </li>
  );
}
