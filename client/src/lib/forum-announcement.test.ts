import { beforeEach, describe, expect, it } from "vitest";
import { winningCornerHint } from "./corner-hints";
import {
  forumAnnouncementKey,
  forumAnnouncementTarget,
  isForumAnnouncementSeen,
  rememberForumAnnouncement,
  resetForumAnnouncementForTests,
  type ForumAnnouncementFacts,
} from "./forum-announcement";

/** A member of a server whose forum is announced, idle, on its #geral. */
const base: ForumAnnouncementFacts = {
  announce: true,
  member: true,
  forumChannelId: "forum-1",
  viewingForum: false,
  seen: false,
  automated: false,
  inCall: false,
  sharing: false,
  appRunning: false,
  campaignsYield: false,
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
  resetForumAnnouncementForTests();
});

describe("who is offered the forum card", () => {
  it("a member, idle, with the flag on and a forum to open: that forum", () => {
    expect(forumAnnouncementTarget(base)).toBe("forum-1");
  });

  it("the flag off shows nothing, wherever the person is", () => {
    expect(forumAnnouncementTarget({ ...base, announce: false })).toBeNull();
  });

  it("somebody who is not a member of the server sees nothing", () => {
    expect(forumAnnouncementTarget({ ...base, member: false })).toBeNull();
  });

  it("nothing when there is no forum the person can see", () => {
    expect(forumAnnouncementTarget({ ...base, forumChannelId: null })).toBeNull();
  });

  it("nothing for somebody already looking at the forum", () => {
    expect(forumAnnouncementTarget({ ...base, viewingForum: true })).toBeNull();
  });

  it("nothing once it was seen for this server", () => {
    expect(forumAnnouncementTarget({ ...base, seen: true })).toBeNull();
  });

  it("never for an automated browser", () => {
    expect(forumAnnouncementTarget({ ...base, automated: true })).toBeNull();
  });
});

describe("it never interrupts", () => {
  it("not in a call, a share, an app or over a live party, even when already up", () => {
    for (const busy of [
      { inCall: true },
      { sharing: true },
      { appRunning: true },
      { campaignsYield: true },
    ]) {
      expect(forumAnnouncementTarget({ ...base, ...busy }), JSON.stringify(busy)).toBeNull();
      expect(
        forumAnnouncementTarget({ ...base, ...busy, showing: true }),
        JSON.stringify(busy),
      ).toBeNull();
    }
  });

  it("typing holds its entrance, but does not pull a card that is already up", () => {
    expect(forumAnnouncementTarget({ ...base, typing: true })).toBeNull();
    expect(forumAnnouncementTarget({ ...base, typing: true, showing: true })).toBe("forum-1");
  });
});

describe("the store", () => {
  it("is once per server: stamping one leaves the other unseen", () => {
    const storage = memoryStorage();
    expect(isForumAnnouncementSeen("qg", storage, true)).toBe(false);
    rememberForumAnnouncement("qg", storage, true);
    expect(storage.data.get(forumAnnouncementKey("qg"))).toBe("1");
    expect(isForumAnnouncementSeen("qg", storage, true)).toBe(true);
    expect(isForumAnnouncementSeen("other", storage, true)).toBe(false);
  });

  it("survives a reload (a fresh load reads the stamp back)", () => {
    const storage = memoryStorage();
    rememberForumAnnouncement("qg", storage, true);
    resetForumAnnouncementForTests();
    expect(isForumAnnouncementSeen("qg", storage, true)).toBe(true);
  });

  it("on a host that persists nothing (localhost) it still stays closed for the load", () => {
    const storage = memoryStorage();
    rememberForumAnnouncement("qg", storage, false);
    expect(storage.data.size).toBe(0);
    expect(isForumAnnouncementSeen("qg", storage, false)).toBe(true);
    resetForumAnnouncementForTests();
    expect(isForumAnnouncementSeen("qg", storage, false)).toBe(false);
  });

  it("storage that throws reads as seen, so a card that cannot remember never nags", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(isForumAnnouncementSeen("qg", hostile, true)).toBe(true);
  });
});

describe("its place in the corner queue", () => {
  it("a Baú post, the notify offer and the QG invite go first", () => {
    for (const first of ["communityHomePost", "notifyOffer", "qg"] as const) {
      expect(winningCornerHint({ [first]: true, forumNews: true })).toBe(first);
    }
  });

  it("it goes before the year-round campaigns", () => {
    expect(
      winningCornerHint({
        forumNews: true,
        seasonalLook: true,
        mobileBeta: true,
        whatsNew: true,
        appsNews: true,
        cargos: true,
        shortcuts: true,
      }),
    ).toBe("forumNews");
  });

  it("a quiet context (hint_budget) holds it like any campaign", () => {
    expect(winningCornerHint({ forumNews: true }, { quiet: true })).toBeNull();
  });
});
