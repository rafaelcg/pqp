import { describe, expect, it } from "vitest";
import { CALL_SPLIT_DIVIDER_PX, MIN_CHAT_HEIGHT_PX } from "./call-split";
import {
  NEWCOMER_WINDOW_MS,
  PARTY_NEWCOMER_STRIP_STORAGE_KEY,
  PHONE_STAGE_EXTRA_PX,
  dismissPartyNewcomerStrip,
  isNewcomerAccount,
  isPartyNewcomerStripDismissed,
  partyNewcomerStripVisible,
  partyPhoneLayoutOn,
  phoneStageTarget,
  suppressAppInviteForNewcomer,
  type PartyNewcomerFacts,
} from "./party-newcomer";

const NOW = Date.parse("2026-09-29T22:00:00.000Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const LIVE_NEWCOMER: PartyNewcomerFacts = {
  flagOn: true,
  partyLive: true,
  audience: true,
  newcomer: true,
  dismissed: false,
};

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function hostileStorage() {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
}

describe("isNewcomerAccount", () => {
  it("is true just after first-run and false past the window", () => {
    expect(isNewcomerAccount(iso(30_000), NOW)).toBe(true);
    expect(isNewcomerAccount(iso(NEWCOMER_WINDOW_MS - 1), NOW)).toBe(true);
    expect(isNewcomerAccount(iso(NEWCOMER_WINDOW_MS), NOW)).toBe(false);
  });

  it("reads absent, junk and far-future stamps as not new", () => {
    expect(isNewcomerAccount(undefined, NOW)).toBe(false);
    expect(isNewcomerAccount(null, NOW)).toBe(false);
    expect(isNewcomerAccount("", NOW)).toBe(false);
    expect(isNewcomerAccount("not a date", NOW)).toBe(false);
    // A device clock an hour behind the server's stamp.
    expect(isNewcomerAccount(iso(-3_600_000), NOW)).toBe(false);
  });

  it("forgives a few seconds of clock skew", () => {
    expect(isNewcomerAccount(iso(-5_000), NOW)).toBe(true);
  });

  it("does not take a grandfathered August account for a newcomer", () => {
    expect(isNewcomerAccount("2026-08-12T03:00:00.000Z", NOW)).toBe(false);
  });
});

describe("the flag gates every behaviour", () => {
  it("with the flag off or absent nothing changes for anybody", () => {
    for (const flagOn of [false, undefined]) {
      const facts = { ...LIVE_NEWCOMER, flagOn };
      expect(partyPhoneLayoutOn(facts)).toBe(false);
      expect(partyNewcomerStripVisible(facts)).toBe(false);
      expect(suppressAppInviteForNewcomer(facts)).toBe(false);
    }
  });

  it("with the flag on, a live party turns all three on for a newcomer", () => {
    expect(partyPhoneLayoutOn(LIVE_NEWCOMER)).toBe(true);
    expect(partyNewcomerStripVisible(LIVE_NEWCOMER)).toBe(true);
    expect(suppressAppInviteForNewcomer(LIVE_NEWCOMER)).toBe(true);
  });

  it("nothing applies once the party is not on air", () => {
    const facts = { ...LIVE_NEWCOMER, partyLive: false };
    expect(partyPhoneLayoutOn(facts)).toBe(false);
    expect(partyNewcomerStripVisible(facts)).toBe(false);
    expect(suppressAppInviteForNewcomer(facts)).toBe(false);
  });
});

describe("who gets which", () => {
  it("gives a regular the phone layout but neither the strip nor the quiet", () => {
    const regular = { ...LIVE_NEWCOMER, newcomer: false };
    expect(partyPhoneLayoutOn(regular)).toBe(true);
    expect(partyNewcomerStripVisible(regular)).toBe(false);
    // The app invite stays for everybody who is not new.
    expect(suppressAppInviteForNewcomer(regular)).toBe(false);
  });

  it("does not draw the strip for somebody holding a seat, but still quiets the invite", () => {
    const seated = { ...LIVE_NEWCOMER, audience: false };
    expect(partyPhoneLayoutOn(seated)).toBe(false);
    expect(partyNewcomerStripVisible(seated)).toBe(false);
    expect(suppressAppInviteForNewcomer(seated)).toBe(true);
  });

  it("stops the strip once it is dismissed and leaves the rest alone", () => {
    const closed = { ...LIVE_NEWCOMER, dismissed: true };
    expect(partyNewcomerStripVisible(closed)).toBe(false);
    expect(partyPhoneLayoutOn(closed)).toBe(true);
    expect(suppressAppInviteForNewcomer(closed)).toBe(true);
  });
});

describe("the strip's memory", () => {
  it("is open until dismissed, and stays dismissed", () => {
    const storage = fakeStorage();
    expect(isPartyNewcomerStripDismissed(storage)).toBe(false);
    dismissPartyNewcomerStrip(storage);
    expect(storage.getItem(PARTY_NEWCOMER_STRIP_STORAGE_KEY)).toBe("1");
    expect(isPartyNewcomerStripDismissed(storage)).toBe(true);
  });

  it("survives storage that throws, or none at all", () => {
    expect(isPartyNewcomerStripDismissed(hostileStorage())).toBe(false);
    expect(() => dismissPartyNewcomerStrip(hostileStorage())).not.toThrow();
    expect(isPartyNewcomerStripDismissed(null)).toBe(false);
    expect(() => dismissPartyNewcomerStrip(null)).not.toThrow();
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
