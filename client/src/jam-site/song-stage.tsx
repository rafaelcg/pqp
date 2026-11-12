import type { PublicJamTrack } from "@pqp/shared";
import { XIcon as X } from "./icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { jamVideoPreload, jamVideoStillSrc, pickJamVideoUrl } from "@/lib/jam-video-source";
import { placeItemsOnCells } from "@/lib/jam-tile-look";
import { LevelStrip, paintLevelStrip, PersonMark, TileCaption } from "@/lib/jam-tile-parts";
import { asInstrument, INSTRUMENT_LOOK, type Instrument } from "./instruments";
import { levelScale, windowBars } from "./levels";
import { cellAreas, mosaicLayout, spotlightLayout } from "./mosaic";
import type { PublicPlayer } from "./player";
import { Badge, MosaicGrid } from "./tiles";
import { useMedia, usePlayerState, useStageAspect } from "./use-player";
import { cn, partLabel, personLabel } from "./util";

/**
 * THE MOSAIC of a song: every public part is a tile. A part with a video is
 * its video (a muted `<video>` that follows the song clock through the engine);
 * a part without one is a person: their picture (or initial) large on the
 * neutral ground with the instrument's chip, and a level meter under them
 * while the song plays. When
 * the song still asks for somebody, a dashed tile says so and opens the record
 * sheet; it never takes a larger cell than a recorded part. Tap a tile to hear
 * only that part, large, with the band small beside it; Escape or the pill's x
 * goes back.
 *
 * The geometry is `mosaic.ts` (pure, tested); the playing is `player.ts` (the
 * app's own engine); the look of a tile is `lib/jam-tile-look.ts` and
 * `lib/jam-tile-parts.tsx`, shared with the app's song view.
 */

const LEVEL_BARS = 15;

/** How many first frames are being fetched at once before play: a big song starts the next as each lands, not all nine together. */
const STILLS_IN_FLIGHT = 4;

type Item =
  | { kind: "part"; track: PublicJamTrack }
  | { kind: "need"; instrument: Instrument };

/**
 * A part with no video: the person, centred and large, on the neutral tile. At
 * rest that is ALL there is (no strip: a flat line under a face read as a broken
 * waveform). While the song plays a strip of the part's own loudness appears
 * under them, and goes again on pause. The player's frame loop already slows
 * itself under reduced motion, and the bars only ease when motion is allowed.
 */
function PartFace({ track, player, covered, playing }: { track: PublicJamTrack; player: PublicPlayer; covered: boolean; playing: boolean }) {
  const instrument = asInstrument(track.instrument);
  const look = INSTRUMENT_LOOK[instrument];
  const scale = useMemo(() => levelScale(track.peaks), [track.peaks]);
  const strip = useRef<HTMLSpanElement | null>(null);
  // Nothing to draw under a video that is showing, and nothing at rest.
  const live = playing && !covered;
  useEffect(() => {
    const element = strip.current;
    if (!element || !live) return;
    const draw = () => paintLevelStrip(element, windowBars(track, player.position(), LEVEL_BARS, scale));
    draw();
    const stopState = player.subscribe(draw);
    const stopFrames = player.onFrame(draw);
    return () => {
      stopState();
      stopFrames();
    };
  }, [track, player, scale, live]);
  return (
    <div className={cn("absolute inset-0 grid place-items-center [container:face/size]", look.tile.ground, look.tile.ink)}>
      <PersonMark
        avatarUrl={track.person.avatarUrl}
        name={personLabel(track.person)}
        fill={look.fill}
        initialFill={look.tile.solid}
        chip={look.tile.chip}
        icon={<look.icon className="h-[58%] w-[58%]" strokeWidth={2} />}
      />
      {live && (
        // under the person and out of the flow: the face never moves when the strip arrives. The
        // wrapper is what is placed (`.jam-level` sets its own `position`, which beats a utility)
        <span className="pointer-events-none absolute inset-x-0 top-[calc(50%+30cqmin)] hidden justify-center @min-[10rem]/face:flex">
          <LevelStrip ref={strip} count={LEVEL_BARS} data-jam-level-live="" className="flex h-[9cqmin] min-h-3 max-h-8" />
        </span>
      )}
    </div>
  );
}

