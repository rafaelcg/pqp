import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREEN_UPLOAD_BUDGET_BPS,
  MAX_SCREEN_UPLOAD_BUDGET_BPS,
  MIN_SCREEN_UPLOAD_BUDGET_BPS,
  measuredUploadBudgetBps,
  nextScreenUploadBudget,
  readAvailableOutgoingBps,
} from "./screen-upload-budget";
import {
  MESH_DEFAULT_UPLINK_BPS,
  MESH_UPLINK_MAX_BPS,
  MESH_UPLINK_MIN_BPS,
} from "@pqp/shared";

const M = 1_000_000;

describe("the screen upload budget follows the measured uplink", () => {
  it("starts where the old constant was", () => {
    expect(DEFAULT_SCREEN_UPLOAD_BUDGET_BPS).toBe(5 * M);
  });

  it("cuts to what a short link reports, at once", () => {
    // Three in the call, two viewers, one 3 Mbps uplink. The constant granted
    // 2 x 2.5 Mbps, both estimators backed off and fought. Neither path fills
    // its 2.5 Mbps share, which is what a shared bottleneck looks like, so the
    // sum is believed: 1.5 + 1.5.
    expect(nextScreenUploadBudget(5 * M, [1.5 * M, 1.5 * M])).toBe(3 * M);
  });

  it("does not cut for a shortfall inside the estimator's normal wobble", () => {
    // Chrome sits a few percent under a ceiling rather than on it. Chasing
    // that would re-tune every sender every tick.
    const current = 5 * M;
    expect(nextScreenUploadBudget(current, [2.4 * M, 2.4 * M])).toBe(current);
  });

  it("never cuts below the floor, whatever one peer says", () => {
    // A peer mid-ICE-restart reporting next to nothing for a tick.
    expect(nextScreenUploadBudget(5 * M, [50_000, 50_000])).toBe(
      MIN_SCREEN_UPLOAD_BUDGET_BPS,
    );
  });

  it("raises when every connection reports clear room, and stops at the cap", () => {
    // Fibre, four viewers: 1.25 Mbps each under the constant, forty times
    // that going spare. Each estimator probes a little past its target, so
    // the reading is only ever "more than this", and the raise is stepwise.
    let budget = 5 * M;
    const steps: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const next = nextScreenUploadBudget(budget, [
        budget,
        budget,
        budget,
        budget,
      ]);
      steps.push(next);
      budget = next;
    }
    expect(steps[0]).toBeGreaterThan(5 * M);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(budget).toBe(MAX_SCREEN_UPLOAD_BUDGET_BPS);
  });

  it("will not raise on headroom that is not clearly above the share", () => {
    // 1.2x over is inside the margin the raise asks for; ratcheting on it
    // would go up one tick and back down the next.
    const current = 5 * M;
    expect(nextScreenUploadBudget(current, [3 * M, 3 * M])).toBe(current);
  });

  it("will not raise unless every peer could be read", () => {
    // One peer on a wide-open path must not speak for one that could not be
    // measured at all.
    const current = 5 * M;
    expect(nextScreenUploadBudget(current, [10 * M, null])).toBe(current);
  });

  it("will not raise when a peer that is genuinely sharing is short", () => {
    // 2.5 Mbps beside 6 is the same order, so it counts as a share of this
    // link, and it has not cleared its own share by the margin a raise wants.
    // Nobody gets more while somebody who is really on this uplink is short.
    const current = 5 * M;
    expect(nextScreenUploadBudget(current, [6 * M, 2.5 * M])).toBe(current);
  });

  it("does raise past a path that is an outlier rather than a share", () => {
    // The counterpart, and the same judgement the cut makes: 1 Mbps beside 10
    // is somebody else's bottleneck, and it neither drags the room down nor
    // gets to veto it going up.
    expect(nextScreenUploadBudget(5 * M, [10 * M, 1 * M])).toBe(6.5 * M);
  });

  it("assumes an unreadable peer looks like the ones it can read", () => {
    // Two peers, one unreadable. The readable one is carrying 1 Mbps, so a
    // copy costs about that, and there are two copies. A missing reading is
    // not evidence of health, and treating it as a full share would let a
    // silent peer prop up a budget the link cannot carry.
    expect(nextScreenUploadBudget(5 * M, [1 * M, null])).toBe(2 * M);
  });

  it("does not punish the whole room for one bad path", () => {
    // THE REGRESSION THIS MODEL EXISTS TO AVOID, found in review. Sharer on
    // fibre, two viewers, one of them on a 50 kbps path. Reading the SUM as
    // the uplink walked the budget to its floor in three ticks and could
    // never raise again, so the healthy viewer dropped from 2500 to 500 kbps
    // because somebody else's wifi was bad. The best path is the evidence
    // about *this* uplink; the bad path is the browser's problem to throttle
    // on its own connection.
    let budget = 5 * M;
    for (let i = 0; i < 6; i += 1) {
      // The healthy path keeps filling whatever share it is given.
      budget = nextScreenUploadBudget(budget, [50_000, (budget / 2) * 1.1]);
    }
    expect(budget).toBeGreaterThanOrEqual(5 * M);
  });

  it("cuts on an unevenly divided uplink, where the maximum would not have", () => {
    // A shared 3 Mbps that GCC has split 70/30 rather than evenly. Nobody
    // reaches their 2.5 Mbps share, so the link is the suspect and the sum is
    // the reading. Budgeting from the widest path instead gave 2.1 x 2 = 4.2
    // Mbps here and then held there for the rest of the call, because every
    // reading is bounded by the ceiling we set and the budget ended up
    // tracking its own past output.
    expect(nextScreenUploadBudget(5 * M, [2.1 * M, 0.9 * M])).toBe(3 * M);
  });

  it("drops a path an order of magnitude under the widest, and keeps a poor one", () => {
    // 50 kbps beside 2.5 Mbps is not a share of anything the two are
    // dividing, so it is ignored and the room is left alone. A path that is
    // merely poor is a share, and counts.
    expect(nextScreenUploadBudget(5 * M, [50_000, 2.5 * M])).toBe(5 * M);
    // Just above a third of the widest: kept, so the mean of 0.9 and 2.5
    // times two peers is 3.4 Mbps, which is a cut.
    expect(nextScreenUploadBudget(5 * M, [0.9 * M, 2.5 * M])).toBe(3.4 * M);
  });

  it("will not call the majority of the room outliers", () => {
    // A 1 Mbps link split 40/10/10/10/10/10/10 is one link divided unevenly,
    // not six bad paths and one good one. Without the minority guard the six
    // were dropped and the room budgeted 2.8 Mbps from the seventh reading.
    const uneven = [400_000, ...Array.from({ length: 6 }, () => 100_000)];
    expect(nextScreenUploadBudget(5 * M, uneven)).toBe(1 * M);
  });

  it("lets a room recover after a dip, even with a bad path still in it", () => {
    // FOUND IN REVIEW, and it reopened the very regression the outlier filter
    // exists to close. The cut dismisses a 50 kbps path as somebody else's
    // bottleneck, but the raise used to consult the unfiltered set, so that
    // same path vetoed every recovery. One dip tick — a wifi hiccup, or the
    // estimators still ramping in the first seconds — pinned a fibre room at
    // the floor for the rest of the call.
    let budget = nextScreenUploadBudget(5 * M, [400_000, 400_000]);
    expect(budget).toBe(1 * M);
    for (let i = 0; i < 4; i += 1) {
      budget = nextScreenUploadBudget(budget, [(budget / 2) * 1.5, 50_000]);
    }
    expect(budget).toBeGreaterThan(2 * M);
  });

  it("takes the cap even when the last step to it is under the delta", () => {
    // Found in review: a budget in the last 10 % below the cap could never
    // reach it, because 16 Mbps is not more than 15.6 x 1.1.
    expect(nextScreenUploadBudget(14.6 * M, [20 * M, 20 * M])).toBe(
      MAX_SCREEN_UPLOAD_BUDGET_BPS,
    );
  });

  it("leaves a 1:1 call alone, however bad its reading", () => {
    // FOUND IN REVIEW. The header claimed this case was untouched and the
    // code did not make it true, so a 1:1 call had its ceiling clamped to a
    // measurement and could then only climb back at 1.3x per tick. One
    // connection is the browser's own job: it probes continuously and
    // re-opens the moment the link does, which no 2-second poll can match.
    const current = 5 * M;
    expect(nextScreenUploadBudget(current, [1.8 * M])).toBe(current);
    expect(nextScreenUploadBudget(current, [50_000])).toBe(current);
    expect(nextScreenUploadBudget(current, [50 * M])).toBe(current);
    expect(nextScreenUploadBudget(current, [null])).toBe(current);
  });

  it("starts managing the moment a second viewer makes it a mesh", () => {
    // The other side of the same line: two connections do have to be divided,
    // because neither can see the other.
    expect(nextScreenUploadBudget(5 * M, [1.5 * M, 1.5 * M])).toBe(3 * M);
  });

  it("holds still with nothing to go on", () => {
    const current = 5 * M;
    expect(nextScreenUploadBudget(current, [])).toBe(current);
    expect(nextScreenUploadBudget(current, [null, null])).toBe(current);
    expect(nextScreenUploadBudget(current, [0, Number.NaN])).toBe(current);
  });

  it("returns the same reference when nothing moves, so callers can compare", () => {
    const current = 5 * M;
    expect(nextScreenUploadBudget(current, [2.5 * M, 2.5 * M])).toBe(current);
  });
});

