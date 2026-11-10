import type { JamInstrument, JamSongSummary } from "@pqp/shared";
import { Lock, Mic, Play, Plus, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "@/lib/i18n";
import type { JamDetail } from "@/lib/jam-state";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { useJamStoreEpoch } from "@/lib/jam-store";
import {
  JAM_TILE_SPAN,
  barsFromPeaks,
  rotateBars,
  seededBars,
  songNeed,
  stretchBars,
  type JamTileSize,
} from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { useBarCount } from "./jam-bars";
import { useNeedLabel } from "./jam-need";
import { bandOrder, ContributorStack, Equalizer, MirrorBars, NeedChip } from "./jam-art";

/**
 * One song on the wall, drawn from the song summary alone. Its picture IS the
 * song: one band per instrument on it, stacked like the lanes of the song, each
 * in its instrument's colour with the song's waveform running through it, and
 * a dashed band where a part is still missing. So a bass-only riff is one blue
 * band, a full song is four, and a song asking for a voice shows the empty
 * voice band before a word is read.
 *
 * Only a song WITH a video reads its detail (for the video's address), and only
 * once the tile comes near the screen; its first frame then takes the picture's
 * place and plays muted under the pointer.
 */

export interface JamTileProps {
  song: JamSongSummary;
  size: JamTileSize;
  detail?: JamDetail;
  index: number;
  /** Arrived while the wall was open: grows in and draws a ring. */
  fresh?: boolean;
  /** Played the staggered entrance (the wall's first paint). */
  entrance?: boolean;
  selected?: boolean;
  /** The open song, and it is playing: the tile dances. */
  playing?: boolean;
  /** A tile with a video came near the screen: the wall reads its detail for the address. */
  onNear?: () => void;
  onOpen: () => void;
}

/** A soft light of the song's first instrument from the top of its tile. */
const GLOW: Record<JamInstrument, string> = {
  guitar: "from-inst-guitar/20",
  bass: "from-inst-bass/20",
  drums: "from-inst-drums/20",
  vocals: "from-inst-vocals/20",
  keys: "from-inst-keys/20",
  other: "from-inst-other/20",
};

function names(song: JamSongSummary, anonymous: string): string {
  const people = song.contributors.length > 0 ? song.contributors.map((one) => one.name ?? anonymous) : [song.authorName ?? anonymous];
  return people.join(", ");
}

export function JamTile({ song, size, detail, index, fresh, entrance, selected, playing, onNear, onOpen }: JamTileProps) {
  const { t } = useTranslation();
  const needLabel = useNeedLabel();
  const need = songNeed(song);
  const missing = need.kind === "missing" ? need.instruments : song.missingInstruments;
  const big = size === "hero";
  const wide = size === "wide";
  const small = size === "small";

  // Near the screen, once: only a tile with a video has anything to read.
  const tileRef = useRef<HTMLLIElement | null>(null);
  const [near, setNear] = useState(false);
  const storeEpoch = useJamStoreEpoch();
  useEffect(() => {
    const element = tileRef.current;
    if (!element || near || !song.hasVideo) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, song.hasVideo]);
  useEffect(() => {
    if (near) {
      onNear?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when it comes near, and again after the store was emptied for another account
  }, [near, storeEpoch]);

  const videoTrack = detail?.tracks.find((track) => track.videoUrl && track.inMix) ?? detail?.tracks.find((track) => track.videoUrl);
  const videoUrl = near ? (videoTrack?.videoUrl ?? null) : null;
  const [posterReady, setPosterReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onVideo = Boolean(videoUrl) && posterReady;

  const [artRef, count] = useBarCount(big ? 7 : 6, 72);
  const shape = useMemo(
    () =>
      count === 0
        ? []
        : stretchBars(song.previewPeaks.length > 0 ? barsFromPeaks(song.previewPeaks, count) : seededBars(song.id, count)),
    [count, song.previewPeaks, song.id],
  );
  const band = bandOrder(song.instruments);
  const main = band[0] ?? "other";

  const who = names(song, t("jam.tile.anonymous"));
  const needText = needLabel(need);
  const subtitle = song.artist ?? t("jam.original");
  const label = `${song.title}, ${subtitle}, ${who}, ${needText}${song.joinMode === "closed" ? `, ${t("jam.tile.closed")}` : ""}`;

  return (
    <li ref={tileRef} className={cn("flex min-w-0", JAM_TILE_SPAN[size])}>
      <button
        type="button"
        onClick={onOpen}
        onPointerEnter={() => {
          if (videoRef.current && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
            void videoRef.current.play().catch(() => undefined);
          }
        }}
        onPointerLeave={() => videoRef.current?.pause()}
        aria-label={label}
        aria-current={selected ? "true" : undefined}
        data-jam-tile={song.id}
        data-jam-tile-size={size}
        data-playing={playing ? "true" : undefined}
        style={{ "--jam-i": Math.min(index, 6), viewTransitionName: selected ? undefined : `jam-cover-${song.id}` } as CSSProperties}
        className={cn(
          "group relative isolate h-full w-full min-w-0 cursor-pointer overflow-hidden rounded-[var(--radius-panel)] bg-surface-1 bg-gradient-to-b to-transparent to-70% text-left outline-none ring-1 ring-inset ring-border",
          GLOW[main],
          wide ? "grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4" : "flex flex-col",
          big ? "gap-4 p-4" : "gap-3 p-3",
          "transition-[transform,box-shadow] duration-[var(--duration-base)] ease-[var(--ease-standard)]",
          "focus-visible:ring-2 focus-visible:ring-focus-ring",
          "active:scale-[0.98] motion-safe:hover:-translate-y-1 hover:shadow-[var(--shadow-2)]",
          selected && "ring-2 ring-text",
          entrance && "jam-tile-in",
          fresh && "jam-tile-arrive",
        )}
      >
        {/* the picture: the band, stacked; or the video when there is one */}
        <span
          ref={artRef}
          aria-hidden="true"
          className={cn(
            "relative flex min-h-0 flex-col justify-center overflow-hidden rounded-[var(--radius-card)] bg-surface-0/70",
            wide ? "col-start-2 h-full" : "flex-1",
            big ? "gap-2 p-3" : small ? "gap-1 p-2" : "gap-1.5 p-2.5",
          )}
        >
          {!onVideo &&
            band.map((instrument, lane) => (
              <span
                key={instrument}
                className={cn(
                  "relative block min-h-2.5 flex-1 overflow-hidden rounded-[var(--radius-control)]",
                  band.length + missing.length > 1 && (big ? "max-h-14" : "max-h-10"),
                  JAM_INSTRUMENT_LOOK[instrument].fill,
                )}
              >
                <MirrorBars
                  bars={rotateBars(shape, lane * 7)}
                  className={cn("absolute inset-x-2.5 inset-y-[18%]", big ? "gap-[3px]" : "gap-[2px]")}
                  barClassName="bg-on-inst/80"
                  animate={entrance || fresh}
                />
              </span>
            ))}
          {!onVideo &&
            missing.map((instrument) => {
              const look = JAM_INSTRUMENT_LOOK[instrument];
              const Icon = look.icon;
              return (
                <span
                  key={`missing-${instrument}`}
                  className={cn(
                    "flex min-h-2.5 flex-1 items-center justify-center gap-1 rounded-[var(--radius-control)] border-2 border-dashed border-current",
                    big ? "max-h-14" : "max-h-10",
                    look.ink,
                  )}
                >
                  {!small && <Plus className="h-3 w-3" strokeWidth={3} />}
                  {!small && <Icon className="h-3.5 w-3.5" />}
                </span>
              );
            })}
          {videoUrl && (
            <video
              ref={videoRef}
              src={`${videoUrl}#t=3`}
              muted
              loop
              playsInline
              preload="metadata"
              aria-hidden="true"
              tabIndex={-1}
              onLoadedData={() => setPosterReady(true)}
              className={cn(
                "absolute inset-0 h-full w-full object-cover transition-opacity duration-[var(--duration-slow)]",
                posterReady ? "opacity-100" : "opacity-0",
              )}
            />
          )}
          {/* the corner marks: video, closed */}
          {(song.hasVideo || song.joinMode === "closed") && (
            <span className="absolute right-1.5 top-1.5 flex items-center gap-1">
              {song.hasVideo && (
                <span className="grid h-6 w-6 place-items-center rounded-full bg-media-scrim/85 text-on-media">
                  <Video className="h-3.5 w-3.5" />
                </span>
              )}
              {song.joinMode === "closed" && (
                <span className="grid h-6 w-6 place-items-center rounded-full bg-media-scrim/85 text-on-media">
                  <Lock className="h-3 w-3" data-jam-tile-closed="" />
                </span>
              )}
            </span>
          )}
        </span>

        {/* the words: title, people, what it needs, and play */}
        <span className={cn("flex min-w-0 flex-col justify-end", big ? "gap-2" : "gap-1.5", wide && "col-start-1 row-start-1")}>
          <span
            className={cn(
              "font-display font-extrabold leading-[1.08] tracking-[-0.01em] text-text [text-wrap:balance]",
              big ? "line-clamp-2 text-4xl" : small ? "line-clamp-2 text-[17px]" : "line-clamp-2 text-[22px]",
            )}
          >
            {song.title}
          </span>
          {!small && (
            <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-text-secondary">
              <ContributorStack people={song.contributors} total={song.contributorCount} size={big ? "md" : "sm"} ringClassName="ring-surface-1" />
              <span className="truncate">{`${subtitle} · ${who}`}</span>
            </span>
          )}
          <span className="flex min-w-0 items-center justify-between gap-2">
            <NeedChip need={need} tone="line" compact={small} />
            <span
              aria-hidden="true"
              className={cn(
                "grid shrink-0 place-items-center rounded-full transition-[transform,background-color] duration-[var(--duration-base)] ease-[var(--ease-emphasized)]",
                big ? "h-12 w-12" : small ? "h-8 w-8 max-sm:hidden" : "h-8 w-8",
                playing
                  ? "bg-accent text-on-accent"
                  : big
                    ? "bg-text text-surface-0 group-hover:scale-110"
                    : "bg-surface-3 text-text group-hover:scale-110 group-hover:bg-text group-hover:text-surface-0 group-focus-visible:bg-text group-focus-visible:text-surface-0",
              )}
            >
              {playing ? <Equalizer /> : <Play className={cn("ml-0.5", big ? "h-5 w-5" : "h-3.5 w-3.5")} fill="currentColor" />}
            </span>
          </span>
        </span>

        {fresh && (
          <span
            aria-hidden="true"
            className="jam-arrive-ring pointer-events-none absolute inset-0 rounded-[var(--radius-panel)] ring-2 ring-accent"
          />
        )}
      </button>
    </li>
  );
}

/** The last tile: an invitation to record, not a song. */
export function JamInviteTile({
  index,
  entrance,
  disabled,
  onRecord,
}: {
  index: number;
  entrance?: boolean;
  disabled?: boolean;
  onRecord: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex min-w-0">
      <button
        type="button"
        onClick={onRecord}
        disabled={disabled}
        data-jam-invite=""
        style={{ "--jam-i": Math.min(index, 6) } as CSSProperties}
        className={cn(
          "group flex h-full w-full min-w-0 flex-col items-center justify-center gap-2.5 rounded-[var(--radius-panel)] border-2 border-dashed border-border-strong p-3.5 text-center text-text-secondary outline-none transition-[transform,background,color,border-color] duration-[var(--duration-base)] hover:border-accent hover:bg-surface-1 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
          entrance && "jam-tile-in",
        )}
      >
        <span className="relative grid h-12 w-12 place-items-center rounded-full bg-accent text-on-accent transition-transform duration-[var(--duration-base)] ease-[var(--ease-emphasized)] motion-safe:group-hover:scale-110">
          <Mic className="relative h-5 w-5" aria-hidden="true" />
        </span>
        <span className="font-display text-base font-extrabold text-text">{t("jam.tile.invite")}</span>
        <span className="text-[13px] text-text-secondary">{t("jam.tile.inviteHint")}</span>
      </button>
    </li>
  );
}
