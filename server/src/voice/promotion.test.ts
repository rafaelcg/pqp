import { afterEach, describe, expect, it } from "vitest";
import {
  blockJoinPromotion,
  decidePromotion,
  decideVideoAdmission,
  estimateRoomMbps,
  estimateSfuLoadMbps,
  promotionBudgetMbps,
  promotionRoomSize,
  screenStreamMbps,
  CAMERA_STREAM_MBPS,
  LARGE_ROOM_SCREEN_MBPS,
  SCREEN_STREAM_MBPS,
  VIDEO_STREAM_MBPS,
  VOICE_PROMOTION_DEFAULT_MAX_MBPS,
  type SfuRoomLoad,
} from "./promotion.js";
import { MESH_ROOM_PROMOTION_SIZE } from "@pqp/shared";

/**
 * The budget that stands between "the fourth camera turns on" and "every call
 * on the media box runs at 27% packet loss".
 *
 * The arithmetic is pinned against `docs/CAPACITY.md` rather than against
 * itself: the six-person, four-camera room in the ladder is 36 Mbit/s there
 * and has to be 36 Mbit/s here, or the guard is measuring something the box
 * does not care about.
 */

const ORIGINAL = process.env.VOICE_PROMOTION_MAX_SFU_MBPS;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS;
  } else {
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = ORIGINAL;
  }
});

function room(partial: Partial<SfuRoomLoad>): SfuRoomLoad {
  return {
    channelId: "channel",
    transport: "livekit",
    participants: 0,
    cameraPublishers: 0,
    screenPublishers: 0,
    ...partial,
  };
}

describe("promotion load estimate", () => {
  it("prices the capacity document's six-person, four-camera room at 36 Mbit/s", () => {
    expect(
      estimateRoomMbps(room({ participants: 6, cameraPublishers: 4 })),
    ).toBeCloseTo(36);
    expect(VIDEO_STREAM_MBPS).toBe(1.5);
  });

  it("charges a mesh room nothing: its media never touches the box", () => {
    expect(
      estimateRoomMbps(
        room({ transport: "mesh", participants: 6, cameraPublishers: 4 }),
      ),
    ).toBe(0);
  });

  it("charges an SFU room with nobody on camera nothing", () => {
    expect(
      estimateRoomMbps(room({ participants: 40, cameraPublishers: 0 })),
    ).toBe(0);
  });

  it("adds the rooms up and ignores the mesh ones", () => {
    expect(
      estimateSfuLoadMbps([
        room({ participants: 6, cameraPublishers: 4 }),
        room({ transport: "mesh", participants: 8, cameraPublishers: 3 }),
        room({ participants: 10, cameraPublishers: 2 }),
      ]),
    ).toBeCloseTo(36 + 30);
  });
});

describe("promotion budget", () => {
  it("defaults to 600 Mbit/s", () => {
    delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS;
    expect(promotionBudgetMbps()).toBe(VOICE_PROMOTION_DEFAULT_MAX_MBPS);
    expect(VOICE_PROMOTION_DEFAULT_MAX_MBPS).toBe(600);
  });

  it("reads the override", () => {
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "120";
    expect(promotionBudgetMbps()).toBe(120);
  });

  it("takes zero as a real value: promotion off without a deploy", () => {
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "0";
    expect(promotionBudgetMbps()).toBe(0);
  });

  it("falls back to the default on a value it cannot read", () => {
    // A typo must not silently uncap the box, and must not silently close it.
    for (const junk of ["", "  ", "six hundred", "-40", "NaN"]) {
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = junk;
      expect(promotionBudgetMbps()).toBe(VOICE_PROMOTION_DEFAULT_MAX_MBPS);
    }
  });
});

