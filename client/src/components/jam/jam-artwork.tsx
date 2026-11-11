import type { JamSongSummary, JamTrack } from "@pqp/shared";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { barsFromPeaks, rotateBars, seededBars, songNeed, stretchBars } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { bandOrder, MirrorBars } from "./jam-art";
import { useBarCount } from "./jam-bars";
import { JamCoverPhoto, type JamCoverState } from "./jam-cover";

/**
 * A song's picture, the same everywhere it is drawn (the wall's tile, the open
 * song's header, the edit sheet). It fills the positioned box it is put in and
 * NOTHING is ever drawn across it: words, people, status and play live in the
 * footer of the tile, on a surface of their own, so a cover that has its own
 * lettering is never crossed by ours.
 *
 * What it shows, first that applies:
 *   1. the cover photo the owner chose, clean;
 *   2. the people: a mosaic of the frames of the song's videos (one, two, three
 *      or four of them), cropped from the top so a face survives;
 *   3. the band: one lane per instrument on the song in its colour, with the
 *      song's own waveform, and a dashed lane where a part is still missing.
 *
 * The mosaic only exists once a video's first frame has loaded; until then (and
 * for a song with no video) the band is what shows, so the picture never blinks.
 */

export interface JamArtworkProps {
  song: JamSongSummary;
  cover: JamCoverState;
  /** The song's tracks, once known: their videos make the mosaic. */
  tracks?: readonly JamTrack[];
  /** A tile near the screen may load its videos' first frames; far away it does not. */
  loadVideo?: boolean;
  /** Bars growing in (the wall's first paint). */
  animate?: boolean;
  /** Load the cover now (the open song's header); a wall of tiles lets the browser decide. */
  eager?: boolean;
  className?: string;
}

const MOSAIC_MAX = 4;

export function JamArtwork({ song, cover, tracks, loadVideo = false, animate = false, eager = false, className }: JamArtworkProps) {
  const covered = cover.src !== null && cover.status !== "failed";
  const videos = useMemo(() => {
    if (!loadVideo || covered || !tracks) {
      return [];
    }
    const withVideo = tracks.filter((track) => track.videoUrl);
    // The ones that are heard first, then the rest; the same people the lanes show.
    return [...withVideo.filter((track) => track.inMix), ...withVideo.filter((track) => !track.inMix)].slice(0, MOSAIC_MAX);
  }, [tracks, loadVideo, covered]);
  const [ready, setReady] = useState<ReadonlySet<string>>(new Set());
  const anyReady = videos.some((track) => ready.has(track.id));

  return (
    <div className={cn("absolute inset-0 overflow-hidden bg-surface-0", className)} aria-hidden="true" data-jam-artwork={covered ? "cover" : videos.length > 0 && anyReady ? "people" : "band"}>
      {covered ? (
        <JamCoverPhoto cover={cover} eager={eager} />
      ) : (
        <>
          <BandArt song={song} animate={animate} />
          {videos.length > 0 && (
            <div
              className={cn(
                "absolute inset-0 grid gap-px bg-surface-0 transition-opacity duration-[var(--duration-slow)] motion-reduce:transition-none",
                anyReady ? "opacity-100" : "opacity-0",
                videos.length === 1 ? "grid-cols-1" : "grid-cols-2",
                videos.length === 3 && "grid-rows-2",
                videos.length === 4 && "grid-rows-2",
              )}
            >
              {videos.map((track, index) => (
                <video
                  key={track.id}
                  src={`${track.videoUrl}#t=3`}
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  tabIndex={-1}
                  data-jam-artwork-video=""
                  onLoadedData={() => setReady((before) => new Set([...before, track.id]))}
                  className={cn(
                    "h-full w-full bg-surface-2 object-cover object-[50%_28%]",
                    videos.length === 3 && index === 0 && "row-span-2",
                  )}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The band as a picture: a soft light of the song's first instrument, then one
 * lane per instrument in its colour with the waveform running through it, a
 * dashed lane for each part still missing. The lanes are capped in height, so a
 * song with one track is one calm band in the middle, never one giant waveform.
 */
export function BandArt({ song, animate = false, className }: { song: JamSongSummary; animate?: boolean; className?: string }) {
  const need = songNeed(song);
  const missing = need.kind === "missing" ? need.instruments : song.missingInstruments;
  const band = bandOrder(song.instruments);
  const main = band[0] ?? missing[0] ?? "other";
  const [ref, count] = useBarCount(6, 64);
  const shape = useMemo(
    () =>
      count === 0
        ? []
        : stretchBars(song.previewPeaks.length > 0 ? barsFromPeaks(song.previewPeaks, count) : seededBars(song.id, count)),
    [count, song.previewPeaks, song.id],
  );
  const lanes = band.length + missing.length;
  return (
    <div className={cn("@container/art absolute inset-0 flex flex-col justify-center bg-surface-0", className)} data-jam-band-art="">
      <span aria-hidden="true" className={cn("absolute inset-0 bg-gradient-to-b to-transparent to-80%", GLOW[main])} />
      <div ref={ref} className="relative flex flex-col justify-center gap-[2.2cqw] px-[9cqw] py-[9cqw]">
        {band.map((instrument, lane) => (
          <span
            key={instrument}
            className={cn("relative block h-[15cqw] overflow-hidden rounded-[var(--radius-control)]", lanes > 5 && "h-[11cqw]", JAM_INSTRUMENT_LOOK[instrument].fill)}
          >
            <MirrorBars
              bars={rotateBars(shape, lane * 7)}
              className="absolute inset-x-[2.4cqw] inset-y-[16%] gap-[2px]"
              barClassName="bg-on-inst/80"
              animate={animate}
            />
          </span>
        ))}
        {missing.map((instrument) => {
          const look = JAM_INSTRUMENT_LOOK[instrument];
          const Icon = look.icon;
          return (
            <span
              key={`missing-${instrument}`}
              className={cn(
                "flex h-[15cqw] items-center justify-center gap-1 rounded-[var(--radius-control)] border-2 border-dashed border-current",
                lanes > 5 && "h-[11cqw]",
                look.ink,
              )}
            >
              <Plus className="hidden h-3 w-3 @min-[9rem]/art:block" strokeWidth={3} />
              <Icon className="hidden h-3.5 w-3.5 @min-[9rem]/art:block" />
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** A soft light of the song's first instrument from the top of its art. */
const GLOW: Record<string, string> = {
  guitar: "from-inst-guitar/25",
  bass: "from-inst-bass/25",
  drums: "from-inst-drums/25",
  vocals: "from-inst-vocals/25",
  keys: "from-inst-keys/25",
  other: "from-inst-other/25",
};