/** A maplike report the way `getStats()` hands one over. */
function report(rows: Array<Record<string, unknown>>) {
  const map = new Map(rows.map((row, i) => [String(row.id ?? i), row]));
  return { forEach: (fn: (stat: unknown) => void) => map.forEach(fn) };
}

describe("reading the uplink estimate off a stats report", () => {
  it("takes the transport's selected pair when there is one", () => {
    expect(
      readAvailableOutgoingBps(
        report([
          { type: "transport", id: "T", selectedCandidatePairId: "P2" },
          {
            type: "candidate-pair",
            id: "P1",
            nominated: true,
            state: "succeeded",
            availableOutgoingBitrate: 1 * M,
          },
          {
            type: "candidate-pair",
            id: "P2",
            state: "succeeded",
            availableOutgoingBitrate: 2 * M,
          },
        ]),
      ),
    ).toBe(2 * M);
  });

  it("falls back to the nominated, succeeded pair", () => {
    expect(
      readAvailableOutgoingBps(
        report([
          {
            type: "candidate-pair",
            id: "P1",
            nominated: false,
            state: "succeeded",
            availableOutgoingBitrate: 9 * M,
          },
          {
            type: "candidate-pair",
            id: "P2",
            nominated: true,
            state: "succeeded",
            availableOutgoingBitrate: 3 * M,
          },
        ]),
      ),
    ).toBe(3 * M);
  });

  it("reports null when the pair carries no estimate", () => {
    expect(
      readAvailableOutgoingBps(
        report([
          { type: "candidate-pair", id: "P", nominated: true, state: "succeeded" },
        ]),
      ),
    ).toBeNull();
    expect(readAvailableOutgoingBps(report([]))).toBeNull();
  });

  it("reads through forEach, not iteration, because the report is maplike", () => {
    // Iterating a Map yields [id, stat] pairs with no `type`. The reader
    // must use forEach or every report is empty. Pinned because that exact
    // mistake once emptied every reading the stats probe took.
    const map = new Map<string, unknown>([
      [
        "P",
        {
          type: "candidate-pair",
          id: "P",
          nominated: true,
          state: "succeeded",
          availableOutgoingBitrate: 4 * M,
        },
      ],
    ]);
    expect(readAvailableOutgoingBps(map)).toBe(4 * M);
  });
});

