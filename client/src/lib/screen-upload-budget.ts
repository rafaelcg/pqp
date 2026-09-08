/**
 * How much upload a mesh screen share may spend, measured rather than assumed.
 *
 * THE ASSUMPTION THIS FILE REPLACES. `meshScreenBitrate` splits one upload
 * budget across the room, a copy per viewer, and that budget was a constant:
 * 5 Mbps, for everyone, forever. It was chosen as "what a great many Brazilian
 * home connections have", and as a guess it is a fair one. As a rule it fails
 * in both directions:
 *
 *  - A 3 Mbps uplink sharing to two viewers was granted 2 x 2.5 Mbps. Neither
 *    copy fits, so each connection's own bandwidth estimator backs off on its
 *    own and the two fight over the same pipe: frames drop, the framerate
 *    collapses, then the picture. Nothing was broken; the budget said the link
 *    was bigger than it is.
 *  - A 50 Mbps uplink sharing to four viewers was granted 4 x 1.25 Mbps, a
 *    soft 1080p, with forty times that going spare.
 *
 * WHO THIS IS FOR, precisely. Rooms of three to eight, where the sharer holds
 * several connections over one uplink. A two-person call has exactly one
 * connection, so there is nothing to split and nothing here to do: Chrome's
 * own congestion control governs a single flow correctly and the ceiling
 * applies as it always did. A two-person share that looks like 144p is a weak
 * link, a relay, or an encoder starved of CPU, and not this.
 *
 * WebRTC already measures the thing the constant guessed at. Every connection
 * reports `availableOutgoingBitrate` on its selected candidate pair, and
 * `voice-stats-probe.ts` had been reading it into a console readout that
 * nothing acted on. This file is what acts on it.
 *
 * WHY NOT JUST USE THE ESTIMATE. Two reasons, and they set the shape of the
 * controller below.
 *
 *  1. Each connection estimates only its own flow. On a saturated link the
 *     estimates split the capacity between them, so their sum is a fair
 *     reading of the whole pipe. On an unsaturated link each estimator only
 *     probes a little above what it is currently sending (measured on 25 Aug:
 *     3.3 Mbps of "headroom" against a 1.5 Mbps ceiling on a loopback link
 *     with no real limit at all), so the sum *under*-reports and cannot be
 *     trusted to say how far up is safe. The estimate is therefore read
 *     asymmetrically: a shortfall is believed at once, and headroom is only a
 *     licence to try a little more.
 *  2. A sample can be missing or momentarily wrong (an ICE restart, a pair
 *     that just changed, Firefox omitting the field). The controller never
 *     moves on the strength of a peer it could not read, and never raises
 *     unless it could read everyone.
 *
 * So: cut immediately to what was measured, raise geometrically while every
 * estimator still reports room above the budget, and stop at a hard cap. It is
 * the same additive-increase / multiplicative-decrease idea every congestion
 * controller uses, one level up, over the room rather than over one flow.
 */

/**
 * Where a share starts, and where it returns to when one ends.
 *
 * Unchanged from the constant this file replaces, on purpose: the first
 * seconds of a share, before any sample has come in, behave exactly as every
 * share did before this existed. Only what happens afterwards is new.
 */
export const DEFAULT_SCREEN_UPLOAD_BUDGET_BPS = 5_000_000;

/**
 * The most the room may be granted in total, however much the link reports.
 *
 * 16 Mbps is two full-fat 4 Mbps shares on a fibre 1:1, or 2 Mbps each on a
 * full mesh of eight, which is already a sharp 720p per copy. Above that the
 * mesh is not the right tool and the SFU is (`transport-policy.ts`), and a
 * ceiling keeps a single optimistic estimator from asking a home router to
 * encode and forward 30 Mbps of the same picture.
 */
export const MAX_SCREEN_UPLOAD_BUDGET_BPS = 16_000_000;

/**
 * The least the controller will ever cut to.
 *
 * Below this the per-sender floor in `meshScreenBitrate` (600 kbps) is what
 * governs anyway, so a lower number would only change which constant a
 * collapsing link runs into. It also keeps a single wildly low sample (one
 * peer mid-ICE-restart reporting 50 kbps) from throwing the whole room to
 * nothing for a tick.
 */
export const MIN_SCREEN_UPLOAD_BUDGET_BPS = 1_000_000;

/**
 * How far below the budget the measurement must fall before it is a cut.
 *
 * Chrome's estimator sits a few percent under a ceiling rather than on it,
 * and a budget that chased every one of those percent would re-tune every
 * sender every tick for nothing. 90 percent is the same line
 * `voice-stats-probe.ts` draws for "at the ceiling", for the same reason.
 */
const CUT_BELOW = 0.9;

/**
 * How far above the budget every estimator must be before a raise is tried.
 *
 * A raise is a bet that the link has more, made on the strength of probes
 * that only ever look a little past what is being sent. Asking for a clear
 * margin (a quarter over) before betting keeps the controller from ratcheting
 * up on the estimator's normal wobble and then straight back down.
 */
const RAISE_ABOVE = 1.25;

