/**
 * THE Z SCALE OVER A PICTURE (2026-09-18, `docs/plans/WATCH_PARTY_UI.md`
 * §10). One ladder for every stage that draws things over a video: the
 * seatless player, the seated call stage, the host's watch party stage, the
 * mini player and the music tile.
 *
 * Before this each file picked 1, 10, 20, 30, 40 or 50 on its own and left a
 * comment about the last collision ("z-20 sat under it, so Leave fullscreen
 * could not be clicked"; "above the control bar, because the bar keeps its
 * pointer events while faded"). Every fix was local, and the next control
 * drawn into a tile at the default z sat under the tile's invisible zoom
 * target and took no clicks. The ladder is the rule; a stage file imports a
 * rung and never writes a `z-*` literal of its own.
 *
 * Bottom to top:
 *
 * - `tileTarget`: the invisible full-tile click target (zoom, "return to
 *   the stage" on the mini player). `z-0`, so every later sibling paints
 *   above it whether or not it sets a z of its own. Rendered first among a
 *   tile's overlays for the same reason.
 * - `labels`: names, the corner label on a tile, a gradient that carries no
 *   control. Never interactive.
 * - `state`: full-bleed state cards (holding, dead, loading) and the warning
 *   strips at the top of a stage.
 * - `reactions`: the floating emoji bursts.
 * - `tileControls`: per-tile hover controls, the floating self tile, the
 *   camera PiP, the participant chips above the bar.
 * - `badges`: the delay badge, the slow-start and dual-device notices.
 * - `chrome`: the bars that fade (top row, bottom bar, the party bar).
 *   The fullscreen chat overlay sits at 45 (`index.css`), under chrome and
 *   over the badges, so Leave fullscreen stays reachable with chat open.
 * - `menus`: a menu or dialog anchored to the chrome.
 *
 * `fullscreen` is the in-page fullscreen container itself (`fixed inset-0`),
 * a different axis: it is the box the ladder lives in.
 */
export const STAGE_LAYER = {
  tileTarget: "z-0",
  labels: "z-10",
  state: "z-10",
  reactions: "z-20",
  tileControls: "z-30",
  badges: "z-40",
  chrome: "z-50",
  menus: "z-[60]",
  fullscreen: "z-50",
} as const;

/**
 * THE RUNG `CallStage`'S OWN CONTROL BAR TAKES, and why it is not always
 * `chrome` (2026-09-18).
 *
 * The party bar and the call stage's control bar are both `absolute
 * inset-x-0 bottom-0` in the same stacking context, and the call bar is
 * later in `App.tsx`'s document order. At equal `z` that means the call bar
 * wins every hit test over the party bar, and the control at the right-hand
 * end of the call bar is the red hang-up. `watchPartyChrome` is supposed to
 * empty that bar and make it inert before the two ever coexist, and on
 * 2026-09-18 it did not: it asked a narrower question than the one that drew
 * the party bar, a host pressed the hang-up while aiming at the party's own
 * controls, and a live show ended twice in four minutes.
 *
 * Both gates are one predicate now (`lib/watch-party-chrome.ts`), but that
 * is a fact about `App.tsx`. This is the fact about the pixels: on a channel
 * whose TYPE is a watch party, the call bar paints a rung DOWN, so the
 * party's controls win any overlap whatever the two gates believe. Its own
 * buttons stay clickable everywhere the party bar has none — the slot is
 * `pointer-events-none` with only its children live.
 */
export function callControlsLayer(isWatchPartyChannel: boolean): string {
  return isWatchPartyChannel ? STAGE_LAYER.badges : STAGE_LAYER.chrome;
}