/**
 * THE READING THE SERVER IS TOLD (2026-09-08).
 *
 * `meshVideoLimit` in `@pqp/shared` decides how many cameras and shares a mesh
 * room may hold from this number, and the controller above decides what
 * bitrate each of them gets from this number. Two models of one link is how
 * the screen controller ended up with four in a day, so the outlier rule is
 * shared and pinned here.
 */
describe("measuredUploadBudgetBps", () => {
  it("is the mean of the sharing paths, times the room", () => {
    expect(measuredUploadBudgetBps([2 * M, 2 * M, 2 * M])).toBeCloseTo(6 * M);
  });

  it("drops one bottlenecked path rather than reading it as the link", () => {
    // A fibre room with one viewer on hotel wifi is a fibre room.
    expect(measuredUploadBudgetBps([50_000, 4 * M, 4 * M])).toBeCloseTo(12 * M);
  });

  it("keeps the narrow paths when they are the majority", () => {
    // Then they are not outliers, they are the room.
    const measured = measuredUploadBudgetBps([4 * M, 200_000, 200_000])!;
    expect(measured).toBeLessThan(6 * M);
  });

  it("has nothing to say about a 1:1 call or an unreadable room", () => {
    // One connection is the browser's to govern; nothing readable is not a
    // measurement of zero.
    expect(measuredUploadBudgetBps([4 * M])).toBeNull();
    expect(measuredUploadBudgetBps([null, null])).toBeNull();
    expect(measuredUploadBudgetBps([])).toBeNull();
  });

  it("agrees with the window the shared limit believes reports inside", () => {
    // The two files cannot import each other's reasoning, so the numbers are
    // pinned against each other here.
    expect(MESH_DEFAULT_UPLINK_BPS).toBe(DEFAULT_SCREEN_UPLOAD_BUDGET_BPS);
    expect(MESH_UPLINK_MIN_BPS).toBe(MIN_SCREEN_UPLOAD_BUDGET_BPS);
    expect(MESH_UPLINK_MAX_BPS).toBe(MAX_SCREEN_UPLOAD_BUDGET_BPS);
  });
});
