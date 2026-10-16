import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DiscordPermission, MAX_IMPORT_CHANNELS, Permission } from "@pqp/shared";
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

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  actor: null as {
    id: string;
    clerk_id: string;
    is_character?: boolean;
  } | null,
  failAudit: false,
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  resolveAuthUser: async () => (stubs.actor ? { user: stubs.actor } : null),
  resolveAuthSession: async () =>
    stubs.actor ? { user: stubs.actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

vi.mock("../lib/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/safe-fetch.js")>();
  return { ...actual, safeFetch: vi.fn() };
});

// The audit row is the LAST write of the merge, so making it throw is how the
// rollback test proves that everything before it was undone too.
vi.mock("../services/audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/audit.js")>();
  return {
    ...actual,
    logAudit: vi.fn(async (...args: Parameters<typeof actual.logAudit>) => {
      if (stubs.failAudit && args[0].action === "server.discord_import_merge") {
        throw new Error("audit write failed");
      }
      return actual.logAudit(...args);
    }),
  };
});

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { upsertUser } = await import("../services/users.js");
const { safeFetch } = await import("../lib/safe-fetch.js");
const { createServer: createPqpServer } = await import("../services/servers.js");
const { resetFeatureFlagsForTests, setGlobalFlag, setServerFlagOverride } =
  await import("../lib/flags.js");

