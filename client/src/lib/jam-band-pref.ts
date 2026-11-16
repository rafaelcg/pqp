/**
 * Whether the app's song view shows the band's lanes under the stage.
 *
 * The stage (the mosaic) already says who is on the song, so the lanes fold
 * under it behind one disclosure instead of reading as a second list right
 * below the first. The lanes are where mute, "only this", volume, "Ajustar" and
 * the take's menu live, so the choice is the person's and it is remembered:
 * per account, on this device, in `localStorage` (a private window or blocked
 * storage simply forgets it, the view still works). With no choice yet the
 * lanes are open only when they fit under the stage without scrolling.
 */

const KEY = "pqp:jam-band-open:";

const keyFor = (viewerId: string | null): string => `${KEY}${viewerId ?? "anon"}`;

/** The person's saved choice, or null when they have not made one. */
export function readBandOpen(viewerId: string | null): boolean | null {
  try {
    const value = localStorage.getItem(keyFor(viewerId));
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

export function writeBandOpen(viewerId: string | null, open: boolean): void {
  try {
    localStorage.setItem(keyFor(viewerId), open ? "1" : "0");
  } catch {
    // Storage is off: the choice lasts as long as the view does.
  }
}

/** A lane is one line on a wide band and two on a narrow one (`JamLaneFrame`'s switch at 40rem of the band). */
const LANE_WIDE = 64;
const LANE_NARROW = 104;
/** The band's heading row and the room under the last lane. */
const BAND_CHROME = 72;

/** The height the band needs to show every lane, in px, for a scroll area this wide. */
export function bandHeight(lanes: number, width: number): number {
  return BAND_CHROME + lanes * (width >= 700 ? LANE_WIDE : LANE_NARROW);
}

/** Whether `lanes` lanes fit in `free` px of height under the stage. */
export function bandFits(free: number, lanes: number, width: number): boolean {
  return lanes > 0 && free >= bandHeight(lanes, width);
}

/** Measures the scroll area: is there room under the stage for every lane without scrolling? */
export function bandFitsBelowStage(scroller: HTMLElement, lanes: number): boolean {
  const stage = scroller.querySelector("[data-jam-stage]");
  if (!stage) {
    return false;
  }
  const stageBottom = stage.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
  return bandFits(scroller.clientHeight - stageBottom, lanes, scroller.clientWidth);
}
