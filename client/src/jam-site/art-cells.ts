import type { PublicJamSong } from "@pqp/shared";
import { asInstrument, type Instrument } from "./instruments";

/**
 * What a song's small picture (a card, the featured hero) is made of. There is
 * no thumbnail per part on a list (a part's video is not in the list payload,
 * and the home never downloads media), so a part is a square in its
 * instrument's colour.
 *
 * The song's COVER is not one of the squares. It used to be the first one, and
 * on a card a painting next to a drum square read as a part somebody played;
 * it is a small cover thumbnail beside the title now, the way the song page
 * has it (`SongCover` in `art.tsx`).
 *
 * A card holds at most `max` squares. When there are more, the squares that say
 * something nobody can read elsewhere win: the dashed "your part" squares (one
 * per instrument the song still asks for, at most two), then the parts in the
 * order they were recorded; whatever does not fit is ONE "+N" square at the
 * end (with the instruments behind it), not a badge floating on a picture.
 */
export type ArtCell =
  | { kind: "part"; instrument: Instrument; name: string; avatarUrl: string | null; index: number }
  | { kind: "need"; instrument: Instrument }
  | { kind: "more"; count: number; instruments: Instrument[] };

export function artCells(song: Pick<PublicJamSong, "parts" | "needs">, max: number): ArtCell[] {
  const needs: ArtCell[] = song.needs
    .slice(0, 2)
    .map((instrument) => ({ kind: "need" as const, instrument: asInstrument(instrument) }));
  const parts = song.parts.map((part, index) => ({
    kind: "part" as const,
    instrument: asInstrument(part.instrument),
    name: part.person.name,
    avatarUrl: part.person.avatarUrl ?? null,
    index,
  }));
  const room = Math.max(1, max);
  if (parts.length + needs.length === 0) {
    // A song with nothing public to show (it is not listed, but be whole).
    return [];
  }
  if (parts.length + needs.length <= room) {
    return [...parts, ...needs];
  }
  // One square is the "+N", so the rest share room - 1.
  const slots = room - 1;
  const keptNeeds = needs.slice(0, Math.min(needs.length, slots));
  const keptParts = parts.slice(0, Math.max(0, slots - keptNeeds.length));
  const hidden = parts.slice(keptParts.length);
  const count = hidden.length + (needs.length - keptNeeds.length);
  const instruments = [...new Set(hidden.map((part) => part.instrument))];
  return [...keptParts, ...keptNeeds, { kind: "more", count, instruments }];
}
