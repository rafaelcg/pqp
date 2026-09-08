import { afterEach, describe, expect, it } from "vitest";
import {
  blockFullRoomPromotion,
  decidePromotion,
  decideVideoAdmission,
  estimateRoomMbps,
  estimateSfuLoadMbps,
  promotionBudgetMbps,
  VIDEO_STREAM_MBPS,
  VOICE_PROMOTION_DEFAULT_MAX_MBPS,
  type SfuRoomLoad,
} from "./promotion.js";

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
    videoPublishers: 0,
    ...partial,
  };
}

describe("promotion load estimate", () => {
  it("prices the capacity document's six-person, four-camera room at 36 Mbit/s", () => {
    expect(
      estimateRoomMbps(room({ participants: 6, videoPublishers: 4 })),
    ).toBeCloseTo(36);
    expect(VIDEO_STREAM_MBPS).toBe(1.5);
  });

  it("charges a mesh room nothing: its media never touches the box", () => {
    expect(
      estimateRoomMbps(
        room({ transport: "mesh", participants: 6, videoPublishers: 4 }),
      ),
    ).toBe(0);
  });

  it("charges an SFU room with nobody on camera nothing", () => {
    expect(
      estimateRoomMbps(room({ participants: 40, videoPublishers: 0 })),
    ).toBe(0);
  });

  it("adds the rooms up and ignores the mesh ones", () => {
    expect(
      estimateSfuLoadMbps([
        room({ participants: 6, videoPublishers: 4 }),
        room({ transport: "mesh", participants: 8, videoPublishers: 3 }),
        room({ participants: 10, videoPublishers: 2 }),
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
        room({ channelId: "other", participants: 10, videoPublishers: 2 }),
      ],
      room: room({ transport: "mesh", participants: 6, videoPublishers: 4 }),
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
        room({ channelId: "other", participants: 590 / 1.5, videoPublishers: 1 }),
      ],
      room: room({ transport: "mesh", participants: 6, videoPublishers: 4 }),
    });

    expect(verdict.promote).toBe(false);
    expect(verdict.refusal).toBe("budget");
  });

  it("refuses when there is no SFU to promote to", () => {
    const verdict = decidePromotion({
      ...base,
      liveKitConfigured: false,
      rooms: [],
      room: room({ transport: "mesh", participants: 4, videoPublishers: 4 }),
    });

    expect(verdict.promote).toBe(false);
    expect(verdict.refusal).toBe("unconfigured");
  });

  it("refuses when the SFU is not answering", () => {
    const verdict = decidePromotion({
      ...base,
      sfuReachable: false,
      rooms: [],
      room: room({ transport: "mesh", participants: 4, videoPublishers: 4 }),
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
      room: room({ transport: "mesh", participants: 4, videoPublishers: 4 }),
    });

    expect(verdict.promote).toBe(true);
  });

  it("does not double count a candidate room that is still on mesh in the list", () => {
    const candidate = room({
      transport: "mesh",
      participants: 6,
      videoPublishers: 4,
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
 * The two refusals that belong to the ROOM-FULL trigger specifically, decided
 * before the box is ever priced.
 */
describe("blockFullRoomPromotion", () => {
  it("lets an ordinary full room through", () => {
    expect(
      blockFullRoomPromotion({
        channelOverride: null,
        joinerCapabilities: ["mesh", "livekit"],
      }),
    ).toBeNull();
  });

  it("never overrules a channel an operator pinned to mesh", () => {
    // "Small, peer-to-peer" in the channel settings dialog. A guess about
    // crowd size may be corrected; a decision may not.
    expect(
      blockFullRoomPromotion({
        channelOverride: "mesh",
        joinerCapabilities: ["mesh", "livekit"],
      }),
    ).toBe("mesh-override");
  });

  it("treats an explicit livekit override as no obstacle at all", () => {
    expect(
      blockFullRoomPromotion({
        channelOverride: "livekit",
        joinerCapabilities: ["mesh", "livekit"],
      }),
    ).toBeNull();
  });

  it("does not move a room for somebody who could not follow it", () => {
    // The trigger is one person's join. Spending the box, moving eight
    // people, and still turning that person away is the worst of both.
    expect(
      blockFullRoomPromotion({
        channelOverride: null,
        joinerCapabilities: ["mesh"],
      }),
    ).toBe("joiner-cannot-follow");
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
    const asking = room({ participants: 20, videoPublishers: 4 });
    const verdict = decideVideoAdmission({
      rooms: [room({ participants: 20, videoPublishers: 3 })],
      room: asking,
      budgetMbps: 600,
    });
    expect(verdict.addedMbps).toBe(120);
    expect(verdict.loadMbps).toBe(0);
    expect(verdict.admit).toBe(true);
  });

  it("refuses when the room plus the rest of the box crosses the budget", () => {
    const asking = room({ participants: 20, videoPublishers: 4 });
    const verdict = decideVideoAdmission({
      rooms: [
        room({ channelId: "other", participants: 40, videoPublishers: 9 }),
        room({ participants: 20, videoPublishers: 3 }),
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
      rooms: [room({ participants: 20, videoPublishers: 3 })],
      room: room({ participants: 20, videoPublishers: 3 }),
      budgetMbps: 600,
    });
    const after = decideVideoAdmission({
      rooms: [room({ participants: 20, videoPublishers: 3 })],
      room: room({ participants: 20, videoPublishers: 4 }),
      budgetMbps: 600,
    });
    expect(after.addedMbps - before.addedMbps).toBe(30);
  });

  it("never counts the asking room twice", () => {
    // The cluster's list already holds this room at its current cost. Adding
    // the candidate on top of it would refuse rooms that fit comfortably.
    const current = room({ participants: 20, videoPublishers: 8 });
    const verdict = decideVideoAdmission({
      rooms: [current],
      room: room({ participants: 20, videoPublishers: 9 }),
      budgetMbps: 300,
    });
    expect(verdict.loadMbps).toBe(0);
    expect(verdict.addedMbps).toBe(270);
    expect(verdict.admit).toBe(true);
  });

  it("takes a budget of zero as a real value: no new video, no deploy", () => {
    const verdict = decideVideoAdmission({
      rooms: [],
      room: room({ participants: 2, videoPublishers: 1 }),
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
    const asking = room({ participants: 20, videoPublishers: 20 });
    const verdict = decideVideoAdmission({
      rooms: [],
      room: asking,
      budgetMbps: 600,
    });
    const everyViewerOnTheTopLayer =
      asking.participants * asking.videoPublishers * VIDEO_STREAM_MBPS;
    expect(verdict.addedMbps).toBe(everyViewerOnTheTopLayer);
    expect(verdict.addedMbps).toBe(600);
    expect(verdict.admit).toBe(true);

    // One more publisher in the same room is over it, and is refused.
    expect(
      decideVideoAdmission({
        rooms: [],
        room: room({ participants: 21, videoPublishers: 21 }),
        budgetMbps: 600,
      }).admit,
    ).toBe(false);
  });
});
