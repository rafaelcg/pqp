import type { PublicJamSong } from "@pqp/shared";
import { asInstrument, type Instrument } from "./instruments";

/**
 * What a song's small picture (a card, the featured hero) is made of. There is
 * no thumbnail per part on a list (a part's video is not in the list payload,
 * and the home never downloads media), so a part is a square in its
 * instrument's colour, and the cover, when it passed the scanner, is the first
 * square.
 *
 * A card holds at most `max` squares. When there are more, the squares that say
 * something nobody can read elsewhere win: the cover, then the dashed "your
 * part" squares (one per instrument the song still asks for, at most two),
 * then the parts in the order they were recorded; whatever does not fit is
 * counted in `extra` ("+2").
 */
export type ArtCell =
  | { kind: "cover"; url: string }
  | { kind: "part"; instrument: Instrument; name: string; index: number }
  | { kind: "need"; instrument: Instrument };

export function artCells(
  song: Pick<PublicJamSong, "coverUrl" | "parts" | "needs">,
  max: number,
): { cells: ArtCell[]; extra: number } {
  const cover: ArtCell[] = song.coverUrl ? [{ kind: "cover", url: song.coverUrl }] : [];
  const needs: ArtCell[] = song.needs
    .slice(0, 2)
    .map((instrument) => ({ kind: "need" as const, instrument: asInstrument(instrument) }));
  const parts: ArtCell[] = song.parts.map((part, index) => ({
    kind: "part" as const,
    instrument: asInstrument(part.instrument),
    name: part.person.name,
    index,
  }));
  const total = cover.length + needs.length + parts.length;
  if (total === 0) {
    // A song with nothing public to show (it is not listed, but be whole).
    return { cells: [], extra: 0 };
  }
  const room = Math.max(1, max);
  const keptNeeds = needs.slice(0, Math.max(0, Math.min(needs.length, room - cover.length)));
  const keptParts = parts.slice(0, Math.max(0, room - cover.length - keptNeeds.length));
  const shown = [...cover, ...keptParts, ...keptNeeds];
  // The cover first, the parts in order, and the dashed squares last.
  const hiddenParts = parts.length - keptParts.length;
  return { cells: shown, extra: hiddenParts + (needs.length - keptNeeds.length) };
}
