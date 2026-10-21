import { afterEach, describe, expect, it } from "vitest";
import {
  blockJoinPromotion,
  calibratedCameraMbps,
  decidePromotion,
  decideVideoAdmission,
  estimateRoomMbps,
  estimateSfuLoadMbps,
  promotionBudgetMbps,
  promotionBudgetMbpsFor,
  promotionRoomSize,
  roomsOnBox,
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

// ------------------------------------------------------- the budget is one box's

describe("the budget is per box", () => {
  const scope = (region: string) => ({ region, home: "sao" });
  /** One box's worth: 20 five-person rooms with a share in each, 20 * 5 * 4 = 400 Mbit/s. */
  function crowdedBox(region: string | null | undefined, prefix: string): SfuRoomLoad[] {
    return Array.from({ length: 20 }, (_, index) =>
      room({
        channelId: `${prefix}-${index}`,
        participants: 5,
        screenPublishers: 1,
        region,
      }),
    );
  }

  it("sums only the rooms on the asking room's box", () => {
    const rooms = [
      ...crowdedBox("sao", "sao"),
      ...crowdedBox("mia", "mia"),
      ...crowdedBox("lon", "lon"),
    ];
    expect(estimateSfuLoadMbps(rooms)).toBe(1200);
    for (const region of ["sao", "mia", "lon"]) {
      expect(estimateSfuLoadMbps(roomsOnBox(rooms, scope(region)))).toBe(400);
    }
  });

  it("reads an unknown region as the home box", () => {
    const rooms = [
      ...crowdedBox(null, "none"),
      ...crowdedBox(undefined, "undefined"),
      ...crowdedBox("mia", "mia"),
    ];
    expect(roomsOnBox(rooms, scope("sao"))).toHaveLength(40);
    expect(roomsOnBox(rooms, scope("mia"))).toHaveLength(20);
  });

  it("refuses a camera on a full box and admits the same camera on another box", () => {
    // Sao is at 580 of 600; Mia carries one quiet room.
    const rooms = [
      ...crowdedBox("sao", "sao"),
      ...crowdedBox("sao", "sao-b").slice(0, 9),
      room({ channelId: "mia-quiet", participants: 3, cameraPublishers: 1, region: "mia" }),
    ];
    const asking = (region: string, channelId: string) =>
      room({ channelId, participants: 6, cameraPublishers: 4, region });
    const onSao = decideVideoAdmission({
      rooms,
      room: asking("sao", "new-sao"),
      budgetMbps: 600,
      scope: scope("sao"),
    });
    const onMia = decideVideoAdmission({
      rooms,
      room: asking("mia", "new-mia"),
      budgetMbps: 600,
      scope: scope("mia"),
    });
    expect(onSao.admit).toBe(false);
    expect(onSao.loadMbps).toBe(580);
    expect(onSao.region).toBe("sao");
    expect(onSao.roomsOnBox).toBe(30);
    expect(onSao.peopleOnBox).toBe(29 * 5 + 6);
    expect(onMia.admit).toBe(true);
    expect(onMia.loadMbps).toBe(4.5);
    expect(onMia.roomsOnBox).toBe(2);
  });

  it("is today's cluster-wide sum without a scope", () => {
    const rooms = [...crowdedBox("sao", "sao"), ...crowdedBox("mia", "mia")];
    const verdict = decideVideoAdmission({
      rooms,
      room: room({ channelId: "new", participants: 6, cameraPublishers: 4, region: "mia" }),
      budgetMbps: 600,
    });
    expect(verdict.loadMbps).toBe(800);
    expect(verdict.admit).toBe(false);
    expect(verdict.region).toBeNull();
  });

  it("does not count mesh rooms as crowding a box", () => {
    const verdict = decideVideoAdmission({
      rooms: [
        room({ channelId: "m", transport: "mesh", participants: 8, cameraPublishers: 3, region: "sao" }),
      ],
      room: room({ channelId: "n", participants: 3, cameraPublishers: 1, region: "sao" }),
      budgetMbps: 600,
      scope: scope("sao"),
    });
    expect(verdict.roomsOnBox).toBe(1);
    expect(verdict.peopleOnBox).toBe(3);
  });

  it("carries the box through a promotion verdict", () => {
    const verdict = decidePromotion({
      liveKitConfigured: true,
      sfuReachable: true,
      rooms: crowdedBox("lon", "lon"),
      room: room({ channelId: "p", transport: "mesh", participants: 5, cameraPublishers: 2, region: "mia" }),
      budgetMbps: 600,
      scope: scope("mia"),
    });
    expect(verdict.promote).toBe(true);
    expect(verdict.region).toBe("mia");
    expect(verdict.loadMbps).toBe(0);
  });
});

describe("the budget of one box", () => {
  const KEYS = [
    "VOICE_PROMOTION_MAX_SFU_MBPS",
    "VOICE_PROMOTION_MAX_SFU_MBPS_MIA",
    "VOICE_PROMOTION_MAX_SFU_MBPS_LON_2",
  ];
  afterEach(() => {
    for (const key of KEYS) {
      delete process.env[key];
    }
  });

  it("is the global budget for a box with no line of its own", () => {
    expect(promotionBudgetMbpsFor("mia")).toBe(VOICE_PROMOTION_DEFAULT_MAX_MBPS);
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "450";
    expect(promotionBudgetMbpsFor("mia")).toBe(450);
    expect(promotionBudgetMbpsFor(null)).toBe(450);
  });

  it("takes a regional override for a smaller or bigger box, and leaves the others alone", () => {
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS_MIA = "300";
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS_LON_2 = "900";
    expect(promotionBudgetMbpsFor("mia")).toBe(300);
    expect(promotionBudgetMbpsFor("lon-2")).toBe(900);
    expect(promotionBudgetMbpsFor("sao")).toBe(VOICE_PROMOTION_DEFAULT_MAX_MBPS);
  });

  it("falls back, never uncaps, on a value it cannot read", () => {
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "450";
    for (const bad of ["abc", "-5", "Infinity", "  "]) {
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS_MIA = bad;
      expect(promotionBudgetMbpsFor("mia")).toBe(450);
    }
  });

  it("takes zero as a real value: that one box is closed", () => {
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS_MIA = "0";
    expect(promotionBudgetMbpsFor("mia")).toBe(0);
    expect(promotionBudgetMbpsFor("sao")).toBe(VOICE_PROMOTION_DEFAULT_MAX_MBPS);
  });
});

// --------------------------------------------------- the calibrated camera price

describe("the calibrated camera price", () => {
  const calibrated = { calibrated: true };

  it("prices the leading camera as the full stage and the rest as grid tiles", () => {
    expect(calibratedCameraMbps(0)).toBe(0);
    expect(calibratedCameraMbps(1)).toBe(1.5);
    expect(calibratedCameraMbps(2)).toBeCloseTo(1.9);
    expect(calibratedCameraMbps(4)).toBeCloseTo(2.7);
  });

  it("is the old price for a lone camera, so nothing about one camera moves", () => {
    for (const participants of [1, 2, 6, 20]) {
      const lone = room({ participants, cameraPublishers: 1 });
      expect(estimateRoomMbps(lone, calibrated)).toBe(estimateRoomMbps(lone));
    }
  });

  it("charges a room of cameras the layer its tiles ask for, not the top layer each", () => {
    const six = room({ participants: 6, cameraPublishers: 4 });
    expect(estimateRoomMbps(six)).toBeCloseTo(36);
    expect(estimateRoomMbps(six, calibrated)).toBeCloseTo(6 * 2.7);
  });

  it("leaves shares exactly as they were", () => {
    const share = room({ participants: 6, screenPublishers: 1 });
    expect(estimateRoomMbps(share, calibrated)).toBe(24);
    const both = room({ participants: 6, cameraPublishers: 2, screenPublishers: 1 });
    expect(estimateRoomMbps(both, calibrated)).toBeCloseTo(6 * (1.9 + 4));
  });

  it("never prices a mesh room", () => {
    expect(
      estimateRoomMbps(
        room({ transport: "mesh", participants: 6, cameraPublishers: 4 }),
        calibrated,
      ),
    ).toBe(0);
  });

  it("keeps the flat tariff for a small watch party with several cameras", () => {
    const party = room({ participants: 6, cameraPublishers: 3, watchParty: true });
    expect(estimateRoomMbps(party, calibrated)).toBe(estimateRoomMbps(party));
    expect(estimateRoomMbps(party, calibrated)).toBeCloseTo(27);
    expect(
      estimateRoomMbps({ ...party, watchParty: false }, calibrated),
    ).toBeLessThan(27);
  });

  it("does not touch a large audience: a 500-viewer party is priced exactly as measured", () => {
    // `docs/CAPACITY.md`: 500 viewers of one stream, 500 x 1.5 = 750 nominal
    // against 880 to 935 real. These shapes must not move by a single bit.
    const shapes = [
      room({ participants: 500, screenPublishers: 1 }),
      room({ participants: 500, screenPublishers: 1, cameraPublishers: 1 }),
      room({ participants: 500, screenPublishers: 1, cameraPublishers: 3 }),
      room({ participants: 21, cameraPublishers: 5 }),
    ];
    for (const shape of shapes) {
      expect(estimateRoomMbps(shape, calibrated)).toBe(estimateRoomMbps(shape));
    }
    expect(estimateRoomMbps(shapes[0]!, calibrated)).toBe(750);
    expect(estimateRoomMbps(shapes[1]!, calibrated)).toBe(1500);
  });

  it("brings a night of small camera rooms down by about a third (synthetic shape)", () => {
    // 37 rooms and 114 people, the SFU's own count at 01:30Z on 2026-10-20,
    // with an INVENTED shape: cameras on in most rooms, a share in a few.
    const rooms: SfuRoomLoad[] = [];
    for (let i = 0; i < 20; i++) {
      rooms.push(
        room({
          channelId: `a${i}`,
          participants: 3,
          cameraPublishers: 2,
          screenPublishers: i < 6 ? 1 : 0,
        }),
      );
    }
    for (let i = 0; i < 10; i++) {
      rooms.push(room({ channelId: `b${i}`, participants: 4, cameraPublishers: 3 }));
    }
    for (let i = 0; i < 7; i++) {
      rooms.push(room({ channelId: `c${i}`, participants: 2, cameraPublishers: 2 }));
    }
    const flat = estimateSfuLoadMbps(rooms);
    const cal = estimateSfuLoadMbps(rooms, calibrated);
    expect(rooms.reduce((sum, r) => sum + r.participants, 0)).toBe(114);
    expect(flat).toBeCloseTo(474);
    expect(cal).toBeCloseTo(304.6);
    expect(cal / flat).toBeLessThan(0.65);
  });

  it("reaches the verdict: the same camera is refused flat and admitted calibrated", () => {
    const rooms = Array.from({ length: 12 }, (_, index) =>
      room({ channelId: `r${index}`, participants: 6, cameraPublishers: 4 }),
    );
    const asking = room({ channelId: "ask", participants: 6, cameraPublishers: 4 });
    // flat: 12 * 36 = 432 + 36 = 468; calibrated: 12 * 16.2 = 194.4 + 16.2
    const flat = decideVideoAdmission({ rooms, room: asking, budgetMbps: 400 });
    const cal = decideVideoAdmission({
      rooms,
      room: asking,
      budgetMbps: 400,
      price: calibrated,
    });
    expect(flat.admit).toBe(false);
    expect(cal.admit).toBe(true);
    expect(cal.loadMbps).toBeCloseTo(194.4);
  });
});
