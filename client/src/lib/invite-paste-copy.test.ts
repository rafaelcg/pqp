import { beforeEach, describe, expect, it, vi } from "vitest";

const createInvite = vi.fn();
vi.mock("@/lib/api", () => ({
  createInvite: (...args: unknown[]) => createInvite(...args),
}));

const {
  REUSE_MS,
  inviteCodeFor,
  rememberInviteCode,
  resetInviteCodeCache,
  setInviteCacheAccount,
} = await import("./invite-paste-copy");

beforeEach(() => {
  resetInviteCodeCache();
  setInviteCacheAccount(null);
  createInvite.mockReset();
  createInvite.mockImplementation(async () => ({ invite: { code: "fresh" } }));
});

describe("inviteCodeFor", () => {
  it("reuses a code minted a moment ago instead of making another link", async () => {
    rememberInviteCode("s1", "wizard", 1_000);
    expect(await inviteCodeFor("s1", 1_000 + 60_000)).toBe("wizard");
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("asks the API again once the reuse window is over (it is the permission check)", async () => {
    rememberInviteCode("s1", "old", 0);
    expect(await inviteCodeFor("s1", REUSE_MS + 1)).toBe("fresh");
    expect(createInvite).toHaveBeenCalledTimes(1);
  });

  it("shares one request between presses that land together", async () => {
    const [a, b] = await Promise.all([inviteCodeFor("s2"), inviteCodeFor("s2")]);
    expect(a).toBe("fresh");
    expect(b).toBe("fresh");
    expect(createInvite).toHaveBeenCalledTimes(1);
  });

  it("forgets everything when the account changes", async () => {
    setInviteCacheAccount("alice");
    rememberInviteCode("s1", "alices");
    setInviteCacheAccount("bob");
    expect(await inviteCodeFor("s1")).toBe("fresh");
  });
});
