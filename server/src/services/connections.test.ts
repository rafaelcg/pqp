import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbUser } from "../db.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const {
  disconnectConnection,
  listOwnConnections,
  listVisibleConnections,
  resolveRedirectOrigin,
  updateConnectionVisibility,
} = await import("./connections.js");

describe("resolveRedirectOrigin", () => {
  const previousCors = process.env.CORS_ALLOWED_ORIGINS;
  const previousApp = process.env.PUBLIC_APP_URL;
  const previousEnv = process.env.NODE_ENV;

  afterAll(() => {
    process.env.CORS_ALLOWED_ORIGINS = previousCors;
    process.env.PUBLIC_APP_URL = previousApp;
    process.env.NODE_ENV = previousEnv;
  });

  it("accepts an Origin that is on PUBLIC_APP_URL", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_URL = "https://pqp.gg";
    process.env.CORS_ALLOWED_ORIGINS = "https://pqp.gg,https://api.pqp.gg";
    expect(resolveRedirectOrigin("https://pqp.gg")).toBe("https://pqp.gg");
    expect(resolveRedirectOrigin("https://evil.example")).toBeNull();
  });

  it("allows loopback only outside production", () => {
    process.env.PUBLIC_APP_URL = "";
    process.env.CORS_ALLOWED_ORIGINS = "";
    process.env.NODE_ENV = "production";
    expect(resolveRedirectOrigin("http://localhost:5173")).toBeNull();
    process.env.NODE_ENV = "test";
    expect(resolveRedirectOrigin("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
  });
});

describeDb("user_connections", () => {
  let alice: DbUser;
  let bob: DbUser;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({
      clerkId: "clerk_conn_alice",
      displayName: "Alice",
      avatarUrl: null,
    });
    bob = await upsertUser({
      clerkId: "clerk_conn_bob",
      displayName: "Bob",
      avatarUrl: null,
    });
  });

  it("upserts one Steam per account and refuses a second person claiming it", async () => {
    await getPool().query(
      `INSERT INTO user_connections (user_id, provider, provider_user_id, display_name)
       VALUES ($1, 'steam', '76561198000000001', 'AliceSteam')`,
      [alice.id],
    );

    await expect(
      getPool().query(
        `INSERT INTO user_connections (user_id, provider, provider_user_id, display_name)
         VALUES ($1, 'steam', '76561198000000001', 'BobSteam')`,
        [bob.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const mine = await listOwnConnections(alice.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.providerUserId).toBe("76561198000000001");
  });

  it("hides hidden links from other people and public-only from the public page", async () => {
    await getPool().query(
      `INSERT INTO user_connections
         (user_id, provider, provider_user_id, display_name, visibility)
       VALUES
         ($1, 'steam', '76561198000000001', 'SteamName', 'public'),
         ($1, 'twitch', '123', 'TwitchName', 'shared'),
         ($1, 'battlenet', '99', 'Tag#1234', 'hidden')`,
      [alice.id],
    );

    const own = await listOwnConnections(alice.id);
    expect(own.map((row) => row.provider).sort()).toEqual([
      "battlenet",
      "steam",
      "twitch",
    ]);

    const card = await listVisibleConnections(alice.id, "shared");
    expect(card.map((row) => row.provider).sort()).toEqual(["steam", "twitch"]);
    expect(card.every((row) => !("providerUserId" in row))).toBe(true);

    const page = await listVisibleConnections(alice.id, "public");
    expect(page.map((row) => row.provider)).toEqual(["steam"]);
  });

  it("changes visibility and disconnects", async () => {
    await getPool().query(
      `INSERT INTO user_connections (user_id, provider, provider_user_id, display_name)
       VALUES ($1, 'twitch', '42', 'AliceTTV')`,
      [alice.id],
    );
    const updated = await updateConnectionVisibility(alice, "twitch", "public");
    expect(updated.visibility).toBe("public");
    await disconnectConnection(alice, "twitch");
    expect(await listOwnConnections(alice.id)).toEqual([]);
  });
});