interface Actor {
  id: string;
  clerk_id: string;
  is_character?: boolean;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

const DISCORD_VIEW = (1n << 10n).toString();

function guildTemplate(channels: unknown[], roles: unknown[] = []) {
  return {
    updated_at: "2026-08-01T00:00:00+00:00",
    is_dirty: false,
    serialized_source_guild: {
      name: "Old Discord",
      roles: [
        { id: 0, name: "@everyone", color: 0, hoist: false, mentionable: false },
        ...roles,
      ],
      channels,
    },
  };
}

function fetchOk(payload: unknown) {
  vi.mocked(safeFetch).mockResolvedValue({
    statusCode: 200,
    headers: {},
    body: Buffer.from(JSON.stringify(payload)),
    finalUrl: "https://discord.com/api/v10/guilds/templates/abcd1234",
  });
}

const TEMPLATE_CHANNELS = [
  { id: 1, type: 4, name: "Text", position: 0 },
  { id: 2, type: 0, name: "general", position: 0, parent_id: 1 },
  { id: 3, type: 0, name: "memes", position: 1, parent_id: 1 },
  { id: 4, type: 4, name: "Voice", position: 1 },
  { id: 5, type: 2, name: "Hangout", position: 0, parent_id: 4 },
  { id: 6, type: 0, name: "rules", position: 0 },
];

type MergeBody = {
  plan: {
    addedCategories: { name: string }[];
    addedChannels: { name: string }[];
    reusedCategories: { name: string }[];
    skipped: { kind: string; name: string; reason: string }[];
    addableRoles: { templateId: number; name: string; overwriteCount: number }[];
  };
  channels: { id: string; name: string; type: string; parentId: string | null; position: number; isPrivate: boolean }[];
  rolesCreated: string[];
};

describeDb("discord layout import into an existing server", () => {
  let server: Server;
  let baseUrl: string;
  let owner: Actor;
  let member: Actor;
  let serverId: string;

  beforeAll(async () => {
    await initDb();
    stubs.actor = null;
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

  // The apply fires `channels-update` fan-out reads without awaiting them
  // (the import is already committed). Let them land before the next test
  // TRUNCATEs the tables they read, or the two lock each other (40P01).
  afterEach(async () => {
    await new Promise((done) => setTimeout(done, 200));
  });

  async function makeUser(clerkId: string, name: string): Promise<Actor> {
    const row = await upsertUser({ clerkId, displayName: name, avatarUrl: null });
    return { id: row.id, clerk_id: row.clerk_id };
  }

  async function enable(id: string = serverId) {
    await setServerFlagOverride("discord_import_existing", id, true, {
      kind: "dashboard",
    });
  }

  beforeEach(async () => {
    resetApiRateLimits();
    vi.mocked(safeFetch).mockReset();
    stubs.failAudit = false;
    resetFeatureFlagsForTests();
    await getPool().query(
      `TRUNCATE users, feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    owner = await makeUser("clerk_merge_owner", "Owner");
    member = await makeUser("clerk_merge_member", "Member");
    const created = await createPqpServer("Mine", owner.id);
    serverId = created.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
  });

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
        ...(as ? { Authorization: "Bearer test" } : {}),
        Origin: "http://localhost:5173",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  const preview = (as: Actor | null, id: string = serverId) =>
    call<MergeBody["plan"] & { canCreateRoles: boolean }>(
      as,
      "POST",
      `/api/servers/${id}/discord-import/preview`,
      { source: "abcd1234" },
    );
  const apply = (as: Actor | null, createRoles?: number[], id: string = serverId) =>
    call<MergeBody>(as, "POST", `/api/servers/${id}/discord-import/apply`, {
      source: "abcd1234",
      ...(createRoles ? { createRoles } : {}),
    });

  async function grantCargo(who: Actor, name: string, bits: bigint) {
    const role = await getPool().query<{ id: string }>(
      `INSERT INTO roles (server_id, name, permissions, position)
       VALUES ($1, $2, $3, 1) RETURNING id`,
      [serverId, name, bits.toString()],
    );
    await getPool().query(
      "INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)",
      [serverId, who.id, role.rows[0]!.id],
    );
  }

  /** Everything the merge promises not to touch, as comparable JSON rows. */
  async function snapshot() {
    const pool = getPool();
    const q = async (sql: string) => (await pool.query(sql, [serverId])).rows;
    return {
      channels: await q(
        `SELECT id, name, type, position, is_private, topic, parent_id, kind
           FROM channels WHERE server_id = $1 ORDER BY id`,
      ),
      // `position` is left out on purpose: it slides when a cargo is added, and
      // the ORDER is asserted separately.
      roles: await q(
        `SELECT id, name, color, hoist, mentionable, permissions::text, is_everyone,
                system_key, show_badge
           FROM roles WHERE server_id = $1 ORDER BY id`,
      ),
      roleOrder: (
        await pool.query(
          `SELECT id FROM roles WHERE server_id = $1 ORDER BY position, id`,
          [serverId],
        )
      ).rows.map((row) => row.id as string),
      overwrites: await q(
        `SELECT o.channel_id, o.target_type, o.target_id, o.allow::text, o.deny::text
           FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id
          WHERE c.server_id = $1 ORDER BY o.channel_id, o.target_id`,
      ),
      memberRoles: await q(
        `SELECT user_id, role_id FROM member_roles WHERE server_id = $1 ORDER BY user_id, role_id`,
      ),
      members: await q(
        `SELECT user_id, role FROM server_members WHERE server_id = $1 ORDER BY user_id`,
      ),
      channelMembers: await q(
        `SELECT cm.channel_id, cm.user_id FROM channel_members cm
           JOIN channels c ON c.id = cm.channel_id WHERE c.server_id = $1
          ORDER BY cm.channel_id, cm.user_id`,
      ),
      server: await q(`SELECT name, owner_id, icon_url, is_community FROM servers WHERE id = $1`),
    };
  }

  type Snapshot = Awaited<ReturnType<typeof snapshot>>;

  /** `after` must contain every row of `before`, byte for byte. */
  function expectOnlyAdditions(before: Snapshot, after: Snapshot) {
    for (const key of ["channels", "roles", "overwrites", "memberRoles", "members", "channelMembers"] as const) {
      const have = new Set(after[key].map((row) => JSON.stringify(row)));
      for (const row of before[key]) {
        expect(have.has(JSON.stringify(row)), `${key} row changed or vanished: ${JSON.stringify(row)}`).toBe(true);
      }
    }
    expect(after.server).toEqual(before.server);
    // Existing cargos keep their order among themselves.
    expect(after.roleOrder.filter((id) => before.roleOrder.includes(id))).toEqual(before.roleOrder);
  }

  describe("flag and permissions", () => {
    it("is a 404 on every route while the flag is off, and the config says disabled", async () => {
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      expect((await preview(owner)).status).toBe(404);
      expect((await apply(owner)).status).toBe(404);
      const config = await call<{ enabled: boolean }>(
        owner,
        "GET",
        `/api/servers/${serverId}/discord-import/config`,
      );
      expect(config.body.enabled).toBe(false);
      expect(vi.mocked(safeFetch)).not.toHaveBeenCalled();
    });

    it("is per server: on for one does not open another", async () => {
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      const other = await createPqpServer("Other", owner.id);
      await enable(other.server.id);
      expect((await preview(owner, other.server.id)).status).toBe(200);
      expect((await preview(owner)).status).toBe(404);
    });

    it("is on globally when the global row says so", async () => {
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      await setGlobalFlag("discord_import_existing", true, { kind: "dashboard" });
      expect((await preview(owner)).status).toBe(200);
    });

    it("answers 404 to a non-member (flag on), 403 to a plain member, 200 to the owner", async () => {
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      await enable();
      const stranger = await makeUser("clerk_merge_stranger", "Stranger");
      expect((await preview(stranger)).status).toBe(404);
      expect((await apply(stranger)).status).toBe(404);
      expect((await preview(member)).status).toBe(403);
      expect((await apply(member)).status).toBe(403);
      expect((await preview(owner)).status).toBe(200);
      expect((await preview(null)).status).toBe(401);
    });

    it("lets a Manage Server cargo preview and apply, and a Manage Roles cargo alone not", async () => {
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      await enable();
      await grantCargo(member, "Roles_only", Permission.MANAGE_ROLES);
      expect((await apply(member)).status).toBe(403);
      await grantCargo(member, "Server_crew", Permission.MANAGE_SERVER);
      const res = await apply(member);
      expect(res.status).toBe(200);
      expect(res.body.channels.length).toBeGreaterThan(0);
    });

    it("refuses cargos to a manager who may not manage roles, before writing anything", async () => {
      fetchOk(
        guildTemplate(TEMPLATE_CHANNELS, [
          { id: 7, name: "Helpers", color: 0, hoist: false, mentionable: false },
        ]),
      );
      await enable();
      await grantCargo(member, "Server_crew", Permission.MANAGE_SERVER);
      const before = await snapshot();
      expect((await apply(member, [7])).status).toBe(403);
      expect(await snapshot()).toEqual(before);
      const pre = await preview(member);
      expect(pre.body.canCreateRoles).toBe(false);
    });

    it("refuses a character account", async () => {
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      await enable();
      await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [owner.id]);
      expect((await preview({ ...owner, is_character: true })).status).toBe(403);
    });

    it("keeps the paste errors of the create path (invite link, not a template)", async () => {
      await enable();
      const res = await call<{ code: string }>(
        owner,
        "POST",
        `/api/servers/${serverId}/discord-import/preview`,
        { source: "discord.gg/abcdefg" },
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("inviteLink");
      expect(vi.mocked(safeFetch)).not.toHaveBeenCalled();
    });
  });

  describe("preview", () => {
    it("writes nothing and lists what would be added, reused and skipped", async () => {
      await enable();
      const cat = await getPool().query<{ id: string }>(
        `INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'text', 'category', 5) RETURNING id`,
        [serverId],
      );
      await getPool().query(
        `INSERT INTO channels (server_id, name, type, position, parent_id) VALUES ($1, 'General', 'text', 0, $2)`,
        [serverId, cat.rows[0]!.id],
      );
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      const before = await snapshot();
      const res = await preview(owner);
      expect(res.status).toBe(200);
      expect(res.body.reusedCategories.map((c) => c.name)).toEqual(["Text"]);
      expect(res.body.addedCategories.map((c) => c.name)).toEqual(["Voice"]);
      expect(res.body.addedChannels.map((c) => c.name)).toEqual(["memes", "Hangout", "rules"]);
      expect(res.body.skipped).toEqual([
        expect.objectContaining({ kind: "channel", name: "general", reason: "exists" }),
      ]);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("apply", () => {
    it("adds categories and channels after the existing ones and touches nothing else", async () => {
      await enable();
      // Something of every kind the guarantee covers: a category with a channel,
      // a private channel with an overwrite, a cargo held by a member.
      const cat = (
        await getPool().query<{ id: string }>(
          `INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'Mine', 'category', 0) RETURNING id`,
          [serverId],
        )
      ).rows[0]!.id;
      const secret = (
        await getPool().query<{ id: string }>(
          `INSERT INTO channels (server_id, name, type, position, parent_id, is_private)
           VALUES ($1, 'secret', 'text', 0, $2, TRUE) RETURNING id`,
          [serverId, cat],
        )
      ).rows[0]!.id;
      const everyone = (
        await getPool().query<{ id: string }>(
          `SELECT id FROM roles WHERE server_id = $1 AND is_everyone`,
          [serverId],
        )
      ).rows[0]!.id;
      await getPool().query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, 'role', $2, 0, $3)`,
        [secret, everyone, Permission.VIEW_CHANNEL.toString()],
      );
      await grantCargo(member, "Regulars", Permission.SEND_MESSAGES);
      const loose = await getPool().query<{ position: number }>(
        `SELECT position FROM channels WHERE server_id = $1 AND parent_id IS NULL AND type <> 'category' ORDER BY position`,
        [serverId],
      );
      const lastLoose = loose.rows[loose.rows.length - 1]!.position;

      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      const before = await snapshot();
      const res = await apply(owner);
      expect(res.status).toBe(200);
      const after = await snapshot();
      expectOnlyAdditions(before, after);

      expect(res.body.plan.addedCategories.map((c) => c.name)).toEqual(["Text", "Voice"]);
      expect(res.body.channels.map((c) => c.name)).toEqual(["general", "memes", "Hangout", "rules"]);
      // 2 categories + 4 channels went in, and only those.
      expect(after.channels.length).toBe(before.channels.length + 6);

      // Categories after the existing one; loose channels after the last loose one.
      const cats = await getPool().query<{ name: string; position: number }>(
        `SELECT name, position FROM channels WHERE server_id = $1 AND type = 'category' ORDER BY position`,
        [serverId],
      );
      expect(cats.rows.map((r) => r.name)).toEqual(["Mine", "Text", "Voice"]);
      expect(cats.rows.map((r) => r.position)).toEqual([0, 1, 2]);
      const rules = res.body.channels.find((c) => c.name === "rules")!;
      expect(rules.parentId).toBeNull();
      expect(rules.position).toBe(lastLoose + 1);
      const text = (await getPool().query(`SELECT id FROM channels WHERE server_id=$1 AND name='Text'`, [serverId])).rows[0]!.id;
      const general = res.body.channels.find((c) => c.name === "general")!;
      const memes = res.body.channels.find((c) => c.name === "memes")!;
      expect(general.parentId).toBe(text);
      expect([general.position, memes.position]).toEqual([0, 1]);
    });

    it("reuses a category by name and adds only the channels it lacks, after its last", async () => {
      await enable();
      const cat = (
        await getPool().query<{ id: string }>(
          `INSERT INTO channels (server_id, name, type, position) VALUES ($1, '  TEXT ', 'category', 0) RETURNING id`,
          [serverId],
        )
      ).rows[0]!.id;
      await getPool().query(
        `INSERT INTO channels (server_id, name, type, position, parent_id) VALUES
           ($1, 'GENERAL', 'text', 0, $2), ($1, 'mine', 'voice', 1, $2)`,
        [serverId, cat],
      );
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      const before = await snapshot();
      const res = await apply(owner);
      expect(res.status).toBe(200);
      expectOnlyAdditions(before, await snapshot());
      expect(res.body.plan.reusedCategories).toHaveLength(1);
      expect(res.body.plan.addedCategories.map((c) => c.name)).toEqual(["Voice"]);
      const memes = res.body.channels.find((c) => c.name === "memes")!;
      expect(memes.parentId).toBe(cat);
      expect(memes.position).toBe(2);
      expect(res.body.plan.skipped).toEqual([
        expect.objectContaining({ name: "general", reason: "exists" }),
      ]);
    });

    it("is idempotent: the second run adds nothing and writes nothing", async () => {
      await enable();
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      const first = await apply(owner);
      expect(first.body.channels.length).toBe(4);
      const before = await snapshot();
      const versionBefore = (
        await getPool().query(`SELECT channel_layout_version AS v FROM servers WHERE id = $1`, [serverId])
      ).rows[0]!.v;
      const auditBefore = (
        await getPool().query(`SELECT count(*)::int AS n FROM audit_log WHERE server_id = $1`, [serverId])
      ).rows[0]!.n;

      const second = await apply(owner);
      expect(second.status).toBe(200);
      expect(second.body.channels).toEqual([]);
      expect(second.body.plan.addedChannels).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(
        (await getPool().query(`SELECT channel_layout_version AS v FROM servers WHERE id = $1`, [serverId])).rows[0]!.v,
      ).toBe(versionBefore);
      expect(
        (await getPool().query(`SELECT count(*)::int AS n FROM audit_log WHERE server_id = $1`, [serverId])).rows[0]!.n,
      ).toBe(auditBefore);
    });

    it("two applies at once still add each thing once", async () => {
      await enable();
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      const [a, b] = await Promise.all([apply(owner), apply(owner)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.channels.length + b.body.channels.length).toBe(4);
      const dupes = await getPool().query(
        `SELECT name, type, parent_id, count(*)::int AS n FROM channels
          WHERE server_id = $1 AND name IN ('general', 'memes', 'Hangout', 'rules', 'Text', 'Voice')
          GROUP BY name, type, parent_id HAVING count(*) > 1`,
        [serverId],
      );
      expect(dupes.rows).toEqual([]);
    });

    it("handles collisions: same name other type is added, repeats are added once, other category is not a clash", async () => {
      await enable();
      const text = (
        await getPool().query<{ id: string }>(
          `INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'Text', 'category', 0) RETURNING id`,
          [serverId],
        )
      ).rows[0]!.id;
      const elsewhere = (
        await getPool().query<{ id: string }>(
          `INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'Elsewhere', 'category', 1) RETURNING id`,
          [serverId],
        )
      ).rows[0]!.id;
      await getPool().query(
        `INSERT INTO channels (server_id, name, type, position, parent_id) VALUES
           ($1, 'general', 'voice', 0, $2), ($1, 'memes', 'text', 0, $3)`,
        [serverId, text, elsewhere],
      );
      fetchOk(
        guildTemplate([
          { id: 1, type: 4, name: "Text", position: 0 },
          { id: 2, type: 0, name: "general", position: 0, parent_id: 1 },
          { id: 3, type: 0, name: "memes", position: 1, parent_id: 1 },
          { id: 4, type: 0, name: "Memes", position: 2, parent_id: 1 },
          { id: 5, type: 0, name: "solo", position: 0 },
          { id: 6, type: 0, name: "SOLO", position: 1 },
        ]),
      );
      const res = await apply(owner);
      expect(res.status).toBe(200);
      expect(res.body.channels.map((c) => c.name)).toEqual(["general", "memes", "solo"]);
      expect(res.body.plan.skipped.map((s) => `${s.name}:${s.reason}`)).toEqual([
        "Memes:duplicate",
        "SOLO:duplicate",
      ]);
    });

    it("keeps a template name with emoji and spaces as Discord spelled it", async () => {
      await enable();
      fetchOk(
        guildTemplate([
          { id: 1, type: 0, name: "💬｜bate papo", position: 0, topic: "oi" },
        ]),
      );
      const res = await apply(owner);
      expect(res.body.channels[0]!.name).toBe("💬｜bate papo");
    });

    it("makes private channels private to @everyone, visible to the person who ran it", async () => {
      await enable();
      await grantCargo(member, "Server_crew", Permission.MANAGE_SERVER);
      fetchOk(
        guildTemplate([
          {
            id: 1,
            type: 0,
            name: "staff",
            position: 0,
            permission_overwrites: [{ id: 0, type: 0, allow: "0", deny: DISCORD_VIEW }],
          },
        ]),
      );
      const res = await apply(member);
      expect(res.status).toBe(200);
      const staff = res.body.channels[0]!;
      expect(staff.isPrivate).toBe(true);
      const rows = await getPool().query<{ deny: string; target_type: string }>(
        `SELECT target_type, deny::text FROM channel_overwrites WHERE channel_id = $1`,
        [staff.id],
      );
      expect(
        rows.rows.some(
          (r) =>
            r.target_type === "role" &&
            (BigInt(r.deny) & Permission.VIEW_CHANNEL) === Permission.VIEW_CHANNEL,
        ),
      ).toBe(true);
      const access = await getPool().query(
        `SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
        [staff.id, member.id],
      );
      expect(access.rows.length).toBe(1);
      // A plain member who was already on the server cannot see it; the runner can.
      const plain = await makeUser("clerk_merge_plain", "Plain");
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, plain.id],
      );
      const names = async (who: Actor) =>
        (
          await call<{ channels: { name: string }[] }>(who, "GET", `/api/servers/${serverId}/channels`)
        ).body.channels.map((c) => c.name);
      expect(await names(plain)).not.toContain("staff");
      expect(await names(member)).toContain("staff");
    });

    it("a forum follows THIS server's forum_channels flag", async () => {
      await enable();
      const template = guildTemplate([
        {
          id: 1,
          type: 15,
          name: "questions",
          position: 0,
          available_tags: [{ name: "Bug", emoji_name: "🐛" }],
        },
      ]);
      fetchOk(template);
      const off = await apply(owner);
      expect(off.body.channels[0]!.type).toBe("text");

      await getPool().query(`DELETE FROM channels WHERE server_id = $1 AND name = 'questions'`, [serverId]);
      await setServerFlagOverride("forum_channels", serverId, true, { kind: "dashboard" });
      const on = await apply(owner);
      expect(on.body.channels[0]!.type).toBe("forum");
      const tags = await getPool().query(`SELECT name FROM forum_tags WHERE forum_id = $1`, [
        on.body.channels[0]!.id,
      ]);
      expect(tags.rows.map((r) => r.name)).toEqual(["Bug"]);
    });

    it("refreshes the cached channel list the open clients read", async () => {
      await enable();
      const list = () =>
        call<{ channels: { name: string }[] }>(owner, "GET", `/api/servers/${serverId}/channels`);
      expect((await list()).body.channels.some((c) => c.name === "memes")).toBe(false);
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      await apply(owner);
      expect((await list()).body.channels.some((c) => c.name === "memes")).toBe(true);
    });

    it("writes the audit entry with counts", async () => {
      await enable();
      fetchOk(guildTemplate(TEMPLATE_CHANNELS));
      await apply(owner);
      const rows = await getPool().query<{ changes: { key: string; new: unknown }[]; actor_id: string }>(
        `SELECT changes, actor_id FROM audit_log WHERE server_id = $1 AND action = 'server.discord_import_merge'`,
        [serverId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.actor_id).toBe(owner.id);
      const byKey = Object.fromEntries(rows.rows[0]!.changes.map((c) => [c.key, c.new]));
      expect(byKey).toMatchObject({
        templateCode: "abcd1234",
        categoriesAdded: 2,
        categoriesReused: 0,
        channelsAdded: 4,
        skipped: 0,
        rolesAdded: 0,
      });
      // The create path's own action is untouched: no "Traz tua galera" window.
      const created = await getPool().query(
        `SELECT 1 FROM audit_log WHERE server_id = $1 AND action = 'server.discord_import'`,
        [serverId],
      );
      expect(created.rows).toEqual([]);
    });

    it("rolls everything back when a step fails midway", async () => {
      await enable();
      fetchOk(
        guildTemplate(TEMPLATE_CHANNELS, [
          { id: 7, name: "Helpers", color: 0, hoist: false, mentionable: false },
        ]),
      );
      const before = await snapshot();
      const versionBefore = (
        await getPool().query(`SELECT channel_layout_version AS v FROM servers WHERE id = $1`, [serverId])
      ).rows[0]!.v;
      stubs.failAudit = true;
      const res = await apply(owner, [7]);
      expect(res.status).toBe(500);
      expect(await snapshot()).toEqual(before);
      expect(
        (await getPool().query(`SELECT channel_layout_version AS v FROM servers WHERE id = $1`, [serverId])).rows[0]!.v,
      ).toBe(versionBefore);
      // And the same request works once the fault is gone.
      stubs.failAudit = false;
      expect((await apply(owner, [7])).status).toBe(200);
    });
  });

  describe("limits", () => {
    async function fill(count: number) {
      await getPool().query(
        `INSERT INTO channels (server_id, name, type, position)
         SELECT $1, 'filler-' || g, 'text', 100 + g FROM generate_series(1, $2) g`,
        [serverId, count],
      );
    }

    it("counts existing channels against the cap and reports what did not fit", async () => {
      await enable();
      const existing = (
        await getPool().query(`SELECT count(*)::int AS n FROM channels WHERE server_id = $1`, [serverId])
      ).rows[0]!.n as number;
      await fill(MAX_IMPORT_CHANNELS - existing - 2);
      fetchOk(
        guildTemplate([
          { id: 1, type: 0, name: "one", position: 0 },
          { id: 2, type: 0, name: "two", position: 1 },
          { id: 3, type: 0, name: "three", position: 2 },
        ]),
      );
      const pre = await preview(owner);
      expect(pre.body.skipped).toEqual([
        expect.objectContaining({ name: "three", reason: "channelLimit" }),
      ]);
      const res = await apply(owner);
      expect(res.body.channels.map((c) => c.name)).toEqual(["one", "two"]);
      const total = (
        await getPool().query(`SELECT count(*)::int AS n FROM channels WHERE server_id = $1`, [serverId])
      ).rows[0]!.n as number;
      expect(total).toBe(MAX_IMPORT_CHANNELS);
      // At the cap, a second run adds nothing and says why.
      fetchOk(guildTemplate([{ id: 3, type: 0, name: "three", position: 0 }]));
      const full = await apply(owner);
      expect(full.body.channels).toEqual([]);
      expect(full.body.plan.skipped[0]).toMatchObject({ reason: "channelLimit" });
    });

    it("stops at the category cap", async () => {
      await enable();
      await getPool().query(
        `INSERT INTO channels (server_id, name, type, position)
         SELECT $1, 'cat-' || g, 'category', g FROM generate_series(1, 30) g`,
        [serverId],
      );
      fetchOk(guildTemplate(TEMPLATE_CHANNELS.slice(0, 3)));
      const res = await apply(owner);
      expect(res.body.plan.addedCategories).toEqual([]);
      expect(res.body.plan.skipped.map((s) => `${s.name}:${s.reason}`)).toEqual([
        "Text:categoryLimit",
        "general:categoryLimit",
        "memes:categoryLimit",
      ]);
    });
  });

  describe("cargos", () => {
    const ROLES = [
      {
        id: 7,
        name: "Helpers",
        color: 3447003,
        hoist: true,
        mentionable: true,
        permissions: (
          DiscordPermission.SEND_MESSAGES | DiscordPermission.MANAGE_ROLES
        ).toString(),
      },
      { id: 8, name: "Mods", color: 0, hoist: false, mentionable: false },
    ];
    const STAFF_CHANNEL = {
      id: 1,
      type: 0,
      name: "staff",
      position: 0,
      permission_overwrites: [
        { id: 0, type: 0, allow: "0", deny: DISCORD_VIEW },
        { id: 7, type: 0, allow: DISCORD_VIEW, deny: "0" },
        { id: 8, type: 0, allow: DISCORD_VIEW, deny: "0" },
      ],
    };

    it("creates no cargo unless it is ticked, and still locks the private channel", async () => {
      await enable();
      fetchOk(guildTemplate([STAFF_CHANNEL], ROLES));
      const before = await snapshot();
      const res = await apply(owner);
      expect(res.status).toBe(200);
      expect(res.body.rolesCreated).toEqual([]);
      const after = await snapshot();
      expectOnlyAdditions(before, after);
      expect(after.roles).toEqual(before.roles);
      const rows = await getPool().query<{ target_type: string; allow: string }>(
        `SELECT target_type, allow::text FROM channel_overwrites WHERE channel_id = $1`,
        [res.body.channels[0]!.id],
      );
      // @everyone deny, plus the running manager's own access, and no role rules.
      expect(rows.rows.filter((r) => r.target_type === "role" && r.allow !== "0")).toEqual([]);
    });

    it("creates a ticked cargo at the lowest rank, never touches an existing one, and wires only what exists", async () => {
      await enable();
      // "Mods" exists already: it is reused as a rule target, not recreated.
      const mods = (
        await getPool().query<{ id: string }>(
          `INSERT INTO roles (server_id, name, permissions, position, color) VALUES ($1, 'mods', 8, 1, '#ff0000') RETURNING id`,
          [serverId],
        )
      ).rows[0]!.id;
      await getPool().query(
        `INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)`,
        [serverId, member.id, mods],
      );
      fetchOk(guildTemplate([STAFF_CHANNEL], ROLES));
      const before = await snapshot();
      const pre = await preview(owner);
      expect(pre.body.canCreateRoles).toBe(true);
      expect(pre.body.addableRoles.map((r) => [r.name, r.overwriteCount])).toEqual([["Helpers", 1]]);

      const res = await apply(owner, [7, 8, 999]);
      expect(res.status).toBe(200);
      // 8 is "Mods", which exists: not created. 999 is not in the template.
      expect(res.body.rolesCreated).toEqual(["Helpers"]);
      const after = await snapshot();
      expectOnlyAdditions(before, after);
      // Nobody was given anything.
      expect(after.memberRoles).toEqual(before.memberRoles);

      const helpers = (
        await getPool().query<{ id: string; permissions: string; position: number; hoist: boolean; color: string }>(
          `SELECT id, permissions::text, position, hoist, color FROM roles WHERE server_id = $1 AND name = 'Helpers'`,
          [serverId],
        )
      ).rows[0]!;
      expect(helpers.position).toBe(1);
      expect(helpers.hoist).toBe(true);
      // Owner holds everything, so the cargo carries the mapped bits (never Administrator).
      expect((BigInt(helpers.permissions) & Permission.ADMINISTRATOR)).toBe(0n);
      // The existing "mods" is exactly as it was, one rank up.
      const modsAfter = await getPool().query(`SELECT color, permissions::text, position FROM roles WHERE id = $1`, [mods]);
      expect(modsAfter.rows[0]).toMatchObject({ color: "#ff0000", permissions: "8", position: 2 });

      const rules = await getPool().query<{ target_id: string }>(
        `SELECT target_id FROM channel_overwrites WHERE channel_id = $1 AND target_type = 'role' AND allow <> 0`,
        [res.body.channels[0]!.id],
      );
      expect(rules.rows.map((r) => r.target_id).sort()).toEqual([helpers.id, mods].sort());

      // Running it again creates no second "Helpers".
      const again = await apply(owner, [7]);
      expect(again.body.rolesCreated).toEqual([]);
      expect(
        (await getPool().query(`SELECT count(*)::int AS n FROM roles WHERE server_id = $1 AND lower(name) = 'helpers'`, [serverId])).rows[0]!.n,
      ).toBe(1);
    });

    it("moves the permissions version only when a rule or cargo was written", async () => {
      await enable();
      const version = async () =>
        (
          await getPool().query<{ v: number }>(
            `SELECT permissions_version AS v FROM servers WHERE id = $1`,
            [serverId],
          )
        ).rows[0]!.v;
      const start = await version();
      fetchOk(guildTemplate([{ id: 1, type: 0, name: "plain", position: 0 }]));
      await apply(owner);
      expect(await version()).toBe(start);
      fetchOk(guildTemplate([STAFF_CHANNEL], ROLES));
      await apply(owner, [7]);
      expect(await version()).toBeGreaterThan(start);
    });

    it("never hands a cargo a permission its creator cannot grant", async () => {
      await enable();
      // Manage Server + Manage Roles, but not Kick Members.
      await grantCargo(member, "Server_crew", Permission.MANAGE_SERVER | Permission.MANAGE_ROLES);
      fetchOk(
        guildTemplate(
          [],
          [
            {
              id: 7,
              name: "Helpers",
              color: 0,
              hoist: false,
              mentionable: false,
              permissions: (
                DiscordPermission.SEND_MESSAGES | DiscordPermission.KICK_MEMBERS
              ).toString(),
            },
          ],
        ),
      );
      const res = await apply(member, [7]);
      expect(res.status).toBe(200);
      const helpers = (
        await getPool().query<{ permissions: string }>(
          `SELECT permissions::text FROM roles WHERE server_id = $1 AND name = 'Helpers'`,
          [serverId],
        )
      ).rows[0]!;
      const bits = BigInt(helpers.permissions);
      expect(bits & Permission.KICK_MEMBERS).toBe(0n);
      expect(bits & Permission.SEND_MESSAGES).toBe(Permission.SEND_MESSAGES);
    });
  });
});
