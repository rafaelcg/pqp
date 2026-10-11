import type { UserStatus } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import {
  EMPTY_PACING,
  EMPTY_PRESENCE,
  MIN_OFFLINE_MS,
  TOAST_GAP_MS,
  observePresence,
  queueArrivals,
  takeToast,
  type PresenceMemory,
} from "./retro-presence";

const POLL = 15_000;

/** Feed snapshots 15 s apart, the friends poll's cadence. Returns each poll's arrivals. */
function run(snapshots: Array<Record<string, UserStatus>>, start = 0) {
  let memory: PresenceMemory = EMPTY_PRESENCE;
  return snapshots.map((snapshot, index) => {
    const result = observePresence(memory, Object.entries(snapshot), start + index * POLL);
    memory = result.memory;
    return result.arrived;
  });
}

describe("observePresence", () => {
  it("the first snapshot is a baseline: nobody arrives", () => {
    expect(run([{ lu: "online", bia: "idle" }])).toEqual([[]]);
  });

  it("a friend offline for two polls who comes online arrives", () => {
    expect(
      run([{ lu: "offline" }, { lu: "offline" }, { lu: "online" }]),
    ).toEqual([[], [], ["lu"]]);
  });

  it("a single offline poll is a blip (a deploy reconnect), not an arrival", () => {
    expect(run([{ lu: "online" }, { lu: "offline" }, { lu: "online" }])).toEqual([
      [],
      [],
      [],
    ]);
  });

  it("two quick snapshots do not add up to the minimum", () => {
    let memory: PresenceMemory = EMPTY_PRESENCE;
    memory = observePresence(memory, [["lu", "online"]], 0).memory;
    memory = observePresence(memory, [["lu", "offline"]], 1_000).memory;
    memory = observePresence(memory, [["lu", "offline"]], 2_000).memory;
    const result = observePresence(memory, [["lu", "online"]], 3_000);
    expect(result.arrived).toEqual([]);
    expect(MIN_OFFLINE_MS).toBeGreaterThan(3_000);
  });

  it("idle and dnd count as here; only offline is away", () => {
    expect(run([{ lu: "offline" }, { lu: "offline" }, { lu: "dnd" }])).toEqual([
      [],
      [],
      ["lu"],
    ]);
    expect(run([{ lu: "idle" }, { lu: "idle" }, { lu: "online" }])).toEqual([[], [], []]);
  });

  it("a brand new friend has no history and does not toast", () => {
    expect(run([{ lu: "offline" }, { lu: "offline" }, { lu: "offline", bia: "online" }])).toEqual([
      [],
      [],
      [],
    ]);
  });

  it("several friends arriving in one poll arrive together", () => {
    expect(
      run([
        { lu: "offline", bia: "offline", guga: "online" },
        { lu: "offline", bia: "offline", guga: "online" },
        { lu: "online", bia: "idle", guga: "online" },
      ]).at(-1),
    ).toEqual(["lu", "bia"]);
  });

  it("a friend who arrived must leave again for two polls to arrive again", () => {
    expect(
      run([
        { lu: "offline" },
        { lu: "offline" },
        { lu: "online" },
        { lu: "offline" },
        { lu: "online" },
      ]),
    ).toEqual([[], [], ["lu"], [], []]);
  });
});

describe("toast pacing", () => {
  it("shows the first arrival at once", () => {
    const pacing = queueArrivals(EMPTY_PACING, ["lu"]);
    const next = takeToast(pacing, 1_000);
    expect(next.ids).toEqual(["lu"]);
    expect(next.pacing.pending).toEqual([]);
  });

  it("holds arrivals inside the gap and groups them into the next card", () => {
    let pacing = takeToast(queueArrivals(EMPTY_PACING, ["lu"]), 0).pacing;
    pacing = queueArrivals(pacing, ["bia"]);
    pacing = queueArrivals(pacing, ["guga", "bia"]);
    const early = takeToast(pacing, 3_000);
    expect(early.ids).toBeNull();
    expect(early.wait).toBe(TOAST_GAP_MS - 3_000);
    const due = takeToast(early.pacing, TOAST_GAP_MS);
    expect(due.ids).toEqual(["bia", "guga"]);
  });

  it("nothing pending, nothing shown", () => {
    expect(takeToast(EMPTY_PACING, 0)).toMatchObject({ ids: null, wait: 0 });
  });
});
