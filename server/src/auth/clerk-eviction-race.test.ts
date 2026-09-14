import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The narrower race Farol's review of #603 flagged (MEDIUM, both findings):
 * `forgetAuthUser` deletes a cache map entry, but deleting a map entry does
 * not cancel a promise that is already in flight. A `loadProfile` or
 * `resolveDbUser` call that started before an eviction can still be sitting
 * on an `await` to Clerk or Postgres when the eviction runs, and without a
 * guard its completion writes straight back into the cache entry the
 * eviction just cleared — for `resolveDbUser`, after `upsertUser` has already
 * recreated the row `DELETE FROM users` just removed.
 *
 * `evictionGeneration` in `clerk.ts` closes this: `loadProfile`/`resolveDbUser`
 * snapshot a per-identity generation counter before starting their async
 * work, `forgetAuthUser` bumps it, and neither writes its result into the
 * cache if the generation moved while it was running.
 *
 * Everything Clerk/Postgres-shaped is mocked here on purpose — the point is
 * to control exactly when each async step resolves relative to the eviction,
 * which a real network call or a real `upsertUser` round trip cannot promise.
 */

const stubs = vi.hoisted(() => ({
  upsertUser: vi.fn(),
  getUser: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("../services/users.js", () => ({
  looksLikeEmailAddress: () => false,
  placeholderDisplayName: (clerkId: string) => `User ${clerkId}`,
  upsertUser: stubs.upsertUser,
}));

vi.mock("../services/age-gate.js", () => ({
  getAgeGateStatus: async () => "passed" as const,
}));

vi.mock("./load-test.js", () => ({
  assertLoadTestAuthConfig: () => {},
  isLoadTestAuthEnabled: () => false,
  loadTestIdentity: () => null,
}));

vi.mock("../services/characters.js", () => ({
  CHARACTER_TOKEN_PREFIX: "character:",
  isCharacterAccountsEnabled: () => false,
  resolveCharacterToken: async () => null,
}));

vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ users: { getUser: stubs.getUser } }),
  verifyToken: stubs.verifyToken,
}));

const { forgetAuthUser, authCacheSizes, clearAuthCaches, resolveAuthUser } =
  await import("./clerk.js");

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function dbUser(clerkId: string) {
  return {
    id: `db_${clerkId}`,
    clerk_id: clerkId,
    display_name: "Race",
    username: null,
    discriminator: null,
    avatar_url: null,
  };
}

describe("auth cache eviction race (Farol review of #603)", () => {
  beforeEach(() => {
    clearAuthCaches();
    stubs.upsertUser.mockReset();
    stubs.getUser.mockReset();
    stubs.verifyToken.mockReset();
    stubs.getUser.mockResolvedValue({
      fullName: "Race",
      username: null,
      imageUrl: null,
      emailAddresses: [],
    });
  });

  it("does not let a slow upsertUser repopulate userCache after an eviction lands mid-flight", async () => {
    const clerkId = "clerk_race_userCache";
    stubs.verifyToken.mockResolvedValue({ sub: clerkId });
    const gate = deferred<ReturnType<typeof dbUser>>();
    stubs.upsertUser.mockReturnValue(gate.promise);

    const inFlight = resolveAuthUser("Bearer real-token");

    // Wait until execution has actually reached `upsertUser` — past
    // `loadProfile`'s own await — before the eviction lands, so this pins
    // the "eviction during resolveDbUser" half of the race specifically.
    await vi.waitFor(() => expect(stubs.upsertUser).toHaveBeenCalled());

    forgetAuthUser(clerkId);
    expect(authCacheSizes().users).toBe(0);

    // The slow upsert finally resolves — with the fix, this must not
    // resurrect the entry the eviction just cleared.
    gate.resolve(dbUser(clerkId));
    await inFlight;

    expect(authCacheSizes().users).toBe(0);
  });

  it("does not let a slow Clerk profile lookup repopulate profileCache after an eviction lands mid-flight", async () => {
    const clerkId = "clerk_race_profileCache";
    stubs.verifyToken.mockResolvedValue({ sub: clerkId });
    stubs.upsertUser.mockResolvedValue(dbUser(clerkId));
    const gate = deferred<{
      fullName: string;
      username: null;
      imageUrl: null;
      emailAddresses: never[];
    }>();
    stubs.getUser.mockReturnValue(gate.promise);

    const inFlight = resolveAuthUser("Bearer real-token");

    await vi.waitFor(() => expect(stubs.getUser).toHaveBeenCalled());

    forgetAuthUser(clerkId);
    expect(authCacheSizes().profiles).toBe(0);

    gate.resolve({
      fullName: "Race",
      username: null,
      imageUrl: null,
      emailAddresses: [],
    });
    await inFlight;

    expect(authCacheSizes().profiles).toBe(0);
  });

  it("still answers the caller waiting on the in-flight lookup, even though the result is not cached", async () => {
    const clerkId = "clerk_race_answer";
    stubs.verifyToken.mockResolvedValue({ sub: clerkId });
    const gate = deferred<ReturnType<typeof dbUser>>();
    stubs.upsertUser.mockReturnValue(gate.promise);

    const inFlight = resolveAuthUser("Bearer real-token");
    await vi.waitFor(() => expect(stubs.upsertUser).toHaveBeenCalled());
    forgetAuthUser(clerkId);
    gate.resolve(dbUser(clerkId));

    const session = await inFlight;
    expect(session?.user.id).toBe(`db_${clerkId}`);
  });
});
