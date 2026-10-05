/**
 * `share_fast_start_quality`: how a screen share's picture starts, for the
 * person watching it and for the person sending it. Per server, default off,
 * served by `GET /api/share/config?serverId=` as `shareFastStartQuality`.
 *
 * What it changes, all measured with `client/e2e/share-fast-start/` (numbers
 * in that directory's README):
 *
 *   1. A viewer asks the SFU for the share's layer as soon as the publication
 *      is known, before the subscription is bound
 *      (`requestShareQualityBeforeSubscribe` in `livekit-session.ts`), so the
 *      first picture is the stage's layer instead of the 360p copy.
 *   2. A presenter's share is not republished when the room crosses the
 *      large-room line (`reconcileScreenPlan("room")`): only the top layer's
 *      ceiling moves, in place.
 *   3. A presenter's capture really comes down to the planned height
 *      (`screen-capture-ceiling.ts`).
 *
 * Off, none of the three runs and the session behaves exactly as before.
 *
 * The answer is per server and the session reads it when an event happens,
 * not when it is built: `setShareFastStartServer` names the server the call
 * is in, `recordShareFastStartQuality` stores each server's answer as the
 * share config arrives (`share-guard-flag.ts`), and
 * `shareFastStartQualityActive` is the current server's answer. Unknown is
 * off. A DM call is the deployment-wide answer, keyed "".
 */

const answers = new Map<string, boolean>();
let activeServer: string | null | undefined = undefined;
/** The harness forces it; production never calls this. */
let forced: boolean | null = null;

export function setShareFastStartQuality(on: boolean): void {
  forced = on;
}

export function setShareFastStartServer(serverId: string | null): void {
  activeServer = serverId;
}

export function recordShareFastStartQuality(
  serverId: string | null,
  on: boolean,
): void {
  answers.set(serverId ?? "", on);
}

export function shareFastStartQualityActive(): boolean {
  if (forced !== null) {
    return forced;
  }
  if (activeServer === undefined) {
    return false;
  }
  return answers.get(activeServer ?? "") === true;
}

export function resetShareFastStartForTests(): void {
  answers.clear();
  activeServer = undefined;
  forced = null;
}

/**
 * The tallest picture a share is asked for before anything is drawn.
 *
 * Before the stage has measured the element nobody knows how big it will be,
 * and asking for the top layer is not free: in a small room the top is a
 * 1080p copy that dynacast has usually paused because nobody is watching it
 * that large, and waiting for it to come back delayed the first picture by
 * about a second in the rig (the first build asked for the top). 720 lines is
 * what a stage on a laptop or a 1080p monitor asks for once it is measured,
 * and the large-room top. A bigger stage (fullscreen on a large monitor)
 * still climbs to 1080 as soon as adaptive stream measures it.
 */
export const EARLY_SHARE_HEIGHT = 720;

/** A layer as LiveKit describes it in `TrackInfo.layers`. */
export interface ShareLayerInfo {
  quality: number;
  height: number;
}

/**
 * LiveKit's own rule for turning a requested height into a layer
 * (`layerSelectionTolerance` in `mediatrackreceiver.go`, 1.13.6): the first
 * declared layer at least 0.9 of the height asked for.
 */
const LAYER_TOLERANCE = 0.9;

/**
 * Which quality to ask for before the share is bound: the layer the SFU would
 * pick for a 720-line element (the smallest declared layer at least 0.9 of
 * `EARLY_SHARE_HEIGHT` tall, else the tallest there is), never above the
 * viewer's own ceiling. So [360, 720, 1080] starts on 720, [360, 720] on 720,
 * and a presenter whose capture never came down ([360, 1080]) on 1080, which
 * is what that viewer's stage would have asked for anyway. A share that
 * declares no layers is asked for at the ceiling.
 */
export function earlyShareQuality(
  layers: readonly ShareLayerInfo[] | undefined,
  ceiling: number,
): number {
  const sized = (layers ?? [])
    .filter((layer) => layer.height > 0)
    .sort((a, b) => a.height - b.height);
  if (sized.length === 0) {
    return ceiling;
  }
  const want = EARLY_SHARE_HEIGHT * LAYER_TOLERANCE;
  const pick = sized.find((layer) => layer.height >= want) ?? sized[sized.length - 1]!;
  return Math.min(pick.quality, ceiling);
}
