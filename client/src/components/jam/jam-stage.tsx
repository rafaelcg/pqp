import type { JamInstrument, JamTrack } from "@pqp/shared";
import { Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { JamClock, JamLaneMix } from "@/hooks/use-jam-playback";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { resolveAvatarUrl } from "@/lib/avatar";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { jamTileLook } from "@/lib/jam-tile-look";
import { LevelStrip, MoreBody, paintLevelStrip, PersonMark, StackDot, TileCaption } from "@/lib/jam-tile-parts";
import { jamVideoPreload, jamVideoStillSrc, pickJamVideoUrl } from "@/lib/jam-video-source";
import {
  assignCells,
  levelOverview,
  levelStrip,
  mosaicLayout,
  mosaicShown,
  stageAspect,
  type MosaicKind,
} from "@/lib/jam-mosaic";
import { cn } from "@/lib/utils";

/**
 * The stage of an open song: ONE rectangle divided among the whole band, above the
 * lanes. Every recording that is in the mix gets a tile, with video or without;
 * `lib/jam-mosaic.ts` decides the arrangement (one tile is the whole stage, two are
 * halves, three are one big and two small, four two by two, up to three by three, and
 * past nine the first eight and a "+N"), from the stage's own aspect: 16:9 on a wide
 * panel, 4:3 on a narrow one and square on a phone, so no tile is ever a sliver. The tiles
 * tile the stage exactly; the 3 px gutter between them is CSS.
 *
 * A recording with a video shows it, covering its tile and following the song clock
 * (`attachVideo`: the file's time is the song's time minus the take's offset, the same
 * follower the engine runs for a stem), muted: the sound is the mix. One without is a
 * person on the instrument's own OPAQUE ground (`lib/jam-tile-look.ts`, the same table the
 * public site draws from): their picture or initial as the biggest thing on the tile, the
 * instrument's badge on it, and a strip of its own loudness running under it: the take's
 * precomputed peaks around the song clock, written straight to the bars (no analyser, no
 * React), a still picture of the whole take under reduced motion, and one baseline where
 * it is silent (`lib/jam-tile.css`).
 *
 * Every tile is a button: it solos its track ("Só essa") and a second press clears it. A
 * track that is muted, or any that is not soloed while another one is, dims. A small
 * caption names the person with the instrument's mark (a colour is never the only cue: the
 * glyph, the lane below and the button's name carry the instrument too). A part the song
 * asks for, and that the viewer may add, is one dashed tile on a neutral ground that opens
 * the studio on that instrument and never takes a larger cell than a recording. The stage
 * can go full screen where the browser allows.
 */

/** Bars in a tile's level strip: the middle one is under the song clock. */
const LEVEL_BARS = 29;

/** The width of an element, measured before the first paint (so a phone never sees the wide arrangement for a frame) and followed as it resizes. */
function useStageWidth(): [(node: HTMLElement | null) => void, number] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) {
      return;
    }
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

