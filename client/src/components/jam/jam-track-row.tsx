import type { JamTrack } from "@pqp/shared";
import { CircleMinus, CirclePlus, Ear, Flag, Headphones, MoreHorizontal, SlidersHorizontal, ThumbsUp, Trash2 } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Menu } from "@/components/ui/menu";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import type { JamClock, JamLaneMix } from "@/hooks/use-jam-playback";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { volumeDelta } from "@/lib/jam-clip";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { cn } from "@/lib/utils";
import { JamLaneFrame, JamLaneIdentity } from "./jam-lane-frame";
import { JamLaneWave, type JamTimeline } from "./jam-lane-wave";

/**
 * One lane of the band: who, on what, and their recording as a clip on the
 * song's timeline, lined up with every other lane.
 *
 * The layout is `JamLaneFrame`'s, the one the studio's review uses too: on a
 * wide band one line (the instrument and the person, the waveform, the
 * controls), on a narrow one two (the identity with the controls, then the
 * waveform). Every control is an icon with a tooltip and a name for a screen
 * reader, in the same place in every row, the viewer's own row included, and
 * nothing is ever drawn over the name.
 *
 * The lane controls (mute, "only this", volume) are the listener's own and are
 * drawn as one cluster whose headphones icon says so; the level the author saved
 * (inside "Ajustar") is a different thing, shown here only as a static label. A
 * recording that competes with another for its instrument carries the vote and
 * the audition; the song's author gets "usar esta gravação"; the recording's own
 * author gets "Ajustar". Rarer actions sit in the lane's menu. A recording's
 * video is not here: the song's stage above the lanes shows it.
 */

export interface JamTrackRowProps {
  track: JamTrack;
  timeline: JamTimeline;
  clock: JamClock;
  lane: JamLaneMix;
  viewerId: string | null;
  index: number;
  /** More than one recording exists for this instrument: show the vote. */
  competing: boolean;
  voted: boolean;
  canSwitchMix: boolean;
  canDelete: boolean;
  canVote: boolean;
  /** Being heard instead of the in-mix recording of its instrument. */
  auditioning: boolean;
  failed?: boolean;
  loading?: boolean;
  /** The recording that just arrived: drops into place. */
  fresh?: boolean;
  /** Another lane is soloed ("only this"): this one, unless it is soloed too, is dimmed. */
  othersSoloed?: boolean;
  /** This viewer's own recording: "Ajustar" is offered. */
  canAdjust: boolean;
  /** Keep the empty slot of "Ajustar" in a lane that has none, so the controls line up with the lane that does. */
  reserveAdjust?: boolean;
  adjusting: boolean;
  /** The adjust editor, drawn right under this lane while it is open. */
  editor?: ReactNode;
  onLane: (patch: Partial<JamLaneMix>) => void;
  onVote: () => void;
  onSwitchMix: () => void;
  onAdjust: () => void;
  onDelete: () => void;
  onAudition: () => void;
  /** A public jam, somebody else's part: "Denunciar essa parte" in the lane's menu. */
  onReport?: () => void;
  onSeek: (fraction: number) => void;
}

