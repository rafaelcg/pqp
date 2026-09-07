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
    // 2 x 2.5 Mbps, both estimators backed off and fought. Two connections on
    // a saturated 3 Mbps pipe report roughly 1.5 Mbps each; their sum is the
    // pipe.
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
    // each estimator, the cut reads the sum, and this is why.
    const current = 5 * M;
    expect(nextScreenUploadBudget(current, [10 * M, 1 * M])).toBe(current);
  });

  it("lets the readable peers cut the room while an unreadable one holds its share", () => {
    // Two peers, one unreadable. The unreadable one is assumed to have
    // exactly its 2.5 Mbps share; the readable one says 1 Mbps. 3.5 Mbps.
    expect(nextScreenUploadBudget(5 * M, [1 * M, null])).toBe(3.5 * M);
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
