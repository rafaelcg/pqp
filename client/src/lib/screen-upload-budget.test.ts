import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREEN_UPLOAD_BUDGET_BPS,
  MAX_SCREEN_UPLOAD_BUDGET_BPS,
  MIN_SCREEN_UPLOAD_BUDGET_BPS,
  nextScreenUploadBudget,
  readAvailableOutgoingBps,
} from "./screen-upload-budget";

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

  it("will not raise when one peer is short even if the sum is generous", () => {
    // A sum of 11 Mbps hides a peer that only has 1 Mbps. The raise reads
    // every estimator, and this is why.
    const current = 5 * M;
    expect(nextScreenUploadBudget(current, [10 * M, 1 * M])).toBe(current);
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

  it("keeps its hands off while somebody is still filling their share", () => {
    // The other half of the same rule, and the reason one bad path cannot
    // drag the room: a path reading at or above what we allowed it says
    // something about our ceiling, not about the link underneath.
    expect(nextScreenUploadBudget(5 * M, [50_000, 2.5 * M])).toBe(5 * M);
    expect(nextScreenUploadBudget(5 * M, [50_000, 2.75 * M])).toBe(5 * M);
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