describe("the verdict", () => {
  const base = {
    liveKitConfigured: true,
    sfuReachable: true as boolean | null,
    budgetMbps: 600,
  };

  it("promotes a small room onto a quiet box", () => {
    const verdict = decidePromotion({
      ...base,
      // Another room, by name. `loadMbps` is the box MINUS the room asking,
      // so a fixture that reuses the default channel id is asking about
      // itself and reads zero.
      rooms: [
        room({ channelId: "other", participants: 10, cameraPublishers: 2 }),
      ],
      room: room({ transport: "mesh", participants: 6, cameraPublishers: 4 }),
    });

    expect(verdict.promote).toBe(true);
    expect(verdict.refusal).toBeNull();
    expect(verdict.loadMbps).toBeCloseTo(30);
    expect(verdict.addedMbps).toBeCloseTo(36);
  });

  it("refuses when this room would take the box over the budget", () => {
    const verdict = decidePromotion({
      ...base,
      // 590 already on the box, in somebody else's room.
      rooms: [
        room({ channelId: "other", participants: 590 / 1.5, cameraPublishers: 1 }),
      ],
      room: room({ transport: "mesh", participants: 6, cameraPublishers: 4 }),
    });

    expect(verdict.promote).toBe(false);
    expect(verdict.refusal).toBe("budget");
  });

  it("refuses when there is no SFU to promote to", () => {
    const verdict = decidePromotion({
      ...base,
      liveKitConfigured: false,
      rooms: [],
      room: room({ transport: "mesh", participants: 4, cameraPublishers: 4 }),
    });

    expect(verdict.promote).toBe(false);
    expect(verdict.refusal).toBe("unconfigured");
  });

  it("refuses when the SFU is not answering", () => {
    const verdict = decidePromotion({
      ...base,
      sfuReachable: false,
      rooms: [],
      room: room({ transport: "mesh", participants: 4, cameraPublishers: 4 }),
    });

    expect(verdict.promote).toBe(false);
    expect(verdict.refusal).toBe("unreachable");
  });

  it("treats an unprobed SFU as fine, not as broken", () => {
    // `null` is "nobody has asked yet", which is the state a fresh process is
    // in. Reading it as a failure would make the first promotion after every
    // deploy fail for no reason anybody could see.
    const verdict = decidePromotion({
      ...base,
      sfuReachable: null,
      rooms: [],
      room: room({ transport: "mesh", participants: 4, cameraPublishers: 4 }),
    });

    expect(verdict.promote).toBe(true);
  });

  it("does not double count a candidate room that is still on mesh in the list", () => {
    const candidate = room({
      transport: "mesh",
      participants: 6,
      cameraPublishers: 4,
    });
    const verdict = decidePromotion({
      ...base,
      rooms: [candidate],
      room: candidate,
    });

    expect(verdict.loadMbps).toBe(0);
    expect(verdict.addedMbps).toBeCloseTo(36);
  });
});

/**
 * The two refusals that belong to the join-triggered promotions (`room-full`
 * and `room-size`), decided before the box is ever priced.
 */
describe("blockJoinPromotion", () => {
  it("lets an ordinary full room through", () => {
    expect(
      blockJoinPromotion({
        channelOverride: null,
        joinerCapabilities: ["mesh", "livekit"],
      }),
    ).toBeNull();
  });

  it("never overrules a channel an operator pinned to mesh", () => {
    // "Small, peer-to-peer" in the channel settings dialog. A guess about
    // crowd size may be corrected; a decision may not.
    expect(
      blockJoinPromotion({
        channelOverride: "mesh",
        joinerCapabilities: ["mesh", "livekit"],
      }),
    ).toBe("mesh-override");
  });

  it("treats an explicit livekit override as no obstacle at all", () => {
    expect(
      blockJoinPromotion({
        channelOverride: "livekit",
        joinerCapabilities: ["mesh", "livekit"],
      }),
    ).toBeNull();
  });

  it("does not move a room for somebody who could not follow it", () => {
    // The trigger is one person's join. Spending the box, moving eight
    // people, and still turning that person away is the worst of both.
    expect(
      blockJoinPromotion({
        channelOverride: null,
        joinerCapabilities: ["mesh"],
      }),
    ).toBe("joiner-cannot-follow");
  });
});

/**
 * The room-size threshold, and the fact that it can be changed or switched off
 * without a deploy. Read per call for exactly that reason.
 */
