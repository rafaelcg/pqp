import { describe, expect, it } from "vitest";
import {
  AdmissionLedger,
  buildSfuAdmissionSnapshot,
  type AdmissionCounts,
  type SfuAdmissionInput,
} from "./sfu-admission-metrics.js";
import {
  decideVideoAdmission,
  estimateSfuLoadMbps,
  type SfuRoomLoad,
} from "./promotion.js";

/**
 * The gauge that says what the video admission estimator believes. The point
 * of pinning it against `decideVideoAdmission` is that a number on a graph and
 * the number an admission compared against the budget cannot drift apart.
 */

function room(partial: Partial<SfuRoomLoad>): SfuRoomLoad {
  return {
    channelId: "c",
    transport: "livekit",
    participants: 0,
    cameraPublishers: 0,
    screenPublishers: 0,
    ...partial,
  };
}

const MINUTE = 60_000;

describe("AdmissionLedger", () => {
  it("counts checks and refusals in the last five minutes", () => {
    const ledger = new AdmissionLedger();
    const t0 = 10 * MINUTE;
    ledger.note("sao", false, t0);
    ledger.note("sao", true, t0 + 1_000);
    ledger.note("sao", true, t0 + 2 * MINUTE);
    ledger.note("mia", false, t0 + 2 * MINUTE);

    const counts = ledger.counts(t0 + 3 * MINUTE);
    expect(counts.get("sao")).toEqual({
      checks5m: 3,
      refusals5m: 2,
      checksTotal: 3,
      refusalsTotal: 2,
    });
    expect(counts.get("mia")?.checks5m).toBe(1);
    expect(counts.get("mia")?.refusals5m).toBe(0);
  });

  it("lets the window age out while the totals keep counting", () => {
    const ledger = new AdmissionLedger();
    const t0 = 10 * MINUTE;
    ledger.note("sao", true, t0);
    ledger.note("sao", true, t0 + 4 * MINUTE);

    // The first refusal is 5 minutes old; the window is minutes t-4..t.
    const later = ledger.counts(t0 + 5 * MINUTE).get("sao");
    expect(later).toMatchObject({ refusals5m: 1, refusalsTotal: 2 });

    const gone = ledger.counts(t0 + 30 * MINUTE).get("sao");
    expect(gone).toMatchObject({
      checks5m: 0,
      refusals5m: 0,
      checksTotal: 2,
      refusalsTotal: 2,
    });
  });

  it("stays bounded however long it runs", () => {
    const ledger = new AdmissionLedger();
    for (let minute = 0; minute < 500; minute += 1) {
      ledger.note("sao", minute % 2 === 0, minute * MINUTE);
    }
    const counts = ledger.counts(499 * MINUTE).get("sao");
    expect(counts?.checks5m).toBe(5);
    expect(counts?.checksTotal).toBe(500);
  });
});

function input(partial: Partial<SfuAdmissionInput>): SfuAdmissionInput {
  return {
    rooms: [],
    source: "cluster",
    perBox: true,
    price: { calibrated: false },
    homeBox: "sao",
    boxIds: ["sao", "mia", "lhr"],
    budgetFor: (box) => (box === "sao" ? 600 : 300),
    clusterBudgetMbps: 600,
    counts: new Map<string, AdmissionCounts>(),
    ...partial,
  };
}

