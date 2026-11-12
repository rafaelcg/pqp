import type { PublicJamSong } from "@pqp/shared";
import { useMemo, useState } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { artCells } from "./art-cells";
import { mosaicLayout } from "./mosaic";
import { MosaicGrid, MoreStill, NeedStill, StillTile } from "./tiles";
import { cn, instrumentName } from "./util";

/**
 * A song's small picture (a card, the featured hero): a square per part, in the
 * instrument's colour with a strip of the song's own peaks, a dashed one for
 * what it still needs and one "+N" for what did not fit, laid out by the same
 * mosaic the song page uses. Nothing here touches a part's media: the song's
 * own peaks only, so a list of forty songs costs no audio and no video.
 *
 * The cover is NOT part of it (`SongCover`, a small thumbnail beside the
 * title): a painting drawn as one of the squares read as a part somebody played.
 */

const BARS = 9;

/** `count` heights from the song's peaks, a different stretch for each square. */
export function stillBars(peaks: readonly number[], slot: number, seed: string): number[] {
  if (peaks.length >= BARS) {
    let max = 0;
    for (const value of peaks) if (value > max) max = value;
    const scale = max > 0.02 ? 1 / max : 1;
    const stride = Math.max(1, Math.floor(peaks.length / (BARS * 2)));
    const start = (slot * Math.max(1, Math.floor(stride * 3))) % Math.max(1, peaks.length - BARS * stride);
    return Array.from({ length: BARS }, (_, k) => Math.min(1, (peaks[start + k * stride] ?? 0) * scale));
  }
  // No peaks (a song so new the worker has none yet): a stable pattern from the name.
  let h = 2166136261;
  for (const ch of `${seed}${slot}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  }
  return Array.from({ length: BARS }, (_, k) => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return 0.25 + ((h >>> 0) % 1000) / 1400 + (k % 3 === 0 ? 0.08 : 0);
  });
}

export function SongArt({
  song,
  variant,
  className,
}: {
  song: Pick<PublicJamSong, "title" | "parts" | "needs" | "previewPeaks">;
  variant: "card" | "hero";
  className?: string;
}) {
  const cells = useMemo(() => artCells(song, variant === "hero" ? 6 : 4), [song, variant]);
  const layout = useMemo(
    () => mosaicLayout(Math.max(1, cells.length), variant === "hero" ? 1.6 : 0.8),
    [cells.length, variant],
  );
  if (cells.length === 0) {
    return <div className={cn("aspect-square w-full bg-surface-2", className)} />;
  }
  return (
    <div className={cn("relative", className)}>
      <MosaicGrid layout={layout} aspect={variant === "card" ? 1 : undefined}>
        {cells.map((cell, slot) => {
          if (cell.kind === "more") {
            return (
              <div
                key="more"
                className="absolute inset-0"
                role="img"
                aria-label={jt("art.more", { count: cell.count })}
              >
                <MoreStill count={cell.count} instruments={cell.instruments} />
              </div>
            );
          }
          if (cell.kind === "need") {
            return (
              <div key={`need-${cell.instrument}`} className="absolute inset-0" role="img" title={jt(`needs.${cell.instrument}` as Parameters<typeof jt>[0])} aria-label={jt(`needs.${cell.instrument}` as Parameters<typeof jt>[0])}>
                <NeedStill
                  instrument={cell.instrument}
                  label={variant === "hero" ? jt(`tile.yours.${cell.instrument}` as Parameters<typeof jt>[0]) : undefined}
                />
              </div>
            );
          }
          return (
            <StillTile
              key={`part-${cell.index}`}
              instrument={cell.instrument}
              name={variant === "hero" ? cell.name : undefined}
              bars={stillBars(song.previewPeaks, slot, `${song.title}${cell.name}`)}
            />
          );
        })}
      </MosaicGrid>
      <span className="sr-only">
        {song.parts.map((part) => `${part.person.name} ${instrumentName(part.instrument)}`).join(", ")}
      </span>
    </div>
  );
}

/**
 * The song's cover as a small thumbnail (a card's title row, the hero's
 * heading): the same small, rounded picture the song page shows at the top of
 * the page, never a tile of the mosaic. Renders nothing without one, or when
 * it fails to load.
 */
export function SongCover({
  title,
  coverUrl,
  className,
}: {
  title: string;
  coverUrl: string | null;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!coverUrl || broken) return null;
  return (
    <img
      src={coverUrl}
      alt={jt("art.cover", { title })}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setBroken(true)}
      data-jam-cover=""
      className={cn("shrink-0 rounded-[var(--radius-card)] bg-surface-2 object-cover", className)}
    />
  );
}