describe("promotionRoomSize", () => {
  const ORIGINAL = process.env.VOICE_PROMOTION_ROOM_SIZE;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.VOICE_PROMOTION_ROOM_SIZE;
    } else {
      process.env.VOICE_PROMOTION_ROOM_SIZE = ORIGINAL;
    }
  });

  it("is four unless told otherwise", () => {
    delete process.env.VOICE_PROMOTION_ROOM_SIZE;
    expect(promotionRoomSize()).toBe(MESH_ROOM_PROMOTION_SIZE);
    expect(MESH_ROOM_PROMOTION_SIZE).toBe(4);
  });

  it("takes the number it is given", () => {
    process.env.VOICE_PROMOTION_ROOM_SIZE = "5";
    expect(promotionRoomSize()).toBe(5);
  });

  it("is off at zero", () => {
    // The switch that has to exist before this ships an hour before a peak.
    process.env.VOICE_PROMOTION_ROOM_SIZE = "0";
    expect(promotionRoomSize()).toBeNull();
  });

  it("is off below two, because one would move every call the moment it opened", () => {
    process.env.VOICE_PROMOTION_ROOM_SIZE = "1";
    expect(promotionRoomSize()).toBeNull();
  });

  it("treats an unreadable value as the default, not as a change", () => {
    // Same rule as the budget: a typo must not silently reshape the night.
    process.env.VOICE_PROMOTION_ROOM_SIZE = "four";
    expect(promotionRoomSize()).toBe(MESH_ROOM_PROMOTION_SIZE);
  });
});

/**
 * THE SAME BUDGET, ASKED BY A ROOM THAT IS ALREADY ON THE BOX (2026-09-08).
 *
 * `CAMERA_LIMIT.livekit` was eight, and eight was ours rather than the box's:
 * on an SFU the ninth camera costs its publisher exactly what the first did.
 * What it does cost is egress, once per viewer, so the count is gone and this
 * is what replaced it. Every number below is `docs/CAPACITY.md` arithmetic.
 */
describe("admitting one more camera on a room already on the SFU", () => {
  it("admits while the box has room for what the room will cost", () => {
    // 20 people, 3 cameras up, a fourth asking: 4 * 20 * 1.5 = 120 Mbit/s.
    const asking = room({ participants: 20, cameraPublishers: 4 });
    const verdict = decideVideoAdmission({
      rooms: [room({ participants: 20, cameraPublishers: 3 })],
      room: asking,
      budgetMbps: 600,
    });
    expect(verdict.addedMbps).toBe(120);
    expect(verdict.loadMbps).toBe(0);
    expect(verdict.admit).toBe(true);
  });

  it("refuses when the room plus the rest of the box crosses the budget", () => {
    const asking = room({ participants: 20, cameraPublishers: 4 });
    const verdict = decideVideoAdmission({
      rooms: [
        room({ channelId: "other", participants: 40, cameraPublishers: 9 }),
        room({ participants: 20, cameraPublishers: 3 }),
      ],
      room: asking,
      budgetMbps: 600,
    });
    // 9 * 40 * 1.5 = 540 elsewhere, plus this room's 120.
    expect(verdict.loadMbps).toBe(540);
    expect(verdict.addedMbps).toBe(120);
    expect(verdict.admit).toBe(false);
  });

  it("prices the asking room whole rather than incrementally", () => {
    // The trap: a new camera in a twenty-person room adds twenty downstreams,
    // not one. An estimate that forgets the multiplier reads 1.5 here.
    const before = decideVideoAdmission({
      rooms: [room({ participants: 20, cameraPublishers: 3 })],
      room: room({ participants: 20, cameraPublishers: 3 }),
      budgetMbps: 600,
    });
    const after = decideVideoAdmission({
      rooms: [room({ participants: 20, cameraPublishers: 3 })],
      room: room({ participants: 20, cameraPublishers: 4 }),
      budgetMbps: 600,
    });
    expect(after.addedMbps - before.addedMbps).toBe(30);
  });

  it("never counts the asking room twice", () => {
    // The cluster's list already holds this room at its current cost. Adding
    // the candidate on top of it would refuse rooms that fit comfortably.
    const current = room({ participants: 20, cameraPublishers: 8 });
    const verdict = decideVideoAdmission({
      rooms: [current],
      room: room({ participants: 20, cameraPublishers: 9 }),
      budgetMbps: 300,
    });
    expect(verdict.loadMbps).toBe(0);
    expect(verdict.addedMbps).toBe(270);
    expect(verdict.admit).toBe(true);
  });

  it("takes a budget of zero as a real value: no new video, no deploy", () => {
    const verdict = decideVideoAdmission({
      rooms: [],
      room: room({ participants: 2, cameraPublishers: 1 }),
      budgetMbps: 0,
    });
    expect(verdict.admit).toBe(false);
  });

  /**
   * A CLIENT THAT LIES ABOUT ITS TILE SIZE GAINS NOTHING HERE.
   *
   * Simulcast and adaptive streaming are how a small tile receives a small
   * layer, and both live on the client, so neither is a guarantee: a modified
   * client can report a huge element, or ignore the ladder and demand the top
   * layer for every publication in the room. The budget is what makes that
   * harmless, and it is harmless because it never reads a number the client
   * sent: `VIDEO_STREAM_MBPS` is the TOP of the camera ladder and every
   * participant is charged for every publisher at that rate. A room admitted
   * under the guard is therefore still inside the budget in the worst case
   * where every viewer takes the top layer, which is exactly what a liar
   * forces.
   */
  it("prices the worst case, so the top layer for everybody is already paid for", () => {
    const asking = room({ participants: 20, cameraPublishers: 20 });
    const verdict = decideVideoAdmission({
      rooms: [],
      room: asking,
      budgetMbps: 600,
    });
    const everyViewerOnTheTopLayer =
      asking.participants * asking.cameraPublishers * VIDEO_STREAM_MBPS;
    expect(verdict.addedMbps).toBe(everyViewerOnTheTopLayer);
    expect(verdict.addedMbps).toBe(600);
    expect(verdict.admit).toBe(true);

    // One more publisher in the same room is over it, and is refused.
    expect(
      decideVideoAdmission({
        rooms: [],
        room: room({ participants: 21, cameraPublishers: 21 }),
        budgetMbps: 600,
      }).admit,
    ).toBe(false);
  });
});

