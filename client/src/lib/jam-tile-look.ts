/**
 * What a part of a song looks like when it has no video, ONE table for both
 * places that draw a mosaic: the public site (`jam-site/`) and the app's song
 * view (`components/jam/jam-stage.tsx`). Before this there were two, and they
 * disagreed: the site's tiles were the instrument's colour at 14% over the
 * media black, the app's were 30% over a panel grey, and neither read as the
 * same product (on a light page the site's were charcoal blocks).
 *
 * The colours are OPAQUE role tokens (`--color-tile-*`, `index.css`), made once
 * per theme: a deep tint of the hue on the dark theme, a pastel on the light
 * one, each with an ink that clears 3:1 on it, and the page's text colour
 * clears 4.5:1 on every ground (the bench measures both). Nothing here is a
 * translucent wash: several washes of different hues on one dark ground turn
 * to mud, which is the bug this replaces.
 *
 * Class strings are written out in full because Tailwind finds a class by
 * reading the source text.
 */
export type JamTileInstrument = "guitar" | "bass" | "drums" | "vocals" | "keys" | "other";

export interface JamTileLook {
  /** The flat ground of a part with no video. */
  ground: string;
  /** The glyph, the level strip and a dashed outline: a text colour (`currentColor`). */
  ink: string;
  /** The dashed outline of an empty slot. */
  dashed: string;
  /** A solid disc in the ink with the ground as its letter: a person with no picture, readable on their own ground. */
  solid: string;
}

export const JAM_TILE_LOOK: Record<JamTileInstrument, JamTileLook> = {
  guitar: { ground: "bg-tile-guitar", ink: "text-tile-guitar-ink", dashed: "border-tile-guitar-ink", solid: "bg-tile-guitar-ink text-tile-guitar" },
  bass: { ground: "bg-tile-bass", ink: "text-tile-bass-ink", dashed: "border-tile-bass-ink", solid: "bg-tile-bass-ink text-tile-bass" },
  drums: { ground: "bg-tile-drums", ink: "text-tile-drums-ink", dashed: "border-tile-drums-ink", solid: "bg-tile-drums-ink text-tile-drums" },
  vocals: { ground: "bg-tile-vocals", ink: "text-tile-vocals-ink", dashed: "border-tile-vocals-ink", solid: "bg-tile-vocals-ink text-tile-vocals" },
  keys: { ground: "bg-tile-keys", ink: "text-tile-keys-ink", dashed: "border-tile-keys-ink", solid: "bg-tile-keys-ink text-tile-keys" },
  other: { ground: "bg-tile-other", ink: "text-tile-other-ink", dashed: "border-tile-other-ink", solid: "bg-tile-other-ink text-tile-other" },
};

/** An instrument id a newer server may send: anything unknown is "other". */
export function jamTileLook(instrument: string): JamTileLook {
  return (JAM_TILE_LOOK as Record<string, JamTileLook | undefined>)[instrument] ?? JAM_TILE_LOOK.other;
}

/**
 * Which cell of a mosaic each item goes in, for a layout whose cells are not
 * all the same size. The DOM order of the items never changes (a `<video>`
 * that moves in the document pauses), only the cell each is PLACED on does.
 *
 * The rule: a "your part here" slot never outranks a recorded part. It takes
 * the smallest cell (the last of them) and the recorded parts take the others
 * in reading order. When every cell is the same size nothing moves.
 *
 * `areas` is the area of each cell in reading order; `slots` marks the items
 * that are an invitation rather than a recording. Returns, for each item, the
 * index of its cell.
 */
export function placeItemsOnCells(areas: readonly number[], slots: readonly boolean[]): number[] {
  const result = slots.map((_, index) => index);
  if (areas.length < slots.length || !slots.some(Boolean)) {
    return result;
  }
  const smallest = Math.min(...areas);
  if (areas.every((area) => area === smallest)) {
    return result;
  }
  const taken = new Set<number>();
  const placed = new Set<number>();
  // each slot, last first, takes the last still-free cell of the smallest size
  for (let item = slots.length - 1; item >= 0; item -= 1) {
    if (!slots[item]) continue;
    for (let cell = areas.length - 1; cell >= 0; cell -= 1) {
      if (!taken.has(cell) && areas[cell] === smallest) {
        taken.add(cell);
        placed.add(item);
        result[item] = cell;
        break;
      }
    }
  }
  const rest = areas.map((_, index) => index).filter((index) => !taken.has(index));
  let next = 0;
  slots.forEach((_, item) => {
    if (placed.has(item)) return;
    result[item] = rest[next++] ?? result[item]!;
  });
  return result;
}
