import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Public handles and the page they address, end to end over HTTP.
 *
 * The two things this file is really for:
 *
 *  1. THE PUBLIC ROUTE MUST STAY THIN. It is the only endpoint in the product
 *     that answers a stranger with a person, so the assertion that matters most
 *     here is a negative one — the exact key set of the body, and every field
 *     somebody might reasonably add later named as forbidden.
 *  2. THE CLAIM MUST HAVE EXACTLY ONE WINNER. Concurrency is asserted against a
 *     real Postgres unique index rather than against a mock, because the index
 *     IS the mechanism (see `claimHandle`) and a mock of it would only be
 *     testing the mock.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
  load: null as
    | ((clerkId: string) => Promise<Record<string, unknown> | null>)
    | null,
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => {
    const user = stubs.actor && (await stubs.load?.(stubs.actor.clerk_id));
    return user ? { user } : null;
  },
  resolveAuthSession: async () => {
    const user = stubs.actor && (await stubs.load?.(stubs.actor.clerk_id));
    return user ? { user, ageGate: "passed" as const } : null;
  },
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { claimHandle, getPublicProfileByHandle, resetProfileFeatureCache } =
  await import("../services/profiles.js");

let server: Server;
let baseUrl: string;

type Actor = { id: string; clerk_id: string };

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

/**
 * No `Authorization` header at all — what a crawler, a WhatsApp unfurl and the
 * Pages middleware all send. If any of these start needing a token, the feature
 * is dead and this is where it should be noticed.
 */
