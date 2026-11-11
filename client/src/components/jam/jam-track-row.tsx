import type { JamTrack } from "@pqp/shared";
import {
  CircleMinus,
  CirclePlus,
  Ear,
  Focus,
  Headphones,
  Maximize2,
  MoreHorizontal,
  SlidersHorizontal,
  ThumbsUp,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import type { JamClock, JamLaneMix } from "@/hooks/use-jam-playback";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { volumeDelta } from "@/lib/jam-clip";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { cn } from "@/lib/utils";
import { JamLaneWave, type JamTimeline } from "./jam-lane-wave";

/**
 * One lane of the band: who, on what, and their recording as a clip on the
 * song's timeline, lined up with every other lane under one playhead.
 *
 * On a phone the lane is a short stack: the person (picture or video, the
 * instrument, who), then the lane's controls, then the clip. On a wide screen
 * the first two are one column beside the clip. Either way every control sits
 * at the same place in every row, the viewer's own row included, and the
 * instrument's name is never given up for a button.
 *
 * The lane controls (mute, "only this", volume) are the listener's own and are
 * drawn as one cluster that says so; the level the author saved (inside
 * "Ajustar") is a different thing, shown here only as a static label. A
 * recording that competes with another for its instrument carries the vote and
 * the audition; the song's author gets "usar esta gravação"; the recording's own
 * author gets "Ajustar". Rarer actions sit in the lane's menu.
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
  adjusting: boolean;
  /** The adjust editor, drawn right under this lane while it is open. */
  editor?: ReactNode;
  onLane: (patch: Partial<JamLaneMix>) => void;
  onVote: () => void;
  onSwitchMix: () => void;
  onAdjust: () => void;
  onDelete: () => void;
  onAudition: () => void;
  onSeek: (fraction: number) => void;
  /** The recording has a video in the mix: drawn at the lane head, kept on the audio clock. */
  attachVideo?: (trackId: string, element: HTMLVideoElement) => () => void;
}