export function JamStage({
  tracks,
  viewerId,
  lanes,
  anySolo,
  attachVideo,
  clock,
  onSolo,
  missing = [],
  onRecord,
  loading = false,
}: {
  /** The recordings that are in the mix, video or not. */
  tracks: readonly JamTrack[];
  viewerId: string | null;
  lanes: Record<string, JamLaneMix>;
  /** Some lane is "only this": the others sit back. */
  anySolo: boolean;
  attachVideo: (trackId: string, element: HTMLVideoElement) => () => void;
  /** The song clock, for the loudness strip of a tile with no video. */
  clock: JamClock;
  /** A tile was pressed: solo this track, or clear it when it is the only one soloed. */
  onSolo: (trackId: string) => void;
  /** The instruments the song asks for and the viewer may add: one dashed tile each. */
  missing?: readonly JamInstrument[];
  onRecord?: (instrument: JamInstrument) => void;
  /** The song's detail has not arrived: the space is held so nothing jumps. */
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement | null>(null);
  const [measure, width] = useStageWidth();
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

  const aspect = stageAspect(width);
  const shown = mosaicShown(tracks.length, onRecord ? missing.length : 0);
  const shownTracks = tracks.slice(0, shown.tracks);
  const shownMissing = onRecord ? missing.slice(0, shown.missing) : [];
  type Item =
    | { kind: "video" | "audio"; track: JamTrack }
    | { kind: "missing"; instrument: JamInstrument }
    | { kind: "more"; count: number };
  const items: Item[] = [
    ...shownTracks.map((track): Item => ({ kind: track.videoUrl ? "video" : "audio", track })),
    ...shownMissing.map((instrument): Item => ({ kind: "missing", instrument })),
    ...(shown.more > 0 ? [{ kind: "more", count: shown.more } as Item] : []),
  ];
  const hiddenInstruments = [...new Set(tracks.slice(shown.tracks).map((track) => track.instrument))];
  const layout = mosaicLayout(items.length, aspect);
  const kinds = items.map((item): MosaicKind => item.kind);
  // the cell of each item. The tiles stay in the DOM in the band's own order (the lanes' order, and
  // the keyboard's) and are only PLACED on the grid: moving a <video> in the document pauses it.
  const cellOfItem = new Map<number, number>();
  assignCells(layout, kinds).forEach((itemIndex, cellIndex) => {
    if (itemIndex >= 0) {
      cellOfItem.set(itemIndex, cellIndex);
    }
  });

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
      data-jam-stage-tiles={items.length}
      data-jam-stage-columns={layout.cols}
      data-jam-stage-rows={layout.rows}
      aria-label={t("jam.stage.label")}
      className={cn(
        "group/stage relative mt-3 [--stage-h:55vh]",
        "[&:fullscreen]:m-0 [&:fullscreen]:grid [&:fullscreen]:place-items-center [&:fullscreen]:bg-surface-0 [&:fullscreen]:p-4 [&:fullscreen]:[--stage-h:calc(100vh_-_2rem)]",
      )}
    >
      <div
        data-jam-stage-grid=""
        className="mx-auto grid w-full gap-[3px] overflow-hidden rounded-[var(--radius-card)] bg-surface-1"
        style={
          {
            aspectRatio: `${aspect}`,
            // the stage is one rectangle of this shape, so a stage capped at --stage-h tall is at most this wide
            maxWidth: `calc(var(--stage-h) * ${aspect.toFixed(4)})`,
            gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
          } as CSSProperties
        }
      >
        {loading && tracks.length === 0 ? (
          <div className="col-span-full row-span-full rounded-[var(--radius-card)] bg-surface-2 motion-safe:animate-pulse" aria-hidden="true" />
        ) : (
          items.map((item, index) => {
            const cell = layout.cells[cellOfItem.get(index) ?? -1];
            if (!cell) {
              return null;
            }
            const place: CSSProperties = {
              gridColumn: `${cell.col + 1} / span ${cell.colSpan}`,
              gridRow: `${cell.row + 1} / span ${cell.rowSpan}`,
            };
            if (item.kind === "missing") {
              return <MissingTile key={`missing-${item.instrument}`} instrument={item.instrument} place={place} onRecord={() => onRecord?.(item.instrument)} />;
            }
            if (item.kind === "more") {
              return <MoreTile key="more" count={item.count} instruments={hiddenInstruments} place={place} />;
            }
            const track = item.track;
            return (
              <StageTile
                key={track.id}
                track={track}
                place={place}
                mine={viewerId !== null && track.authorId === viewerId}
                dimmed={lanes[track.id]?.muted === true || (anySolo && lanes[track.id]?.solo !== true)}
                soloed={lanes[track.id]?.solo === true}
                onSolo={() => onSolo(track.id)}
                attachVideo={attachVideo}
                clock={clock}
                parts={tracks.length}
              />
            );
          })
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

/** A tile is its own size container, so its glyph, strip and caption follow the tile (a ninth of the stage or all of it), not the window. */
const TILE_BASE =
  "[container:tile/size] relative block h-full w-full min-h-0 min-w-0 cursor-pointer overflow-hidden p-0 text-left outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring";

function StageTile({
  track,
  place,
  mine,
  dimmed,
  soloed,
  onSolo,
  attachVideo,
  clock,
  parts,
}: {
  track: JamTrack;
  place: CSSProperties;
  mine: boolean;
  dimmed: boolean;
  soloed: boolean;
  onSolo: () => void;
  attachVideo: (trackId: string, element: HTMLVideoElement) => () => void;
  clock: JamClock;
  /** How many recordings the song has: a big song only loads each video's first frame before play. */
  parts: number;
}) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[track.instrument];
  const tile = jamTileLook(track.instrument);
  const person = mine ? t("jam.lane.you") : (track.authorName ?? t("jam.tile.anonymous"));
  const instrumentName = t(look.nameKey as MessageKey);
  const hasVideo = Boolean(track.videoUrl);
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    return attachVideo(track.id, element);
    // `hasVideo` is a dependency: the <video> mounts and unmounts with it, and the follower follows the element
  }, [attachVideo, track.id, hasVideo]);
  const videoUrl = pickJamVideoUrl(track);
  return (
    <button
      type="button"
      data-jam-stage-tile={track.id}
      data-jam-stage-kind={hasVideo ? "video" : "audio"}
      data-dimmed={dimmed ? "true" : undefined}
      data-soloed={soloed ? "true" : undefined}
      aria-pressed={soloed}
      aria-label={t("jam.stage.tile", { instrument: instrumentName, name: person })}
      onClick={onSolo}
      style={place}
      className={cn(TILE_BASE, "group/tile", hasVideo ? "bg-surface-0" : tile.ground)}
    >
      {hasVideo ? (
        <video
          ref={ref}
          src={videoUrl ? jamVideoStillSrc(videoUrl) : undefined}
          muted
          playsInline
          preload={jamVideoPreload(parts, false)}
          aria-hidden="true"
          tabIndex={-1}
          data-jam-stage-video=""
          className={cn(
            "h-full w-full object-cover motion-safe:transition-[opacity,filter] motion-safe:duration-[var(--duration-base)]",
            dimmed && "brightness-[0.42] saturate-50",
          )}
        />
      ) : (
        <span
          aria-hidden="true"
          data-jam-stage-art=""
          className={cn(
            "absolute inset-0 flex flex-col items-center justify-center gap-[5cqmin] pb-[9cqmin] motion-safe:transition-opacity motion-safe:duration-[var(--duration-base)]",
            tile.ink,
            dimmed && "opacity-40",
          )}
        >
          <PersonMark
            avatarUrl={resolveAvatarUrl(track.authorAvatarUrl)}
            name={track.authorName ?? person}
            fill={look.fill}
            icon={<look.icon className="h-[58%] w-[58%]" strokeWidth={2} />}
          />
          <TileLevel track={track} clock={clock} />
        </span>
      )}
      {soloed && (
        <span
          data-jam-stage-solo-badge=""
          aria-hidden="true"
          className="absolute left-1.5 top-1.5 rounded-full bg-accent px-2 py-0.5 text-[11px] font-extrabold leading-4 text-on-accent @min-[15rem]/tile:left-2 @min-[15rem]/tile:top-2 @min-[15rem]/tile:px-2.5 @min-[15rem]/tile:text-xs"
        >
          {t("jam.stage.soloBadge")}
        </span>
      )}
      {soloed && <span aria-hidden="true" className="pointer-events-none absolute inset-0 ring-[3px] ring-inset ring-accent" />}
      {/* the keyboard's ring is its own layer: a box-shadow on the button is painted under a full-size video */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] opacity-0 ring-2 ring-inset ring-focus-ring group-focus-visible/tile:opacity-100" />
      <TileCaption
        data-jam-stage-chip=""
        tone={hasVideo ? "media" : "ground"}
        mark={
          <span aria-hidden="true" className={cn("grid h-4 w-4 shrink-0 place-items-center rounded-full @min-[16rem]/tile:h-5 @min-[16rem]/tile:w-5", look.fill)}>
            <look.icon className="h-[58%] w-[58%]" strokeWidth={2} />
          </span>
        }
        name={person}
        label={instrumentName}
      />
    </button>
  );
}

/**
 * The loudness of one take as a strip of bars, the middle one under the song clock. Written
 * straight to the bars' transforms when the peak under the clock changes, so it costs a
 * handful of style writes a second and no re-render, and no analyser node sits on the audio
 * graph. Where motion is not wanted it is the whole take as a still picture. A silent stretch
 * is one baseline (`lib/jam-tile.css`), not a row of dots.
 */
function TileLevel({ track, clock }: { track: JamTrack; clock: JamClock }) {
  const reduced = usePrefersReducedMotion();
  const strip = useRef<HTMLSpanElement | null>(null);
  const paint = useCallback((values: readonly number[]) => {
    if (strip.current) {
      paintLevelStrip(strip.current, values);
    }
  }, []);
  const { peaks, offsetMs, trimStartMs, trimEndMs, durationMs } = track;
  useEffect(() => {
    const timing = { peaks, offsetMs, trimStartMs, trimEndMs, durationMs };
    if (reduced) {
      paint(levelOverview(timing, LEVEL_BARS));
      return;
    }
    const msPerPeak = durationMs / Math.max(1, peaks.length);
    let lastStep = Number.NaN;
    return clock.subscribe((positionMs) => {
      const step = Math.floor((positionMs - offsetMs) / Math.max(1, msPerPeak));
      if (step === lastStep) {
        return;
      }
      lastStep = step;
      paint(levelStrip(timing, positionMs, LEVEL_BARS));
    });
  }, [clock, paint, reduced, peaks, offsetMs, trimStartMs, trimEndMs, durationMs]);
  return (
    <LevelStrip
      ref={strip}
      count={LEVEL_BARS}
      data-jam-stage-level=""
      className="flex h-[14cqmin] min-h-4 max-h-10 w-full [--jam-level-gap:clamp(1px,1cqmin,4px)] [--jam-level-w:clamp(2px,1.8cqmin,8px)]"
    />
  );
}

/** "Teu baixo aqui": the part the song asks for, a dashed tile in that instrument's ink on a neutral ground, so it reads as a slot and never as a part. */
function MissingTile({ instrument, place, onRecord }: { instrument: JamInstrument; place: CSSProperties; onRecord: () => void }) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const tile = jamTileLook(instrument);
  const label = t(`jam.stage.slot.${instrument}` as MessageKey);
  return (
    <button
      type="button"
      data-jam-stage-slot={instrument}
      aria-label={t(`jam.song.recordAs.${instrument}` as MessageKey)}
      onClick={onRecord}
      style={place}
      className={cn(
        TILE_BASE,
        "group/slot grid place-items-center bg-surface-2 text-text transition-colors duration-[var(--duration-base)] hover:bg-surface-3 motion-reduce:transition-none",
      )}
    >
      <span aria-hidden="true" className={cn("pointer-events-none absolute inset-1.5 rounded-[var(--radius-card)] border-2 border-dashed @min-[10rem]/tile:inset-2.5", tile.dashed)} />
      <span aria-hidden="true" className="relative flex max-w-[86%] flex-col items-center gap-[4cqmin]">
        <span className={cn("grid h-[22cqmin] min-h-7 w-[22cqmin] min-w-7 max-h-14 max-w-14 place-items-center rounded-full", look.fill)}>
          <look.icon className="h-[55%] w-[55%]" strokeWidth={2} aria-hidden />
        </span>
        <span className="flex items-center gap-1.5 text-center text-xs font-bold leading-tight @min-[10rem]/tile:text-sm">
          <span className="line-clamp-2">{label}</span>
        </span>
      </span>
    </button>
  );
}

/** "+3": the recordings past the eighth tile, with a stack of the instruments behind it. */
function MoreTile({ count, instruments, place }: { count: number; instruments: readonly JamInstrument[]; place: CSSProperties }) {
  const { t } = useTranslation();
  return (
    <div
      data-jam-stage-more=""
      role="img"
      aria-label={t("jam.stage.more", { count, countLabel: count })}
      style={place}
      className="[container:tile/size] min-h-0 min-w-0"
    >
      <MoreBody
        count={count}
        dots={instruments.slice(0, 3).map((instrument) => {
          const look = JAM_INSTRUMENT_LOOK[instrument];
          return (
            <StackDot key={instrument} fill={look.fill}>
              <look.icon className="h-3 w-3" strokeWidth={2.25} aria-hidden />
            </StackDot>
          );
        })}
      />
    </div>
  );
}
