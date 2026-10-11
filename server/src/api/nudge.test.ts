import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbUser } from "../db.js";

/**
 * CHAMAR A ATENÇÃO, THE HTTP HALF, on a real Postgres: the config route the
 * client reads the flag from, the preferences the opt-out and Modo 2005 ride
 * in, history carrying the kind, and an edit that must not turn the server's
 * line into somebody's text. The socket rules and the two-machine delivery
 * are in `ws/nudge-cluster.test.ts`.
 *
 * The flag is set the way production sets it, a `feature_flags` row after
 * `startFeatureFlags()`, never through the environment (pitfalls 9 and 12).
 */

let actor: DbUser | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.NUDGE;
delete process.env.CLUSTER_BUS;

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { openConversation } = await import("../services/dms.js");
const { acceptFriendRequest, sendFriendRequest } = await import("../services/friends.js");
const { createMessage } = await import("../services/messages.js");
const { resetFeatureFlagsForTests, setGlobalFlag, startFeatureFlags } = await import(
  "../lib/flags.js"
);
const { handleApi, resetApiRateLimits } = await import("./index.js");

describeDb("chamar a atenção over HTTP", () => {
  let http: Server;
  let baseUrl: string;
  let alice: DbUser;
  let bob: DbUser;
  let dmChannelId: string;

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: "Bearer test",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : {} };
  }

  beforeAll(async () => {
    await initDb();
    http = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => http.listen(0, done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => http.close(() => done()));
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, feature_flags, feature_flag_overrides,
                feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({ clerkId: "clerk_alice", displayName: "Alice", avatarUrl: null });
    bob = await upsertUser({ clerkId: "clerk_bob", displayName: "Bob", avatarUrl: null });
    await getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);
    await sendFriendRequest(alice.id, bob.id);
    await acceptFriendRequest(bob.id, alice.id);
    dmChannelId = (await openConversation(alice.id, [bob.id])).channelId;
    await startFeatureFlags();
    actor = alice;
  });

  it("GET /api/fun/config follows the nudge flag: off by default, on by a row", async () => {
    expect(await call("GET", "/api/fun/config")).toEqual({
      status: 200,
      json: { nudge: false },
    });
    await setGlobalFlag("nudge", true, { kind: "dashboard" });
    expect((await call("GET", "/api/fun/config")).json).toEqual({ nudge: true });
  });

  it("history returns the kind, and a nudge cannot be edited into text", async () => {
    const nudge = await createMessage(dmChannelId, alice, "📳", null, undefined, undefined, {
      systemKind: "nudge",
    });
    const plain = await createMessage(dmChannelId, alice, "oi");
    const history = await call("GET", `/api/channels/${dmChannelId}/messages`);
    expect(history.status).toBe(200);
    const messages = history.json.messages as Array<{ id: string; systemKind?: string | null }>;
    expect(messages.find((m) => m.id === nudge!.id)!.systemKind).toBe("nudge");
    expect(messages.find((m) => m.id === plain!.id)!.systemKind ?? null).toBeNull();

    const edit = await call("PATCH", `/api/messages/${nudge!.id}`, { body: "virei texto" });
    expect(edit.status).toBe(400);
    const row = await getPool().query<{ body: string; system_kind: string }>(
      `SELECT body, system_kind FROM messages WHERE id = $1`,
      [nudge!.id],
    );
    expect(row.rows[0]).toEqual({ body: "📳", system_kind: "nudge" });

    // An ordinary message still edits.
    expect((await call("PATCH", `/api/messages/${plain!.id}`, { body: "oi!" })).status).toBe(200);

    // And the nudge deletes like any message.
    expect((await call("DELETE", `/api/messages/${nudge!.id}`)).status).toBeLessThan(300);
  });

  it("the opt-out, the easter-egg find, the new cues and Modo 2005 are stored and read back", async () => {
    const saved = await call("PATCH", "/api/me/preferences", {
      allowNudges: false,
      appearance: "retro",
      easterEggs: { retro: "2026-10-11T12:00:00.000Z" },
      sounds: { nudge: false, friendOnline: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.preferences).toMatchObject({
      allowNudges: false,
      appearance: "retro",
      easterEggs: { retro: "2026-10-11T12:00:00.000Z" },
      sounds: { nudge: false, friendOnline: true },
    });

    // A look this build has never heard of is refused and nothing changes.
    const later = await call("PATCH", "/api/me/preferences", { appearance: "y2k" });
    expect(later.status).toBe(400);
    const after = await getPool().query<{ settings: { appearance?: string } }>(
      `SELECT settings FROM user_preferences WHERE user_id = $1`,
      [alice.id],
    );
    expect(after.rows[0]!.settings.appearance).toBe("retro");
  });
});
