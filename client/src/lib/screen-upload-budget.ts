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
 *  1. `availableOutgoingBitrate` IS NOT THIS MACHINE'S UPLINK. It is a
 *     per-path estimate, and a path is throttled by whichever end is
 *     narrowest: our uplink, that one viewer's downlink, or a relay carrying
 *     that pair. Summing the paths therefore cannot tell "my uplink is small"
 *     from "one viewer is on hotel wifi", and an earlier version of this file
 *     did exactly that, in a comment that claimed the sum was "a fair reading
 *     of the whole pipe". It was not. With two viewers, one of them on a
 *     50 kbps path, the sum dragged the budget to its floor in three ticks and
 *     could never raise again, so the *healthy* viewer went from 2500 kbps to
 *     500 kbps because somebody else's wifi was bad. Found in review before it
 *     shipped.
 *
     What separates them is that a shared bottleneck squeezes every path at
 *     once, while one bad path leaves the others alone. So a path far narrower
 *     than the widest is treated as independently bottlenecked and dropped,
 *     and the rest are read as genuinely dividing this uplink. Two models were
 *     tried and measured before this one: the plain sum, which read one
 *     50 kbps viewer as a 50 kbps uplink and dragged a fibre room to its floor
 *     in three ticks; and the widest path alone, which read one good viewer as
 *     a wide uplink and, because every reading is bounded by the ceiling we
 *     ourselves set, tracked its own past output and sat 2.8x over a 1 Mbps
 *     link forever.
 *  2. On an unsaturated link each estimator only probes a little above what it
 *     is currently sending (measured on 25 Aug: 3.3 Mbps of "headroom" against
 *     a 1.5 Mbps ceiling on a loopback link with no real limit at all), so
 *     even the best path *under*-reports and cannot be trusted to say how far
 *     up is safe. The estimate is therefore read asymmetrically: a shortfall
 *     is believed at once, and headroom is only a licence to try a little
 *     more.
 *  3. A sample can be missing or momentarily wrong (an ICE restart, a pair
 *     that just changed, Firefox omitting the field). The controller never
 *     raises unless it could read everyone.
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
 * This is the only floor left: the per-copy one that used to sit in
 * `meshScreenBitrate` is gone, because against a measured budget it asked a
 * 1 Mbps link for up to 4.2 Mbps. A floor on the room is the right shape for
 * one, and it bounds how far a tick of bad readings can throw the room.
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

/**
 * How far below the widest path a reading has to be before it is treated as
 * that path's own bottleneck rather than a share of a link everyone is
 * dividing.
 *
 * A third of the best path. An uplink divided between peers gives readings of
 * the same order as each other, even when GCC has not split it evenly; a
 * viewer on hotel wifi is an order of magnitude down. Set generously, because
 * the cost of the two mistakes is asymmetric: wrongly keeping a bad path only
 * makes the budget conservative, while wrongly dropping a real share makes it
 * over-commit a link that cannot carry it.
 */
const OUTLIER_FRACTION = 1 / 3;

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

  const perPeer = current / peers;

  // Did ANYBODY fill the share we gave them? An estimator reports roughly
  // what its path is carrying, so a reading at the ceiling is a statement
  // about the ceiling and not about the link. While one path manages that,
  // this uplink has not been shown to be the constraint, and a low reading on
  // some *other* path is that path's own bottleneck — which the browser
  // throttles on that connection by itself, under whatever ceiling we set.
  //
  // Reading the estimate as headroom rather than as a limit is safe here
  // because an unconstrained estimator probes ABOVE what it is sending
  // (measured 25 Aug: 3.3 Mbps against a 1.5 Mbps ceiling), so a healthy path
  // clears its share comfortably rather than sitting exactly on it.
  // ONE BAD PATH IS NOT A SMALL UPLINK, and separating them is the whole
  // difficulty. A path far narrower than the widest one is bottlenecked
  // somewhere that is not shared — that viewer's own downlink, or a relay
  // carrying just that pair — because anything genuinely shared would be
  // squeezing the others too. Such a path is dropped from the reading, and the
  // browser goes on throttling it by itself on that one connection, under
  // whatever ceiling this sets.
  //
  // Two earlier models failed here, both measured on the harness. Summing
  // every path read one 50 kbps viewer as a 50 kbps uplink and walked a fibre
  // room to its floor in three ticks. Budgeting from the widest path alone
  // read one good viewer as a wide uplink, and since every reading is bounded
  // by the ceiling we set, the budget ended up tracking its own past output
  // and sat 2.8x over a 1 Mbps link forever.
  const bestPath = Math.max(...readable);
  const candidates = readable.filter((s) => s >= bestPath * OUTLIER_FRACTION);
  // An outlier is by definition the exception. If dropping the narrow paths
  // would discard half the room or more, they are not outliers, they are the
  // room, and what looked like one bad path is a link everybody is dividing
  // unevenly. Without this, a 1 Mbps uplink split 40/10/10/10/10/10/10 across
  // seven viewers dropped six readings and budgeted 2.8 Mbps from the seventh.
  const sharing = candidates.length * 2 >= readable.length ? candidates : readable;

  // The mean of what is left, times the room: the paths that are plausibly
  // dividing one link tell us what a copy costs, and there is a copy per
  // viewer. Peers that could not be read are assumed to look like the ones
  // that could, which is why this scales the mean rather than adding a sum.
  const measured = (sharing.reduce((sum, s) => sum + s, 0) / sharing.length) * peers;

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
  // The cap is always worth taking, even when the last step up to it is
  // smaller than the delta. Without this a budget anywhere in the last 10 %
  // below the cap could never reach it: 12.0 Mbps raises to 15.6, and 16 is
  // not more than 15.6 x 1.1, so it would sit there for the rest of the call.
  if (raised === MAX_SCREEN_UPLOAD_BUDGET_BPS && raised > current) {
    return raised;
  }
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
