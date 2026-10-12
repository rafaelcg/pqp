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
import type { WebSocket } from "ws";
import {
  buildSidebarLayout,
  layoutToPayload,
  moveInLayout,
  navigableIds,
  type Channel,
  type SidebarLayout,
} from "@pqp/shared";

/**
 * THE MIXED CHANNEL LIST, ON A REAL POSTGRES, WITH THE FLAG ON.
 *
 * Driven through the real router, like `channels-update.test.ts`. The flag is
 * set the way production sets it (a `feature_flags` row or a per-server
 * override through `setGlobalFlag` / `setServerFlagOverride`, read through the
 * snapshot), never by stubbing `isEnabled`: CLAUDE.md pitfall 12 is a flag
 * whose tests ran with it off while production ran with it on.
 *
 * What is pinned: the boot renumbering keeps every old client's per-type
 * order; a migration keeps the web's order exactly, is idempotent and
 * reversible; the full-order PUT is atomic, refuses a stale list, and leaves a
 * channel the actor cannot see where it was; the legacy move and create rules
 * that keep iOS 1.0.21 and Android 0.4.14 working; how a new server is born.
 */

// TEST_DATABASE_URL wins: these tests truncate.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

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

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "../ws/sockets.js"
);
const { resetReadCacheForTests } = await import("../lib/read-cache.js");
const {
  resetFeatureFlagsForTests,
  setGlobalFlag,
  setServerFlagOverride,
  startFeatureFlags,
} = await import("../lib/flags.js");
const {
  channelLayoutReport,
  migrateChannelLayout,
  revertChannelLayout,
  runChannelLayoutMigrations,
} = await import("../services/channel-layout.js");
const { resetChannelLayoutMetricsForTests, channelLayoutMetrics } = await import(
  "../services/channel-layout-metrics.js"
);

type User = Awaited<ReturnType<typeof upsertUser>>;

const MANAGE_CHANNELS = String(1n << 4n);

let server: Server;
let baseUrl: string;
const sockets: WebSocket[] = [];

async function call<T = Record<string, unknown>>(
  as: User,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function connect(user: User): string[] {
  const received: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(payload),
    on: () => {},
  } as unknown as WebSocket;
  setAuthenticatedSocket(socket, user);
  sockets.push(socket);
  return received;
}

async function channelsOf(as: User, serverId: string): Promise<Channel[]> {
  const res = await call<{ channels: Channel[] }>(as, "GET", `/api/servers/${serverId}/channels`);
  expect(res.status).toBe(200);
  return res.body.channels;
}

async function configOf(as: User, serverId: string) {
  const res = await call<{ mixed: boolean; version: number }>(
    as,
    "GET",
    `/api/servers/${serverId}/channel-layout`,
  );
  expect(res.status).toBe(200);
  return res.body;
}

/** A layout by NAME, so a failure reads like the sidebar. */
function named(layout: SidebarLayout<Channel>) {
  return {
    loose: layout.loose.map((c) => c.name),
    categories: layout.categories.map((entry) => [
      entry.category.name,
      entry.children.map((c) => c.name),
    ]),
  };
}

async function mixedView(as: User, serverId: string) {
  return named(buildSidebarLayout(await channelsOf(as, serverId), { mixed: true }));
}

/** What an OLD client draws: per type, by position (`mixed: false`). */
function oldClientOrder(channels: Channel[]) {
  const byType = (types: string[]) =>
    channels
      .filter((c) => !c.parentId && types.includes(c.type))
      .sort((a, b) => a.position - b.position)
      .map((c) => c.name);
  return {
    text: byType(["text", "forum"]),
    voice: byType(["voice"]),
    watchParty: byType(["watch_party"]),
  };
}

/** The web's flattened order: every row in the order a person reads it. */
function flattened(channels: Channel[], mixed: boolean): string[] {
  const layout = buildSidebarLayout(channels, { mixed });
  const byId = new Map(channels.map((c) => [c.id, c.name]));
  return navigableIds(layout).map((id) => byId.get(id)!);
}