describe("buildSfuAdmissionSnapshot", () => {
  it("reports every configured box, a quiet one at zero", () => {
    const snapshot = buildSfuAdmissionSnapshot(input({}));
    expect(snapshot.boxes.map((box) => box.box)).toEqual(["sao", "lhr", "mia"]);
    for (const box of snapshot.boxes) {
      expect(box).toMatchObject({
        loadMbps: 0,
        utilisation: 0,
        rooms: 0,
        checks5m: 0,
        refusals5m: 0,
      });
    }
    expect(snapshot.boxes[0]?.budgetMbps).toBe(600);
    expect(snapshot.boxes[1]?.budgetMbps).toBe(300);
  });

  it("prices each box's rooms alone, as the per-box budget does", () => {
    const rooms = [
      room({ channelId: "a", region: "sao", participants: 6, cameraPublishers: 4 }),
      room({ channelId: "b", region: "mia", participants: 6, cameraPublishers: 2 }),
      // No region is the home box.
      room({ channelId: "c", participants: 4, screenPublishers: 1 }),
    ];
    const snapshot = buildSfuAdmissionSnapshot(input({ rooms }));
    const byBox = Object.fromEntries(snapshot.boxes.map((box) => [box.box, box]));

    // Flat tariff: 4 x 6 x 1.5 = 36, plus one 4-person share, 1 x 4 x 4 = 16.
    expect(byBox.sao?.loadMbps).toBe(52);
    expect(byBox.sao?.rooms).toBe(2);
    expect(byBox.sao?.participants).toBe(10);
    expect(byBox.sao?.cameraPublishers).toBe(4);
    expect(byBox.sao?.screenPublishers).toBe(1);
    expect(byBox.mia?.loadMbps).toBe(18);
    expect(byBox.lhr?.loadMbps).toBe(0);
    expect(byBox.sao?.utilisation).toBeCloseTo(52 / 600, 3);
  });

  it("is the same number the admission guard compared against the budget", () => {
    const rooms = [
      room({ channelId: "a", region: "sao", participants: 8, cameraPublishers: 5 }),
      room({ channelId: "b", region: "sao", participants: 3, screenPublishers: 1 }),
    ];
    for (const calibrated of [false, true]) {
      const price = { calibrated };
      const snapshot = buildSfuAdmissionSnapshot(input({ rooms, price }));
      const asked = decideVideoAdmission({
        rooms,
        // A room that is not in the list, adding nothing: loadMbps is the rest.
        room: room({ channelId: "asker", region: "sao" }),
        budgetMbps: 600,
        scope: { region: "sao", home: "sao" },
        price,
      });
      expect(snapshot.boxes[0]?.loadMbps).toBe(
        Math.round(estimateSfuLoadMbps(rooms, price) * 10) / 10,
      );
      expect(snapshot.boxes[0]?.loadMbps).toBeCloseTo(asked.loadMbps, 1);
      expect(snapshot.calibrated).toBe(calibrated);
    }
  });

  it("does not charge the box for a mesh room", () => {
    const snapshot = buildSfuAdmissionSnapshot(
      input({
        rooms: [
          room({ transport: "mesh", region: "sao", participants: 6, cameraPublishers: 6 }),
        ],
      }),
    );
    expect(snapshot.boxes[0]).toMatchObject({ loadMbps: 0, rooms: 0, participants: 0 });
  });

  it("reads a closed box (budget 0) as no utilisation rather than dividing by zero", () => {
    const snapshot = buildSfuAdmissionSnapshot(
      input({ budgetFor: () => 0, rooms: [room({ participants: 2, cameraPublishers: 1 })] }),
    );
    expect(snapshot.boxes[0]?.utilisation).toBeNull();
    expect(snapshot.boxes[0]?.budgetMbps).toBe(0);
  });

  it("joins the ledger's counts to their box", () => {
    const counts = new Map<string, AdmissionCounts>([
      ["sao", { checks5m: 9, refusals5m: 4, checksTotal: 90, refusalsTotal: 12 }],
    ]);
    const snapshot = buildSfuAdmissionSnapshot(input({ counts }));
    expect(snapshot.boxes[0]).toMatchObject({
      checks5m: 9,
      refusals5m: 4,
      checksTotal: 90,
      refusalsTotal: 12,
    });
  });

  it("with the per-box flag off sums the cluster into one box named all", () => {
    const rooms = [
      room({ channelId: "a", region: "sao", participants: 6, cameraPublishers: 4 }),
      room({ channelId: "b", region: "mia", participants: 6, cameraPublishers: 2 }),
    ];
    const counts = new Map<string, AdmissionCounts>([
      ["sao", { checks5m: 2, refusals5m: 1, checksTotal: 2, refusalsTotal: 1 }],
      ["mia", { checks5m: 3, refusals5m: 0, checksTotal: 3, refusalsTotal: 0 }],
    ]);
    const snapshot = buildSfuAdmissionSnapshot(input({ perBox: false, rooms, counts }));
    expect(snapshot.perBox).toBe(false);
    expect(snapshot.boxes).toHaveLength(1);
    expect(snapshot.boxes[0]).toMatchObject({
      box: "all",
      loadMbps: 54,
      budgetMbps: 600,
      checks5m: 5,
      refusals5m: 1,
    });
  });

  it("carries where the rooms came from, so a local floor is not read as a total", () => {
    expect(buildSfuAdmissionSnapshot(input({ source: "local" })).source).toBe("local");
  });
});