/**
 * A SHARE IS NOT A CAMERA, AND CHARGING IT AS ONE UNDER-PRICED THE BOX BY
 * NEARLY THREE (2026-09-08).
 *
 * `VIDEO_STREAM_MBPS` was 1.5 for everything, which is the top of the camera
 * ladder on Auto. A screen share asks for 3 Mbit/s on Auto and 4 on an
 * explicit 1080p, because full-frame motion with hard edges is not a still
 * background with a moving oval in it. Removing `SCREEN_SHARE_LIMIT.livekit`
 * without fixing this would have replaced a count that was too strict with a
 * price that was too generous, which is worse: a count refuses one person and
 * a wrong price takes the box down.
 */
describe("what each kind of publication is charged", () => {
  it("charges a share several times what a camera costs", () => {
    expect(SCREEN_STREAM_MBPS).toBeGreaterThan(CAMERA_STREAM_MBPS * 2);
    expect(CAMERA_STREAM_MBPS).toBe(1.5);
    expect(SCREEN_STREAM_MBPS).toBe(4);
  });

  it("prices a small room's share at the top rung a presenter can pick", () => {
    // Six people, one share: 6 * 4 = 24, against 9 if it were a camera.
    expect(
      estimateRoomMbps(room({ participants: 6, screenPublishers: 1 })),
    ).toBeCloseTo(24);
    expect(
      estimateRoomMbps(room({ participants: 6, cameraPublishers: 1 })),
    ).toBeCloseTo(9);
  });

  it("prices a large room's share at the cap the client actually applies", () => {
    // Above LARGE_ROOM_PARTICIPANTS the client holds the top layer to
    // 1.5 Mbit/s (`screenSimulcastPlan`), so charging 4 there would refuse a
    // hundred-person watch party the box carries comfortably.
    expect(screenStreamMbps(21)).toBe(LARGE_ROOM_SCREEN_MBPS);
    expect(screenStreamMbps(20)).toBe(SCREEN_STREAM_MBPS);
    expect(
      estimateRoomMbps(room({ participants: 100, screenPublishers: 1 })),
    ).toBeCloseTo(150);
  });

  it("adds the two kinds rather than picking one", () => {
    // One person doing both is in both counts, because they publish two
    // tracks and the box forwards two tracks.
    expect(
      estimateRoomMbps(
        room({ participants: 4, cameraPublishers: 2, screenPublishers: 1 }),
      ),
    ).toBeCloseTo(4 * (2 * 1.5 + 4));
  });

  it("still charges a mesh room nothing", () => {
    expect(
      estimateRoomMbps(
        room({ transport: "mesh", participants: 8, screenPublishers: 3 }),
      ),
    ).toBe(0);
  });

  it("keeps the old name pointing at the camera rate", () => {
    // `VIDEO_STREAM_MBPS` meant a camera everywhere it was read.
    expect(VIDEO_STREAM_MBPS).toBe(CAMERA_STREAM_MBPS);
  });
});