async function createIn(
  as: User,
  serverId: string,
  name: string,
  type: string,
  extra: Record<string, unknown> = {},
) {
  const res = await call<{ channel: Channel }>(as, "POST", `/api/servers/${serverId}/channels`, {
    name,
    type,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.channel;
}

describeDb("mixed channel list", () => {
  let owner: User;
  let member: User;
  let manager: User;
  let outsider: User;

  async function makeServer(): Promise<{ serverId: string; general: Channel; lobby: Channel }> {
    const created = await call<{ server: { id: string }; channels: Channel[] }>(
      owner,
      "POST",
      "/api/servers",
      { name: "Resenha dos Guris" },
    );
    expect(created.status).toBe(201);
    const serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [serverId, member.id, manager.id],
    );
    // A manager by a role, not by rank: MANAGE_CHANNELS and nothing that
    // shows them a private channel they were not let into.
    const role = await call<{ role: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/roles`,
      { name: "Gerente", permissions: MANAGE_CHANNELS },
    );
    expect(role.status).toBe(201);
    await getPool().query(
      `INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [serverId, manager.id, role.body.role.id],
    );
    const general = created.body.channels.find((c) => c.name === "general")!;
    const lobby = created.body.channels.find((c) => c.name === "Lobby")!;
    return { serverId, general, lobby };
  }

  /** A server shaped like the redesign's "before" mock, made with the flag off. */
  async function legacyServer() {
    const base = await makeServer();
    const test = await createIn(owner, base.serverId, "test", "text");
    const duvidas = await createIn(owner, base.serverId, "duvidas", "text");
    const squad = await createIn(owner, base.serverId, "Squad", "voice");
    const jogos = await createIn(owner, base.serverId, "Jogos", "category");
    const clipes = await createIn(owner, base.serverId, "clipes", "text");
    const lfg = await createIn(owner, base.serverId, "lfg", "voice");
    for (const channel of [clipes, lfg]) {
      await call(owner, "PATCH", `/api/channels/${channel.id}/move`, {
        parentId: jogos.id,
        index: 99,
      });
    }
    return { ...base, test, duvidas, squad, jogos, clipes, lfg };
  }

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetReadCacheForTests();
    resetFeatureFlagsForTests();
    resetChannelLayoutMetricsForTests();
    delete process.env.MIXED_CHANNEL_LIST;
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, roles, member_roles,
                server_invites, server_bans, channel_reads, audit_log,
                feature_flags, feature_flag_overrides, feature_flag_audit,
                channel_layout_migrations
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({ clerkId: "clerk_owner", displayName: "Owner", avatarUrl: null });
    member = await upsertUser({ clerkId: "clerk_member", displayName: "Member", avatarUrl: null });
    manager = await upsertUser({ clerkId: "clerk_manager", displayName: "Manager", avatarUrl: null });
    outsider = await upsertUser({ clerkId: "clerk_outsider", displayName: "Outsider", avatarUrl: null });
    await startFeatureFlags();
  });

  afterEach(() => {
    for (const socket of sockets) {
      deleteAuthenticatedSocket(socket);
    }
    sockets.length = 0;
  });

  async function flagOn(serverId?: string) {
    if (serverId) {
      await setServerFlagOverride("mixed_channel_list", serverId, true, { kind: "dashboard" });
    } else {
      await setGlobalFlag("mixed_channel_list", true, { kind: "dashboard" });
    }
  }

  // ------------------------------------------------------------ step 0

  describe("step 0: one loose sequence at boot", () => {
    it("renumbers per-type positions into one sequence an old client reads the same way, once", async () => {
      const { serverId, general, lobby } = await makeServer();
      const regras = await createIn(owner, serverId, "regras", "text");
      const forum = await createIn(owner, serverId, "ideias", "text");
      const afk = await createIn(owner, serverId, "AFK", "voice");
      // Put the rows back the way they were numbered before the unify: each
      // type its own 0..n-1, which collides across types.
      const old: Array<[string, number]> = [
        [general.id, 0],
        [regras.id, 1],
        [forum.id, 2],
        [lobby.id, 1],
        [afk.id, 0],
      ];
      for (const [id, position] of old) {
        await getPool().query(`UPDATE channels SET position = $2 WHERE id = $1`, [id, position]);
      }
      await getPool().query(`UPDATE channels SET type = 'forum' WHERE id = $1`, [forum.id]);
      const before = oldClientOrder(await channelsOf(owner, serverId));
      expect(before).toEqual({
        text: ["general", "regras", "ideias"],
        voice: ["AFK", "Lobby"],
        watchParty: [],
      });

      await getPool().query(
        `DELETE FROM data_migrations WHERE name = 'channel_top_level_unify_2026_10'`,
      );
      await initDb({ mode: "always" });
      resetReadCacheForTests();

      const after = await channelsOf(owner, serverId);
      expect(oldClientOrder(after)).toEqual(before);
      expect(
        after
          .filter((c) => !c.parentId)
          .sort((a, b) => a.position - b.position)
          .map((c) => [c.name, c.position]),
      ).toEqual([
        ["general", 0],
        ["regras", 1],
        ["ideias", 2],
        ["AFK", 3],
        ["Lobby", 4],
      ]);

      // Recorded: a second boot leaves a later write alone.
      await getPool().query(`UPDATE channels SET position = 9 WHERE id = $1`, [general.id]);
      await initDb({ mode: "always" });
      const row = await getPool().query(`SELECT position FROM channels WHERE id = $1`, [
        general.id,
      ]);
      expect(row.rows[0].position).toBe(9);
    });
  });

  // ------------------------------------------------------------ migrate

  describe("migrate", () => {
    it("keeps the web's flattened order exactly: TEXTO + VOZ become one Canais at the top", async () => {
      const { serverId } = await legacyServer();
      const before = await channelsOf(owner, serverId);
      const webOrder = flattened(before, false);
      expect(webOrder).toEqual(["general", "test", "duvidas", "Lobby", "Squad", "clipes", "lfg"]);
      expect((await configOf(owner, serverId)).mixed).toBe(false);

      await flagOn(serverId);
      // Flag on, data not migrated yet: the client still draws the old list.
      expect((await configOf(owner, serverId)).mixed).toBe(false);

      const result = await migrateChannelLayout(serverId);
      expect(result).toMatchObject({ status: "migrated", loose: 5, categoryName: "Canais" });

      const after = await channelsOf(owner, serverId);
      expect(flattened(after, true)).toEqual(webOrder);
      expect(await mixedView(owner, serverId)).toEqual({
        loose: [],
        categories: [
          ["Canais", ["general", "test", "duvidas", "Lobby", "Squad"]],
          ["Jogos", ["clipes", "lfg"]],
        ],
      });
      expect(await configOf(owner, serverId)).toMatchObject({ mixed: true });
      expect(channelLayoutMetrics().migrated).toBe(1);
    });

    it("migrates watch party and forum rows with the rest", async () => {
      const { serverId } = await makeServer();
      await getPool().query(
        `INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'filme', 'watch_party', 2)`,
        [serverId],
      );
      await flagOn();
      await migrateChannelLayout(serverId);
      expect(await mixedView(owner, serverId)).toEqual({
        loose: [],
        categories: [["Canais", ["general", "Lobby", "filme"]]],
      });
    });

    it("records a server with nothing loose as done, without a category", async () => {
      const { serverId, general, lobby } = await makeServer();
      const cat = await createIn(owner, serverId, "Tudo", "category");
      for (const id of [general.id, lobby.id]) {
        await call(owner, "PATCH", `/api/channels/${id}/move`, { parentId: cat.id, index: 9 });
      }
      await flagOn(serverId);
      expect(await migrateChannelLayout(serverId)).toMatchObject({ status: "noop", loose: 0 });
      expect(await mixedView(owner, serverId)).toEqual({
        loose: [],
        categories: [["Tudo", ["general", "Lobby"]]],
      });
      expect((await configOf(owner, serverId)).mixed).toBe(true);
    });

    it("names it Geral when a Canais category already exists, and Channels for an English owner", async () => {
      const { serverId } = await makeServer();
      await createIn(owner, serverId, "canais", "category");
      expect(await migrateChannelLayout(serverId, { dryRun: true })).toMatchObject({
        collision: true,
        categoryName: "Geral",
      });

      const english = await makeServer();
      await getPool().query(
        `INSERT INTO user_preferences (user_id, settings) VALUES ($1, '{"locale":"en"}')
         ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`,
        [owner.id],
      );
      expect(await migrateChannelLayout(english.serverId)).toMatchObject({
        categoryName: "Channels",
      });
    });

    it("a dry run writes nothing and says when every loose channel is private", async () => {
      const { serverId, general, lobby } = await makeServer();
      await call(owner, "DELETE", `/api/channels/${general.id}`);
      await call(owner, "DELETE", `/api/channels/${lobby.id}`);
      await createIn(owner, serverId, "staff", "text", { isPrivate: true });
      const before = await channelsOf(owner, serverId);
      expect(await migrateChannelLayout(serverId, { dryRun: true })).toEqual({
        status: "dry-run",
        loose: 1,
        categories: 0,
        collision: false,
        categoryName: "Canais",
        privateLoose: 1,
        privateOnlyLoose: true,
      });
      expect(await channelsOf(owner, serverId)).toEqual(before);
      const rows = await getPool().query(`SELECT 1 FROM channel_layout_migrations`);
      expect(rows.rows).toHaveLength(0);
    });

    it("two concurrent migrations make one category; a third call is a no-op", async () => {
      const { serverId } = await legacyServer();
      const results = await Promise.all([
        migrateChannelLayout(serverId),
        migrateChannelLayout(serverId),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["already", "migrated"]);
      expect(await migrateChannelLayout(serverId)).toMatchObject({ status: "already" });
      const categories = await getPool().query(
        `SELECT name FROM channels WHERE server_id = $1 AND type = 'category' ORDER BY position`,
        [serverId],
      );
      expect(categories.rows.map((r) => r.name)).toEqual(["Canais", "Jogos"]);
    });

    it("revert restores every row exactly as it was", async () => {
      const { serverId } = await legacyServer();
      const snapshot = async () =>
        (
          await getPool().query(
            `SELECT id, parent_id, position FROM channels
              WHERE server_id = $1 AND type <> 'thread' ORDER BY id`,
            [serverId],
          )
        ).rows;
      const before = await snapshot();
      await migrateChannelLayout(serverId);
      const reverted = await revertChannelLayout(serverId);
      expect(reverted).toMatchObject({ status: "reverted", restored: 5, categoryDeleted: true });
      expect(await snapshot()).toEqual(before);
      expect((await configOf(owner, serverId)).mixed).toBe(false);
    });

    it("revert keeps a channel added to Canais since, and Canais with it", async () => {
      const { serverId } = await legacyServer();
      await flagOn(serverId);
      await migrateChannelLayout(serverId);
      const canais = (await channelsOf(owner, serverId)).find((c) => c.name === "Canais")!;
      await createIn(owner, serverId, "novo", "text", { parentId: canais.id });
      expect(await revertChannelLayout(serverId)).toMatchObject({
        status: "reverted",
        restored: 5,
        categoryDeleted: false,
      });
      const after = await channelsOf(owner, serverId);
      expect(oldClientOrder(after)).toEqual({
        text: ["general", "test", "duvidas"],
        voice: ["Lobby", "Squad"],
        watchParty: [],
      });
      // Canais keeps its place at the top: the owner has used it.
      expect(named(buildSidebarLayout(after, { mixed: false })).categories).toEqual([
        ["Canais", ["novo"]],
        ["Jogos", ["clipes", "lfg"]],
      ]);
    });

    it("the job follows a per-server override, never re-migrates a reverted server, and the operator can", async () => {
      const qg = await legacyServer();
      const other = await legacyServer();
      // Global off: only the overridden server is work.
      await flagOn(qg.serverId);
      expect(await runChannelLayoutMigrations()).toEqual([qg.serverId]);
      expect((await configOf(owner, qg.serverId)).mixed).toBe(true);
      expect((await configOf(owner, other.serverId)).mixed).toBe(false);
      expect(await runChannelLayoutMigrations()).toEqual([]);

      await revertChannelLayout(qg.serverId);
      expect(await runChannelLayoutMigrations()).toEqual([]);
      expect(await migrateChannelLayout(qg.serverId)).toMatchObject({ status: "already" });

      // The operator route may migrate it again, after a revert.
      const route = await call<{ status: string }>(owner, "POST", "/api/admin/channel-layout", {
        serverId: qg.serverId,
        action: "migrate",
      });
      // Not an instance moderator: the route does not exist for them.
      expect(route.status).toBe(404);
      expect(
        await migrateChannelLayout(qg.serverId, { allowReverted: true }),
      ).toMatchObject({ status: "migrated" });
      expect((await configOf(owner, qg.serverId)).mixed).toBe(true);
    });

    it("global on walks every server except the ones overridden off", async () => {
      const a = await legacyServer();
      const b = await legacyServer();
      await setServerFlagOverride("mixed_channel_list", b.serverId, false, { kind: "dashboard" });
      await flagOn();
      expect(await runChannelLayoutMigrations()).toEqual([a.serverId]);
      expect((await configOf(owner, b.serverId)).mixed).toBe(false);
    });

    it("tells every member's sidebar after the operator migrates", async () => {
      const { serverId } = await legacyServer();
      const memberFrames = connect(member);
      const outsiderFrames = connect(outsider);
      process.env.ADMIN_METRICS_TOKEN = "layoutlayoutlayoutlayoutlayout32";
      try {
        const response = await fetch(`${baseUrl}/api/admin/channel-layout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer layoutlayoutlayoutlayoutlayout32",
          },
          body: JSON.stringify({ serverId, action: "migrate" }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "migrated" });
      } finally {
        delete process.env.ADMIN_METRICS_TOKEN;
      }
      await vi.waitFor(() => {
        expect(memberFrames.map((f) => JSON.parse(f).type)).toContain("channels-update");
      });
      expect(outsiderFrames).toEqual([]);
    });
  });

  // ------------------------------------------------------------ PUT layout

  describe("PUT /api/servers/:id/channel-layout", () => {
    async function migrated() {
      const fixture = await legacyServer();
      await flagOn(fixture.serverId);
      await migrateChannelLayout(fixture.serverId);
      const cinema = await createIn(owner, fixture.serverId, "Cinema", "category");
      return { ...fixture, cinema };
    }

    async function put(as: User, serverId: string, body: unknown) {
      return call<{ channels: Channel[]; version: number; error?: string }>(
        as,
        "PUT",
        `/api/servers/${serverId}/channel-layout`,
        body,
      );
    }

    /** The payload a client builds after one move, from its own list. */
    async function payloadAfter(
      as: User,
      serverId: string,
      move: (layout: SidebarLayout<Channel>) => SidebarLayout<Channel> | null,
    ) {
      const config = await configOf(as, serverId);
      const layout = buildSidebarLayout(await channelsOf(as, serverId), { mixed: true });
      const next = move(layout)!;
      expect(next).not.toBeNull();
      return layoutToPayload(next, config.version);
    }

    it("mixes types across categories, reorders categories, and fills an empty one", async () => {
      const { serverId, lobby, cinema, clipes } = await migrated();
      const memberFrames = connect(member);
      const body = await payloadAfter(manager, serverId, (layout) => {
        let next = moveInLayout(layout, lobby.id, {
          parentId: (layout.categories[1]!.category.id),
          index: 1,
        });
        next = next && moveInLayout(next, clipes.id, { parentId: cinema.id, index: 0 });
        return next && moveInLayout(next, cinema.id, { parentId: null, index: 0 });
      });
      const res = await put(manager, serverId, body);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.version).toBe(body.baseVersion + 1);
      expect(named(buildSidebarLayout(res.body.channels, { mixed: true }))).toEqual({
        loose: [],
        categories: [
          ["Cinema", ["clipes"]],
          ["Canais", ["general", "test", "duvidas", "Squad"]],
          ["Jogos", ["Lobby", "lfg"]],
        ],
      });
      // Everyone else sees it: same list on a member's refetch, and a nudge.
      expect(await mixedView(member, serverId)).toEqual(
        named(buildSidebarLayout(res.body.channels, { mixed: true })),
      );
      await vi.waitFor(() => {
        expect(memberFrames.map((f) => JSON.parse(f).type)).toContain("channels-update");
      });
      const audit = await getPool().query(
        `SELECT action, changes FROM audit_log WHERE server_id = $1 AND action = 'channel.reorder'`,
        [serverId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(channelLayoutMetrics().reorders).toBe(1);
    });

    it("moves a channel to the loose area above the first category", async () => {
      const { serverId, general } = await migrated();
      const body = await payloadAfter(owner, serverId, (layout) =>
        moveInLayout(layout, general.id, { parentId: null, index: 0 }),
      );
      expect((await put(owner, serverId, body)).status).toBe(200);
      expect((await mixedView(owner, serverId)).loose).toEqual(["general"]);
    });

    it("leaves a private channel the manager cannot see exactly where it was", async () => {
      const { serverId, test } = await migrated();
      const canais = (await channelsOf(owner, serverId)).find((c) => c.name === "Canais")!;
      const staff = await createIn(owner, serverId, "staff", "text", {
        isPrivate: true,
        parentId: canais.id,
      });
      // Owner's view: staff at the end of Canais. Put it right after general.
      const ownerBody = await payloadAfter(owner, serverId, (layout) =>
        moveInLayout(layout, staff.id, { parentId: canais.id, index: 1 }),
      );
      expect((await put(owner, serverId, ownerBody)).status).toBe(200);
      expect((await mixedView(owner, serverId)).categories[0]).toEqual([
        "Canais",
        ["general", "staff", "test", "duvidas", "Lobby", "Squad"],
      ]);

      // The manager does not see staff, and moves test to the top.
      const managerChannels = await channelsOf(manager, serverId);
      expect(managerChannels.map((c) => c.name)).not.toContain("staff");
      const body = await payloadAfter(manager, serverId, (layout) =>
        moveInLayout(layout, test.id, { parentId: canais.id, index: 0 }),
      );
      expect(body.groups.flatMap((g) => g.channelIds)).not.toContain(staff.id);
      expect((await put(manager, serverId, body)).status).toBe(200);
      // staff stays right after its old neighbour, general.
      expect((await mixedView(owner, serverId)).categories[0]).toEqual([
        "Canais",
        ["test", "general", "staff", "duvidas", "Lobby", "Squad"],
      ]);
    });

    it("refuses a channel the manager cannot see with the same answer as an unknown id", async () => {
      const { serverId } = await migrated();
      const staff = await createIn(owner, serverId, "staff", "text", { isPrivate: true });
      const config = await configOf(manager, serverId);
      const layout = buildSidebarLayout(await channelsOf(manager, serverId), { mixed: true });
      const body = layoutToPayload(layout, config.version);
      body.groups[0]!.channelIds.push(staff.id);
      const res = await put(manager, serverId, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Unknown channel");
    });

    it("400s every broken shape and writes nothing", async () => {
      const { serverId, general, jogos } = await migrated();
      const thread = await getPool().query<{ id: string }>(
        `INSERT INTO channels (server_id, name, type, parent_id, position)
         VALUES ($1, 'fio', 'thread', $2, 0) RETURNING id`,
        [serverId, general.id],
      );
      const config = await configOf(owner, serverId);
      const good = layoutToPayload(
        buildSidebarLayout(await channelsOf(owner, serverId), { mixed: true }),
        config.version,
      );
      const before = await channelsOf(owner, serverId);
      const unknown = "00000000-0000-4000-8000-000000000999";
      const cases: Array<[string, unknown]> = [
        ["unknown id", { ...good, groups: [{ parentId: null, channelIds: [unknown] }] }],
        [
          "thread",
          { ...good, groups: [{ parentId: null, channelIds: [thread.rows[0]!.id] }] },
        ],
        ["category as a channel", { ...good, groups: [{ parentId: null, channelIds: [jogos.id] }] }],
        ["missing category", { ...good, categoryIds: good.categoryIds.slice(1) }],
        ["duplicate category", { ...good, categoryIds: [...good.categoryIds, good.categoryIds[0]] }],
        [
          "duplicate channel",
          {
            ...good,
            groups: [...good.groups, { parentId: null, channelIds: [general.id] }],
          },
        ],
        [
          "parent not a category",
          { ...good, groups: [{ parentId: general.id, channelIds: [] }] },
        ],
      ];
      for (const [label, body] of cases) {
        const res = await put(owner, serverId, body);
        expect(res.status, label).toBe(400);
      }
      expect(await channelsOf(owner, serverId)).toEqual(before);
      expect((await configOf(owner, serverId)).version).toBe(config.version);
    });

    it("409s a stale list with the fresh one, and the second of two managers sees it", async () => {
      const { serverId, test, duvidas } = await migrated();
      const first = await payloadAfter(owner, serverId, (layout) =>
        moveInLayout(layout, test.id, { parentId: null, index: 0 }),
      );
      const second = await payloadAfter(manager, serverId, (layout) =>
        moveInLayout(layout, duvidas.id, { parentId: null, index: 0 }),
      );
      expect((await put(owner, serverId, first)).status).toBe(200);
      const res = await put(manager, serverId, second);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("channel_layout_stale");
      expect(res.body.version).toBe(first.baseVersion + 1);
      expect(named(buildSidebarLayout(res.body.channels, { mixed: true })).loose).toEqual([
        "test",
      ]);
      expect(channelLayoutMetrics().staleRejected).toBe(1);
    });

    it("a PUT racing a move and a delete never deadlocks: each commits or is a clean 409", async () => {
      const { serverId, test, duvidas } = await migrated();
      let applied = 0;
      for (let round = 0; round < 6; round += 1) {
        const extra = await createIn(owner, serverId, `x${round}`, "text", { parentId: null });
        // Built after the create, so the PUT is current and really writes:
        // it holds the server row and goes for the channel rows while the
        // move and the delete go for the same rows.
        const body = await payloadAfter(manager, serverId, (layout) =>
          moveInLayout(layout, duvidas.id, { parentId: null, index: round % 2 }),
        );
        const [written, move, removed] = await Promise.all([
          put(manager, serverId, body),
          call(owner, "PATCH", `/api/channels/${test.id}/move`, {
            parentId: null,
            index: round % 3,
          }),
          call(owner, "DELETE", `/api/channels/${extra.id}`),
        ]);
        expect([200, 409]).toContain(written.status);
        expect(move.status).toBe(200);
        expect(removed.status).toBe(200);
        applied += written.status === 200 ? 1 : 0;
      }
      // Not only clean refusals: some rounds really raced and committed.
      expect(applied).toBeGreaterThan(0);
    });

    it("bumps the version on create, delete, move and a category rename", async () => {
      const { serverId, jogos, test } = await migrated();
      let version = (await configOf(owner, serverId)).version;
      const next = async () => {
        const now = (await configOf(owner, serverId)).version;
        expect(now).toBeGreaterThan(version);
        version = now;
      };
      const extra = await createIn(owner, serverId, "extra", "text", { parentId: null });
      await next();
      await call(owner, "PATCH", `/api/channels/${test.id}/move`, { parentId: jogos.id, index: 0 });
      await next();
      expect(
        (await call(owner, "PATCH", `/api/channels/${jogos.id}`, { name: "Salas de jogo" })).status,
      ).toBe(200);
      await next();
      await call(owner, "DELETE", `/api/channels/${extra.id}`);
      await next();
    });

    it("403s a member, 404s an outsider, 409s a server not in the mixed layout", async () => {
      const { serverId } = await migrated();
      const config = await configOf(owner, serverId);
      const body = layoutToPayload(
        buildSidebarLayout(await channelsOf(owner, serverId), { mixed: true }),
        config.version,
      );
      expect((await put(member, serverId, body)).status).toBe(403);
      expect((await put(outsider, serverId, body)).status).toBe(404);
      expect((await call(outsider, "GET", `/api/servers/${serverId}/channel-layout`)).status).toBe(
        404,
      );

      const legacy = await legacyServer();
      const legacyConfig = await configOf(owner, legacy.serverId);
      const off = await put(
        owner,
        legacy.serverId,
        layoutToPayload(
          buildSidebarLayout(await channelsOf(owner, legacy.serverId), { mixed: true }),
          legacyConfig.version,
        ),
      );
      expect(off.status).toBe(409);
      expect(off.body.error).toBe("channel_layout_off");
    });
  });

  // ------------------------------------------------------------ legacy rules

  describe("older clients keep working", () => {
    it("old web 'move up' on a voice room is read per type", async () => {
      const { serverId } = await makeServer();
      const squad = await createIn(owner, serverId, "Squad", "voice");
      await createIn(owner, serverId, "test", "text");
      // Old web: VOZ is [Lobby, Squad]; Squad up is index 0 of the voice list.
      expect(
        (await call(owner, "PATCH", `/api/channels/${squad.id}/move`, { parentId: null, index: 0 }))
          .status,
      ).toBe(200);
      expect(oldClientOrder(await channelsOf(owner, serverId))).toEqual({
        text: ["general", "test"],
        voice: ["Squad", "Lobby"],
        watchParty: [],
      });
      expect(channelLayoutMetrics().legacyMoveTranslated).toBe(1);
    });

    it("old web drag onto a loose row takes its slot, both directions", async () => {
      const { serverId } = await makeServer();
      await createIn(owner, serverId, "a", "text");
      const b = await createIn(owner, serverId, "b", "text");
      // general, a, b. Drag b onto general (index 0): b first.
      await call(owner, "PATCH", `/api/channels/${b.id}/move`, { parentId: null, index: 0 });
      expect(oldClientOrder(await channelsOf(owner, serverId)).text).toEqual(["b", "general", "a"]);
      // Drag b (index 0) onto a (index 2): b after a.
      await call(owner, "PATCH", `/api/channels/${b.id}/move`, { parentId: null, index: 2 });
      expect(oldClientOrder(await channelsOf(owner, serverId)).text).toEqual(["general", "a", "b"]);
    });

    it("iOS 1.0.21 'Top level' (index 0) out of Canais lands loose on a migrated server", async () => {
      const { serverId, lobby } = await legacyServer();
      await flagOn(serverId);
      await migrateChannelLayout(serverId);
      await call(owner, "PATCH", `/api/channels/${lobby.id}/move`, { parentId: null, index: 0 });
      expect((await mixedView(owner, serverId)).loose).toEqual(["Lobby"]);
    });

    it("a create with no parentId key goes to the first category; null stays loose", async () => {
      const { serverId } = await legacyServer();
      // Not mixed yet: an old client's create is loose, as always.
      await createIn(owner, serverId, "antes", "text");
      expect((await mixedView(owner, serverId)).loose).toContain("antes");

      await flagOn(serverId);
      await migrateChannelLayout(serverId);
      await createIn(owner, serverId, "velho", "voice");
      await createIn(owner, serverId, "novo", "text", { parentId: null });
      const view = await mixedView(owner, serverId);
      expect(view.loose).toEqual(["novo"]);
      expect(view.categories[0]![0]).toBe("Canais");
      expect((view.categories[0]![1] as string[]).at(-1)).toBe("velho");
      expect(channelLayoutMetrics().legacyCreateRedirected).toBe(1);
    });

    it("a create into a category appends to it, and refuses a parent that is not one", async () => {
      const { serverId, jogos, general } = await legacyServer();
      await createIn(owner, serverId, "speedrun", "text", { parentId: jogos.id });
      expect((await mixedView(owner, serverId)).categories.at(-1)).toEqual([
        "Jogos",
        ["clipes", "lfg", "speedrun"],
      ]);
      const bad = await call(owner, "POST", `/api/servers/${serverId}/channels`, {
        name: "x",
        type: "text",
        parentId: general.id,
      });
      expect(bad.status).toBe(400);
    });

    it("deleting Canais leaves its channels loose on top, in order, with no header", async () => {
      const { serverId } = await legacyServer();
      await flagOn(serverId);
      await migrateChannelLayout(serverId);
      const canais = (await channelsOf(owner, serverId)).find((c) => c.name === "Canais")!;
      expect((await call(owner, "DELETE", `/api/channels/${canais.id}`)).status).toBe(200);
      expect(await mixedView(owner, serverId)).toEqual({
        loose: ["general", "test", "duvidas", "Lobby", "Squad"],
        categories: [["Jogos", ["clipes", "lfg"]]],
      });
    });
  });

  // ------------------------------------------------------------ names, new servers

  describe("names and new servers", () => {
    it("a category takes spaces and accents; a channel still does not", async () => {
      const { serverId, general } = await makeServer();
      const cat = await createIn(owner, serverId, "Salas de voz", "category");
      expect(cat.name).toBe("Salas de voz");
      expect(
        (await call(owner, "PATCH", `/api/channels/${cat.id}`, { name: " Jogos e Música " })).status,
      ).toBe(200);
      expect((await channelsOf(owner, serverId)).find((c) => c.id === cat.id)!.name).toBe(
        "Jogos e Música",
      );
      expect(
        (await call(owner, "PATCH", `/api/channels/${general.id}`, { name: "Geral Novo" })).status,
      ).toBe(400);
      expect(
        (
          await call(owner, "POST", `/api/servers/${serverId}/channels`, {
            name: "a".repeat(33),
            type: "category",
          })
        ).status,
      ).toBe(400);
    });

    it("flag on globally: a new server starts with Canais holding general and Lobby", async () => {
      await flagOn();
      const created = await call<{ server: { id: string }; channels: Channel[] }>(
        owner,
        "POST",
        "/api/servers",
        { name: "Novo", locale: "es" },
      );
      expect(created.status).toBe(201);
      expect(named(buildSidebarLayout(created.body.channels, { mixed: true }))).toEqual({
        loose: [],
        categories: [["Canales", ["general", "Lobby"]]],
      });
      const serverId = created.body.server.id;
      expect((await configOf(owner, serverId)).mixed).toBe(true);
      // Recorded as migrated: the job leaves it alone.
      expect(await runChannelLayoutMigrations()).toEqual([]);

      const english = await call<{ channels: Channel[] }>(owner, "POST", "/api/servers", {
        name: "Mine",
        locale: "en",
      });
      expect(english.body.channels.find((c) => c.type === "category")!.name).toBe("Channels");
      const pt = await call<{ channels: Channel[] }>(owner, "POST", "/api/servers", {
        name: "Meu",
      });
      expect(pt.body.channels.find((c) => c.type === "category")!.name).toBe("Canais");
    });

    it("flag off: a new server is exactly as before", async () => {
      const { serverId } = await makeServer();
      expect(await mixedView(owner, serverId)).toEqual({
        loose: ["general", "Lobby"],
        categories: [],
      });
    });

    it("reports the counters and the table on the metrics block", async () => {
      const { serverId } = await legacyServer();
      await migrateChannelLayout(serverId);
      const report = await channelLayoutReport();
      expect(report).toMatchObject({
        enabled: false,
        migratedServers: 1,
        revertedServers: 0,
        migrated: 1,
      });
      for (const key of [
        "migratedNoop",
        "reverted",
        "reorders",
        "staleRejected",
        "legacyMoveTranslated",
        "legacyCreateRedirected",
        "jobFailures",
      ]) {
        expect(report).toHaveProperty(key);
      }
    });
  });
});
