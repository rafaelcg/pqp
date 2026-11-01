import { describe, expect, it } from "vitest";
import { CALL_SPLIT_DIVIDER_PX, MIN_CHAT_HEIGHT_PX } from "./call-split";
import {
  PHONE_STAGE_EXTRA_PX,
  partyPhoneLayoutOn,
  phoneShortStageHeight,
  phoneStageTarget,
  type PartyNewcomerFacts,
} from "./party-newcomer";

const LIVE_AUDIENCE: PartyNewcomerFacts = {
  flagOn: true,
  partyLive: true,
  audience: true,
};

describe("the flag gates the phone layout", () => {
  it("with the flag off or absent nothing changes for anybody", () => {
    for (const flagOn of [false, undefined]) {
      expect(partyPhoneLayoutOn({ ...LIVE_AUDIENCE, flagOn })).toBe(false);
    }
  });

  it("with the flag on, a live party turns it on for a seatless viewer", () => {
    expect(partyPhoneLayoutOn(LIVE_AUDIENCE)).toBe(true);
  });

  it("nothing applies once the party is not on air", () => {
    expect(partyPhoneLayoutOn({ ...LIVE_AUDIENCE, partyLive: false })).toBe(
      false,
    );
  });

  it("drops the phone layout for somebody holding a seat", () => {
    expect(partyPhoneLayoutOn({ ...LIVE_AUDIENCE, audience: false })).toBe(
      false,
    );
  });
});

describe("phoneStageTarget", () => {
  const divider = CALL_SPLIT_DIVIDER_PX;

  it("gives the picture its 16:9 and the chat the rest on a tall phone", () => {
    const stage = phoneStageTarget(600, 390, MIN_CHAT_HEIGHT_PX, divider);
    expect(stage).toBe(Math.round((390 * 9) / 16) + PHONE_STAGE_EXTRA_PX);
    // The chat keeps well over its floor.
    expect(600 - divider - stage).toBeGreaterThan(MIN_CHAT_HEIGHT_PX);
  });

  it("holds the chat at its floor when the pane is short", () => {
    const container = 420;
    const stage = phoneStageTarget(container, 390, MIN_CHAT_HEIGHT_PX, divider);
    expect(container - divider - stage).toBeGreaterThanOrEqual(
      MIN_CHAT_HEIGHT_PX,
    );
  });
});

describe("phoneShortStageHeight", () => {
  it("is under half on a pane that only just misses the divider", () => {
    expect(phoneShortStageHeight(364)).toBe(164);
  });

  it("never takes the chat's reserve, however short the pane", () => {
    expect(phoneShortStageHeight(250)).toBe(90);
    expect(250 - phoneShortStageHeight(250)).toBeGreaterThanOrEqual(160);
    expect(phoneShortStageHeight(120)).toBe(0);
    expect(phoneShortStageHeight(0)).toBe(0);
  });
});