/** 32 px with a pointer, 44 px under a finger. */
const LANE_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-secondary outline-none transition-colors duration-[var(--duration-fast)] hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11 pointer-coarse:w-11";
const PILL_BUTTON =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-bold outline-none transition-colors duration-[var(--duration-fast)] focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11";

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
  adjusting,
  editor,
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
  // The author's SAVED volume for this recording, said on its own lane when it is not the recorded level.
  // A fact about the recording, not a control: the listener's own volume is the slider.
  const gainWords = volumeDelta(track.gain);
  const heard = track.inMix || auditioning;
  // Somebody else is soloed: this lane sits back so the soloed one stands out.
  const soloDimmed = othersSoloed && !lane.solo;
  const [watching, setWatching] = useState(false);

  const menu: ContextMenuItemDef[] = [
    ...(canSwitchMix && track.inMix
      ? [{ id: "take-out", label: t("jam.take.takeOut"), icon: CircleMinus, onSelect: onSwitchMix }]
      : []),
    ...(canDelete ? [{ id: "delete", label: t("jam.take.delete"), icon: Trash2, danger: true, onSelect: onDelete }] : []),
  ];

  const adjustButton = canAdjust ? (
    <button
      type="button"
      onClick={onAdjust}
      aria-pressed={adjusting}
      aria-label={t("jam.take.adjustMine")}
      data-jam-adjust-open={track.id}
      className={cn(
        PILL_BUTTON,
        adjusting ? "bg-text text-surface-0" : "bg-surface-3 text-text hover:bg-border-strong",
      )}
    >
      <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {t("jam.take.adjust")}
    </button>
  ) : null;

  const hasActions = outOfMix || competing;

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
      {/* the head: who and what, then the listener's own controls. They share one line while the song is wide
          enough and the controls drop to a line of their own when it is not; either way the name is whole. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-jam-lane-head="">
        <div className="flex min-w-0 flex-1 basis-[10.5rem] items-center gap-2.5">
          <span className={cn("relative shrink-0 motion-safe:transition-opacity motion-safe:duration-[var(--duration-base)]", soloDimmed && "opacity-40")}>
            {attachVideo && track.videoUrl ? (
              <LaneVideo track={track} attach={attachVideo} muted={lane.muted} label={name} suspended={watching} onOpen={() => setWatching(true)} />
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
          <span
            data-jam-lane-name=""
            className={cn(
              "flex min-w-0 flex-1 flex-col leading-tight motion-safe:transition-opacity motion-safe:duration-[var(--duration-base)]",
              soloDimmed && "opacity-40",
            )}
          >
            <span className={cn("break-words text-sm font-extrabold", outOfMix && !auditioning ? "text-text-secondary" : "text-text")}>
              {instrumentName}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-text-secondary">
              <span className="break-words">
                {person}
                {track.label ? ` · ${track.label}` : ""}
              </span>
              {outOfMix && (
                <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-px text-[11px] font-bold text-text-secondary">
                  {t("jam.take.out")}
                </span>
              )}
            </span>
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {heard && (
            // One cluster, and it is only for the listener: nothing here is sent anywhere.
            <div role="group" aria-label={t("jam.lane.mineOnly")} data-jam-lane-mix="" className="flex items-center gap-0.5 rounded-full bg-surface-2/70 pl-2 pr-1">
              <Tooltip label={t("jam.lane.mineOnly")}>
                <span className="grid h-6 w-5 shrink-0 place-items-center text-text-secondary">
                  <Headphones className="h-3.5 w-3.5" aria-hidden />
                </span>
              </Tooltip>
              <Tooltip label={lane.muted ? t("jam.lane.unmute", { name }) : t("jam.lane.mute", { name })}>
                <button
                  type="button"
                  aria-pressed={lane.muted}
                  onClick={() => onLane({ muted: !lane.muted })}
                  data-jam-mute=""
                  className={cn(
                    LANE_BUTTON,
                    "flex w-auto items-center gap-1 px-2.5 text-xs font-bold pointer-coarse:w-auto",
                    lane.muted && "bg-warning-soft text-on-warning-soft hover:bg-warning-soft hover:text-on-warning-soft",
                  )}
                >
                  {lane.muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
                  {t("jam.lane.muteShort")}
                </button>
              </Tooltip>
              <Tooltip label={lane.solo ? t("jam.lane.unsolo", { name }) : t("jam.lane.solo", { name })}>
                <button
                  type="button"
                  aria-pressed={lane.solo}
                  onClick={() => onLane({ solo: !lane.solo })}
                  data-jam-solo=""
                  className={cn(
                    LANE_BUTTON,
                    "flex w-auto items-center gap-1 px-2.5 text-xs font-bold pointer-coarse:w-auto",
                    lane.solo && "bg-accent text-on-accent hover:bg-accent hover:text-on-accent",
                  )}
                >
                  <Focus className="h-4 w-4" aria-hidden />
                  {t("jam.lane.soloShort")}
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
                className="mx-1.5 w-20 pointer-coarse:h-11 pointer-coarse:[&_[role=slider]]:h-6 pointer-coarse:[&_[role=slider]]:w-6"
              />
            </div>
          )}
          {/* the menu's slot is kept in every row, so the controls end at the same place in all of them */}
          {menu.length > 0 ? (
            <Menu items={menu} align="end">
              <button type="button" aria-label={t("jam.lane.more", { name })} data-jam-lane-menu="" className={LANE_BUTTON}>
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
            </Menu>
          ) : (
            <span aria-hidden="true" className="h-8 w-8 shrink-0 pointer-coarse:h-11 pointer-coarse:w-11" />
          )}
        </div>
      </div>

      {(adjustButton !== null || hasActions) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1" data-jam-lane-actions="">
          {adjustButton}
          {outOfMix && (
            <Tooltip label={auditioning ? t("jam.take.stopListening") : t("jam.take.listen")}>
              <button
                type="button"
                aria-pressed={auditioning}
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
                disabled={!canVote}
                onClick={onVote}
                data-jam-vote=""
                className={cn(
                  PILL_BUTTON,
                  "gap-1 tabular-nums hover:bg-surface-3 disabled:opacity-50",
                  voted ? "bg-accent-soft text-on-accent-soft" : "text-text-secondary",
                )}
              >
                <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
                <span>{track.voteCount}</span>
              </button>
            </Tooltip>
          )}
          {canSwitchMix && outOfMix && (
            <button
              type="button"
              onClick={onSwitchMix}
              data-jam-mix-switch=""
              aria-pressed={false}
              className={cn(PILL_BUTTON, "bg-accent text-on-accent transition-transform active:scale-[0.96]")}
            >
              <CirclePlus className="h-3.5 w-3.5" aria-hidden />
              {t("jam.take.useThis")}
            </button>
          )}
        </div>
      )}

      {/* the recording on the song's timeline: the full width of the song, under its head */}
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
            className="h-14"
            playhead
            gain={track.gain}
          />
        </button>
        {gainWords && (
          <span
            data-jam-gain=""
            className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-surface-0/85 px-1.5 py-px text-[11px] font-bold tabular-nums text-text"
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

      {editor && <EditorSlot>{editor}</EditorSlot>}

      {attachVideo && track.videoUrl && (
        <Dialog open={watching} title={name} description={t("jam.lane.watchHint")} size="lg" onClose={() => setWatching(false)}>
          <DialogBody>
            <EnlargedVideo track={track} attach={attachVideo} />
          </DialogBody>
        </Dialog>
      )}
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

/**
 * A recording's video at its lane head: a small 16:9 frame, muted and kept on the
 * audio clock by the engine, and a button that opens it big.
 */
function LaneVideo({
  track,
  attach,
  muted,
  label,
  suspended,
  onOpen,
}: {
  track: JamTrack;
  attach: (trackId: string, element: HTMLVideoElement) => () => void;
  muted: boolean;
  label: string;
  /** The enlarged player is open: this small one is detached and paused until it closes. */
  suspended: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    if (suspended) {
      element.pause();
      return;
    }
    return attach(track.id, element);
  }, [attach, track.id, suspended]);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("jam.lane.watch", { name: label })}
      data-jam-lane-video-open=""
      className="group/video relative block aspect-video w-16 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-0 outline-none ring-1 ring-inset ring-border focus-visible:ring-2 focus-visible:ring-focus-ring sm:w-20 pointer-coarse:w-20"
    >
      <video
        ref={ref}
        src={track.videoUrl ?? undefined}
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        tabIndex={-1}
        data-jam-lane-video=""
        className={cn(
          "h-full w-full object-cover transition-opacity duration-[var(--duration-base)] motion-reduce:transition-none",
          muted && "opacity-40",
        )}
      />
      <span
        aria-hidden="true"
        className="absolute left-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-media-scrim/70 text-on-media opacity-80 transition-opacity group-hover/video:opacity-100"
      >
        <Maximize2 className="h-2.5 w-2.5" />
      </span>
    </button>
  );
}

/**
 * The same recording's video, big, in a dialog. A second element on the same
 * stem is fine: the engine's follower is per element, and detaching this one
 * stops only this one.
 */
function EnlargedVideo({
  track,
  attach,
}: {
  track: JamTrack;
  attach: (trackId: string, element: HTMLVideoElement) => () => void;
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
      data-jam-lane-video-big=""
      className="aspect-video w-full rounded-[var(--radius-card)] bg-surface-0 object-contain"
    />
  );
}
