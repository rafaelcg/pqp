import { beforeEach, describe, expect, it } from "vitest";
import { cornerOrder, winningCornerHint } from "./corner-hints";
import {
  isJamAnnouncementSeen,
  JAM_ANNOUNCEMENT_KEY,
  jamAnnouncementWanted,
  rememberJamAnnouncement,
  resetJamAnnouncementForTests,
  type JamAnnouncementFacts,
} from "./jam-announcement";

/** Somebody signed in, idle, with the flag on and the top-song lookup answered. */
const base: JamAnnouncementFacts = {
  announce: true,
  topReady: true,
  seen: false,
  inJam: false,
  automated: false,
  inCall: false,
  sharing: false,
  appRunning: false,
  campaignsYield: false,
  arriving: false,
  typing: false,
  showing: false,
};

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

beforeEach(() => {
  resetJamAnnouncementForTests();
});

describe("who is offered the Jam card", () => {
  it("anybody idle with the flag on, once the lookup answered", () => {
    expect(jamAnnouncementWanted(base)).toBe(true);
  });

  it("the flag off shows nothing", () => {
    expect(jamAnnouncementWanted({ ...base, announce: false })).toBe(false);
  });

  it("waits for the top-song lookup, so its button never changes label", () => {
    expect(jamAnnouncementWanted({ ...base, topReady: false })).toBe(false);
  });

  it("nothing once seen, for somebody already in Jam, or for an automated browser", () => {
    expect(jamAnnouncementWanted({ ...base, seen: true })).toBe(false);
    expect(jamAnnouncementWanted({ ...base, inJam: true })).toBe(false);
    expect(jamAnnouncementWanted({ ...base, automated: true })).toBe(false);
  });
});

describe("it never interrupts", () => {
  it("not in a call, a share, an app, over a live party or watch-now strip, or a fresh arrival, even when already up", () => {
    for (const busy of [
      { inCall: true },
      { sharing: true },
      { appRunning: true },
      { campaignsYield: true },
      { arriving: true },
    ]) {
      expect(jamAnnouncementWanted({ ...base, ...busy }), JSON.stringify(busy)).toBe(false);
      expect(
        jamAnnouncementWanted({ ...base, ...busy, showing: true }),
        JSON.stringify(busy),
      ).toBe(false);
    }
  });

  it("typing holds its entrance, but does not pull a card that is already up", () => {
    expect(jamAnnouncementWanted({ ...base, typing: true })).toBe(false);
    expect(jamAnnouncementWanted({ ...base, typing: true, showing: true })).toBe(true);
  });
});

describe("the store", () => {
  it("is once per browser, under its own key", () => {
    const storage = memoryStorage();
    expect(isJamAnnouncementSeen(storage, true)).toBe(false);
    rememberJamAnnouncement(storage, true);
    expect(JAM_ANNOUNCEMENT_KEY).toBe("pqp:jam-announcement-2026-11");
    expect(storage.data.get(JAM_ANNOUNCEMENT_KEY)).toBe("1");
    expect(isJamAnnouncementSeen(storage, true)).toBe(true);
  });

  it("survives a reload (a fresh load reads the stamp back)", () => {
    const storage = memoryStorage();
    rememberJamAnnouncement(storage, true);
    resetJamAnnouncementForTests();
    expect(isJamAnnouncementSeen(storage, true)).toBe(true);
  });

  it("on a host that persists nothing (localhost) it still stays closed for the load", () => {
    const storage = memoryStorage();
    rememberJamAnnouncement(storage, false);
    expect(storage.data.size).toBe(0);
    expect(isJamAnnouncementSeen(storage, false)).toBe(true);
    resetJamAnnouncementForTests();
    expect(isJamAnnouncementSeen(storage, false)).toBe(false);
  });

  it("storage that throws reads as seen, so a card that cannot remember never nags", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(isJamAnnouncementSeen(hostile, true)).toBe(true);
  });
});

describe("its place in the corner queue", () => {
  it("a Baú post and the notify offer (moments, not campaigns) go first for everybody", () => {
    for (const newcomer of [false, true]) {
      for (const first of ["communityHomePost", "notifyOffer"] as const) {
        expect(winningCornerHint({ [first]: true, jamNews: true }, { newcomer })).toBe(first);
      }
    }
  });

  it("a member sees it before the QG invite and the forum card, without dismissing anything unrelated", () => {
    for (const other of ["qg", "listingNudge", "forumNews"] as const) {
      expect(winningCornerHint({ [other]: true, jamNews: true })).toBe("jamNews");
      expect(winningCornerHint({ [other]: true, jamNews: true }, { newcomer: false })).toBe("jamNews");
    }
  });

  it("a new account is invited to the QG first, then gets the Jam card the moment that is gone", () => {
    expect(winningCornerHint({ qg: true, jamNews: true }, { newcomer: true })).toBe("qg");
    expect(winningCornerHint({ qg: false, jamNews: true }, { newcomer: true })).toBe("jamNews");
    // Still ahead of the cards after it, so it is not pushed behind the campaigns by the reorder.
    expect(winningCornerHint({ jamNews: true, listingNudge: true, forumNews: true, cargos: true }, { newcomer: true })).toBe("jamNews");
  });

  it("the two orders hold the same cards, so one card at a time is unchanged", () => {
    expect([...cornerOrder(true)].sort()).toEqual([...cornerOrder(false)].sort());
    expect(cornerOrder(true).indexOf("jamNews")).toBe(cornerOrder(true).indexOf("qg") + 1);
  });

  it("it goes before Voz limpa and the year-round campaigns", () => {
    expect(
      winningCornerHint({
        jamNews: true,
        voiceClean: true,
        seasonalLook: true,
        mobileBeta: true,
        whatsNew: true,
        appsNews: true,
        cargos: true,
        shortcuts: true,
      }),
    ).toBe("jamNews");
  });

  it("a quiet context (hint_budget) holds it like any campaign", () => {
    expect(winningCornerHint({ jamNews: true }, { quiet: true })).toBeNull();
  });
});
