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
  connectionAdoption,
  disconnectConnection,
  listCardConnections,
  listOwnConnections,
  listVisibleConnections,
  resolveRedirectOrigin,
  updateConnectionVisibility,
  upsertConnection,
} = await import("./connections.js");
const { sendFriendRequest, acceptFriendRequest } = await import("./friends.js");
const { createServer } = await import("./servers.js");
const { blockUser } = await import("./blocks.js");

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

  it("shows shared links to self, friends, and a shared server, not to a stranger", async () => {
    await upsertConnection(alice.id, "steam", {
      providerUserId: "76561198000000001",
      displayName: "AliceSteam",
      avatarUrl: null,
      profileUrl: null,
    });
    const carol = await upsertUser({
      clerkId: "clerk_conn_carol",
      displayName: "Carol",
      avatarUrl: null,
    });
    const dave = await upsertUser({
      clerkId: "clerk_conn_dave",
      displayName: "Dave",
      avatarUrl: null,
    });

    expect(await listCardConnections(alice.id, alice.id)).toHaveLength(1);
    expect(await listCardConnections(bob.id, alice.id)).toEqual([]);
    expect(await listCardConnections(dave.id, alice.id)).toEqual([]);

    await sendFriendRequest(alice.id, bob.id);
    await acceptFriendRequest(bob.id, alice.id);
    expect(await listCardConnections(bob.id, alice.id)).toHaveLength(1);

    const { server } = await createServer("sala", alice.id);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [server.id, carol.id],
    );
    expect(await listCardConnections(carol.id, alice.id)).toHaveLength(1);
    expect(await listCardConnections(dave.id, alice.id)).toEqual([]);
  });

  it("hides the card from a blocked pair even when they share a server", async () => {
    await upsertConnection(alice.id, "steam", {
      providerUserId: "76561198000000001",
      displayName: "AliceSteam",
      avatarUrl: null,
      profileUrl: null,
    });
    const carol = await upsertUser({
      clerkId: "clerk_conn_carol_block",
      displayName: "Carol",
      avatarUrl: null,
    });
    const { server } = await createServer("sala", alice.id);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [server.id, carol.id],
    );
    await blockUser(alice.id, carol.id);
    expect(await listCardConnections(carol.id, alice.id)).toEqual([]);
  });

  it("keeps visibility when the same account reconnects, and resets when a different one does", async () => {
    await upsertConnection(alice.id, "steam", {
      providerUserId: "76561198000000001",
      displayName: "AliceSteam",
      avatarUrl: null,
      profileUrl: null,
    });
    await updateConnectionVisibility(alice, "steam", "public");
    const same = await upsertConnection(alice.id, "steam", {
      providerUserId: "76561198000000001",
      displayName: "AliceSteam2",
      avatarUrl: null,
      profileUrl: null,
    });
    expect(same.visibility).toBe("public");
    expect(same.displayName).toBe("AliceSteam2");

    const switched = await upsertConnection(alice.id, "steam", {
      providerUserId: "76561198000000002",
      displayName: "OtherSteam",
      avatarUrl: null,
      profileUrl: null,
    });
    expect(switched.visibility).toBe("shared");
    expect(switched.providerUserId).toBe("76561198000000002");
  });

  /**
   * The operator dashboard's numbers. The cases that matter are the ones where
   * a naive `COUNT(*) GROUP BY provider` would lie: one person on two
   * providers, and accounts that are not people.
   */
  describe("connectionAdoption", () => {
    const providerEnv = [
      "STEAM_WEB_API_KEY",
      "TWITCH_CLIENT_ID",
      "TWITCH_CLIENT_SECRET",
      "BATTLENET_CLIENT_ID",
      "BATTLENET_CLIENT_SECRET",
    ] as const;
    const saved = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const name of providerEnv) {
        saved.set(name, process.env[name]);
        delete process.env[name];
      }
    });

    afterAll(() => {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });

    async function link(
      userId: string,
      provider: "steam" | "battlenet" | "twitch",
      providerUserId: string,
      visibility: "hidden" | "shared" | "public",
    ): Promise<void> {
      await getPool().query(
        `INSERT INTO user_connections (user_id, provider, provider_user_id, display_name, visibility)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, provider, providerUserId, `${provider}-name`, visibility],
      );
    }

    it("reports every provider with zeros when nobody has linked anything", async () => {
      const adoption = await connectionAdoption();
      expect(adoption.anyProvider).toBe(0);
      expect(adoption.anyProviderPublic).toBe(0);
      expect(adoption.providers.map((p) => p.provider)).toEqual([
        "steam",
        "battlenet",
        "twitch",
      ]);
      for (const row of adoption.providers) {
        expect(row).toMatchObject({ linked: 0, public: 0, shared: 0, hidden: 0 });
      }
    });

    it("counts people once across providers and splits them by visibility", async () => {
      const carol = await upsertUser({
        clerkId: "clerk_conn_carol_adoption",
        displayName: "Carol",
        avatarUrl: null,
      });

      // Alice links two providers: one account, two links, one of them public.
      await link(alice.id, "steam", "76561198000000001", "public");
      await link(alice.id, "twitch", "twitch-alice", "hidden");
      // Bob links Steam only, at the default visibility.
      await link(bob.id, "steam", "76561198000000002", "shared");
      // Carol links Twitch only, and shows it.
      await link(carol.id, "twitch", "twitch-carol", "public");

      const adoption = await connectionAdoption();

      // Three accounts have linked something, not four links.
      expect(adoption.anyProvider).toBe(3);
      // Alice and Carol show something publicly; Bob does not.
      expect(adoption.anyProviderPublic).toBe(2);

      const byProvider = Object.fromEntries(
        adoption.providers.map((row) => [row.provider, row]),
      );
      expect(byProvider.steam).toMatchObject({
        linked: 2,
        public: 1,
        shared: 1,
        hidden: 0,
      });
      expect(byProvider.twitch).toMatchObject({
        linked: 2,
        public: 1,
        shared: 0,
        hidden: 1,
      });
      expect(byProvider.battlenet).toMatchObject({ linked: 0, public: 0 });

      // The visibility split always accounts for every linked person.
      for (const row of adoption.providers) {
        expect(row.public + row.shared + row.hidden).toBe(row.linked);
      }
    });

    it("excludes webhook pseudo-accounts and the house cast", async () => {
      const bot = await upsertUser({
        clerkId: "clerk_conn_webhook",
        displayName: "Deploy bot",
        avatarUrl: null,
      });
      const npc = await upsertUser({
        clerkId: "clerk_conn_character",
        displayName: "Casa",
        avatarUrl: null,
      });
      await getPool().query(`UPDATE users SET is_webhook = TRUE WHERE id = $1`, [
        bot.id,
      ]);
      await getPool().query(
        `UPDATE users SET is_character = TRUE WHERE id = $1`,
        [npc.id],
      );
      await link(alice.id, "steam", "76561198000000001", "public");
      await link(bot.id, "steam", "76561198000000009", "public");
      await link(npc.id, "twitch", "twitch-npc", "public");

      const adoption = await connectionAdoption();
      expect(adoption.anyProvider).toBe(1);
      expect(adoption.anyProviderPublic).toBe(1);
      const steam = adoption.providers.find((p) => p.provider === "steam");
      expect(steam).toMatchObject({ linked: 1, public: 1 });
      const twitch = adoption.providers.find((p) => p.provider === "twitch");
      expect(twitch).toMatchObject({ linked: 0 });
    });

    it("marks a provider enabled only when its credentials are configured", async () => {
      const off = await connectionAdoption();
      expect(off.providers.map((p) => p.enabled)).toEqual([false, false, false]);

      process.env.STEAM_WEB_API_KEY = "steam-key";
      const on = await connectionAdoption();
      expect(
        on.providers.find((p) => p.provider === "steam")?.enabled,
      ).toBe(true);
      expect(
        on.providers.find((p) => p.provider === "twitch")?.enabled,
      ).toBe(false);
    });
  });
});
