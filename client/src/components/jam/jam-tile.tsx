import type { JamSongSummary } from "@pqp/shared";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "@/lib/i18n";
import type { JamDetail } from "@/lib/jam-state";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import {
  JAM_TILE_SPAN,
  barsFromPeaks,
  seededBars,
  songNeed,
  tileInstrument,
  type JamTileSize,
} from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { JamBars, useBarCount } from "./jam-bars";
import { useNeedLabel } from "./jam-need";

/**
 * One song on the wall. A song with a video shows the video's first frame; one
 * without is a flat tile in its main instrument's colour drawing its waveform
 * from `peaks`. The tile says the title, who is on it and what it needs, and
 * nothing else: the song itself is one tap away.
 *
 * What the list read does not carry (the peaks, whether there is a video, the
 * names of everybody on it) comes from the song's detail when the wall has read
 * it, and the tile is complete without it: stand-in bars, the author and a
 * count.
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
  /** The tile came near the screen: the wall reads what the tile draws from. */
  onNear?: () => void;
  onOpen: () => void;
}

function whoLine(
  song: JamSongSummary,
  detail: JamDetail | undefined,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const gone = t("jam.tile.anonymous");
  if (detail) {
    const names: string[] = [];
    for (const track of detail.tracks) {
      const name = track.authorName ?? gone;
      if (!names.includes(name)) {
        names.push(name);
      }
    }
    if (names.length > 0) {
      const shown = names.slice(0, 3).join(", ");
      return names.length > 3 ? t("jam.tile.whoMore", { name: shown, count: names.length - 3 }) : shown;
    }
  }
  const author = song.authorName ?? gone;
  const others = Math.max(0, song.contributorCount - 1);
  return others > 0 ? t("jam.tile.whoMore", { name: author, count: others }) : author;
}

export function JamTile({ song, size, detail, index, fresh, entrance, selected, onNear, onOpen }: JamTileProps) {
  const { t } = useTranslation();
  const needLabel = useNeedLabel();
  const need = songNeed(song);
  const instrument = tileInstrument(song);
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const big = size !== "small";

  // Near the screen, once: the detail read and the video's first frame wait for it.
  const tileRef = useRef<HTMLLIElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = tileRef.current;
    if (!element || near) {
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
  }, [near]);
  useEffect(() => {
    if (near) {
      onNear?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when it comes near
  }, [near]);

  const videoTrack = detail?.tracks.find((track) => track.videoUrl && track.inMix) ?? detail?.tracks.find((track) => track.videoUrl);
  const hasVideo = Boolean(videoTrack?.videoUrl);
  const showVideo = hasVideo && near;
  const peaks = useMemo(() => {
    const loud = detail?.tracks.find((track) => track.inMix && track.peaks.length > 0);
    return loud?.peaks ?? [];
  }, [detail]);

  const [waveRef, count] = useBarCount(size === "small" ? 6 : 7, 90);
  const bars = useMemo(
    () => (count === 0 ? [] : peaks.length > 0 ? barsFromPeaks(peaks, count) : seededBars(song.id, count)),
    [count, peaks, song.id],
  );

  const who = whoLine(song, detail, t);
  const needText = needLabel(need);
  const subtitle = song.artist ?? t("jam.original");
  const label = `${song.title}, ${who}, ${needText}`;

  return (
    <li ref={tileRef} className={cn("flex min-w-0", JAM_TILE_SPAN[size])}>
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      data-jam-tile={song.id}
      data-jam-tile-size={size}
      style={{ "--jam-i": Math.min(index, 10) } as CSSProperties}
      className={cn(
        "group relative flex h-full w-full min-w-0 flex-col justify-between overflow-hidden rounded-[var(--radius-card)] p-3.5 text-left outline-none transition-[transform,box-shadow] duration-[var(--duration-fast)] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 active:scale-[0.98] motion-safe:hover:-translate-y-0.5",
        hasVideo ? "bg-surface-2 text-on-media" : look.fill,
        selected && "ring-2 ring-accent ring-offset-2 ring-offset-surface-0",
        entrance && "jam-tile-in",
        fresh && "jam-tile-arrive",
      )}
    >
      {showVideo && videoTrack?.videoUrl && (
        <>
          <video
            src={`${videoTrack.videoUrl}#t=0.5`}
            muted
            playsInline
            preload="metadata"
            aria-hidden="true"
            tabIndex={-1}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-media-scrim/95 via-media-scrim/60 to-media-scrim/10"
          />
        </>
      )}

      {!hasVideo && (
        <div
          ref={waveRef}
          className={cn("relative w-full", size === "hero" ? "max-h-44 min-h-16 flex-1" : big ? "h-16" : "h-9")}
        >
          <JamBars bars={bars} className="h-full" barClassName="bg-on-inst" animate={entrance || fresh} />
        </div>
      )}
      {hasVideo && <span className="relative" />}

      <span className="relative mt-2 flex min-w-0 flex-col gap-1">
        <span
          className={cn(
            "font-display font-extrabold leading-tight [text-wrap:balance]",
            size === "hero" ? "line-clamp-2 text-3xl" : big ? "line-clamp-2 text-xl" : "line-clamp-2 text-base",
          )}
        >
          {song.title}
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center gap-2 text-xs font-semibold",
            hasVideo ? "text-on-media-muted" : "text-on-inst",
          )}
        >
          <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
            {song.instruments.slice(0, 4).map((one) => {
              const Icon = JAM_INSTRUMENT_LOOK[one].icon;
              return <Icon key={one} className="h-3.5 w-3.5" />;
            })}
          </span>
          <span className="truncate">{size === "small" ? who : `${subtitle} · ${who}`}</span>
        </span>
        <span
          className={cn(
            "mt-0.5 inline-flex w-fit max-w-full items-center rounded-full bg-surface-0 px-2.5 py-0.5 text-[11px] font-bold text-text",
            need.kind === "missing" && "ring-1 ring-inset ring-text/25",
          )}
        >
          <span className="truncate">{needText}</span>
        </span>
      </span>

      {fresh && (
        <span
          aria-hidden="true"
          className="jam-arrive-ring pointer-events-none absolute inset-0 rounded-[var(--radius-card)] ring-2 ring-accent"
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
      style={{ "--jam-i": Math.min(index, 10) } as CSSProperties}
      className={cn(
        "group flex h-full w-full min-w-0 flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-border-strong p-3.5 text-center text-text-secondary outline-none transition-[transform,background,color] duration-[var(--duration-fast)] hover:bg-surface-1 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
        entrance && "jam-tile-in",
      )}
    >
      <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-2 transition-transform duration-[var(--duration-base)] motion-safe:group-hover:scale-110">
        <Plus className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="text-sm font-semibold">{t("jam.tile.invite")}</span>
      <span className="text-xs text-text-tertiary">{t("jam.tile.inviteHint")}</span>
    </button>
    </li>
  );
}
