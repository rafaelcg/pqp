/**
 * What a part of a song looks like when it has no video, ONE table for both
 * places that draw a mosaic: the public site (`jam-site/`) and the app's song
 * view (`components/jam/jam-stage.tsx`).
 *
 * The ground is ONE neutral token (`--color-tile`, `index.css`) for every
 * instrument. It used to be a tint of the instrument's hue, first translucent
 * (14% and 30% washes, which disagreed between the two places) and then opaque
 * (deep tints and pastels, which still put six muddy colours side by side on
 * one page and scored 5.5 to 6 on colour three rounds running). Now the hue
 * lives only where it identifies: the chip, the glyph, the level strip, the
 * initial and a dashed outline, all in the instrument's INK
 * (`--color-tile-<instrument>-ink`: the pale end on the dark theme, the deep
 * end on the light one, each clearing 3:1 on the ground; the bench measures it
 * for every instrument in every look).
 *
 * Class strings are written out in full because Tailwind finds a class by
 * reading the source text.
 */
export type JamTileInstrument = "guitar" | "bass" | "drums" | "vocals" | "keys" | "other";

export interface JamTileLook {
  /** The flat neutral ground of a part with no video: the same for every instrument. */
  ground: string;
  /** The glyph, the level strip and a dashed outline: a text colour (`currentColor`). */
  ink: string;
  /** The dashed outline of an empty slot. */
  dashed: string;
  /** The initial of a person with no picture: their ink on a neutral disc. */
  solid: string;
  /** A hairline in the ink around the instrument's chip, so a pale chip (yellow, cyan) keeps its edge on a pale light-theme tile. */
  chip: string;
}

const GROUND = "bg-tile";
const DISC = "bg-tile-disc";

export const JAM_TILE_LOOK: Record<JamTileInstrument, JamTileLook> = {
  guitar: { ground: GROUND, ink: "text-tile-guitar-ink", dashed: "border-tile-guitar-ink", solid: `${DISC} text-tile-guitar-ink`, chip: "outline outline-1 -outline-offset-1 outline-tile-guitar-ink/40" },
  bass: { ground: GROUND, ink: "text-tile-bass-ink", dashed: "border-tile-bass-ink", solid: `${DISC} text-tile-bass-ink`, chip: "outline outline-1 -outline-offset-1 outline-tile-bass-ink/40" },
  drums: { ground: GROUND, ink: "text-tile-drums-ink", dashed: "border-tile-drums-ink", solid: `${DISC} text-tile-drums-ink`, chip: "outline outline-1 -outline-offset-1 outline-tile-drums-ink/40" },
  vocals: { ground: GROUND, ink: "text-tile-vocals-ink", dashed: "border-tile-vocals-ink", solid: `${DISC} text-tile-vocals-ink`, chip: "outline outline-1 -outline-offset-1 outline-tile-vocals-ink/40" },
  keys: { ground: GROUND, ink: "text-tile-keys-ink", dashed: "border-tile-keys-ink", solid: `${DISC} text-tile-keys-ink`, chip: "outline outline-1 -outline-offset-1 outline-tile-keys-ink/40" },
  other: { ground: GROUND, ink: "text-tile-other-ink", dashed: "border-tile-other-ink", solid: `${DISC} text-tile-other-ink`, chip: "outline outline-1 -outline-offset-1 outline-tile-other-ink/40" },
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