/** The size of one raise. Five ticks from the default to the cap. */
const RAISE_FACTOR = 1.3;

/**
 * A change smaller than this is not worth a `setParameters` on every peer.
 * Applies to both directions; a cut of 3 percent is noise, not a signal.
 */
const APPLY_DELTA = 0.1;

/** How often the room is sampled while a share is up. */
export const SCREEN_BUDGET_SAMPLE_MS = 2_000;

/**
 * One reading per peer connection, in bps, or `null` for a peer whose selected
 * pair reported no estimate this tick.
 */
export type UplinkSample = number | null;

/**
 * The budget to run the next tick on, given the last one and what the room's
 * connections say.
 *
 * Returns `current` unchanged (same reference, so callers can `===`) when no
 * move is warranted, which is the common case: a link that is neither short
 * nor plainly under-used.
 *
 * `samples` carries one entry per live peer, including the ones that could
 * not be read; the count is what says how much of the room the readable ones
 * speak for.
 */
export function nextScreenUploadBudget(
  current: number,
  samples: readonly UplinkSample[],
): number {
  const peers = samples.length;
  // FEWER THAN TWO CONNECTIONS IS NOT THIS CONTROLLER'S BUSINESS, and the
  // guard is here rather than only at the call site because the invariant is
  // the reason the module exists. Everything above is built on one premise:
  // several connections from one machine cannot see each other, so something
  // above them has to divide the link. A 1:1 call has exactly one, and Chrome's
  // own congestion control governs one flow with far better information than a
  // 2-second poll — it probes continuously and re-opens the moment the link
  // does. Clamping the ceiling to a measurement there subtracts from that: a
  // transient dip would pin the ceiling low and then let it back only at 1.3x
  // per tick, so a hiccup that Chrome would have recovered from in a second
  // takes the ladder several to undo.
  //
  // Caught in review, after the module's own header had claimed this case was
  // untouched and the wiring had never made it true.
  if (peers < 2) {
    return current;
  }
  const readable = samples.filter(
    (s): s is number => typeof s === "number" && Number.isFinite(s) && s > 0,
  );
  if (readable.length === 0) {
    return current;
  }

  // A peer that could not be read is assumed to have exactly its share, no
  // more and no less: it can neither pull the room down nor lift it.
  const perPeer = current / peers;
  const measured =
    readable.reduce((sum, s) => sum + s, 0) + (peers - readable.length) * perPeer;

  if (measured < current * CUT_BELOW) {
    const cut = Math.max(MIN_SCREEN_UPLOAD_BUDGET_BPS, Math.round(measured));
    return cut < current * (1 - APPLY_DELTA) ? cut : current;
  }

  // A raise needs everyone's word, not the sum's: one peer on a wide-open
  // path must not be allowed to speak for another that is already struggling.
  const everyoneHasRoom =
    readable.length === peers && readable.every((s) => s > perPeer * RAISE_ABOVE);
  if (!everyoneHasRoom) {
    return current;
  }
  const raised = Math.min(
    MAX_SCREEN_UPLOAD_BUDGET_BPS,
    Math.round(current * RAISE_FACTOR),
  );
  return raised > current * (1 + APPLY_DELTA) ? raised : current;
}

/** The shape `getStats()` rows are read through. Deliberately loose. */
interface StatLike {
  type?: unknown;
  id?: unknown;
  selectedCandidatePairId?: unknown;
  nominated?: unknown;
  state?: unknown;
  availableOutgoingBitrate?: unknown;
}

/**
 * The uplink estimate for one connection, read off its selected pair.
 *
 * The transport's `selectedCandidatePairId` is the authoritative answer to
 * "which pair carries the media"; the nominated-and-succeeded scan is the
 * fallback for browsers that omit it. Same two-step as `summariseStats`, kept
 * separate because that function builds a whole readout and this one needs
 * one number, fifteen times a minute, on every peer.
 *
 * `RTCStatsReport` is maplike: `forEach` yields the stats, iteration yields
 * `[id, stat]` pairs. See the note on `statRows` in `voice-stats-probe.ts` for
 * how that shape once emptied every reading this module's predecessor took.
 */
export function readAvailableOutgoingBps(report: {
  forEach: (fn: (stat: unknown) => void) => void;
}): UplinkSample {
  const rows: StatLike[] = [];
  report.forEach((stat) => {
    if (stat && typeof stat === "object") {
      rows.push(stat as StatLike);
    }
  });
  const selected = new Set<string>();
  for (const row of rows) {
    if (row.type === "transport" && typeof row.selectedCandidatePairId === "string") {
      selected.add(row.selectedCandidatePairId);
    }
  }
  for (const row of rows) {
    if (row.type !== "candidate-pair") {
      continue;
    }
    const chosen =
      selected.size > 0
        ? typeof row.id === "string" && selected.has(row.id)
        : row.nominated === true && row.state === "succeeded";
    if (!chosen) {
      continue;
    }
    const bps = row.availableOutgoingBitrate;
    if (typeof bps === "number" && Number.isFinite(bps) && bps > 0) {
      return bps;
    }
  }
  return null;
}