async function anonymous<T = Record<string, unknown>>(
  path: string,
): Promise<ApiResult<T>> {
  stubs.actor = null;
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

describeDb("public handles and profiles", () => {
  let alice: Actor;
  let bob: Actor;

  beforeAll(async () => {
    await initDb();
    stubs.load = async (clerkId) => {
      const result = await getPool().query(
        `SELECT id, clerk_id, display_name, username, discriminator, avatar_url,
                avatar_key, is_character, handle, handle_changed_at
         FROM users WHERE clerk_id = $1`,
        [clerkId],
      );
      return result.rows[0] ?? null;
    };
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetProfileFeatureCache();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds
       RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({
      clerkId: "clerk_alice",
      displayName: "Alice",
      avatarUrl: null,
    });
    bob = await upsertUser({
      clerkId: "clerk_bob",
      displayName: "Bob",
      avatarUrl: null,
    });
  });

  // ------------------------------------------------------------------ claim

  it("claims a handle through PATCH /api/me and reports it back", async () => {
    const patched = await call<{ handle: string; handleChangedAt: string }>(
      alice,
      "PATCH",
      "/api/me",
      { handle: "rafa" },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.handle).toBe("rafa");
    expect(patched.body.handleChangedAt).toEqual(expect.any(String));

    const me = await call<{ handle: string }>(alice, "GET", "/api/me");
    expect(me.body.handle).toBe("rafa");
  });

  it("normalises what somebody typed rather than refusing it", async () => {
    const patched = await call<{ handle: string }>(alice, "PATCH", "/api/me", {
      handle: "@João Silva",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.handle).toBe("joao_silva");
  });

  it("refuses a reserved word", async () => {
    const patched = await call(alice, "PATCH", "/api/me", { handle: "suporte" });
    expect(patched.status).toBe(400);
  });

  it("refuses a slur", async () => {
    const patched = await call(alice, "PATCH", "/api/me", {
      handle: "v1ado_oficial2",
    });
    expect(patched.status).toBe(400);
  });

  it("gives the handle to whoever asked first and 409s the loser", async () => {
    const first = await call(alice, "PATCH", "/api/me", { handle: "neymar" });
    expect(first.status).toBe(200);

    const second = await call(bob, "PATCH", "/api/me", { handle: "neymar" });
    expect(second.status).toBe(409);

    const profile = await anonymous<{ profile: { displayName: string } }>(
      "/api/public/profiles/neymar",
    );
    expect(profile.body.profile.displayName).toBe("Alice");
  });

  it("has exactly one winner when two claims race", async () => {
    // Two writes, both in flight, both told the handle is free. This is the
    // scenario the unique index exists for, and the only way to prove it is to
    // actually run it — see the note on `claimHandle`.
    const results = await Promise.allSettled([
      claimHandle(alice.id, "disputado"),
      claimHandle(bob.id, "disputado"),
    ]);
    const won = results.filter((one) => one.status === "fulfilled");
    const lost = results.filter((one) => one.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
    });
  });

  it("does not leave a half-saved form behind when the handle is taken", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "tomado" });
    const refused = await call(bob, "PATCH", "/api/me", {
      handle: "tomado",
      displayName: "Bob Renamed",
    });
    expect(refused.status).toBe(409);
    const me = await call<{ displayName: string }>(bob, "GET", "/api/me");
    expect(me.body.displayName).toBe("Bob");
  });

  // --------------------------------------------------------------- cooldown

  it("lets the first claim through free and then holds the handle for 30 days", async () => {
    expect(
      (await call(alice, "PATCH", "/api/me", { handle: "primeiro" })).status,
    ).toBe(200);
    const again = await call(alice, "PATCH", "/api/me", { handle: "segundo" });
    expect(again.status).toBe(429);
    const me = await call<{ handle: string }>(alice, "GET", "/api/me");
    expect(me.body.handle).toBe("primeiro");
  });

  it("re-sending the handle you already hold is a free no-op", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "mesmo" });
    const before = await call<{ handleChangedAt: string }>(
      alice,
      "GET",
      "/api/me",
    );
    // The settings form sends every field on save. If this spent the cooldown,
    // editing a display name would lock the handle for a month.
    const resaved = await call(alice, "PATCH", "/api/me", {
      handle: "mesmo",
      displayName: "Alice Again",
    });
    expect(resaved.status).toBe(200);
    const after = await call<{ handleChangedAt: string; displayName: string }>(
      alice,
      "GET",
      "/api/me",
    );
    expect(after.body.handleChangedAt).toBe(before.body.handleChangedAt);
    expect(after.body.displayName).toBe("Alice Again");
  });

  it("opens the rename again once the window has passed", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "antigo" });
    await getPool().query(
      `UPDATE users SET handle_changed_at = NOW() - INTERVAL '31 days' WHERE id = $1`,
      [alice.id],
    );
    const renamed = await call<{ handle: string }>(alice, "PATCH", "/api/me", {
      handle: "novo",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.handle).toBe("novo");
    // The old URL stops resolving, which is the cost of renaming and the reason
    // the cooldown exists at all.
    expect((await anonymous("/api/public/profiles/antigo")).status).toBe(404);
  });

  // ----------------------------------------------------------- public route

  it("serves a claimed handle with no Authorization header at all", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const response = await anonymous<{ profile: Record<string, unknown> }>(
      "/api/public/profiles/rafa",
    );
    expect(response.status).toBe(200);
    expect(response.body.profile).toMatchObject({
      handle: "rafa",
      displayName: "Alice",
    });
  });

  it("answers a body with these keys and no others", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const response = await anonymous<{ profile: Record<string, unknown> }>(
      "/api/public/profiles/rafa",
    );
    expect(Object.keys(response.body.profile).sort()).toEqual([
      "achievements",
      "avatarUrl",
      "badges",
      "bannerUrl",
      "connections",
      "depoimentoCount",
      "depoimentos",
      "displayName",
      "handle",
      "memberSince",
    ]);
  });

  it("puts only public connections on the public page, without the provider id", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    await getPool().query(
      `INSERT INTO user_connections
         (user_id, provider, provider_user_id, display_name, profile_url, visibility)
       VALUES
         ($1, 'steam', '76561198000000001', 'AliceSteam',
          'https://steamcommunity.com/profiles/76561198000000001', 'public'),
         ($1, 'twitch', '99', 'AliceTTV', 'https://www.twitch.tv/alicetv', 'shared')`,
      [alice.id],
    );
    const response = await anonymous<{
      profile: {
        connections: Array<Record<string, unknown>>;
      };
    }>("/api/public/profiles/rafa");
    expect(response.body.profile.connections).toEqual([
      {
        provider: "steam",
        displayName: "AliceSteam",
        avatarUrl: null,
        profileUrl: "https://steamcommunity.com/profiles/76561198000000001",
      },
    ]);
    expect(response.body.profile.connections[0]).not.toHaveProperty(
      "providerUserId",
    );
    expect(JSON.stringify(response.body)).not.toContain("AliceTTV");
  });

  it("truncates the join date to a month before it leaves the process", async () => {
    // MONTH GRANULARITY IS WHY THIS FIELD IS ALLOWED ON THE PAGE AT ALL. A
    // timestamp on a surface served to the open internet is a fact about when
    // somebody was at a computer; "no pqp desde julho de 2026" is a badge.
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const response = await anonymous<{
      profile: { memberSince: string };
    }>("/api/public/profiles/rafa");
    expect(response.body.profile.memberSince).toMatch(/^\d{4}-\d{2}$/);
  });

  it("never discloses the id, the tag, the email or the presence", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const response = await anonymous("/api/public/profiles/rafa");
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(alice.id);
    expect(serialised).not.toContain(alice.clerk_id);
    for (const forbidden of ["clerkId", "tag", "discriminator", "email", "status", "ageGate"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("404s an unclaimed handle, which is also how the landing reads 'free'", async () => {
    expect((await anonymous("/api/public/profiles/ninguem")).status).toBe(404);
  });

  it("404s a handle that could never have been claimed", async () => {
    // Same answer for "too short", "reserved" and "never claimed" — this route
    // must not sort strings into kinds for an unauthenticated caller.
    for (const path of ["ab", "admin", "NotLowercase", ".dotfile"]) {
      expect(
        (await anonymous(`/api/public/profiles/${encodeURIComponent(path)}`))
          .status,
      ).toBe(404);
    }
  });

  it("404s a character account's handle", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "personagem" });
    await getPool().query(
      `UPDATE users SET is_character = TRUE, dm_privacy = 'nobody',
              age_checked_at = NOW(), age_check_passed = TRUE
       WHERE id = $1`,
      [alice.id],
    );
    expect((await anonymous("/api/public/profiles/personagem")).status).toBe(
      404,
    );
    expect(await getPublicProfileByHandle("personagem")).toBeNull();
  });

  it("refuses to give a character a handle in the first place", async () => {
    await getPool().query(
      `UPDATE users SET is_character = TRUE, dm_privacy = 'nobody',
              age_checked_at = NOW(), age_check_passed = TRUE
       WHERE id = $1`,
      [alice.id],
    );
    await expect(claimHandle(alice.id, "personagem")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("counts zero depoimentos when the table does not exist yet", async () => {
    // The parallel branch has not landed here. A missing table must read as
    // "none", never as a 500 on the one page strangers see.
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const response = await anonymous<{
      profile: { depoimentoCount: number };
    }>("/api/public/profiles/rafa");
    expect(response.body.profile.depoimentoCount).toBe(0);
  });

  it("shows listed communities as badges and hides everything else", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const created = await call<{ server: { id: string } }>(
      alice,
      "POST",
      "/api/servers",
      { name: "Privado" },
    );
    const publicServer = await call<{ server: { id: string } }>(
      alice,
      "POST",
      "/api/servers",
      { name: "Futebol" },
    );
    await getPool().query(
      `UPDATE servers SET is_community = TRUE, community_category = 'futebol'
       WHERE id = $1`,
      [publicServer.body.server.id],
    );

    const response = await anonymous<{
      profile: { badges: { id: string; name: string; category: string }[] };
    }>("/api/public/profiles/rafa");
    expect(response.body.profile.badges).toEqual([
      {
        id: publicServer.body.server.id,
        name: "Futebol",
        category: "futebol",
      },
    ]);
    // The private server is the whole point: a public page must never disclose
    // who somebody talks to.
    expect(JSON.stringify(response.body)).not.toContain(
      created.body.server.id,
    );
    expect(JSON.stringify(response.body)).not.toContain("Privado");
  });

  it("drops a badge the operator has suspended", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const community = await call<{ server: { id: string } }>(
      alice,
      "POST",
      "/api/servers",
      { name: "Problema" },
    );
    await getPool().query(
      `UPDATE servers SET is_community = TRUE, is_community_suspended = TRUE
       WHERE id = $1`,
      [community.body.server.id],
    );
    const response = await anonymous<{ profile: { badges: unknown[] } }>(
      "/api/public/profiles/rafa",
    );
    expect(response.body.profile.badges).toEqual([]);
  });

  /**
   * The depoimento wall, rendered rather than counted.
   *
   * WHAT CHANGED AND WHY. This used to be a number, on the cautious reading
   * that user-generated text about a third party belongs behind a login. It
   * does not, for a depoimento specifically, and the reason is the approval:
   * the author wrote it for a profile, and the subject published it from a
   * preview that said exactly where it would go. Two people consented to this
   * page. What is asserted below is that everything ELSE stays refused — the
   * author's id and tag above all, because a depoimento must never become a way
   * to enumerate the people who know somebody.
   */
  describe("rendered depoimentos", () => {
    /** Approved unless told otherwise; the state machine is `approved_at`. */
    async function writeDepoimento(
      author: Actor,
      subject: Actor,
      body: string,
      options: { approved?: boolean } = {},
    ): Promise<void> {
      await getPool().query(
        `INSERT INTO depoimentos (author_id, subject_id, body, approved_at)
         VALUES ($1, $2, $3, ${options.approved === false ? "NULL" : "NOW()"})`,
        [author.id, subject.id, body],
      );
    }

    it("renders what the subject published, newest first", async () => {
      await call(alice, "PATCH", "/api/me", { handle: "rafa" });
      await writeDepoimento(bob, alice, "primeira");
      await writeDepoimento(
        await upsertUser({
          clerkId: "clerk_carol",
          displayName: "Carol",
          avatarUrl: null,
        }),
        alice,
        "segunda",
      );
      const response = await anonymous<{
        profile: { depoimentos: { body: string }[]; depoimentoCount: number };
      }>("/api/public/profiles/rafa");
      expect(response.body.profile.depoimentos.map((d) => d.body)).toEqual([
        "segunda",
        "primeira",
      ]);
      expect(response.body.profile.depoimentoCount).toBe(2);
    });

    it("never renders one the subject has not published", async () => {
      // `approved_at IS NULL` is the whole state machine, and pending is
      // readable by the subject alone. A pending depoimento on a public page
      // would be the "Não aceita!" failure with a URL attached.
      await call(alice, "PATCH", "/api/me", { handle: "rafa" });
      await writeDepoimento(bob, alice, "não aceita", { approved: false });
      const response = await anonymous<{
        profile: { depoimentos: unknown[]; depoimentoCount: number };
      }>("/api/public/profiles/rafa");
      expect(response.body.profile.depoimentos).toEqual([]);
      expect(response.body.profile.depoimentoCount).toBe(0);
    });

    it("carries the author as a name and a face and nothing else", async () => {
      await call(alice, "PATCH", "/api/me", { handle: "rafa" });
      await writeDepoimento(bob, alice, "meu irmão");
      const response = await anonymous<{
        profile: { depoimentos: { author: Record<string, unknown> }[] };
      }>("/api/public/profiles/rafa");
      const author = response.body.profile.depoimentos[0]!.author;
      expect(Object.keys(author).sort()).toEqual([
        "avatarUrl",
        "displayName",
        "handle",
      ]);
      // The author has claimed no handle, so there is no page to link to and
      // nothing stands in for one — least of all their `name#1234` tag, which
      // is contact details a third party never opted into publishing.
      expect(author.handle).toBeNull();
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(bob.id);
      expect(serialised).not.toContain(bob.clerk_id);
    });

    it("carries the author's handle when they have one", async () => {
      await call(bob, "PATCH", "/api/me", { handle: "bia" });
      await call(alice, "PATCH", "/api/me", { handle: "rafa" });
      await writeDepoimento(bob, alice, "meu irmão");
      const response = await anonymous<{
        profile: { depoimentos: { author: { handle: string | null } }[] };
      }>("/api/public/profiles/rafa");
      expect(response.body.profile.depoimentos[0]!.author.handle).toBe("bia");
    });

    it("shows at most six and says how many more there are", async () => {
      await call(alice, "PATCH", "/api/me", { handle: "rafa" });
      for (let i = 0; i < 8; i++) {
        const author = await upsertUser({
          clerkId: `clerk_friend_${i}`,
          displayName: `Friend ${i}`,
          avatarUrl: null,
        });
        await writeDepoimento(author, alice, `depoimento ${i}`);
      }
      const response = await anonymous<{
        profile: { depoimentos: unknown[]; depoimentoCount: number };
      }>("/api/public/profiles/rafa");
      // The array is capped and the count is not, which is what lets the page
      // say "e mais 2" honestly.
      expect(response.body.profile.depoimentos).toHaveLength(6);
      expect(response.body.profile.depoimentoCount).toBe(8);
    });
  });

  it("carries the banner the account uploaded, and null when it has none", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const before = await anonymous<{
      profile: { bannerUrl: string | null };
    }>("/api/public/profiles/rafa");
    expect(before.body.profile.bannerUrl).toBeNull();

    await getPool().query(
      `UPDATE users SET banner_url = $2, banner_key = $3 WHERE id = $1`,
      [alice.id, "/api/users/x/banner?v=abcd1234", "banners/x/y.jpg"],
    );
    const after = await anonymous<{
      profile: { bannerUrl: string | null };
    }>("/api/public/profiles/rafa");
    expect(after.body.profile.bannerUrl).toBe("/api/users/x/banner?v=abcd1234");
    // The STORAGE KEY must never travel. It is the one string that names an
    // object in the bucket, and this page is served to the open internet.
    expect(JSON.stringify(after.body)).not.toContain("banners/x/y.jpg");
  });

  it("is rate limited even though it takes no token", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    let sawLimit = false;
    // The bucket is 60 with a slow refill; a script asking a hundred times in a
    // row must hit it. A public route with no per-user key has nothing else
    // standing between it and a scraper.
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await anonymous("/api/public/profiles/rafa");
      if (response.status === 429) {
        sawLimit = true;
        expect(response.headers.get("retry-after")).toBeTruthy();
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it("caches briefly, so one shared link is not one query per recipient", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const response = await anonymous("/api/public/profiles/rafa");
    expect(response.headers.get("cache-control")).toContain("max-age=60");
  });

  // -------------------------------------------------- authenticated lookup

  it("resolves a handle to a user for a signed-in caller", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const found = await call<{ user: { id: string; tag: string } }>(
      bob,
      "GET",
      "/api/users/by-handle/rafa",
    );
    expect(found.status).toBe(200);
    expect(found.body.user.id).toBe(alice.id);
    // The signed-in shape may carry the tag — that is what "add this person"
    // needs, and it is the same shape user search already hands over.
    expect(found.body.user.tag).toEqual(expect.any(String));
  });

  it("requires a session for the handle lookup, unlike the public profile", async () => {
    await call(alice, "PATCH", "/api/me", { handle: "rafa" });
    const response = await anonymous("/api/users/by-handle/rafa");
    expect(response.status).toBe(401);
  });

  it("404s the lookup for a handle nobody holds", async () => {
    expect(
      (await call(bob, "GET", "/api/users/by-handle/ninguem")).status,
    ).toBe(404);
  });
});
