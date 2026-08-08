import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Communities, pinned at the four boundaries that actually matter.
 *
 * This feature is a legal category change before it is a product feature (see
 * docs/research/communities-orkut.html §08 and the header of
 * services/communities.ts), so what is asserted here is not "the grid renders"
 * — it is every way the surface could be wider than intended:
 *
 *   * WITH THE FLAG OFF NOTHING EXISTS. Every route 404s, including the report
 *     subject, and no server can be made into a community. This is the one that
 *     protects production today, where the flag is unset.
 *   * A BAN IS INVISIBILITY. A server you are barred from must not appear in
 *     the directory, must not appear in search, and must not be joinable — in
 *     that order, because listing-then-refusing tells a banned person exactly
 *     where they are unwelcome.
 *   * JOINING IS IDEMPOTENT. The client navigates the instant the call
 *     resolves, so a double tap and a retry have to be the same join.
 *   * THE OPT-IN LEAVES A TRAIL. Making a private room publicly findable is the
 *     most consequential setting an owner has, and an audit entry is the only
 *     durable record of who did it.
 *
 * Route-level checks go through the real router with only the identity layer
 * stubbed, the same arrangement api.test.ts and reports.test.ts use: a service
 * that scopes correctly is worth nothing if the route in front of it does not
 * gate.
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
const { isCommunitiesEnabled, listCommunities } = await import(
  "./communities.js"
);
const { COMMUNITY_SLUG_PATTERN_SQL, slugifyCommunityName } = await import(
  "@pqp/shared"
);

let httpServer: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/**
 * The raw `Response`, for the assertions that are about headers rather than
 * about a body — the public page's cacheability, above all, which is the one
 * JSON response in this API that is not `no-store` and is therefore the one
 * whose headers can be wrong in a way no body assertion would notice.
 *
 * `as: null` sends NO Authorization header at all rather than a dummy one, so
 * "this route needs no session" is actually being tested and not merely
 * asserted against a stub that would have answered anyway.
 */
