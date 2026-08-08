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
 * Depoimentos, pinned at the properties the feature's safety rests on rather
 * than at "the list renders".
 *
 * Everything asserted here is a way the surface could be wider than intended,
 * and each one traces to a paragraph of
 * `docs/research/communities-orkut.html` §05:
 *
 *   * ONLY FRIENDS WRITE. A stranger, and an ex-friend, cannot put anything in
 *     your queue at all. This is the gate that closes most of the harassment
 *     story before moderation has to exist.
 *   * A PENDING ONE IS INVISIBLE TO EVERYONE BUT THE SUBJECT, its author after
 *     sending very much included.
 *   * REFUSING DELETES THE ROW. The "Não aceita!" lesson: a queue that retains
 *     what it refuses is a covert DM channel with a publish button attached, so
 *     there must be nothing left behind to mine and nothing to publish later.
 *   * REPLACING RETURNS IT TO PENDING. One standing depoimento per pair, and a
 *     rewrite cannot silently edit what is already on somebody's card.
 *   * CHARACTERS ARE OUTSIDE IT in both directions.
 *   * A BLOCK AND AN UNFRIEND both reach the table, at the storage layer, with
 *     the asymmetry the triggers encode.
 *
 * Route-level checks go through the real router with only the identity layer
 * stubbed — the arrangement api.test.ts, reports.test.ts and communities.test.ts
 * all use. A service that scopes correctly is worth nothing if the route in
 * front of it does not gate.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

/** The identity the next HTTP request will authenticate as. */
let actor: { id: string; clerk_id: string } | null = null;

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

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer } = await import("./servers.js");
const { sendFriendRequest, acceptFriendRequest, removeFriendship } =
  await import("./friends.js");
const { blockUser } = await import("./blocks.js");
const {
  approveDepoimento,
  deleteDepoimento,
  DepoimentoFloodError,
  DepoimentoRefusedError,
  listApprovedDepoimentos,
  listPendingDepoimentos,
  listProfileCommunities,
  setProfileVisibility,
  writeDepoimento,
} = await import("./depoimentos.js");

let httpServer: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface DepoimentoBody {
  id: string;
  author: { id: string; displayName: string };
  body: string;
  createdAt: string;
  approvedAt: string | null;
}

