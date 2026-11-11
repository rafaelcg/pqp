import type { JamTrack } from "@pqp/shared";
import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { JamLaneMix } from "@/hooks/use-jam-playback";
import { useElementWidth } from "./jam-bars";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { cn } from "@/lib/utils";

/**
 * The stage of an open song: every recording that has a video, at real size,
 * above the lanes. One video is one large tile, two sit side by side, more form
 * an even grid; every tile is 16:9 and the whole stage is no taller than about
 * 55% of the window, so the lanes stay in view on a laptop.
 *
 * Each video follows the song clock (`attachVideo`: the file's time is the
 * song's time minus the take's offset, the same follower the engine runs for a
 * stem) and is muted: the sound is the mix. A lane that is muted, or any lane
 * that is not "only this" while another one is, dims its tile.
 *
 * A corner chip names the person, with the instrument's colour as its dot (a
 * colour is never the only cue: the lane below carries the instrument's icon
 * and name). The stage can go full screen where the browser allows it.
 */

/**
 * Below this width of the stage (34rem) two or three tiles side by side would each be
 * a thumbnail (about 255 px at the narrowest desktop panel), so they stack instead:
 * the same 55vh holds them bigger, and a phone gets full-width tiles.
 */
const STAGE_NARROW_PX = 544;

/**
 * Columns for N tiles. Wide: 1, 2 and 3 in a row, four as two by two, then three or four
 * wide. Narrow: up to three stacked, then two wide.
 */
export function stageColumns(count: number, narrow = false): number {
  if (narrow) return count <= 3 ? 1 : 2;
  if (count <= 3) return Math.max(1, count);
  if (count === 4) return 2;
  return count <= 6 ? 3 : 4;
}

export function JamStage({
  tracks,
  viewerId,
  lanes,
  anySolo,
  attachVideo,
  loading = false,
}: {
  /** The recordings that have a video and are in the mix. */
  tracks: readonly JamTrack[];
  viewerId: string | null;
  lanes: Record<string, JamLaneMix>;
  /** Some lane is "only this": the others sit back. */
  anySolo: boolean;
  attachVideo: (trackId: string, element: HTMLVideoElement) => () => void;
  /** The song's detail has not arrived: the space is held so nothing jumps. */
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement | null>(null);
  const [measure, width] = useElementWidth<HTMLElement>();
  const setRoot = (node: HTMLElement | null) => {
    root.current = node;
    measure(node);
  };
  const [full, setFull] = useState(false);
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled === true;
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === root.current && root.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const count = Math.max(1, tracks.length);
  const columns = stageColumns(count, width > 0 && width < STAGE_NARROW_PX);
  const rows = Math.ceil(count / columns);
  const toggleFullscreen = () => {
    const element = root.current;
    if (!element) {
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void element.requestFullscreen?.().catch(() => undefined);
    }
  };

  return (
    <section
      ref={setRoot}
      data-jam-stage=""
      data-jam-stage-count={tracks.length}
      data-jam-stage-columns={columns}
      aria-label={t("jam.stage.label")}
      className={cn(
        "group/stage relative mt-3",
        // one row can be as tall as 55% of the window; several rows share a little less, so the first lane still shows under them
        rows === 1 ? "[--stage-h:55vh]" : "[--stage-h:46vh]",
        "[&:fullscreen]:m-0 [&:fullscreen]:grid [&:fullscreen]:place-items-center [&:fullscreen]:bg-surface-0 [&:fullscreen]:p-4 [&:fullscreen]:[--stage-h:calc(100vh_-_2rem)]",
      )}
    >
      <div
        className="mx-auto grid w-full gap-2"
        style={
          {
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            // a tile is 16:9, so a stage capped at --stage-h tall is at most this wide
            maxWidth: `calc(${columns} * (var(--stage-h) / ${rows}) * 1.7778)`,
          } as CSSProperties
        }
      >
        {loading && tracks.length === 0 ? (
          <div className="aspect-video rounded-[var(--radius-card)] bg-surface-2 motion-safe:animate-pulse" aria-hidden="true" />
        ) : (
          tracks.map((track) => (
            <StageTile
              key={track.id}
              track={track}
              mine={viewerId !== null && track.authorId === viewerId}
              dimmed={lanes[track.id]?.muted === true || (anySolo && lanes[track.id]?.solo !== true)}
              attachVideo={attachVideo}
              eager={tracks.length <= 2}
            />
          ))
        )}
      </div>
      {canFullscreen && (
        <button
          type="button"
          onClick={toggleFullscreen}
          data-jam-stage-fullscreen=""
          aria-label={full ? t("jam.stage.exitFullscreen") : t("jam.stage.fullscreen")}
          // shown when the pointer is over the stage or the keyboard is on it, and always under a finger (no hover there)
          className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-full bg-media-scrim/70 text-on-media opacity-0 outline-none backdrop-blur-sm transition-[background-color,opacity] duration-[var(--duration-fast)] hover:bg-media-scrim focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/stage:opacity-100 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
        >
          {full ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
        </button>
      )}
    </section>
  );
}

function StageTile({
  track,
  mine,
  dimmed,
  attachVideo,
  eager,
}: {
  track: JamTrack;
  mine: boolean;
  dimmed: boolean;
  attachVideo: (trackId: string, element: HTMLVideoElement) => () => void;
  /** Buffer the picture before play (a still frame on the tile). Off for a big grid: those buffer when they play. */
  eager: boolean;
}) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[track.instrument];
  const person = mine ? t("jam.lane.you") : (track.authorName ?? t("jam.tile.anonymous"));
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    return attachVideo(track.id, element);
  }, [attachVideo, track.id]);
  return (
    <div
      data-jam-stage-tile={track.id}
      data-dimmed={dimmed ? "true" : undefined}
      className="@container/tile relative aspect-video overflow-hidden rounded-[var(--radius-card)] bg-surface-0 ring-1 ring-inset ring-border"
    >
      <video
        ref={ref}
        src={track.videoUrl ?? undefined}
        muted
        playsInline
        preload={eager ? "auto" : "metadata"}
        aria-hidden="true"
        tabIndex={-1}
        data-jam-stage-video=""
        className={cn(
          "h-full w-full object-cover motion-safe:transition-[opacity,filter] motion-safe:duration-[var(--duration-base)]",
          dimmed && "opacity-35 saturate-50",
        )}
      />
      <span
        data-jam-stage-chip=""
        title={`${t(look.nameKey as MessageKey)}, ${person}`}
        className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-full bg-media-scrim/75 py-0.5 pl-1.5 pr-2 text-[11px] font-bold text-on-media backdrop-blur-sm @min-[15rem]/tile:bottom-2 @min-[15rem]/tile:left-2 @min-[15rem]/tile:py-1 @min-[15rem]/tile:pl-2 @min-[15rem]/tile:pr-2.5 @min-[15rem]/tile:text-xs"
      >
        <span aria-hidden="true" className={cn("h-2.5 w-2.5 shrink-0 rounded-full", look.fill)} />
        <span className="truncate">{person}</span>
      </span>
    </div>
  );
}