async function callRaw(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  actor = as;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(as ? { Authorization: "Bearer test" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await callRaw(as, method, path, body);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface CommunityCard {
  id: string;
  name: string;
  tagline: string | null;
  category: string;
  memberCount: number;
  joined: boolean;
}

describeDb("communities", () => {
  let owner: { id: string; clerk_id: string };
  let joiner: { id: string; clerk_id: string };
  let banned: { id: string; clerk_id: string };
  let filler: { id: string; clerk_id: string };
  let operator: { id: string; clerk_id: string };

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
    delete process.env.INSTANCE_MODERATOR_CLERK_IDS;
    process.env.COMMUNITIES_ENABLED = "true";

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    owner = await makeUser("owner");
    joiner = await makeUser("joiner");
    banned = await makeUser("banned");
    filler = await makeUser("filler");
    operator = await makeUser("operator");
  });

  afterEach(() => {
    delete process.env.COMMUNITIES_ENABLED;
  });

  /**
   * A listed community that clears the member floor.
   *
   * `filler` is added so the row has two members — see COMMUNITY_MEMBER_FLOOR.
   * Every test that browses needs this, and forgetting it is the single most
   * confusing way for one of these to fail (an empty grid, no error).
   */
  async function makeCommunity(
    name: string,
    options: {
      category?: string;
      tagline?: string | null;
      listed?: boolean;
      suspended?: boolean;
      extraMembers?: { id: string }[];
      /**
       * The public address. Written straight in rather than derived, because
       * these rows bypass `updateCommunitySettings` — which is itself under
       * test and must not be the thing that sets up its own fixtures. Null
       * models a listing made before slugs existed.
       */
      slug?: string | null;
    } = {},
  ): Promise<string> {
    const created = await createChatServer(name, owner.id);
    const serverId = created.server.id;
    for (const member of options.extraMembers ?? [{ id: filler.id }]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role)
         VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
        [serverId, member.id],
      );
    }
    await getPool().query(
      `UPDATE servers SET is_community = $2, community_category = $3,
              community_tagline = $4, is_community_suspended = $5,
              community_slug = $6
       WHERE id = $1`,
      [
        serverId,
        options.listed ?? true,
        options.category ?? "geral",
        options.tagline ?? null,
        options.suspended ?? false,
        options.slug === undefined
          ? slugifyCommunityName(name) || null
          : options.slug,
      ],
    );
    return serverId;
  }

  // ------------------------------------------------------------- the flag

  describe("with COMMUNITIES_ENABLED unset", () => {
    beforeEach(() => {
      delete process.env.COMMUNITIES_ENABLED;
    });

    it("reports itself off through the config endpoint rather than 404ing it", async () => {
      // The client cannot tell "off" from "unreachable" if this route also
      // disappears, and it has to render those two states identically.
      const res = await call(joiner, "GET", "/api/communities/config");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: false });
    });

    it("404s the directory, a listing, and the join", async () => {
      process.env.COMMUNITIES_ENABLED = "true";
      const serverId = await makeCommunity("Eu odeio acordar cedo");
      delete process.env.COMMUNITIES_ENABLED;

      expect((await call(joiner, "GET", "/api/communities")).status).toBe(404);
      expect(
        (await call(joiner, "GET", `/api/communities/${serverId}`)).status,
      ).toBe(404);
      expect(
        (await call(joiner, "POST", `/api/communities/${serverId}/join`)).status,
      ).toBe(404);
    });

    it("404s the owner's own opt-in routes", async () => {
      const created = await createChatServer("Private", owner.id);
      expect(
        (await call(owner, "GET", `/api/servers/${created.server.id}/community`))
          .status,
      ).toBe(404);
      expect(
        (
          await call(
            owner,
            "PATCH",
            `/api/servers/${created.server.id}/community`,
            { isCommunity: true },
          )
        ).status,
      ).toBe(404);
    });

    it("404s a community report, rather than filing one against nothing", async () => {
      process.env.COMMUNITIES_ENABLED = "true";
      const serverId = await makeCommunity("Report me");
      delete process.env.COMMUNITIES_ENABLED;

      const res = await call(joiner, "POST", "/api/reports", {
        subjectType: "server",
        serverId,
        reason: "hate_speech",
      });
      expect(res.status).toBe(404);
    });

    it("leaves the ordinary server PATCH working", async () => {
      // The flag must not take anything existing down with it.
      const created = await createChatServer("Private", owner.id);
      const res = await call(owner, "PATCH", `/api/servers/${created.server.id}`, {
        name: "Renamed",
      });
      expect(res.status).toBe(200);
    });

    it("is what `isCommunitiesEnabled` reads, per call and not at import", async () => {
      expect(isCommunitiesEnabled()).toBe(false);
      process.env.COMMUNITIES_ENABLED = "true";
      expect(isCommunitiesEnabled()).toBe(true);
      process.env.COMMUNITIES_ENABLED = "1";
      // Only the exact string turns it on: a truthy-looking value is somebody
      // guessing, and guessing wrong here publishes a directory.
      expect(isCommunitiesEnabled()).toBe(false);
    });
  });

  // -------------------------------------------------------- the directory

  describe("the directory", () => {
    it("lists only servers that opted in", async () => {
      const listed = await makeCommunity("Só mais 5 minutinhos");
      await makeCommunity("Not listed", { listed: false });

      const res = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      expect(res.status).toBe(200);
      expect(res.body.communities.map((c) => c.id)).toEqual([listed]);
    });

    it("filters by category, and refuses a category nobody defined", async () => {
      const games = await makeCommunity("LoL BR", { category: "games" });
      await makeCommunity("Pagode", { category: "musica" });

      const filtered = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities?category=games",
      );
      expect(filtered.body.communities.map((c) => c.id)).toEqual([games]);

      const all = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      expect(all.body.communities).toHaveLength(2);

      // Not silently ignored: answering a filtered request with everything
      // reads as the filter being broken.
      expect(
        (await call(joiner, "GET", "/api/communities?category=cripto")).status,
      ).toBe(400);
    });

    it("searches name and tagline, and treats `%` as text", async () => {
      const byName = await makeCommunity("Eu odeio acordar cedo");
      const byTagline = await makeCommunity("Clube", {
        tagline: "quem odeia segunda entra aqui",
      });
      await makeCommunity("100% seguro");

      const name = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities?q=acordar",
      );
      expect(name.body.communities.map((c) => c.id)).toEqual([byName]);

      const tagline = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities?q=segunda",
      );
      expect(tagline.body.communities.map((c) => c.id)).toEqual([byTagline]);

      // A bare `%` would match everything if the metacharacter leaked through.
      const literal = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities?q=%25%25%25",
      );
      expect(literal.body.communities).toHaveLength(0);
    });

    it("hides one-member rooms from browsing but finds them by search", async () => {
      // The cold-start rule from the research doc, both halves of it.
      const lonely = await makeCommunity("Acabei de criar", {
        extraMembers: [],
      });

      const browse = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      expect(browse.body.communities).toHaveLength(0);

      const searched = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities?q=Acabei",
      );
      expect(searched.body.communities.map((c) => c.id)).toEqual([lonely]);
    });

    it("orders by member count, biggest first", async () => {
      const small = await makeCommunity("Small");
      const big = await makeCommunity("Big", {
        extraMembers: [{ id: filler.id }, { id: joiner.id }, { id: banned.id }],
      });

      const res = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      expect(res.body.communities.map((c) => c.id)).toEqual([big, small]);
      expect(res.body.communities[0]!.memberCount).toBe(4);
      expect(res.body.communities[1]!.memberCount).toBe(2);
    });

    it("keeps the member count true across joins, leaves and cascades", async () => {
      // The trigger, not the application code — every path has to agree or the
      // directory's only ordering key drifts.
      const serverId = await makeCommunity("Counted");
      const count = async () =>
        Number(
          (
            await getPool().query<{ member_count: number }>(
              `SELECT member_count FROM servers WHERE id = $1`,
              [serverId],
            )
          ).rows[0]!.member_count,
        );
      expect(await count()).toBe(2);

      await call(joiner, "POST", `/api/communities/${serverId}/join`);
      expect(await count()).toBe(3);

      await call(joiner, "POST", `/api/servers/${serverId}/leave`);
      expect(await count()).toBe(2);

      // A deleted account takes its membership with it via ON DELETE CASCADE,
      // which no application code ever sees.
      await getPool().query(`DELETE FROM users WHERE id = $1`, [filler.id]);
      expect(await count()).toBe(1);
    });

    it("marks a community the caller is already in as joined", async () => {
      const serverId = await makeCommunity("Já entrei");
      await call(joiner, "POST", `/api/communities/${serverId}/join`);

      const res = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      // Still listed. The card just offers "open" instead of "join" — hiding it
      // would make the grid contradict itself the moment you joined from it.
      expect(res.body.communities[0]!.joined).toBe(true);

      const other = await call<{ communities: CommunityCard[] }>(
        banned,
        "GET",
        "/api/communities",
      );
      expect(other.body.communities[0]!.joined).toBe(false);
    });

    it("pages, and says whether there is more", async () => {
      for (let i = 0; i < 3; i += 1) {
        await makeCommunity(`Community ${i}`);
      }
      const first = await call<{ communities: CommunityCard[]; hasMore: boolean }>(
        joiner,
        "GET",
        "/api/communities?limit=2",
      );
      expect(first.body.communities).toHaveLength(2);
      expect(first.body.hasMore).toBe(true);

      const second = await call<{
        communities: CommunityCard[];
        hasMore: boolean;
      }>(joiner, "GET", "/api/communities?limit=2&offset=2");
      expect(second.body.communities).toHaveLength(1);
      expect(second.body.hasMore).toBe(false);
    });

    it("does not leak the owner, the retention policy or the SSO domain", async () => {
      await makeCommunity("Público");
      const res = await call<{ communities: Record<string, unknown>[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      const card = res.body.communities[0]!;
      // The list is the assertion, and it is exhaustive on purpose: a column
      // added to `DIRECTORY_COLUMNS` has to be a deliberate decision to show a
      // stranger, not something that arrived because it was already selected
      // somewhere else. `iconUrl` / `bannerUrl` are here because a community
      // asked to be found and its picture is what a card is for; `slug` is here
      // because the card's share button copies `pqp.gg/c/<slug>`, which is the
      // one address a member can hand to somebody outside the product.
      expect(Object.keys(card).sort()).toEqual([
        "bannerUrl",
        "category",
        "createdAt",
        "iconUrl",
        "id",
        "joined",
        "memberCount",
        "name",
        "slug",
        "tagline",
      ]);
    });
  });

  // -------------------------------------------------------- bans and pulls

  describe("exclusions", () => {
    it("hides a community the viewer is banned from, everywhere", async () => {
      const serverId = await makeCommunity("Sem você");
      await getPool().query(
        `INSERT INTO server_bans (server_id, user_id, banned_by)
         VALUES ($1, $2, $3)`,
        [serverId, banned.id, owner.id],
      );

      // Not in the grid…
      const browse = await call<{ communities: CommunityCard[] }>(
        banned,
        "GET",
        "/api/communities",
      );
      expect(browse.body.communities).toHaveLength(0);

      // …not in search, which is the hole a "hide it from the list" fix leaves…
      const searched = await call<{ communities: CommunityCard[] }>(
        banned,
        "GET",
        "/api/communities?q=Sem",
      );
      expect(searched.body.communities).toHaveLength(0);

      // …not by direct id…
      expect(
        (await call(banned, "GET", `/api/communities/${serverId}`)).status,
      ).toBe(404);

      // …and not joinable.
      expect(
        (await call(banned, "POST", `/api/communities/${serverId}/join`)).status,
      ).toBe(403);

      // Everyone else still sees it.
      const others = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      expect(others.body.communities.map((c) => c.id)).toEqual([serverId]);
    });

    it("hides a community the operator suspended, from everyone including its owner", async () => {
      const serverId = await makeCommunity("Pulled", { suspended: true });

      for (const who of [joiner, owner]) {
        const res = await call<{ communities: CommunityCard[] }>(
          who,
          "GET",
          "/api/communities",
        );
        expect(res.body.communities).toHaveLength(0);
      }
      expect(
        (await call(joiner, "POST", `/api/communities/${serverId}/join`)).status,
      ).toBe(404);
    });

    it("does not let the owner relist a suspended community", async () => {
      // The operator's decision outranks the owner's, or it is not a tool.
      const serverId = await makeCommunity("Pulled", { suspended: true });
      const res = await call<{ community: { isCommunity: boolean } }>(
        owner,
        "PATCH",
        `/api/servers/${serverId}/community`,
        { isCommunity: true },
      );
      expect(res.status).toBe(200);
      expect(res.body.community.isCommunity).toBe(true);

      // …and it changes nothing about what anybody can see.
      const browse = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      expect(browse.body.communities).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- joining

  describe("joining", () => {
    it("is idempotent: a second call adds nothing and still succeeds", async () => {
      const serverId = await makeCommunity("Entra");

      const first = await call<{ joinedNow: boolean }>(
        joiner,
        "POST",
        `/api/communities/${serverId}/join`,
      );
      expect(first.status).toBe(200);
      expect(first.body.joinedNow).toBe(true);

      const second = await call<{ joinedNow: boolean }>(
        joiner,
        "POST",
        `/api/communities/${serverId}/join`,
      );
      expect(second.status).toBe(200);
      expect(second.body.joinedNow).toBe(false);

      const members = await getPool().query(
        `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
        [serverId, joiner.id],
      );
      expect(members.rows).toHaveLength(1);
    });

    it("survives two simultaneous taps without a duplicate or an error", async () => {
      const serverId = await makeCommunity("Corrida");
      // Sequential through the same actor slot, but overlapping in the database
      // is what the ON CONFLICT is for; both must answer 200 either way.
      const results = await Promise.all([
        call(joiner, "POST", `/api/communities/${serverId}/join`),
        call(joiner, "POST", `/api/communities/${serverId}/join`),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
    });

    it("really puts you in the server, not just in the directory's opinion", async () => {
      const serverId = await makeCommunity("De verdade");
      await call(joiner, "POST", `/api/communities/${serverId}/join`);

      const servers = await call<{ servers: { id: string }[] }>(
        joiner,
        "GET",
        "/api/servers",
      );
      expect(servers.body.servers.map((s) => s.id)).toContain(serverId);
    });

    it("refuses a server that never opted in", async () => {
      const created = await createChatServer("Private", owner.id);
      expect(
        (
          await call(
            joiner,
            "POST",
            `/api/communities/${created.server.id}/join`,
          )
        ).status,
      ).toBe(404);
    });

    it("writes an audit entry the owner can read, once", async () => {
      const serverId = await makeCommunity("Auditada");
      await call(joiner, "POST", `/api/communities/${serverId}/join`);
      await call(joiner, "POST", `/api/communities/${serverId}/join`);

      const log = await call<{
        entries: { action: string; actorId: string }[];
      }>(owner, "GET", `/api/servers/${serverId}/audit-log`);
      const joins = log.body.entries.filter(
        (e) => e.action === "member.community_join",
      );
      expect(joins).toHaveLength(1);
      expect(joins[0]!.actorId).toBe(joiner.id);
    });
  });

  // ------------------------------------------------------------- the opt-in

  describe("the owner's opt-in", () => {
    it("is owner-only", async () => {
      const created = await createChatServer("Meu", owner.id);
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [created.server.id, joiner.id],
      );
      // An admin may not make somebody else's private room public.
      expect(
        (
          await call(
            joiner,
            "PATCH",
            `/api/servers/${created.server.id}/community`,
            { isCommunity: true },
          )
        ).status,
      ).toBe(403);
      // A stranger gets 404, not 403 — no probing which server ids exist.
      expect(
        (
          await call(
            banned,
            "PATCH",
            `/api/servers/${created.server.id}/community`,
            { isCommunity: true },
          )
        ).status,
      ).toBe(404);
    });

    it("lists the server and writes one audit entry naming what changed", async () => {
      const created = await createChatServer("Vira comunidade", owner.id);
      const serverId = created.server.id;

      const res = await call<{
        community: { isCommunity: boolean; tagline: string | null; category: string };
      }>(owner, "PATCH", `/api/servers/${serverId}/community`, {
        isCommunity: true,
        tagline: "acorda cedo não",
        category: "humor",
      });
      expect(res.status).toBe(200);
      expect(res.body.community).toEqual({
        isCommunity: true,
        // Derived from the name by the opt-in itself — nothing in this request
        // asked for it. See the `communitySlug` audit entry below.
        slug: "vira-comunidade",
        tagline: "acorda cedo não",
        category: "humor",
        suspended: false,
      });

      const log = await call<{
        entries: {
          action: string;
          actorId: string;
          changes: { key: string; old: unknown; new: unknown }[];
        }[];
      }>(owner, "GET", `/api/servers/${serverId}/audit-log`);
      const entry = log.body.entries.find(
        (e) => e.action === "server.community_update",
      );
      expect(entry).toBeDefined();
      expect(entry!.actorId).toBe(owner.id);
      expect(
        entry!.changes.find((c) => c.key === "isCommunity"),
      ).toEqual({ key: "isCommunity", old: false, new: true });
      expect(entry!.changes.find((c) => c.key === "communityTagline")).toEqual({
        key: "communityTagline",
        old: null,
        new: "acorda cedo não",
      });
    });

    it("writes no audit entry when nothing actually moved", async () => {
      const serverId = await makeCommunity("Já é", { category: "humor" });
      await call(owner, "PATCH", `/api/servers/${serverId}/community`, {
        isCommunity: true,
        category: "humor",
      });
      const log = await call<{ entries: { action: string }[] }>(
        owner,
        "GET",
        `/api/servers/${serverId}/audit-log`,
      );
      expect(
        log.body.entries.filter((e) => e.action === "server.community_update"),
      ).toHaveLength(0);
    });

    it("unlists without forgetting the pitch", async () => {
      const serverId = await makeCommunity("Sai da lista", {
        tagline: "volto já",
        category: "humor",
      });
      await call(owner, "PATCH", `/api/servers/${serverId}/community`, {
        isCommunity: false,
      });

      const settings = await call<{
        community: { isCommunity: boolean; tagline: string | null; category: string };
      }>(owner, "GET", `/api/servers/${serverId}/community`);
      expect(settings.body.community.isCommunity).toBe(false);
      // Relisting a week later must not mean retyping.
      expect(settings.body.community.tagline).toBe("volto já");
      expect(settings.body.community.category).toBe("humor");

      const browse = await call<{ communities: CommunityCard[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      expect(browse.body.communities).toHaveLength(0);
    });

    it("clears the tagline on an emptied box rather than storing whitespace", async () => {
      const serverId = await makeCommunity("Limpa", { tagline: "algo" });
      await call(owner, "PATCH", `/api/servers/${serverId}/community`, {
        tagline: "   ",
      });
      const settings = await call<{ community: { tagline: string | null } }>(
        owner,
        "GET",
        `/api/servers/${serverId}/community`,
      );
      expect(settings.body.community.tagline).toBeNull();
    });

    it("refuses a tagline past the cap with a sentence the owner can read", async () => {
      const serverId = await makeCommunity("Longa");
      const res = await call<{ error: string }>(
        owner,
        "PATCH",
        `/api/servers/${serverId}/community`,
        { tagline: "a".repeat(200) },
      );
      expect(res.status).toBe(400);
      expect(res.body.error).not.toBe("Invalid request");
    });

    it("refuses a category the schema does not know", async () => {
      const serverId = await makeCommunity("Categoria");
      const res = await call(owner, "PATCH", `/api/servers/${serverId}/community`, {
        category: "cripto",
      });
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------- moderation

  describe("reporting a community", () => {
    it("goes to the instance queue and never to the community's own owner", async () => {
      // The whole moderation posture in one assertion: a hostile owner
      // resolving reports about their own listing is the hole this closes.
      const serverId = await makeCommunity("Denunciada");

      const filed = await call<{ report: { id: string } }>(
        joiner,
        "POST",
        "/api/reports",
        {
          subjectType: "server",
          serverId,
          reason: "hate_speech",
          details: "o nome já diz tudo",
        },
      );
      expect(filed.status).toBe(201);

      // The owner's own queue does not have it.
      const ownerQueue = await call<{ reports: { id: string }[] }>(
        owner,
        "GET",
        `/api/servers/${serverId}/reports`,
      );
      expect(ownerQueue.body.reports).toHaveLength(0);

      // The instance queue does.
      process.env.INSTANCE_MODERATOR_CLERK_IDS = operator.clerk_id;
      const instanceQueue = await call<{
        reports: {
          id: string;
          subjectType: string;
          reportedUserName: string | null;
          reportedUserId: string | null;
        }[];
      }>(operator, "GET", "/api/reports/instance");
      expect(instanceQueue.body.reports).toHaveLength(1);
      const report = instanceQueue.body.reports[0]!;
      expect(report.subjectType).toBe("server");
      // The subject label is the community's NAME — the thing being judged.
      expect(report.reportedUserName).toBe("Denunciada");
      // …and the owner is still named, so the queue points at somebody.
      expect(report.reportedUserId).toBe(owner.id);
    });

    it("is deduped per reporter while it is open", async () => {
      const serverId = await makeCommunity("Duas vezes");
      const body = {
        subjectType: "server" as const,
        serverId,
        reason: "spam" as const,
      };
      const first = await call(joiner, "POST", "/api/reports", body);
      const second = await call(joiner, "POST", "/api/reports", body);
      expect(first.status).toBe(201);
      // 200 rather than an error: "we already have this" and "thank you" are
      // the same fact to a reporter.
      expect(second.status).toBe(200);

      process.env.INSTANCE_MODERATOR_CLERK_IDS = operator.clerk_id;
      const queue = await call<{ reports: unknown[] }>(
        operator,
        "GET",
        "/api/reports/instance",
      );
      expect(queue.body.reports).toHaveLength(1);
    });

    it("refuses a report about a server that is not listed", async () => {
      const created = await createChatServer("Privado", owner.id);
      const res = await call(joiner, "POST", "/api/reports", {
        subjectType: "server",
        serverId: created.server.id,
        reason: "spam",
      });
      // A private server is not public content, and answering anything but 404
      // would make this endpoint a probe for which server ids exist.
      expect(res.status).toBe(404);
    });

    it("can be filed by somebody the community banned", async () => {
      // The person who objected and got banned for it is exactly the person who
      // most needs this path.
      const serverId = await makeCommunity("Baniu");
      await getPool().query(
        `INSERT INTO server_bans (server_id, user_id, banned_by)
         VALUES ($1, $2, $3)`,
        [serverId, banned.id, owner.id],
      );
      const res = await call(banned, "POST", "/api/reports", {
        subjectType: "server",
        serverId,
        reason: "harassment",
      });
      expect(res.status).toBe(201);
    });

    it("survives the community being deleted", async () => {
      const serverId = await makeCommunity("Some depois");
      await call(joiner, "POST", "/api/reports", {
        subjectType: "server",
        serverId,
        reason: "illegal_content",
      });
      await call(owner, "DELETE", `/api/servers/${serverId}`);

      process.env.INSTANCE_MODERATOR_CLERK_IDS = operator.clerk_id;
      const queue = await call<{
        reports: { reportedUserName: string | null }[];
      }>(operator, "GET", "/api/reports/instance");
      // ON DELETE SET NULL, not CASCADE: the evidence outlives the room.
      expect(queue.body.reports).toHaveLength(1);
      expect(queue.body.reports[0]!.reportedUserName).toBe("Some depois");
    });
  });

  // ------------------------------------------------------- slugs and /c/…

  /**
   * The public address, and the page it addresses.
   *
   * What is pinned here is the same list of ways a public surface can be wider
   * than intended that the rest of this file pins, applied to the one route in
   * the feature that answers with no session at all:
   *
   *   * SUSPENDED, UNLISTED AND UNKNOWN ARE ONE ANSWER. Any difference between
   *     them publishes the operator's moderation decisions to anybody holding a
   *     URL, and turns the route into a probe for which rooms exist.
   *   * THE FLAG STILL COVERS IT. A deployment without the directory has no
   *     public community pages, and 404 is what an unbuilt feature answers.
   *   * THE PAYLOAD CARRIES NO DOOR. No member list, no channels, no owner, and
   *     no id — the id in particular, because withholding it is what forces the
   *     join intent to travel as a slug and be resolved behind auth.
   *   * ONE ADDRESS, ONE LISTED COMMUNITY. Decided by the unique index and not
   *     by a pre-check, so the loser of a race gets a refusal naming the field.
   */
  describe("community slugs", () => {
    it("derives one from the name on the first opt-in", async () => {
      const created = await createChatServer("Valorant Brasil", owner.id);
      const res = await call<{ community: { slug: string | null } }>(
        owner,
        "PATCH",
        `/api/servers/${created.server.id}/community`,
        { isCommunity: true },
      );
      expect(res.status).toBe(200);
      expect(res.body.community.slug).toBe("valorant-brasil");
    });

    it("keeps the derived address through a later edit", async () => {
      // The address is in screenshots and the name is not, so a rename must not
      // move the URL under a link somebody already shared.
      const created = await createChatServer("Valorant Brasil", owner.id);
      await call(owner, "PATCH", `/api/servers/${created.server.id}/community`, {
        isCommunity: true,
      });
      const res = await call<{ community: { slug: string | null } }>(
        owner,
        "PATCH",
        `/api/servers/${created.server.id}/community`,
        { tagline: "a gente perde junto" },
      );
      expect(res.body.community.slug).toBe("valorant-brasil");
    });

    it("refuses the listing when the address collides", async () => {
      await makeCommunity("Valorant Brasil");
      const second = await createChatServer("valorant brasil", owner.id);
      const res = await call<{ error: string }>(
        owner,
        "PATCH",
        `/api/servers/${second.server.id}/community`,
        { isCommunity: true },
      );
      // 409, the status a lost race gets — the request was well formed and a
      // retry with a different value works. The row is NOT listed: half-listing
      // a community at no address is a share button that is silently missing.
      expect(res.status).toBe(409);
      const settings = await call<{ community: { isCommunity: boolean } }>(
        owner,
        "GET",
        `/api/servers/${second.server.id}/community`,
      );
      expect(settings.body.community.isCommunity).toBe(false);
    });

    it("refuses a name that cannot become an address, with a different status", async () => {
      // 422 rather than 409: nothing about *this* request will be different on
      // a retry, so the form has to ask for something rather than say "again".
      const created = await createChatServer("🔥🔥🔥", owner.id);
      const res = await call(
        owner,
        "PATCH",
        `/api/servers/${created.server.id}/community`,
        { isCommunity: true },
      );
      expect(res.status).toBe(422);
    });

    it("takes an address the owner typed, slugifying it on the way in", async () => {
      const created = await createChatServer("🔥🔥🔥", owner.id);
      const res = await call<{ community: { slug: string | null } }>(
        owner,
        "PATCH",
        `/api/servers/${created.server.id}/community`,
        { isCommunity: true, slug: "Fogo Fogo Fogo" },
      );
      expect(res.status).toBe(200);
      expect(res.body.community.slug).toBe("fogo-fogo-fogo");
    });

    it("refuses a reserved address", async () => {
      const created = await createChatServer("Suporte", owner.id);
      const res = await call(
        owner,
        "PATCH",
        `/api/servers/${created.server.id}/community`,
        { isCommunity: true, slug: "suporte" },
      );
      // "pqp.gg/c/suporte pediu sua senha" is a working attack that costs one
      // free signup, so the word never becomes an address.
      expect(res.status).toBe(400);
    });

    it("frees the address when a community is unlisted", async () => {
      // The unique index is partial on `is_community` precisely so an unlisted
      // holder cannot squat an address against a live claimant — while still
      // keeping its own, so relisting a week later needs no retyping.
      const first = await makeCommunity("Valorant Brasil");
      await call(owner, "PATCH", `/api/servers/${first}/community`, {
        isCommunity: false,
      });
      const second = await createChatServer("valorant brasil", owner.id);
      const res = await call<{ community: { slug: string | null } }>(
        owner,
        "PATCH",
        `/api/servers/${second.server.id}/community`,
        { isCommunity: true },
      );
      expect(res.status).toBe(200);
      expect(res.body.community.slug).toBe("valorant-brasil");
    });

    it("records the address in the audit trail even when nobody typed it", async () => {
      // The most common way this field moves is a derivation nobody asked for,
      // so a trail that only logged deliberate changes would have no record of
      // how a room got the URL it is now known by.
      const created = await createChatServer("Valorant Brasil", owner.id);
      await call(owner, "PATCH", `/api/servers/${created.server.id}/community`, {
        isCommunity: true,
      });
      const log = await call<{
        entries: { action: string; changes: { key: string }[] }[];
      }>(owner, "GET", `/api/servers/${created.server.id}/audit-log`);
      const entry = log.body.entries.find(
        (one) => one.action === "server.community_update",
      );
      expect(entry?.changes.map((c) => c.key)).toContain("communitySlug");
    });

    it("carries the slug on every directory card", async () => {
      await makeCommunity("Valorant Brasil");
      const res = await call<{ communities: { slug: string | null }[] }>(
        joiner,
        "GET",
        "/api/communities",
      );
      expect(res.body.communities[0]!.slug).toBe("valorant-brasil");
    });
  });

  describe("GET /api/public/communities/:slug", () => {
    it("answers a listed community to somebody with no session at all", async () => {
      await makeCommunity("Valorant Brasil", {
        category: "games",
        tagline: "a gente perde junto",
      });
      // `null` actor: no Bearer header is sent at all. This is the assertion
      // the whole surface rests on.
      const res = await call<{ community: Record<string, unknown> }>(
        null,
        "GET",
        "/api/public/communities/valorant-brasil",
      );
      expect(res.status).toBe(200);
      expect(res.body.community.name).toBe("Valorant Brasil");
      expect(res.body.community.tagline).toBe("a gente perde junto");
      expect(res.body.community.category).toBe("games");
      expect(res.body.community.memberCount).toBe(2);
      expect(res.body.community.createdMonth).toMatch(/^\d{4}-\d{2}$/);
    });

    it("carries no id, no member list and no owner", async () => {
      await makeCommunity("Valorant Brasil");
      const res = await call<{ community: Record<string, unknown> }>(
        null,
        "GET",
        "/api/public/communities/valorant-brasil",
      );
      expect(Object.keys(res.body.community).sort()).toEqual([
        "bannerUrl",
        "category",
        "createdMonth",
        "iconUrl",
        "memberCount",
        "name",
        "slug",
        "tagline",
      ]);
    });

    it("404s a suspended community exactly as it 404s an unknown slug", async () => {
      await makeCommunity("Pulled", { slug: "pulled", suspended: true });
      const suspended = await call(
        null,
        "GET",
        "/api/public/communities/pulled",
      );
      const unknown = await call(
        null,
        "GET",
        "/api/public/communities/never-existed",
      );
      expect(suspended.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(suspended.body).toEqual(unknown.body);
    });

    it("404s an unlisted server that still holds a slug", async () => {
      await makeCommunity("Private", { slug: "private", listed: false });
      const res = await call(null, "GET", "/api/public/communities/private");
      expect(res.status).toBe(404);
    });

    it("404s with the flag off", async () => {
      await makeCommunity("Valorant Brasil");
      delete process.env.COMMUNITIES_ENABLED;
      const res = await call(
        null,
        "GET",
        "/api/public/communities/valorant-brasil",
      );
      expect(res.status).toBe(404);
    });

    it("does not reach the database for a slug that could never exist", async () => {
      // A path segment from the open internet. The alternative is one query per
      // junk string a scanner throws at us.
      for (const junk of ["ab", "-x", "valorant.br", "VALORANT.br"]) {
        const res = await call(
          null,
          "GET",
          `/api/public/communities/${encodeURIComponent(junk)}`,
        );
        expect(res.status).toBe(404);
      }
    });

    it("does not even match the route for an absurdly long segment", async () => {
      // The dispatch regex caps the segment at 64 characters, exactly as the
      // public profile's does, so an over-long path never reaches the public
      // handler at all and falls through to the ordinary authenticated router —
      // which refuses it. A 401 here is the correct answer and the assertion
      // exists so that stays a decision rather than an accident.
      const res = await call(
        null,
        "GET",
        `/api/public/communities/${"a".repeat(200)}`,
      );
      expect(res.status).toBe(401);
    });

    it("is cacheable, unlike every other JSON this API answers", async () => {
      await makeCommunity("Valorant Brasil");
      const res = await callRaw(
        null,
        "GET",
        "/api/public/communities/valorant-brasil",
      );
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      // The 404 stays no-store: a community can be listed at any moment, and a
      // cached "no such page" would outlive the decision to publish it.
      const missing = await callRaw(
        null,
        "GET",
        "/api/public/communities/never-existed",
      );
      expect(missing.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("GET /api/communities/by-slug/:slug", () => {
    it("resolves the slug a join intent carried through sign-up", async () => {
      const serverId = await makeCommunity("Valorant Brasil");
      const res = await call<{ community: { id: string } }>(
        joiner,
        "GET",
        "/api/communities/by-slug/valorant-brasil",
      );
      expect(res.status).toBe(200);
      expect(res.body.community.id).toBe(serverId);
    });

    it("404s for somebody banned from it, rather than 403", async () => {
      // A ban is invisibility. A 403 confirms where they are unwelcome and
      // hands them a page to hammer.
      const serverId = await makeCommunity("Valorant Brasil");
      await getPool().query(
        `INSERT INTO server_bans (server_id, user_id, banned_by)
         VALUES ($1, $2, $3)`,
        [serverId, banned.id, owner.id],
      );
      const res = await call(
        banned,
        "GET",
        "/api/communities/by-slug/valorant-brasil",
      );
      expect(res.status).toBe(404);
    });

    it("needs a session, unlike the public page", async () => {
      await makeCommunity("Valorant Brasil");
      const res = await call(
        null,
        "GET",
        "/api/communities/by-slug/valorant-brasil",
      );
      expect(res.status).toBe(401);
    });
  });

  // --------------------------------------------------------- service layer

  describe("listCommunities, called directly", () => {
    it("returns an empty page rather than throwing when nothing is listed", async () => {
      const page = await listCommunities(joiner.id, { limit: 10, offset: 0 });
      expect(page).toEqual({ communities: [], hasMore: false });
    });
  });

  describe("the schema's slug CHECK", () => {
    it("carries the same expression @pqp/shared does", async () => {
      // The schema is the last line of defence for a value the API is supposed
      // to have validated. A constraint that has drifted defends something
      // other than what the application believes.
      const res = await getPool().query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'servers_community_slug_format'`,
      );
      expect(res.rows[0]?.definition).toContain(COMMUNITY_SLUG_PATTERN_SQL);
    });

    it("refuses a malformed slug at the database, not merely at the route", async () => {
      const created = await createChatServer("Guard", owner.id);
      await expect(
        getPool().query(
          `UPDATE servers SET community_slug = $2 WHERE id = $1`,
          [created.server.id, "-nope-"],
        ),
      ).rejects.toThrow();
    });
  });
});