describeDb("depoimentos", () => {
  let alice: { id: string; clerk_id: string };
  let bruno: { id: string; clerk_id: string };
  let carla: { id: string; clerk_id: string };

  beforeAll(async () => {
    await initDb();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetApiRateLimits();
    delete process.env.COMMUNITIES_ENABLED;

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    alice = await makeUser("alice");
    bruno = await makeUser("bruno");
    carla = await makeUser("carla");
  });

  /** Two people who said yes to each other — the gate every write goes through. */
  async function befriend(a: { id: string }, b: { id: string }) {
    await sendFriendRequest(a.id, b.id);
    await acceptFriendRequest(b.id, a.id);
  }

  async function rows() {
    const result = await getPool().query(
      `SELECT * FROM depoimentos ORDER BY created_at`,
    );
    return result.rows;
  }

  // ------------------------------------------------------------ the friend gate

  it("refuses a stranger, without saying why", async () => {
    await expect(
      writeDepoimento(alice.id, bruno.id, "oi"),
    ).rejects.toBeInstanceOf(DepoimentoRefusedError);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses somebody with only a PENDING request — half a yes is not a yes", async () => {
    await sendFriendRequest(alice.id, bruno.id);
    await expect(
      writeDepoimento(alice.id, bruno.id, "oi"),
    ).rejects.toMatchObject({ reason: "not-friends" });
  });

  it("accepts once both sides said yes", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(
      alice.id,
      bruno.id,
      "melhor call da minha vida",
    );
    expect(written.approvedAt).toBeNull();
    expect(written.author.id).toBe(alice.id);
  });

  it("refuses writing about yourself", async () => {
    await expect(
      writeDepoimento(alice.id, alice.id, "eu sou demais"),
    ).rejects.toMatchObject({ reason: "self" });
  });

  /**
   * The route must not tell the four refusals apart. Probing it would otherwise
   * report whether a specific person has blocked you — the exact oracle
   * `POST /api/friends` and `POST /api/dms` both refuse to be.
   */
  it("answers one sentence for every refusal, whatever the reason", async () => {
    const stranger = await call(alice, "POST", `/api/users/${bruno.id}/depoimentos`, {
      body: "oi",
    });
    await blockUser(carla.id, alice.id);
    const blocked = await call(alice, "POST", `/api/users/${carla.id}/depoimentos`, {
      body: "oi",
    });
    expect(stranger.status).toBe(403);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual(stranger.body);
  });

  // ------------------------------------------------------------- the approval

  it("keeps a pending one out of the subject's public list", async () => {
    await befriend(alice, bruno);
    await writeDepoimento(alice.id, bruno.id, "te amo, sua louca");
    expect(await listApprovedDepoimentos(carla.id, bruno.id)).toEqual([]);
    // And out of its own author's view of the profile, which is the case the
    // "invisible to them-after-sending" rule is actually about.
    expect(await listApprovedDepoimentos(alice.id, bruno.id)).toEqual([]);
    // The subject's own profile read does not leak it either — the queue is a
    // different route, and this one filters on `approved_at` for everybody.
    expect(await listApprovedDepoimentos(bruno.id, bruno.id)).toEqual([]);
  });

  it("shows it to the subject's queue and to nobody else's", async () => {
    await befriend(alice, bruno);
    await writeDepoimento(alice.id, bruno.id, "te amo");
    expect(await listPendingDepoimentos(bruno.id)).toHaveLength(1);
    expect(await listPendingDepoimentos(alice.id)).toEqual([]);
    expect(await listPendingDepoimentos(carla.id)).toEqual([]);
  });

  it("publishes only for the subject, never for the author", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "te amo");
    expect(await approveDepoimento(alice.id, written.id)).toBeNull();
    expect(await approveDepoimento(carla.id, written.id)).toBeNull();
    expect(await approveDepoimento(bruno.id, written.id)).toBe(alice.id);
    const published = await listApprovedDepoimentos(carla.id, bruno.id);
    expect(published).toHaveLength(0); // carla shares nothing with bruno
    expect(await listApprovedDepoimentos(alice.id, bruno.id)).toHaveLength(1);
  });

  /**
   * Idempotent, and deliberately so: the client publishes from a two-tap
   * preview, and a double tap must not re-stamp the publication date and jump
   * the thing back to the top of a profile that is ordered by it.
   */
  it("is a no-op the second time, so a double tap does not reorder a profile", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "te amo");
    expect(await approveDepoimento(bruno.id, written.id)).toBe(alice.id);
    expect(await approveDepoimento(bruno.id, written.id)).toBeNull();
  });

  // ---------------------------------------------------- refusing DELETES it

  /**
   * THE LESSON THE WHOLE FEATURE IS SHAPED BY. Because Orkut's unaccepted queue
   * was readable by the recipient forever, Brazilians worked out that a
   * depoimento was a private message and wrote confessions into it prefixed
   * "Não aceita!". A queue that RETAINS what it refuses is a covert DM channel
   * with a publish button on it — so there must be no row left, in no state.
   */
  it("leaves NOTHING behind when the subject refuses", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "não aceita!");
    expect(await deleteDepoimento(bruno.id, written.id)).toBe(true);
    expect(await rows()).toEqual([]);
    // Nothing to publish later, either — which is the failure mode the folklore
    // is actually about.
    expect(await approveDepoimento(bruno.id, written.id)).toBeNull();
  });

  it("lets the author withdraw their own", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "pensando bem…");
    expect(await deleteDepoimento(alice.id, written.id)).toBe(true);
    expect(await rows()).toEqual([]);
  });

  it("lets the subject take a PUBLISHED one down later, without notice", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "te amo");
    await approveDepoimento(bruno.id, written.id);
    expect(await deleteDepoimento(bruno.id, written.id)).toBe(true);
    expect(await listApprovedDepoimentos(alice.id, bruno.id)).toEqual([]);
  });

  it("refuses a third party's delete", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "te amo");
    expect(await deleteDepoimento(carla.id, written.id)).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  // ------------------------------------------------- one per pair, replaced

  it("replaces the standing one instead of stacking a second", async () => {
    await befriend(alice, bruno);
    await writeDepoimento(alice.id, bruno.id, "primeira versão");
    await writeDepoimento(alice.id, bruno.id, "segunda versão");
    const standing = await rows();
    expect(standing).toHaveLength(1);
    expect(standing[0]!.body).toBe("segunda versão");
  });

  /**
   * Rewriting an APPROVED one sends it back to the queue rather than editing
   * what is already on somebody's card. The author could have reached the same
   * place by withdrawing and rewriting, so refusing would only add an error to
   * a sequence that stays possible — but silently changing published text
   * would be a different thing entirely.
   */
  it("returns an approved one to pending when it is rewritten", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "te amo");
    await approveDepoimento(bruno.id, written.id);
    await writeDepoimento(alice.id, bruno.id, "na verdade, não");
    expect(await listApprovedDepoimentos(alice.id, bruno.id)).toEqual([]);
    expect(await listPendingDepoimentos(bruno.id)).toHaveLength(1);
  });

  /**
   * The durable cap bounds BREADTH — how many people can have something
   * standing from you today — because it is a count of rows and a count of rows
   * is the only thing this feature can afford: anything stronger would need a
   * log of depoimentos that no longer exist, which is the graveyard the whole
   * design refuses. So a rewrite of the same person's costs nothing extra, and
   * that is the documented trade rather than an accident.
   */
  it("caps how many PEOPLE can have one standing from you in a day", async () => {
    await befriend(alice, bruno);
    await befriend(alice, carla);
    await writeDepoimento(alice.id, bruno.id, "um", { maxPerDay: 1 });
    // Rewriting the same person's is free — one row, one slot.
    await writeDepoimento(alice.id, bruno.id, "um, revisado", { maxPerDay: 1 });
    // A second person is not.
    await expect(
      writeDepoimento(alice.id, carla.id, "dois", { maxPerDay: 1 }),
    ).rejects.toBeInstanceOf(DepoimentoFloodError);
  });

  // ------------------------------------------------------------- characters

  /**
   * A character neither writes nor receives. The friends gate already makes
   * both unreachable in practice (no friendship with a character is possible),
   * so this is the belt-and-braces restatement — "the fictional stranger left a
   * testimonial on my profile" is a promise a config file cannot keep.
   */
  it("refuses a character in either direction, even with a friendship forced in", async () => {
    await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [
      carla.id,
    ]);
    // The row is written directly: `sendFriendRequest` would refuse it, which
    // is exactly why the check has to exist independently of that path.
    const [low, high] =
      alice.id < carla.id ? [alice.id, carla.id] : [carla.id, alice.id];
    await getPool().query(
      `INSERT INTO friendships (low_user_id, high_user_id, requested_by, status, accepted_at)
       VALUES ($1, $2, $1, 'accepted', NOW())`,
      [low, high],
    );
    await expect(
      writeDepoimento(alice.id, carla.id, "oi"),
    ).rejects.toMatchObject({ reason: "character" });
    await expect(
      writeDepoimento(carla.id, alice.id, "oi"),
    ).rejects.toMatchObject({ reason: "character" });
  });

  // ------------------------------------------------- blocks and unfriending

  it("a block destroys it in both directions, published or not", async () => {
    await befriend(alice, bruno);
    const mine = await writeDepoimento(alice.id, bruno.id, "te amo");
    await approveDepoimento(bruno.id, mine.id);
    await writeDepoimento(bruno.id, alice.id, "eu também");
    await blockUser(bruno.id, alice.id);
    expect(await rows()).toEqual([]);
  });

  /**
   * The asymmetry the trigger encodes, and the reason it is worth a trigger.
   * Unfriending withdraws what is still PENDING — that is the answer to the one
   * harassment shape the friends gate leaves open, an ex-friend's thing sitting
   * in your queue. It leaves an APPROVED one alone, because by then it is not
   * theirs: the subject published it, and a falling-out must not silently
   * rewrite somebody's profile.
   */
  it("an unfriend withdraws the pending one and leaves the published one", async () => {
    await befriend(alice, bruno);
    const published = await writeDepoimento(alice.id, bruno.id, "te amo");
    await approveDepoimento(bruno.id, published.id);
    await writeDepoimento(bruno.id, alice.id, "ainda pensando");

    await removeFriendship(bruno.id, alice.id);

    expect(await listPendingDepoimentos(alice.id)).toEqual([]);
    expect(await listApprovedDepoimentos(bruno.id, bruno.id)).toHaveLength(1);
  });

  // ----------------------------------------------------------- who may read

  it("shows a profile's depoimentos to somebody who shares a server", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "te amo");
    await approveDepoimento(bruno.id, written.id);
    // carla is a stranger to both until she is in the room.
    expect(await listApprovedDepoimentos(carla.id, bruno.id)).toEqual([]);
    const { server } = await createChatServer("sala", bruno.id);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [server.id, carla.id],
    );
    expect(await listApprovedDepoimentos(carla.id, bruno.id)).toHaveLength(1);
  });

  it("hides them from somebody the subject blocked, however they share a room", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "te amo");
    await approveDepoimento(bruno.id, written.id);
    const { server } = await createChatServer("sala", bruno.id);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [server.id, carla.id],
    );
    await blockUser(bruno.id, carla.id);
    expect(await listApprovedDepoimentos(carla.id, bruno.id)).toEqual([]);
  });

  it("orders a profile newest-published first — 'o top' is the last one accepted", async () => {
    await befriend(alice, bruno);
    await befriend(carla, bruno);
    const first = await writeDepoimento(alice.id, bruno.id, "primeiro");
    const second = await writeDepoimento(carla.id, bruno.id, "segundo");
    // Approved in the opposite order to the one they were written in, which is
    // the whole point of ordering on `approved_at`.
    await approveDepoimento(bruno.id, second.id);
    await approveDepoimento(bruno.id, first.id);
    const list = await listApprovedDepoimentos(alice.id, bruno.id);
    expect(list.map((one) => one.body)).toEqual(["primeiro", "segundo"]);
  });

  // ------------------------------------------------------------- the routes

  it("drives the whole loop over HTTP: write, queue, approve, profile", async () => {
    await befriend(alice, bruno);

    const written = await call<{ depoimento: DepoimentoBody }>(
      alice,
      "POST",
      `/api/users/${bruno.id}/depoimentos`,
      { body: "conheci essa mulher jogando às 3 da manhã 💜" },
    );
    expect(written.status).toBe(201);
    expect(written.body.depoimento.approvedAt).toBeNull();

    const queue = await call<{ depoimentos: DepoimentoBody[] }>(
      bruno,
      "GET",
      "/api/me/depoimentos/pending",
    );
    expect(queue.body.depoimentos).toHaveLength(1);
    // The queue names the author, which is what stops anybody being ambushed
    // by a paragraph from a name they were not ready to read.
    expect(queue.body.depoimentos[0]!.author.displayName).toBe("alice");

    const id = queue.body.depoimentos[0]!.id;
    expect((await call(bruno, "POST", `/api/depoimentos/${id}/approve`)).status)
      .toBe(200);

    const profile = await call<{ depoimentos: DepoimentoBody[] }>(
      alice,
      "GET",
      `/api/users/${bruno.id}/depoimentos`,
    );
    expect(profile.body.depoimentos).toHaveLength(1);
    expect(profile.body.depoimentos[0]!.approvedAt).not.toBeNull();
  });

  it("404s the approve when it is somebody else's queue", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "te amo");
    expect(
      (await call(carla, "POST", `/api/depoimentos/${written.id}/approve`))
        .status,
    ).toBe(404);
  });

  it("answers an empty list rather than 403 to a stranger reading a profile", async () => {
    await befriend(alice, bruno);
    const written = await writeDepoimento(alice.id, bruno.id, "te amo");
    await approveDepoimento(bruno.id, written.id);
    const seen = await call<{ depoimentos: DepoimentoBody[] }>(
      carla,
      "GET",
      `/api/users/${bruno.id}/depoimentos`,
    );
    expect(seen.status).toBe(200);
    expect(seen.body.depoimentos).toEqual([]);
  });

  it("tells an author their text is too long, in words they can act on", async () => {
    await befriend(alice, bruno);
    const tooLong = await call(alice, "POST", `/api/users/${bruno.id}/depoimentos`, {
      body: "a".repeat(501),
    });
    expect(tooLong.status).toBe(400);
    expect(String(tooLong.body.error)).toMatch(/500 characters/);
  });

  // -------------------------------------------- community badges on a card

  /** A listed community with a second member, the way the directory wants it. */
  async function makeCommunity(
    name: string,
    member: { id: string },
    options: { suspended?: boolean; listed?: boolean } = {},
  ): Promise<string> {
    const { server } = await createChatServer(name, alice.id);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [server.id, member.id],
    );
    await getPool().query(
      `UPDATE servers SET is_community = $2, is_community_suspended = $3
        WHERE id = $1`,
      [server.id, options.listed ?? true, options.suspended ?? false],
    );
    return server.id;
  }

  it("chips only the listed communities, never a private server", async () => {
    await makeCommunity("privada", bruno, { listed: false });
    await makeCommunity("Eu odeio acordar cedo", bruno);
    const badges = await listProfileCommunities(carla.id, bruno.id);
    expect(badges.communities.map((one) => one.name)).toEqual([
      "Eu odeio acordar cedo",
    ]);
    expect(badges.total).toBe(1);
  });

  /**
   * The operator's kill switch reaches every profile at once, with no
   * per-member fan-out and nothing anyone has to remember to also do.
   */
  it("drops a suspended community from every profile the moment it is pulled", async () => {
    const id = await makeCommunity("problemática", bruno);
    expect((await listProfileCommunities(carla.id, bruno.id)).total).toBe(1);
    await getPool().query(
      `UPDATE servers SET is_community_suspended = TRUE WHERE id = $1`,
      [id],
    );
    expect(await listProfileCommunities(carla.id, bruno.id)).toEqual({
      communities: [],
      total: 0,
    });
  });

  it("honours one membership's opt-out and leaves the others alone", async () => {
    const hidden = await makeCommunity("terapia", bruno);
    await makeCommunity("valorant", bruno);
    expect(await setProfileVisibility(bruno.id, hidden, false)).toBe(true);
    const badges = await listProfileCommunities(carla.id, bruno.id);
    expect(badges.communities.map((one) => one.name)).toEqual(["valorant"]);
    expect(badges.total).toBe(1);
  });

  it("caps the chips at six and reports the real total for the +N", async () => {
    for (let i = 0; i < 8; i++) {
      await makeCommunity(`comunidade ${i}`, bruno);
    }
    const badges = await listProfileCommunities(carla.id, bruno.id);
    expect(badges.communities).toHaveLength(6);
    expect(badges.total).toBe(8);
  });

  it("hides a community from somebody it banned, matching the directory", async () => {
    const id = await makeCommunity("fechada", bruno);
    await getPool().query(
      `INSERT INTO server_bans (server_id, user_id, banned_by) VALUES ($1, $2, $3)`,
      [id, carla.id, alice.id],
    );
    expect((await listProfileCommunities(carla.id, bruno.id)).total).toBe(0);
    // …and still shows it to everybody else.
    expect((await listProfileCommunities(alice.id, bruno.id)).total).toBe(1);
  });

  it("flips the opt-out over HTTP and 404s for a server you are not in", async () => {
    const id = await makeCommunity("valorant", bruno);
    const ok = await call(bruno, "PATCH", `/api/servers/${id}/profile-visibility`, {
      showOnProfile: false,
    });
    expect(ok.status).toBe(200);
    expect((await listProfileCommunities(alice.id, bruno.id)).total).toBe(0);

    const outsider = await call(
      carla,
      "PATCH",
      `/api/servers/${id}/profile-visibility`,
      { showOnProfile: false },
    );
    expect(outsider.status).toBe(404);
  });

  /**
   * The member's switch is the member's. An owner cannot reach into somebody
   * else's membership row through the server PATCH they DO own.
   */
  it("keeps the switch off the owner's server PATCH", async () => {
    const id = await makeCommunity("valorant", bruno);
    await call(alice, "PATCH", `/api/servers/${id}`, { showOnProfile: false });
    expect((await listProfileCommunities(carla.id, bruno.id)).total).toBe(1);
  });

  it("carries both facts on the member's own server list", async () => {
    const id = await makeCommunity("valorant", bruno);
    await setProfileVisibility(bruno.id, id, false);
    const listed = await call<{
      servers: { id: string; isCommunity: boolean; showOnProfile: boolean }[];
    }>(bruno, "GET", "/api/servers");
    const row = listed.body.servers.find((one) => one.id === id)!;
    expect(row.isCommunity).toBe(true);
    expect(row.showOnProfile).toBe(false);
  });
});
