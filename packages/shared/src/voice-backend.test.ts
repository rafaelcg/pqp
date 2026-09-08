import { describe, expect, it } from "vitest";
import {
  CAMERA_LIMIT,
  MESH_DEFAULT_UPLINK_BPS,
  MESH_UPLINK_MAX_BPS,
  MESH_UPLINK_MIN_BPS,
  MESH_VIDEO_HARD_LIMIT,
  SCREEN_SHARE_LIMIT,
  clampReportedUplinkBps,
  meshVideoLimit,
  narrowestUplinkBps,
} from "./voice-backend.js";

/**
 * THE MESH LIMIT IS NOW A FACT ABOUT A LINK, AND THESE ARE THE FACTS.
 *
 * Every number below was chosen against `MESH_COPY_FLOOR_BPS` and is checked
 * here rather than restated, so a change to either floor fails loudly instead
 * of quietly letting a 4G call carry four cameras.
 */
describe("meshVideoLimit", () => {
  it("is exactly the old constant when nothing has been measured", () => {
    // The whole no-regression promise: a client that reports nothing (every
    // native client today) behaves as it did before this existed, in every
    // room size.
    for (const roomSize of [2, 3, 4, 5, 8]) {
      expect(meshVideoLimit({ kind: "screens", roomSize, uplinkBps: null })).toBe(
        SCREEN_SHARE_LIMIT.mesh,
      );
      expect(meshVideoLimit({ kind: "cameras", roomSize, uplinkBps: null })).toBe(
        CAMERA_LIMIT.mesh,
      );
    }
  });

  it("lets fibre in a small room do more than the constant allowed", () => {
    // Three people, a link measured at 16 Mbit/s: two viewers to feed, so a
    // share costs 1.6 Mbit/s of the budget and the room is nowhere near its
    // link. The old answer was 2 shares and 3 cameras whatever the link.
    const room = { roomSize: 3, uplinkBps: 16_000_000 } as const;
    expect(meshVideoLimit({ kind: "screens", ...room })).toBe(
      MESH_VIDEO_HARD_LIMIT.screens,
    );
    expect(meshVideoLimit({ kind: "cameras", ...room })).toBe(
      MESH_VIDEO_HARD_LIMIT.cameras,
    );
    expect(MESH_VIDEO_HARD_LIMIT.screens).toBeGreaterThan(
      SCREEN_SHARE_LIMIT.mesh,
    );
    expect(MESH_VIDEO_HARD_LIMIT.cameras).toBeGreaterThan(CAMERA_LIMIT.mesh);
  });

  it("stops a weak link at one, in a room where the constant allowed three", () => {
    // Five people on a link measured at 2 Mbit/s. Four viewers each, so one
    // camera is already 2 Mbit/s of copies. The old rule said three cameras
    // and two shares here, which is where a call falls apart.
    const room = { roomSize: 5, uplinkBps: 2_000_000 } as const;
    expect(meshVideoLimit({ kind: "screens", ...room })).toBe(1);
    expect(meshVideoLimit({ kind: "cameras", ...room })).toBe(1);
  });

  it("never refuses the first publication, however bad the link", () => {
    // A weak link gets a smaller picture (the budget controller's job), not a
    // dead button.
    expect(
      meshVideoLimit({ kind: "screens", roomSize: 8, uplinkBps: 1 }),
    ).toBe(1);
  });

  it("falls as the room grows, on one unchanged link", () => {
    const uplinkBps = 8_000_000;
    const sizes = [3, 4, 5, 6, 7, 8];
    const limits = sizes.map((roomSize) =>
      meshVideoLimit({ kind: "cameras", roomSize, uplinkBps }),
    );
    for (let i = 1; i < limits.length; i += 1) {
      expect(limits[i]!).toBeLessThanOrEqual(limits[i - 1]!);
    }
    expect(limits[0]!).toBeGreaterThan(limits[limits.length - 1]!);
  });

  it("holds the hard ceiling against any report at all", () => {
    // THE ANSWER TO A LIAR. Every number a client could send, honest or not,
    // lands under the ceiling, because the report is clamped before it is
    // read and the ceiling is applied after.
    for (const lie of [
      1e9,
      Number.MAX_SAFE_INTEGER,
      Number.POSITIVE_INFINITY,
      1e300,
    ]) {
      expect(
        meshVideoLimit({ kind: "screens", roomSize: 2, uplinkBps: lie }),
      ).toBeLessThanOrEqual(MESH_VIDEO_HARD_LIMIT.screens);
      expect(
        meshVideoLimit({ kind: "cameras", roomSize: 2, uplinkBps: lie }),
      ).toBeLessThanOrEqual(MESH_VIDEO_HARD_LIMIT.cameras);
    }
  });

  it("gives a huge lie nothing an honest fibre link does not already get", () => {
    const honest = meshVideoLimit({
      kind: "screens",
      roomSize: 4,
      uplinkBps: MESH_UPLINK_MAX_BPS,
    });
    const lie = meshVideoLimit({
      kind: "screens",
      roomSize: 4,
      uplinkBps: 500_000_000,
    });
    expect(lie).toBe(honest);
  });

  it("treats a 1:1 call as one viewer rather than as none", () => {
    // roomSize 2 and roomSize 1 (a stale count, or the very first frame) must
    // both divide by one, never by zero.
    expect(
      Number.isFinite(
        meshVideoLimit({ kind: "cameras", roomSize: 1, uplinkBps: 5_000_000 }),
      ),
    ).toBe(true);
  });
});

describe("clampReportedUplinkBps", () => {
  it("reads anything unusable as no measurement at all", () => {
    // Not as zero: zero would refuse everybody.
    for (const bad of [null, undefined, "20000000", NaN, -1, 0, {}]) {
      expect(clampReportedUplinkBps(bad)).toBeNull();
    }
  });

  it("holds a report inside the window the controller itself runs in", () => {
    expect(clampReportedUplinkBps(1)).toBe(MESH_UPLINK_MIN_BPS);
    expect(clampReportedUplinkBps(1e12)).toBe(MESH_UPLINK_MAX_BPS);
    expect(clampReportedUplinkBps(6_000_000)).toBe(6_000_000);
  });
});

describe("narrowestUplinkBps", () => {
  it("takes the minimum, so one inflated report cannot lift a room", () => {
    expect(narrowestUplinkBps([2_000_000, 500_000_000, 9_000_000])).toBe(
      2_000_000,
    );
  });

  it("skips seats that reported nothing rather than counting them as slow", () => {
    // One iOS client in a room of web clients must not pin the room.
    expect(narrowestUplinkBps([null, undefined, 12_000_000])).toBe(12_000_000);
    expect(narrowestUplinkBps([null, null])).toBeNull();
    expect(narrowestUplinkBps([])).toBeNull();
  });
});

describe("the constants the client half depends on", () => {
  it("starts from the same 5 Mbit/s the budget controller starts from", () => {
    // Pinned here because the two files cannot import each other and a drift
    // would make the server's model of a link differ from the client's.
    expect(MESH_DEFAULT_UPLINK_BPS).toBe(5_000_000);
    expect(MESH_UPLINK_MIN_BPS).toBe(1_000_000);
    expect(MESH_UPLINK_MAX_BPS).toBe(16_000_000);
  });

  it("has no headcount on the voice server, for either kind", () => {
    expect(SCREEN_SHARE_LIMIT.livekit).toBeNull();
    expect(CAMERA_LIMIT.livekit).toBeNull();
  });
});