function PartTile({
  index,
  track,
  player,
  playing,
  stemsReady,
  parts,
  fetchStill,
  onSettled,
  spotlit,
  dimmed,
  onSelect,
}: {
  index: number;
  track: PublicJamTrack;
  player: PublicPlayer;
  playing: boolean;
  stemsReady: boolean;
  /** How many parts the song has: a big song only loads its first frames before play. */
  parts: number;
  /** This video may start loading its first frame now (a queue, so a big song does not fan out every request at once). */
  fetchStill: boolean;
  /** Its first frame landed, or failed: the next in the queue may start. */
  onSettled: () => void;
  spotlit: boolean;
  dimmed: boolean;
  onSelect: () => void;
}) {
  const instrument = asInstrument(track.instrument);
  const look = INSTRUMENT_LOOK[instrument];
  const name = personLabel(track.person);
  const videoUrl = useMemo(() => pickJamVideoUrl(track), [track]);
  const video = useRef<HTMLVideoElement | null>(null);
  const [shown, setShown] = useState(false);
  // a tile tells the queue once, whatever the browser fires after
  const settledOnce = useRef(false);
  const settle = () => {
    if (!settledOnce.current) {
      settledOnce.current = true;
      onSettled();
    }
  };

  useEffect(() => {
    const element = video.current;
    if (!element || !stemsReady || !videoUrl) return;
    return player.attachVideo(track.id, element);
  }, [player, track.id, stemsReady, videoUrl]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={spotlit}
      aria-label={jt("tile.listen", { name, instrument: partLabel(track).toLowerCase() })}
      data-jam-tile={track.id}
      data-jam-tile-index={index}
      data-jam-tile-kind={videoUrl ? "video" : "audio"}
      data-jam-tile-shown={shown ? "true" : undefined}
      data-spotlit={spotlit ? "true" : undefined}
      className={cn(
        "@container/tile group/tile absolute inset-0 block h-full w-full cursor-pointer overflow-hidden bg-surface-2 text-left outline-none",
        // The ring is a layer ABOVE the picture: a box-shadow on the button is painted under the video.
        "after:pointer-events-none after:absolute after:inset-0 after:z-10 after:content-[''] focus-visible:after:shadow-[inset_0_0_0_3px_var(--color-accent)]",
        dimmed && "opacity-50",
      )}
      style={spotlit ? ({ "--jam-ring": `var(${look.token})` } as React.CSSProperties) : undefined}
    >
      <PartFace track={track} player={player} covered={shown} playing={playing} />
      {videoUrl && (
        <video
          ref={video}
          src={fetchStill ? jamVideoStillSrc(videoUrl) : undefined}
          muted
          playsInline
          preload={jamVideoPreload(parts, playing || stemsReady)}
          aria-hidden="true"
          tabIndex={-1}
          disablePictureInPicture
          onLoadedMetadata={(event) => {
            // A browser that ignores the fragment still lands on a frame to show.
            const element = event.currentTarget;
            if (element.paused && element.currentTime === 0) element.currentTime = 0.1;
          }}
          onLoadedData={() => {
            setShown(true);
            settle();
          }}
          onSeeked={() => setShown(true)}
          onError={() => {
            setShown(false);
            settle();
          }}
          className={cn(
            "absolute inset-0 h-full w-full object-cover motion-safe:transition-opacity motion-safe:duration-[var(--duration-base)]",
            shown ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      <TileCaption
        tone={videoUrl ? "media" : "ground"}
        mark={<Badge instrument={instrument} className="h-4 w-4 @min-[16rem]/tile:h-5 @min-[16rem]/tile:w-5" />}
        name={name}
        label={partLabel(track).toLowerCase()}
      />
    </button>
  );
}

function NeedTile({ instrument, onClick }: { instrument: Instrument; onClick: () => void }) {
  const look = INSTRUMENT_LOOK[instrument];
  return (
    <button
      type="button"
      onClick={onClick}
      data-jam-need-tile={instrument}
      className={cn(
        "@container/need group/need absolute inset-0 grid h-full w-full cursor-pointer place-items-center bg-surface-1 text-center text-text outline-none transition-colors hover:bg-surface-2 motion-reduce:transition-none",
        "after:pointer-events-none after:absolute after:inset-0 after:z-10 after:content-[''] focus-visible:after:shadow-[inset_0_0_0_3px_var(--color-accent)]",
      )}
    >
      <span className={cn("pointer-events-none absolute inset-2.5 rounded-[var(--radius-card)] border-2 border-dashed @max-[9rem]/need:inset-1.5", look.tile.dashed)} />
      <span className="relative flex flex-col items-center gap-2 px-3">
        <Badge instrument={instrument} className="h-10 w-10 @max-[9rem]/need:h-7 @max-[9rem]/need:w-7" />
        <span className="text-sm font-bold leading-tight @max-[9rem]/need:hidden">
          {jt(`tile.yours.${instrument}` as Parameters<typeof jt>[0])}
        </span>
      </span>
      <span className="sr-only">{jt(`record.${instrument}` as Parameters<typeof jt>[0])}</span>
    </button>
  );
}

export function SongStage({
  tracks,
  need,
  player,
  spot,
  onSpot,
  onRecord,
  label,
}: {
  tracks: readonly PublicJamTrack[];
  /** The first instrument the song still asks for, or null. */
  need: Instrument | null;
  player: PublicPlayer;
  /** Index into `tracks` of the spotlit part, or null. */
  spot: number | null;
  onSpot: (index: number | null) => void;
  onRecord: (instrument: Instrument) => void;
  label: string;
}) {
  const state = usePlayerState(player);
  const wide = useMedia("(min-width: 640px)");
  const items: Item[] = useMemo(
    () => [
      ...tracks.map((track): Item => ({ kind: "part", track })),
      ...(need ? [{ kind: "need", instrument: need } as Item] : []),
    ],
    [tracks, need],
  );
  const stage = useStageAspect();
  const aspect = wide ? stage : 0.8;
  const spotIndex = spot !== null && spot < tracks.length ? spot : null;
  const layout = useMemo(
    () => (spotIndex === null ? mosaicLayout(items.length, aspect) : spotlightLayout(items.length, spotIndex, aspect)),
    [items.length, spotIndex, aspect],
  );
  // The invitation never takes a larger cell than a recording (the spotlight keeps its own order).
  const order = useMemo(
    () =>
      spotIndex === null
        ? placeItemsOnCells(
            cellAreas(layout),
            items.map((item) => item.kind === "need"),
          )
        : undefined,
    [layout, items, spotIndex],
  );
  const soloed = spotIndex !== null ? tracks[spotIndex] : null;
  // The first frames queue: the first few start at once, each that lands lets the next start; once play is
  // pressed (or the stems are decoded) everything is allowed.
  const [settled, setSettled] = useState(0);
  const videoRank = useMemo(() => {
    let rank = 0;
    return tracks.map((track) => (pickJamVideoUrl(track) ? rank++ : -1));
  }, [tracks]);

  return (
    <div className="relative w-full">
      <MosaicGrid layout={layout} order={order} label={label} className="rounded-[var(--radius-panel)]">
        {items.map((item, index) =>
          item.kind === "need" ? (
            <NeedTile key={`need-${item.instrument}`} instrument={item.instrument} onClick={() => onRecord(item.instrument)} />
          ) : (
            <PartTile
              key={item.track.id}
              index={index}
              track={item.track}
              player={player}
              playing={state.playing}
              stemsReady={state.stemsReady}
              parts={tracks.length}
              fetchStill={state.playing || state.stemsReady || tracks.length <= STILLS_IN_FLIGHT || videoRank[index]! < STILLS_IN_FLIGHT + settled}
              onSettled={() => setSettled((count) => count + 1)}
              spotlit={spotIndex === index}
              dimmed={spotIndex !== null && spotIndex !== index}
              onSelect={() => onSpot(spotIndex === index ? null : index)}
            />
          ),
        )}
      </MosaicGrid>
      {soloed && (
        <div
          data-jam-solo=""
          className="absolute left-3 top-3 z-20 inline-flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full bg-on-media py-1 pl-4 pr-1 text-[13px] font-bold text-media-scrim"
        >
          <span className="truncate">
            {jt("spot.only", { name: personLabel(soloed.person), instrument: partLabel(soloed).toLowerCase() })}
          </span>
          <button
            type="button"
            onClick={() => onSpot(null)}
            aria-label={jt("spot.back")}
            data-jam-solo-exit=""
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-media-scrim text-on-media outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
