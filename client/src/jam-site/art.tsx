import type { PublicJamSong } from "@pqp/shared";
import { useMemo, useState } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { JamGeneratedCover } from "@/lib/jam-generated-cover";
import { artCells } from "./art-cells";
import { mosaicLayout } from "./mosaic";
import { MosaicGrid, MoreStill, NeedStill, StillTile } from "./tiles";
import { cn, instrumentName } from "./util";

/**
 * A song's small picture (a card, the featured hero): a square per part, the
 * person on a neutral tile with the instrument's chip, a dashed one for what it
 * still needs and one "+N" for what did not fit, laid out by the same mosaic the
 * song page uses. Nothing here touches a part's media, so a list of forty songs
 * costs no audio and no video, and it draws no level strip (a card is at rest).
 *
 * The cover is NOT part of it (`SongCover`, a small thumbnail beside the
 * title): a painting drawn as one of the squares read as a part somebody played.
 */

export function SongArt({
  song,
  variant,
  className,
}: {
  song: Pick<PublicJamSong, "title" | "parts" | "needs">;
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
        {cells.map((cell) => {
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
              name={cell.name}
              avatarUrl={cell.avatarUrl}
              caption={variant === "hero"}
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
 * heading, the song page's top): the same small, rounded picture everywhere,
 * never a tile of the mosaic. A song with no cover (or one that fails to load)
 * gets the generated one (`JamGeneratedCover`: flat shapes in the colours of
 * its instruments, the same for the same song on every surface), so a card
 * never has a hole where a picture goes and a rough upload does not look broken.
 */
export function SongCover({
  song,
  className,
}: {
  song: Pick<PublicJamSong, "id" | "title" | "coverUrl" | "parts">;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!song.coverUrl || broken) {
    return (
      <span aria-hidden="true" data-jam-cover="generated" className={cn("relative block shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-surface-2", className)}>
        <JamGeneratedCover songId={song.id} instruments={song.parts.map((part) => part.instrument)} />
      </span>
    );
  }
  return (
    <img
      src={song.coverUrl}
      alt={jt("art.cover", { title: song.title })}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setBroken(true)}
      data-jam-cover=""
      className={cn("shrink-0 rounded-[var(--radius-card)] bg-surface-2 object-cover", className)}
    />
  );
}