/** 32 px with a pointer, 44 px under a finger. */
export const LANE_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-secondary outline-none transition-colors duration-[var(--duration-fast)] hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11 pointer-coarse:w-11";

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
  othersSoloed = false,
  canAdjust,
  reserveAdjust = true,
  adjusting,
  editor,
  onLane,
  onVote,
  onSwitchMix,
  onAdjust,
  onDelete,
  onAudition,
  onReport,
  onSeek,
}: JamTrackRowProps) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[track.instrument];
  const instrumentName = t(look.nameKey as MessageKey);
  const mine = viewerId !== null && track.authorId === viewerId;
  const person = mine ? t("jam.lane.you") : (track.authorName ?? t("jam.tile.anonymous"));
  const name = `${instrumentName}, ${person}`;
  const outOfMix = !track.inMix;
  // The author's SAVED volume for this recording, said on its own lane when it is not the recorded level.
  // A fact about the recording, not a control: the listener's own volume is the slider.
  const gainWords = volumeDelta(track.gain);
  const heard = track.inMix || auditioning;
  // Somebody else is soloed: this lane sits back so the soloed one stands out.
  const soloDimmed = othersSoloed && !lane.solo;
  const who = `${person}${track.label ? ` · ${track.label}` : ""}`;

  const menu: ContextMenuItemDef[] = [
    ...(canSwitchMix && track.inMix
      ? [{ id: "take-out", label: t("jam.take.takeOut"), icon: CircleMinus, onSelect: onSwitchMix }]
      : []),
    ...(onReport ? [{ id: "report", label: t("jam.public.menu.reportPart"), icon: Flag, onSelect: onReport }] : []),
    ...(canDelete ? [{ id: "delete", label: t("jam.take.delete"), icon: Trash2, danger: true, onSelect: onDelete }] : []),
  ];

  // "Ajustar": an icon in the controls, never a pill beside the name. The word is its tooltip.
  const adjustButton = canAdjust ? (
    <Tooltip label={t("jam.take.adjust")}>
      <button
        type="button"
        onClick={onAdjust}
        aria-pressed={adjusting}
        aria-label={t("jam.take.adjustMine")}
        data-jam-adjust-open={track.id}
        className={cn(LANE_BUTTON, adjusting && "bg-text text-surface-0 hover:bg-text hover:text-surface-0")}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden />
      </button>
    </Tooltip>
  ) : reserveAdjust ? (
    // the slot is kept in every row, so the controls end at the same place in all of them
    <span aria-hidden="true" className="h-8 w-8 shrink-0 pointer-coarse:h-11 pointer-coarse:w-11" />
  ) : null;

  const controls = (
    <>
      {/* an alternate take (or a competing one) keeps its audition, vote and "use this" whether or not it is being heard: an audition has to be stoppable from the lane it plays in */}
      {(outOfMix || competing) && (
        <div data-jam-lane-actions="" className="flex items-center gap-0.5">
          {outOfMix && (
            <Tooltip label={auditioning ? t("jam.take.stopListening") : t("jam.take.listen")}>
              <button
                type="button"
                aria-pressed={auditioning}
                aria-label={auditioning ? t("jam.take.stopListening") : t("jam.take.listen")}
                onClick={onAudition}
                data-jam-audition=""
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
                aria-label={voted ? t("jam.take.unvote") : t("jam.take.vote")}
                disabled={!canVote}
                onClick={onVote}
                data-jam-vote=""
                className={cn(
                  LANE_BUTTON,
                  "w-auto gap-1 px-2 text-xs font-bold tabular-nums disabled:opacity-50 pointer-coarse:w-auto",
                  voted && "bg-accent-soft text-on-accent-soft hover:bg-accent-soft hover:text-on-accent-soft",
                )}
              >
                <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
                <span>{track.voteCount}</span>
              </button>
            </Tooltip>
          )}
          {canSwitchMix && outOfMix && (
            <Tooltip label={t("jam.take.useThis")}>
              <button
                type="button"
                onClick={onSwitchMix}
                data-jam-mix-switch=""
                aria-pressed={false}
                aria-label={t("jam.take.useThis")}
                className={cn(LANE_BUTTON, "bg-accent text-on-accent hover:bg-accent hover:text-on-accent active:scale-[0.94]")}
              >
                <CirclePlus className="h-4 w-4" aria-hidden />
              </button>
            </Tooltip>
          )}
        </div>
      )}
      {heard && (
        // One cluster, and it is only for the listener: nothing here is sent anywhere.
        <div role="group" aria-label={t("jam.lane.mineOnly")} data-jam-lane-mix="" className="flex items-center gap-0.5 rounded-full bg-surface-2 pl-1 pr-1.5">
          <Tooltip label={t("jam.lane.mineNote")}>
            <span
              tabIndex={0}
              role="img"
              aria-label={t("jam.lane.mineNote")}
              data-jam-mine-note=""
              className="grid h-8 w-6 shrink-0 place-items-center rounded-full text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11"
            >
              <Headphones className="h-3.5 w-3.5" aria-hidden />
            </span>
          </Tooltip>
          <Tooltip label={lane.muted ? t("jam.lane.unmute", { name }) : t("jam.lane.mute", { name })}>
            <button
              type="button"
              aria-pressed={lane.muted}
              aria-label={lane.muted ? t("jam.lane.unmute", { name }) : t("jam.lane.mute", { name })}
              onClick={() => onLane({ muted: !lane.muted })}
              data-jam-mute=""
              className={cn(
                LANE_BUTTON,
                "w-7 pointer-coarse:w-11",
                lane.muted && "bg-warning-soft text-on-warning-soft hover:bg-warning-soft hover:text-on-warning-soft",
              )}
            >
              {/* the letter every mixer uses; the words are the tooltip and the name for a screen reader */}
              <span aria-hidden="true" className="text-[13px] font-extrabold leading-none">M</span>
            </button>
          </Tooltip>
          <Tooltip label={lane.solo ? t("jam.lane.unsolo", { name }) : t("jam.lane.solo", { name })}>
            <button
              type="button"
              aria-pressed={lane.solo}
              aria-label={lane.solo ? t("jam.lane.unsolo", { name }) : t("jam.lane.solo", { name })}
              onClick={() => onLane({ solo: !lane.solo })}
              data-jam-solo=""
              className={cn(LANE_BUTTON, "w-7 pointer-coarse:w-11", lane.solo && "bg-accent text-on-accent hover:bg-accent hover:text-on-accent")}
            >
              <span aria-hidden="true" className="text-[13px] font-extrabold leading-none">S</span>
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
            // A 44 px tall hit area (the root is the pointer target) and a bigger thumb under a finger.
            className="mx-1 w-11 @min-[40rem]/band:mx-1.5 @min-[40rem]/band:w-12 pointer-coarse:h-11 pointer-coarse:[&_[role=slider]]:h-6 pointer-coarse:[&_[role=slider]]:w-6"
          />
        </div>
      )}
      {adjustButton}
      {/* the menu's slot is kept in every row too */}
      {menu.length > 0 ? (
        <Menu items={menu} align="end">
          <button type="button" aria-label={t("jam.lane.more", { name })} data-jam-lane-menu="" className={LANE_BUTTON}>
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </Menu>
      ) : (
        <span aria-hidden="true" className="h-8 w-8 shrink-0 pointer-coarse:h-11 pointer-coarse:w-11" />
      )}
    </>
  );

  return (
    <li
      data-jam-track={track.id}
      data-in-mix={track.inMix ? "true" : "false"}
      data-solo-dimmed={soloDimmed ? "true" : undefined}
      style={{ "--jam-l": index } as CSSProperties}
      className={cn(
        "group/lane flex flex-col gap-1.5 rounded-[var(--radius-card)] p-1.5 transition-colors duration-[var(--duration-fast)] hover:bg-surface-2/60",
        fresh ? "jam-drop-in" : "jam-lane-in",
        adjusting && "bg-surface-2/60",
      )}
    >
      <JamLaneFrame
        identity={
          <JamLaneIdentity
            instrument={track.instrument}
            title={instrumentName}
            sub={who}
            subTitle={who}
            dimmed={soloDimmed}
            muted={outOfMix && !auditioning}
          />
        }
        controls={controls}
        wave={
          // the recording on the song's timeline
          <div className={cn("relative min-w-0", outOfMix && !auditioning && "rounded-[var(--radius-control)] opacity-60 grayscale outline-2 outline-dashed outline-offset-2 outline-border-strong")}>
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
                dimmed={lane.muted || soloDimmed}
                playhead
                gain={track.gain}
              />
            </button>
            {outOfMix && (
              <span
                data-jam-out-pill=""
                className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-surface-0/85 px-1.5 py-px text-[11px] font-bold text-text-secondary"
              >
                {t("jam.take.out")}
              </span>
            )}
            {gainWords && (
              <span
                data-jam-gain=""
                className="pointer-events-none absolute right-1.5 top-1.5 rounded-full bg-surface-0/85 px-1.5 py-px text-[11px] font-bold tabular-nums text-text"
              >
                {t("jam.lane.gainLabel", { value: gainWords })}
              </span>
            )}
            {(loading || failed) && (
              <span
                role={failed ? "alert" : "status"}
                className="absolute inset-0 grid place-items-center rounded-[var(--radius-control)] bg-surface-0/70 text-xs font-semibold text-text"
              >
                {failed ? t("jam.song.stemError") : t("jam.song.loadingTrack")}
              </span>
            )}
          </div>
        }
      />

      {editor && <EditorSlot>{editor}</EditorSlot>}
    </li>
  );
}

/**
 * The adjust editor under its lane: it opens by growing from nothing (instantly
 * under reduced motion) and, once it is open, stops clipping so its sticky
 * footer can stick to the scroll area and focus rings are not cut.
 */
function EditorSlot({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"closed" | "opening" | "open">("closed");
  useEffect(() => {
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => setPhase("opening")) : 0;
    if (!raf) {
      setPhase("opening");
    }
    const settle = window.setTimeout(() => setPhase("open"), 280);
    return () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      window.clearTimeout(settle);
    };
  }, []);
  return (
    <div
      data-jam-editor-slot={phase}
      className={cn(
        "grid motion-safe:transition-[grid-template-rows] motion-safe:duration-[var(--duration-base)] motion-safe:ease-[var(--ease-emphasized)]",
        phase === "closed" ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
      )}
    >
      <div className={cn("min-h-0", phase === "open" ? "overflow-visible" : "overflow-hidden")}>
        <div className="pt-1.5">{children}</div>
      </div>
    </div>
  );
}
