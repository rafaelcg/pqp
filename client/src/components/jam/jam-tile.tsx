import type { JamSongSummary } from "@pqp/shared";
import { Lock, Mic, Play, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "@/lib/i18n";
import type { JamDetail } from "@/lib/jam-state";
import { useJamStoreEpoch } from "@/lib/jam-store";
import {
  JAM_TILE_SPAN,
  barsFromPeaks,
  formatClock,
  seededBars,
  songNeed,
  type JamTileSize,
} from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { useBarCount } from "./jam-bars";
import { useNeedLabel } from "./jam-need";
import { BandStrip, ContributorStack, coverGradient, Equalizer, MirrorBars, NeedChip } from "./jam-art";

/**
 * One song on the wall, drawn from the song summary alone: the cover is a
 * gradient through the colours of the instruments on it, the loudest stem's
 * waveform (`previewPeaks`) runs across it, the band strip says who is in and
 * who is missing, and the faces of the people on it sit by the title. "Falta
 * voz" is the loudest thing on a tile that is asking for somebody.
 *
 * Only a song WITH a video reads its detail (for the video's address), and only
 * once the tile comes near the screen; every other tile is complete from the
 * list read.
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

  const [waveRef, count] = useBarCount(big ? 9 : 7, 72);
  const bars = useMemo(
    () =>
      count === 0
        ? []
        : song.previewPeaks.length > 0
          ? barsFromPeaks(song.previewPeaks, count)
          : seededBars(song.id, count),
    [count, song.previewPeaks, song.id],
  );

  const who = names(song, t("jam.tile.anonymous"));
  const needText = needLabel(need);
  const subtitle = song.artist ?? t("jam.original");
  const label = `${song.title}, ${subtitle}, ${who}, ${needText}${song.joinMode === "closed" ? `, ${t("jam.tile.closed")}` : ""}`;
  const onVideo = Boolean(videoUrl) && posterReady;
  // The words always sit on a dark scrim at the foot of the cover, so a title
  // reads the same on every tile whatever colours the band painted above it.
  const ink = "text-on-media";
  const ink2 = "text-on-media-muted";

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
        style={{ "--jam-i": Math.min(index, 10), viewTransitionName: selected ? undefined : `jam-cover-${song.id}` } as CSSProperties}
        className={cn(
          "group relative isolate h-full w-full min-w-0 overflow-hidden rounded-[var(--radius-panel)] text-left outline-none",
          // A wide tile is two columns: the words on the left, the waveform on the right.
          wide ? "grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] grid-rows-[auto_1fr_auto] gap-x-4" : "flex flex-col justify-between",
          "transition-[transform,box-shadow] duration-[var(--duration-base)] ease-[var(--ease-standard)]",
          "focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0",
          "active:scale-[0.98] motion-safe:hover:-translate-y-1 hover:shadow-[var(--shadow-2)]",
          big ? "p-5" : "p-3.5",
          coverGradient(song.instruments),
          ink,
          selected && "ring-2 ring-text ring-offset-2 ring-offset-surface-0",
          entrance && "jam-tile-in",
          fresh && "jam-tile-arrive",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -z-10",
            wide
              ? "inset-y-0 left-0 w-[62%] bg-gradient-to-r from-media-scrim/90 via-media-scrim/60 to-media-scrim/0"
              : "inset-x-0 bottom-0 h-[64%] bg-gradient-to-t from-media-scrim/95 via-media-scrim/60 to-media-scrim/0",
          )}
        />
        {videoUrl && (
          <>
            <video
              ref={videoRef}
              src={`${videoUrl}#t=0.5`}
              muted
              loop
              playsInline
              preload="metadata"
              aria-hidden="true"
              tabIndex={-1}
              onLoadedData={() => setPosterReady(true)}
              className={cn(
                "absolute inset-0 -z-10 h-full w-full object-cover transition-opacity duration-[var(--duration-slow)]",
                posterReady ? "opacity-100" : "opacity-0",
              )}
            />
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-0 -z-10 bg-gradient-to-t from-media-scrim via-media-scrim/40 to-media-scrim/0 transition-opacity duration-[var(--duration-slow)]",
                posterReady ? "opacity-100" : "opacity-0",
              )}
            />
          </>
        )}

        {/* top: who is in the band, and how long it is */}
        <span className={cn("flex min-w-0 items-start justify-between gap-2", wide && "col-start-1 row-start-1")}>
          <BandStrip instruments={song.instruments} missing={missing} size={big ? "md" : "sm"} />
          <span className="flex shrink-0 items-center gap-1.5">
            {playing && (
              <span className="flex h-6 items-center gap-1 rounded-full bg-on-inst px-2 text-accent">
                <Equalizer />
              </span>
            )}
            {song.hasVideo && (
              <span className="grid h-6 w-6 place-items-center rounded-full bg-on-inst text-on-media" aria-hidden="true">
                <Video className="h-3.5 w-3.5" />
              </span>
            )}
            {song.joinMode === "closed" && (
              <span className="grid h-6 w-6 place-items-center rounded-full bg-on-inst text-on-media" aria-hidden="true">
                <Lock className="h-3 w-3" data-jam-tile-closed="" />
              </span>
            )}
            {big && (song.mixDurationMs ?? 0) > 0 && (
              <span className="flex h-6 items-center rounded-full bg-on-inst px-2 text-[11px] font-bold tabular-nums text-on-media">
                {formatClock(song.mixDurationMs ?? 0)}
              </span>
            )}
          </span>
        </span>

        {/* the waveform, in its own band of the cover so it never runs under the title */}
        <span
          ref={waveRef}
          aria-hidden="true"
          className={cn(
            "pointer-events-none relative block min-h-0 flex-1 transition-opacity duration-[var(--duration-slow)]",
            big ? "my-4" : wide ? "col-start-2 row-span-3 row-start-1 my-1" : "my-2",
            onVideo && "opacity-0",
          )}
        >
          <MirrorBars
            bars={bars}
            className="absolute inset-0"
            barClassName="bg-on-inst/80"
            animate={entrance || fresh}
          />
        </span>

        {/* bottom: the title, the people, the call */}
        <span className={cn("flex min-w-0 flex-col", big ? "gap-2" : "gap-1.5", wide && "col-start-1 row-start-3")}>
          <span
            className={cn(
              "font-display font-extrabold leading-[1.05] tracking-tight [text-wrap:balance]",
              big ? "line-clamp-2 text-4xl" : size === "small" ? "line-clamp-1 text-lg" : "line-clamp-2 text-[22px]",
            )}
          >
            {song.title}
          </span>
          {size !== "small" && (
            <span className={cn("flex min-w-0 items-center gap-2 text-xs font-semibold", ink2)}>
              <ContributorStack
                people={song.contributors}
                total={song.contributorCount}
                size={big ? "md" : "sm"}
                ringClassName="ring-media-scrim"
              />
              <span className="truncate">{`${subtitle} · ${who}`}</span>
            </span>
          )}
          <span className="flex min-w-0 items-center justify-between gap-2">
            <NeedChip need={need} />
            {/* the play disc: the tile opens the song and it starts playing */}
            {size !== "small" && (
            <span
              aria-hidden="true"
              className={cn(
                "grid shrink-0 place-items-center rounded-full shadow-[var(--shadow-2)] transition-[transform,opacity] duration-[var(--duration-base)] ease-[var(--ease-emphasized)]",
                big ? "h-12 w-12" : "h-9 w-9",
                playing
                  ? "bg-accent text-on-accent opacity-100"
                  : "bg-on-media text-media-scrim",
                playing
                  ? ""
                  : "opacity-0 motion-safe:translate-y-1 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
              )}
            >
              {playing ? <Equalizer /> : <Play className={cn("ml-0.5", big ? "h-5 w-5" : "h-4 w-4")} fill="currentColor" />}
            </span>
            )}
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
        style={{ "--jam-i": Math.min(index, 10) } as CSSProperties}
        className={cn(
          "group flex h-full w-full min-w-0 flex-col items-center justify-center gap-2.5 rounded-[var(--radius-panel)] border-2 border-dashed border-border-strong p-3.5 text-center text-text-secondary outline-none transition-[transform,background,color,border-color] duration-[var(--duration-base)] hover:border-accent hover:bg-surface-1 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
          entrance && "jam-tile-in",
        )}
      >
        <span className="relative grid h-12 w-12 place-items-center rounded-full bg-accent text-on-accent transition-transform duration-[var(--duration-base)] ease-[var(--ease-emphasized)] motion-safe:group-hover:scale-110">
          <span aria-hidden="true" className="jam-invite-ping absolute inset-0 rounded-full ring-2 ring-accent" />
          <Mic className="relative h-5 w-5" aria-hidden="true" />
        </span>
        <span className="font-display text-base font-extrabold text-text">{t("jam.tile.invite")}</span>
        <span className="text-xs text-text-tertiary">{t("jam.tile.inviteHint")}</span>
      </button>
    </li>
  );
}
