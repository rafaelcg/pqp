/**
 * Where the watch player STARTS on a slow link, decided before hls.js has
 * measured anything.
 *
 * WHY THE DEFAULT IS WRONG FOR OUR AUDIENCE. hls.js picks its first rendition
 * from `abrEwmaDefaultEstimate`, which this player seeds at the 720p30
 * average (1.8 Mbit/s) so a good link does not spend its first seconds at
 * 480p. On a phone on 3G that is a 720p first segment that never finishes:
 * the viewer sees "Carregando" until the estimate is corrected by the very
 * download that is failing. Most of this product's audience is in Brazil,
 * on phones, on whatever the bus has, and the first ten seconds of a film
 * night are the ones people give up in.
 *
 * So when the browser SAYS the link is slow (`navigator.connection`:
 * `effectiveType` of 3g or worse, or the person has asked for less data with
 * `saveData`), start on the lowest rung and seed the estimate below the
 * second one, so ABR climbs when it has measured a reason to rather than
 * assuming one. A bandwidth this browser already measured on a previous
 * stream beats both: that is a fact, the signal is a guess.
 *
 * Safari and Firefox have no `navigator.connection`, so there the signal is
 * absent and nothing here changes. Pure, so it is testable without a DOM.
 */

/** The subset of `navigator.connection` read here. */
export interface ConnectionLike {
  effectiveType?: string;
  saveData?: boolean;
}

const SLOW_EFFECTIVE_TYPES = new Set(["slow-2g", "2g", "3g"]);

/** Just under the 480p30 rung (900 kbit/s): the second rung is out of reach. */
export const HLS_SLOW_START_ESTIMATE_BPS = 700_000;

export function isSlowConnection(
  connection: ConnectionLike | null | undefined,
): boolean {
  if (!connection) {
    return false;
  }
  return (
    SLOW_EFFECTIVE_TYPES.has(connection.effectiveType ?? "") ||
    connection.saveData === true
  );
}

export interface HlsStartPlan {
  /** hls.js `startLevel`: `0` is the lowest rung, `-1` lets ABR guess. */
  startLevel: number;
  /** hls.js `abrEwmaDefaultEstimate`. */
  abrEwmaDefaultEstimate: number;
  /** True when the slow-link rule decided this, which earns the one-line notice. */
  slowStart: boolean;
}

export function hlsStartPlan(input: {
  connection: ConnectionLike | null | undefined;
  /** What this browser measured on an earlier stream, or the seed if none. */
  rememberedEstimateBps: number;
  /** Whether that number came from a measurement rather than the seed. */
  measuredBefore: boolean;
}): HlsStartPlan {
  if (input.measuredBefore) {
    return {
      startLevel: -1,
      abrEwmaDefaultEstimate: input.rememberedEstimateBps,
      slowStart: false,
    };
  }
  if (isSlowConnection(input.connection)) {
    return {
      startLevel: 0,
      abrEwmaDefaultEstimate: HLS_SLOW_START_ESTIMATE_BPS,
      slowStart: true,
    };
  }
  return {
    startLevel: -1,
    abrEwmaDefaultEstimate: input.rememberedEstimateBps,
    slowStart: false,
  };
}

/** `navigator.connection`, where it exists. */
export function browserConnection(): ConnectionLike | null {
  try {
    if (typeof navigator === "undefined") {
      return null;
    }
    const nav = navigator as Navigator & {
      connection?: ConnectionLike;
      mozConnection?: ConnectionLike;
      webkitConnection?: ConnectionLike;
    };
    return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
  } catch {
    return null;
  }
}
