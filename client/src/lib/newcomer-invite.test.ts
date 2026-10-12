import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-refresh", () => ({ onConfigRefresh: () => () => {} }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const {
  NEWCOMER_INVITE_STORAGE_KEY,
  NEWCOMER_INVITE_WINDOW_MS,
  dismissNewcomerInvite,
  inviteMomentFromConfig,
  isNewcomerInviteDismissed,
  isNewcomerInviteMomentOn,
  isRecentNewcomer,
  loadNewcomerInviteConfig,
  newcomerInviteVisible,
  ownRoomCount,
  setNewcomerInviteMomentForTests,
} = await import("./newcomer-invite");
type Facts = Parameters<typeof newcomerInviteVisible>[0];

const NOW = Date.parse("2026-10-10T20:00:00.000Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const ME = "11111111-1111-4111-8111-111111111111";
const SOMEONE = "22222222-2222-4222-8222-222222222222";

const ALONE_IN_QG: Facts = {
  flagOn: true,
  newcomer: true,
  friendsLoaded: true,
  friendCount: 0,
  ownRooms: 0,
  inCommunity: true,
  partyLive: false,
  dismissed: false,
};

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("newcomerInviteVisible", () => {
  it("shows to a newcomer alone in a public community", () => {
    expect(newcomerInviteVisible(ALONE_IN_QG)).toBe(true);
  });

  it.each([
    ["the flag is off", { flagOn: false }],
    ["the account is not new", { newcomer: false }],
    ["the friends list has not answered yet", { friendsLoaded: false }],
    ["they have a friend (or asked somebody)", { friendCount: 1 }],
    ["they have a room of their own or were invited to one", { ownRooms: 1 }],
    ["the open server is not a public community", { inCommunity: false }],
    ["a watch party is live on screen", { partyLive: true }],
    ["it was closed on this device", { dismissed: true }],
  ] as const)("hides when %s", (_label, change) => {
    expect(newcomerInviteVisible({ ...ALONE_IN_QG, ...change })).toBe(false);
  });
});

describe("ownRoomCount", () => {
  it("does not count a public community somebody else owns (the QG placement)", () => {
    expect(ownRoomCount([{ ownerId: SOMEONE, isCommunity: true }], ME)).toBe(0);
  });

  it("counts a private room they were invited to", () => {
    expect(ownRoomCount([{ ownerId: SOMEONE, isCommunity: false }], ME)).toBe(1);
    // An older API that sends no `isCommunity` is a private room.
    expect(ownRoomCount([{ ownerId: SOMEONE }], ME)).toBe(1);
  });

  it("counts a community they own", () => {
    expect(ownRoomCount([{ ownerId: ME, isCommunity: true }], ME)).toBe(1);
  });

  it("counts each kind once in a mixed list", () => {
    expect(
      ownRoomCount(
        [
          { ownerId: SOMEONE, isCommunity: true },
          { ownerId: ME, isCommunity: false },
          { ownerId: SOMEONE, isCommunity: false },
        ],
        ME,
      ),
    ).toBe(2);
  });
});

describe("isRecentNewcomer", () => {
  it("is true inside the week after first-run and false after it", () => {
    expect(isRecentNewcomer(iso(60_000), NOW)).toBe(true);
    expect(isRecentNewcomer(iso(NEWCOMER_INVITE_WINDOW_MS - 1), NOW)).toBe(true);
    expect(isRecentNewcomer(iso(NEWCOMER_INVITE_WINDOW_MS), NOW)).toBe(false);
  });

  it("reads absent, garbage and far-future stamps as not new", () => {
    expect(isRecentNewcomer(undefined, NOW)).toBe(false);
    expect(isRecentNewcomer(null, NOW)).toBe(false);
    expect(isRecentNewcomer("banana", NOW)).toBe(false);
    expect(isRecentNewcomer(iso(-10 * 60_000), NOW)).toBe(false);
  });
});

describe("dismissal", () => {
  it("round-trips through storage under its own key", () => {
    const storage = fakeStorage();
    expect(isNewcomerInviteDismissed(storage)).toBe(false);
    dismissNewcomerInvite(storage);
    expect(storage.getItem(NEWCOMER_INVITE_STORAGE_KEY)).toBe("1");
    expect(isNewcomerInviteDismissed(storage)).toBe(true);
  });

  it("survives storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(isNewcomerInviteDismissed(hostile)).toBe(false);
    expect(() => dismissNewcomerInvite(hostile)).not.toThrow();
  });
});

describe("the onboarding config", () => {
  beforeEach(() => setNewcomerInviteMomentForTests(false));

  it("only an explicit true turns it on", () => {
    expect(inviteMomentFromConfig({ inviteMoment: true })).toBe(true);
    expect(inviteMomentFromConfig({ inviteMoment: "true" })).toBe(false);
    expect(inviteMomentFromConfig({})).toBe(false);
  });

  it("applies the answer, and keeps it when a later ask fails", async () => {
    await loadNewcomerInviteConfig(async () => ({ inviteMoment: true }));
    expect(isNewcomerInviteMomentOn()).toBe(true);
    await loadNewcomerInviteConfig(async () => {
      throw new Error("404");
    });
    expect(isNewcomerInviteMomentOn()).toBe(true);
  });

  it("drops a slow old answer that lands after a newer one", async () => {
    let releaseOld: (value: { inviteMoment: boolean }) => void = () => {};
    const old = loadNewcomerInviteConfig(
      () => new Promise((resolve) => (releaseOld = resolve)),
    );
    await loadNewcomerInviteConfig(async () => ({ inviteMoment: false }));
    releaseOld({ inviteMoment: true });
    await old;
    expect(isNewcomerInviteMomentOn()).toBe(false);
  });
});

describe("App wiring", () => {
  const app = readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");

  it("the strip takes the arrival slot, never over a live party", () => {
    expect(app).toMatch(/if \(surface !== "party" && newcomerInvite\) \{/);
  });

  it("the first-run server row stops counting the placed community only with the flag on", () => {
    expect(app).toMatch(
      /serverCount: newcomerInviteMomentOn\s*\? ownRoomCount\(servers, user\.id\)\s*: servers\.length/,
    );
  });

  it("Criar sala opened from the strip carries the name and ?ref=chama", () => {
    expect(app).toMatch(/startName=\{createServerPrefill\?\.name \?\? null\}/);
    expect(app).toMatch(/inviteRef=\{createServerPrefill \? "chama" : "convite"\}/);
  });
});
