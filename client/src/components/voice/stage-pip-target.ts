/**
 * Which share the control bar's picture-in-picture button pops out.
 *
 * Only shares that can go into PiP right now are candidates: a peer's live
 * share whose tile has a `<video>` on the page (not our own, not a declined
 * one, not one played over HLS, whose player carries its own button). A
 * share already in the PiP window wins, so the button reads as on and closes
 * it rather than swapping the window to another share. Otherwise, with
 * several, the one the person is looking at wins: the share alone in
 * fullscreen, then the pinned one, then the one the header names as
 * presenting, then the first in the grid.
 */
export function stagePipTarget(input: {
  /** Candidate peer ids, in grid order. */
  candidates: readonly string[];
  /** The candidate whose `<video>` holds the PiP window right now, if any. */
  inPipPeerId: string | null;
  /** `useStageFullscreen().soloPeerId`; a camera or music id never matches. */
  soloPeerId: string | null;
  pinnedTileId: string | null;
  focusedPeerId: string | null;
}): string | null {
  for (const preferred of [
    input.inPipPeerId,
    input.soloPeerId,
    input.pinnedTileId,
    input.focusedPeerId,
  ]) {
    if (preferred !== null && input.candidates.includes(preferred)) {
      return preferred;
    }
  }
  return input.candidates[0] ?? null;
}
