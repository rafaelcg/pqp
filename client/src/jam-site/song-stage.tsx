import type { PublicJamTrack } from "@pqp/shared";
import { XIcon as X } from "./icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { pickJamVideoUrl } from "@/lib/jam-video-source";
import { asInstrument, INSTRUMENT_LOOK, type Instrument } from "./instruments";
import { levelScale, windowBars } from "./levels";
import { mosaicLayout, spotlightLayout } from "./mosaic";
import type { PublicPlayer } from "./player";
import { Badge, Glyph, LiveBars, MosaicGrid, tileGround } from "./tiles";
import { useMedia, usePlayerState } from "./use-player";
import { cn, instrumentName, personLabel } from "./util";

/**
 * THE MOSAIC of a song: every public part is a tile. A part with a video is
 * its video (a muted `<video>` that follows the song clock through the engine);
 * a part without one is a square in its instrument's colour with a level meter
 * that moves with the song. When the song still asks for somebody, a dashed
 * tile says so and opens the record sheet. Tap a tile to hear only that part,
 * large, with the band small beside it; Escape or the pill's x goes back.
 *
 * The geometry is `mosaic.ts` (pure, tested); the playing is `player.ts` (the
 * app's own engine); this file is only the drawing of the two together.
 */

const LEVEL_BARS = 15;

type Item =
  | { kind: "part"; track: PublicJamTrack }
  | { kind: "need"; instrument: Instrument };

function PartFace({ track, player, playing }: { track: PublicJamTrack; player: PublicPlayer; playing: boolean }) {
  const instrument = asInstrument(track.instrument);
  const scale = useMemo(() => levelScale(track.peaks), [track.peaks]);
  const paint = useCallback(
    (apply: (values: readonly number[]) => void) => {
      const draw = () => apply(windowBars(track, player.position(), LEVEL_BARS, scale));
      draw();
      const off = player.subscribe(draw);
      let raf = 0;
      let timer: ReturnType<typeof setInterval> | null = null;
      if (playing) {
        const reduce = (() => {
          try {
            return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          } catch {
            return false;
          }
        })();
        if (reduce) {
          timer = setInterval(draw, 250);
        } else {
          const loop = () => {
            draw();
            raf = requestAnimationFrame(loop);
          };
          raf = requestAnimationFrame(loop);
        }
      }
      return () => {
        off();
        if (raf) cancelAnimationFrame(raf);
        if (timer) clearInterval(timer);
      };
    },
    [track, player, scale, playing],
  );
  return (
    <div className={cn("@container/face absolute inset-0 flex flex-col items-center justify-center gap-3", tileGround(instrument))}>
      <Glyph instrument={instrument} className="h-[22%] w-[22%] min-h-8 min-w-8 max-h-20 max-w-20" />
      <LiveBars instrument={instrument} count={LEVEL_BARS} paint={paint} className="hidden h-[14%] min-h-6 max-h-10 @min-[7rem]/face:flex" />
    </div>
  );
}

function PartTile({
  track,
  player,
  playing,
  stemsReady,
  spotlit,
  dimmed,
  eager,
  onSelect,
}: {
  track: PublicJamTrack;
  player: PublicPlayer;
  playing: boolean;
  stemsReady: boolean;
  spotlit: boolean;
  dimmed: boolean;
  eager: boolean;
  onSelect: () => void;
}) {
  const instrument = asInstrument(track.instrument);
  const look = INSTRUMENT_LOOK[instrument];
  const name = personLabel(track.person);
  const videoUrl = useMemo(() => pickJamVideoUrl(track), [track]);
  const video = useRef<HTMLVideoElement | null>(null);
  const [shown, setShown] = useState(false);

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
      aria-label={jt("tile.listen", { name, instrument: instrumentName(instrument) })}
      data-jam-tile={track.id}
      data-jam-tile-kind={videoUrl ? "video" : "audio"}
      data-spotlit={spotlit ? "true" : undefined}
      className={cn(
        "@container/tile group/tile absolute inset-0 block h-full w-full cursor-pointer overflow-hidden bg-media-scrim text-left outline-none",
        "focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_3px_var(--color-accent)]",
        dimmed && "saturate-[0.45] brightness-[0.82]",
      )}
      style={spotlit ? { boxShadow: `inset 0 0 0 3px var(${look.token})` } : undefined}
    >
      <PartFace track={track} player={player} playing={playing} />
      {videoUrl && (
        <video
          ref={video}
          src={eager ? `${videoUrl}#t=0.1` : videoUrl}
          muted
          playsInline
          preload={eager || playing || stemsReady ? "auto" : "none"}
          aria-hidden="true"
          tabIndex={-1}
          disablePictureInPicture
          onLoadedData={() => setShown(true)}
          onError={() => setShown(false)}
          className={cn(
            "absolute inset-0 h-full w-full object-cover motion-safe:transition-opacity motion-safe:duration-[var(--duration-base)]",
            shown ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      <span className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-media-scrim/80 py-1 pl-1 pr-2.5 text-xs font-bold text-on-media backdrop-blur-sm @max-[7rem]/tile:pr-1 @min-[16rem]/tile:bottom-3 @min-[16rem]/tile:left-3 @min-[16rem]/tile:text-[13px]">
        <Badge instrument={instrument} className="h-5 w-5" />
        <span className="truncate @max-[7rem]/tile:hidden">
          {name}
          <span className="hidden font-semibold text-on-media-muted @min-[11rem]/tile:inline"> · {instrumentName(instrument)}</span>
        </span>
      </span>
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
        "@container/need group/need absolute inset-0 grid h-full w-full cursor-pointer place-items-center text-center text-on-media outline-none",
        "focus-visible:shadow-[inset_0_0_0_3px_var(--color-accent)]",
        tileGround(instrument),
      )}
    >
      <span className={cn("pointer-events-none absolute inset-3 rounded-[var(--radius-card)] border-2 border-dashed @max-[9rem]/need:inset-1.5", look.dashed)} />
      <span className="relative flex flex-col items-center gap-3 px-3">
        <Badge instrument={instrument} className="h-12 w-12 @max-[9rem]/need:h-8 @max-[9rem]/need:w-8" />
        <span className="text-[15px] font-bold leading-tight @max-[9rem]/need:hidden">
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
  const aspect = wide ? 16 / 9 : 0.8;
  const spotIndex = spot !== null && spot < tracks.length ? spot : null;
  const layout = useMemo(
    () => (spotIndex === null ? mosaicLayout(items.length, aspect) : spotlightLayout(items.length, spotIndex, aspect)),
    [items.length, spotIndex, aspect],
  );
  const eager = tracks.length <= 4;
  const soloed = spotIndex !== null ? tracks[spotIndex] : null;

  return (
    <div className="relative mx-auto w-full" style={{ maxWidth: wide ? `calc((100dvh - 12rem) * ${layout.aspect})` : undefined, minWidth: wide ? "min(100%, 36rem)" : undefined }}>
      <MosaicGrid layout={layout} label={label} className="rounded-[var(--radius-panel)]">
        {items.map((item, index) =>
          item.kind === "need" ? (
            <NeedTile key={`need-${item.instrument}`} instrument={item.instrument} onClick={() => onRecord(item.instrument)} />
          ) : (
            <PartTile
              key={item.track.id}
              track={item.track}
              player={player}
              playing={state.playing}
              stemsReady={state.stemsReady}
              spotlit={spotIndex === index}
              dimmed={spotIndex !== null && spotIndex !== index}
              eager={eager}
              onSelect={() => onSpot(spotIndex === index ? null : index)}
            />
          ),
        )}
      </MosaicGrid>
      {soloed && (
        <div
          data-jam-solo=""
          className="absolute left-3 top-3 z-20 inline-flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full bg-on-media py-1 pl-4 pr-1 text-[13px] font-bold text-media-scrim shadow-[var(--shadow-2)]"
        >
          <span className="truncate">
            {jt("spot.only", { name: personLabel(soloed.person), instrument: instrumentName(soloed.instrument) })}
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

