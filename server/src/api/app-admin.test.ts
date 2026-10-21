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
 * The operator's apps routes (PLAN Phase 5, P5-A), over HTTP against a real
 * Postgres, through both doors: the dashboard's machine token and an instance
 * moderator's session. What is pinned here:
 *
 *  1. WHO. A wrong token and a signed-in non-moderator are the same 404 a
 *     route that is not there gives; a moderator works and is the audit actor.
 *  2. THE RULES. Nothing goes live or on for everybody without an approved
 *     current version (409 `not-reviewed`), an approval needs the whole
 *     checklist, a public community cannot be switched on for an app that is
 *     not unlocked for communities (409 `community-locked`).
 *  3. THE TRAIL. One `app_admin_audit` row per field that changed, in the same
 *     transaction as the write, none for a write that changed nothing and none
 *     for a refused one; and one `apps.changed` frame on the bus after each
 *     committed change, none otherwise.
 *
 * The suite runs with the cluster bus installed (a memory transport) because
 * that is how production runs: the hint is what a sibling's cache listens for.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
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

const { handleApi, resetApiRateLimits, matchAdminMachineRoute } = await import(
  "./index.js"
);
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createMemoryHub, createMemoryTransport, observeBusFrames, setBusTransport } =
  await import("../lib/bus.js");
const { APPS_BUS_TOPIC, onAppsChanged } = await import("../apps/changed.js");

const TOKEN = "0123456789abcdef0123456789abcdef";
const WRONG_TOKEN = "ffffffffffffffffffffffffffffffff";
const SHA = "a".repeat(64);

type Actor = { id: string; clerk_id: string };

let server: Server;
let baseUrl: string;

async function asMachine<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  token = TOKEN,
): Promise<{ status: number; body: T }> {
  stubs.actor = null;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function asUser<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: "Bearer session",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function manifest(id: string, category: string, name: string) {
  return {
    manifestVersion: 1,
    id,
    version: "1.0.0",
    publisher: "pqp",
    platformApi: 1,
    name: "name",
    description: "description",
    icon: "gamepad",
    category,
    channelTypes: ["text", "voice"],
    players: { min: 1, max: 4, spectators: true, maxSpectators: 50 },
    requires: { start: "USE_APPS", join: "VIEW_CHANNEL" },
    capabilities: { identity: "display", share: "none", localFiles: { allowed: false }, peer: "none" },
    content: { userText: false, userImages: false },
    license: { spdx: "AGPL-3.0-only", source: "https://github.com/rafaelcg/pqp" },
    i18n: {
      "pt-BR": { name, description: `${name}, descricao` },
      en: { name, description: name },
      es: { name, description: name },
    },
  };
}

const FULL_CHECKLIST = {
  sandbox: true,
  noNetwork: true,
  license: true,
  romPolicy: true,
  i18n: true,
  presence: true,
};

interface AppView {
  id: string;
  name: string;
  status: string;
  globalEnabled: boolean;
  communityUnlocked: boolean;
  currentVersion: string | null;
  currentApproved: boolean;
  goLiveBlocker: string | null;
  serversOn: number;
  serversOwnerOff: number;
  liveSessions: number;
  versions: {
    version: string;
    isCurrent: boolean;
    reviewStatus: string;
    reviewedBy: string | null;
    manifest: { name: string; category: string | null };
  }[];
}

describeDb("operator apps routes", () => {
  let ana: Actor;
  let operator: Actor;
  let privateId: string;
  let otherPrivateId: string;
  let communityId: string;
  const frames: { topic: string; data: unknown }[] = [];
  let stopObserving: () => void;

  beforeAll(async () => {
    await initDb();
    setBusTransport(createMemoryTransport(createMemoryHub()));
    stopObserving = observeBusFrames((frame) => {
      if (frame.topic === APPS_BUS_TOPIC) {
        frames.push({ topic: frame.topic, data: frame.data });
      }
    });
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.INSTANCE_MODERATOR_CLERK_IDS;
    delete process.env.ADMIN_METRICS_TOKEN;
    stopObserving();
    setBusTransport(null);
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    process.env.ADMIN_METRICS_TOKEN = TOKEN;
    frames.length = 0;

    const pool = getPool();
    // Cascades to app_publishers and everything under it.
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    await pool.query(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    ana = await upsertUser({ clerkId: "clerk-ana", displayName: "Ana", avatarUrl: null });
    operator = await upsertUser({
      clerkId: "clerk-operator",
      displayName: "Operator",
      avatarUrl: null,
    });
    process.env.INSTANCE_MODERATOR_CLERK_IDS = operator.clerk_id;

    const servers = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id, is_community, is_community_listed)
       VALUES ('Turma do Fundao', $1, FALSE, FALSE),
              ('Sandbox', $1, FALSE, FALSE),
              ('QG', $1, TRUE, FALSE)
       RETURNING id`,
      [ana.id],
    );
    privateId = servers.rows[0]!.id;
    otherPrivateId = servers.rows[1]!.id;
    communityId = servers.rows[2]!.id;
    await pool.query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [privateId, ana.id],
    );

    // Two apps: an emulator app and a plain one, each with one pending version.
    for (const [id, category, name] of [
      ["sala-de-jogos", "emulator", "Sala de jogos"],
      ["quadro", "tool", "Quadro"],
    ] as const) {
      await pool.query(
        `INSERT INTO apps (id, publisher_id, status, current_version)
         VALUES ($1, 'pqp', 'draft', NULL)`,
        [id],
      );
      await pool.query(
        `INSERT INTO app_versions (app_id, version, manifest, manifest_sha256, entry_sha256)
         VALUES ($1, '1.0.0', $2::jsonb, $3, $3)`,
        [id, JSON.stringify(manifest(id, category, name)), SHA],
      );
      await pool.query(`UPDATE apps SET current_version = '1.0.0' WHERE id = $1`, [id]);
    }
  });

  afterEach(() => {
    stubs.actor = null;
  });

  async function listApps() {
    const { status, body } = await asMachine<{
      apps: AppView[];
      serverCount: number;
      liveSessions: number;
      audit: { action: string; actorKind: string; appId: string }[];
    }>("GET", "/api/admin/apps");
    expect(status).toBe(200);
    return body;
  }

  async function appOf(id: string): Promise<AppView> {
    return (await listApps()).apps.find((a) => a.id === id)!;
  }

  async function auditRows() {
    const rows = await getPool().query<{
      actor_kind: string;
      actor_user_id: string | null;
      action: string;
      app_id: string;
      app_version: string | null;
      server_id: string | null;
      before: unknown;
      after: unknown;
    }>(`SELECT * FROM app_admin_audit ORDER BY id ASC`);
    return rows.rows;
  }

  async function approve(appId: string, version = "1.0.0") {
    const response = await asMachine("PUT", "/api/admin/app-review", {
      appId,
      version,
      reviewStatus: "approved",
      checklist: FULL_CHECKLIST,
      note: "ok",
    });
    expect(response.status).toBe(200);
  }

  describe("the allowlist", () => {
    it("names the five routes, with the ids in the body and never in the path", () => {
      for (const [method, path] of [
        ["GET", "/api/admin/apps"],
        ["PUT", "/api/admin/apps"],
        ["PUT", "/api/admin/app-review"],
        ["GET", "/api/admin/app-servers"],
        ["PUT", "/api/admin/server-apps"],
        ["POST", "/api/admin/app-disable-everywhere"],
        ["POST", "/api/admin/app-session-end"],
      ] as const) {
        expect(matchAdminMachineRoute(method, path)).not.toBeNull();
      }
      for (const [method, path] of [
        ["POST", "/api/admin/apps"],
        ["DELETE", "/api/admin/apps"],
        ["PUT", "/api/admin/apps/sala-de-jogos"],
        ["GET", "/api/admin/apps/"],
        ["PUT", "/api/admin/apps/sala-de-jogos/versions/1.0.0/review"],
        ["GET", "/api/admin/server-apps"],
        ["POST", "/api/admin/app-review"],
        ["PUT", "/api/admin/app-disable-everywhere"],
        ["GET", "/api/admin/app-session-end"],
        ["POST", "/api/admin/apps/sala-de-jogos/disable-everywhere"],
        ["POST", "/api/admin/app-sessions/00000000-0000-4000-8000-000000000001/end"],
      ] as const) {
        expect(matchAdminMachineRoute(method, path)).toBeNull();
      }
    });
  });

  describe("who may do this", () => {
    it("a wrong token and a signed-in non-moderator are a 404, and nothing moves", async () => {
      const wrong = await asMachine(
        "PUT",
        "/api/admin/apps",
        { appId: "quadro", communityUnlocked: true },
        WRONG_TOKEN,
      );
      expect(wrong.status).toBe(404);
      const user = await asUser(ana, "PUT", "/api/admin/apps", {
        appId: "quadro",
        communityUnlocked: true,
      });
      expect(user.status).toBe(404);
      const read = await asUser(ana, "GET", "/api/admin/apps");
      expect(read.status).toBe(404);
      const servers = await asUser(ana, "GET", "/api/admin/app-servers?appId=quadro");
      expect(servers.status).toBe(404);
      expect((await appOf("quadro")).communityUnlocked).toBe(false);
      expect(await auditRows()).toHaveLength(0);
    });

    it("an instance moderator works and is the audit actor; the token has no account", async () => {
      const viaSession = await asUser(operator, "PUT", "/api/admin/apps", {
        appId: "quadro",
        communityUnlocked: true,
      });
      expect(viaSession.status).toBe(200);
      const viaToken = await asMachine("PUT", "/api/admin/apps", {
        appId: "sala-de-jogos",
        communityUnlocked: true,
      });
      expect(viaToken.status).toBe(200);
      const rows = await auditRows();
      expect(rows.map((r) => [r.actor_kind, r.actor_user_id])).toEqual([
        ["moderator", operator.id],
        ["dashboard", null],
      ]);
    });

    it("a bad body is a 400, an unknown app a 404", async () => {
      expect(
        (await asMachine("PUT", "/api/admin/apps", { appId: "Quadro!" })).status,
      ).toBe(400);
      expect((await asMachine("PUT", "/api/admin/apps", { appId: "quadro" })).status).toBe(400);
      expect(
        (await asMachine("PUT", "/api/admin/apps", { appId: "nao-existe", status: "review" }))
          .status,
      ).toBe(404);
      expect((await asMachine("GET", "/api/admin/app-servers")).status).toBe(400);
    });
  });

  describe("the list", () => {
    it("is every app, with the pt-BR name, versions, counts and the reason it cannot go live", async () => {
      const list = await listApps();
      expect(list.serverCount).toBe(3);
      expect(list.liveSessions).toBe(0);
      expect(list.apps.map((a) => a.id).sort()).toEqual(["quadro", "sala-de-jogos"]);
      const sala = list.apps.find((a) => a.id === "sala-de-jogos")!;
      expect(sala).toMatchObject({
        name: "Sala de jogos",
        status: "draft",
        globalEnabled: false,
        communityUnlocked: false,
        currentVersion: "1.0.0",
        currentApproved: false,
        goLiveBlocker: "not-reviewed",
        serversOn: 0,
        liveSessions: 0,
      });
      expect(sala.versions).toHaveLength(1);
      expect(sala.versions[0]).toMatchObject({
        version: "1.0.0",
        isCurrent: true,
        reviewStatus: "pending",
        manifest: { name: "Sala de jogos", category: "emulator" },
      });
    });

    it("counts live sessions and operator-on servers, and the owner's switch-offs", async () => {
      await approve("quadro");
      await asMachine("PUT", "/api/admin/server-apps", {
        serverId: privateId,
        appId: "quadro",
        operatorEnabled: true,
      });
      await asMachine("PUT", "/api/admin/server-apps", {
        serverId: otherPrivateId,
        appId: "quadro",
        operatorEnabled: true,
      });
      await getPool().query(
        `UPDATE server_apps SET owner_enabled = FALSE WHERE server_id = $1`,
        [otherPrivateId],
      );
      const channel = await getPool().query<{ id: string }>(
        `INSERT INTO channels (server_id, name, type) VALUES ($1, 'geral', 'text') RETURNING id`,
        [privateId],
      );
      await getPool().query(
        `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version)
         VALUES ($1, $2, 'quadro', '1.0.0')`,
        [privateId, channel.rows[0]!.id],
      );
      const list = await listApps();
      const quadro = list.apps.find((a) => a.id === "quadro")!;
      expect(quadro).toMatchObject({
        serversOn: 2,
        serversOwnerOff: 1,
        liveSessions: 1,
        currentApproved: true,
        goLiveBlocker: null,
      });
      expect(list.liveSessions).toBe(1);
    });

    it("carries the last 20 audit rows, newest first", async () => {
      for (let i = 0; i < 22; i += 1) {
        await asMachine("PUT", "/api/admin/apps", {
          appId: "quadro",
          communityUnlocked: i % 2 === 0,
        });
      }
      const list = await listApps();
      expect(list.audit).toHaveLength(20);
      expect(list.audit[0]).toMatchObject({
        action: "community-unlock",
        actorKind: "dashboard",
        appId: "quadro",
      });
    });
  });

  describe("going live", () => {
    it("is refused with not-reviewed until the current version is approved, and nothing moves", async () => {
      for (const body of [
        { status: "live" },
        { globalEnabled: true },
        { status: "live", globalEnabled: true },
      ]) {
        const response = await asMachine<{ error: string }>("PUT", "/api/admin/apps", {
          appId: "quadro",
          ...body,
        });
        expect(response.status).toBe(409);
        expect(response.body.error).toBe("not-reviewed");
      }
      expect(await appOf("quadro")).toMatchObject({ status: "draft", globalEnabled: false });
      expect(await auditRows()).toHaveLength(0);
      expect(frames).toHaveLength(0);
    });

    it("a rejected or withdrawn version is not approved either", async () => {
      await asMachine("PUT", "/api/admin/app-review", {
        appId: "quadro",
        version: "1.0.0",
        reviewStatus: "rejected",
        checklist: { ...FULL_CHECKLIST, sandbox: false },
      });
      const response = await asMachine("PUT", "/api/admin/apps", {
        appId: "quadro",
        status: "live",
      });
      expect(response.status).toBe(409);
    });

    it("works after approval, with one audit row per field that changed", async () => {
      await approve("quadro");
      const response = await asMachine<{ app: AppView; changed: number }>(
        "PUT",
        "/api/admin/apps",
        { appId: "quadro", status: "live", globalEnabled: true },
      );
      expect(response.status).toBe(200);
      expect(response.body.changed).toBe(2);
      expect(response.body.app).toMatchObject({ status: "live", globalEnabled: true });

      const rows = (await auditRows()).filter((r) => r.action !== "review");
      expect(rows.map((r) => [r.action, r.before, r.after])).toEqual([
        ["status", { status: "draft" }, { status: "live" }],
        ["global", { globalEnabled: false }, { globalEnabled: true }],
      ]);
      expect(rows.every((r) => r.actor_kind === "dashboard" && r.actor_user_id === null)).toBe(true);
    });

    it("a write that changes nothing adds no audit row and sends no hint", async () => {
      await approve("quadro");
      await asMachine("PUT", "/api/admin/apps", { appId: "quadro", status: "live" });
      const rowsBefore = (await auditRows()).length;
      frames.length = 0;
      const again = await asMachine<{ changed: number }>("PUT", "/api/admin/apps", {
        appId: "quadro",
        status: "live",
      });
      expect(again.status).toBe(200);
      expect(again.body.changed).toBe(0);
      expect((await auditRows()).length).toBe(rowsBefore);
      expect(frames).toHaveLength(0);
    });

    it("switching off never needs a review", async () => {
      await approve("quadro");
      await asMachine("PUT", "/api/admin/apps", {
        appId: "quadro",
        status: "live",
        globalEnabled: true,
      });
      const off = await asMachine("PUT", "/api/admin/apps", {
        appId: "quadro",
        status: "retired",
        globalEnabled: false,
      });
      expect(off.status).toBe(200);
      expect(await appOf("quadro")).toMatchObject({ status: "retired", globalEnabled: false });
    });

    it("moving the current version to an unreviewed one is refused on a live app, and rollback works", async () => {
      await approve("quadro");
      await getPool().query(
        `INSERT INTO app_versions (app_id, version, manifest, manifest_sha256, entry_sha256)
         VALUES ('quadro', '1.1.0', $1::jsonb, $2, $2)`,
        [JSON.stringify({ ...manifest("quadro", "tool", "Quadro"), version: "1.1.0" }), SHA],
      );
      await asMachine("PUT", "/api/admin/apps", {
        appId: "quadro",
        status: "live",
        globalEnabled: true,
      });
      const blocked = await asMachine<{ error: string }>("PUT", "/api/admin/apps", {
        appId: "quadro",
        currentVersion: "1.1.0",
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe("not-reviewed");
      expect((await appOf("quadro")).currentVersion).toBe("1.0.0");

      await approve("quadro", "1.1.0");
      const moved = await asMachine("PUT", "/api/admin/apps", {
        appId: "quadro",
        currentVersion: "1.1.0",
      });
      expect(moved.status).toBe(200);
      const back = await asMachine("PUT", "/api/admin/apps", {
        appId: "quadro",
        currentVersion: "1.0.0",
      });
      expect(back.status).toBe(200);
      expect((await appOf("quadro")).currentVersion).toBe("1.0.0");
      const missing = await asMachine("PUT", "/api/admin/apps", {
        appId: "quadro",
        currentVersion: "9.9.9",
      });
      expect(missing.status).toBe(404);
      const rows = (await auditRows()).filter((r) => r.action === "current-version");
      expect(rows.map((r) => r.app_version)).toEqual(["1.1.0", "1.0.0"]);
    });

    it("sends one apps.changed hint per committed write", async () => {
      await approve("quadro");
      frames.length = 0;
      await asMachine("PUT", "/api/admin/apps", { appId: "quadro", status: "live" });
      expect(frames).toEqual([
        { topic: APPS_BUS_TOPIC, data: { appId: "quadro", serverId: null } },
      ]);
    });
  });

  describe("the review", () => {
    it("records reviewer, checklist and note, and an approval needs every line", async () => {
      const incomplete = await asMachine<{ error: string }>("PUT", "/api/admin/app-review", {
        appId: "quadro",
        version: "1.0.0",
        reviewStatus: "approved",
        checklist: { ...FULL_CHECKLIST, noNetwork: false },
      });
      expect(incomplete.status).toBe(409);
      expect(incomplete.body.error).toBe("checklist-incomplete");
      expect((await appOf("quadro")).versions[0]!.reviewStatus).toBe("pending");

      const ok = await asMachine<{ app: AppView }>("PUT", "/api/admin/app-review", {
        appId: "quadro",
        version: "1.0.0",
        reviewStatus: "approved",
        checklist: { sandbox: true, noNetwork: true, license: true, i18n: true, presence: true },
        note: "Revisado a mao.",
      });
      expect(ok.status).toBe(200);
      expect(ok.body.app.versions[0]).toMatchObject({
        reviewStatus: "approved",
        reviewedBy: "dashboard",
      });
      const row = await getPool().query<{ review_note: string; reviewed_at: Date | null }>(
        `SELECT review_note, reviewed_at FROM app_versions WHERE app_id = 'quadro'`,
      );
      expect(row.rows[0]!.review_note).toBe("Revisado a mao.");
      expect(row.rows[0]!.reviewed_at).not.toBeNull();
      const audit = (await auditRows()).filter((r) => r.action === "review");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ app_id: "quadro", app_version: "1.0.0" });
    });

    it("an emulator app also needs the ROM policy line", async () => {
      const { romPolicy: _omit, ...withoutRom } = FULL_CHECKLIST;
      void _omit;
      const refused = await asMachine("PUT", "/api/admin/app-review", {
        appId: "sala-de-jogos",
        version: "1.0.0",
        reviewStatus: "approved",
        checklist: withoutRom,
      });
      expect(refused.status).toBe(409);
      const ok = await asMachine("PUT", "/api/admin/app-review", {
        appId: "sala-de-jogos",
        version: "1.0.0",
        reviewStatus: "approved",
        checklist: FULL_CHECKLIST,
      });
      expect(ok.status).toBe(200);
    });

    it("a moderator's review names them; rejecting needs no complete checklist", async () => {
      const rejected = await asUser<{ app: AppView }>(operator, "PUT", "/api/admin/app-review", {
        appId: "quadro",
        version: "1.0.0",
        reviewStatus: "rejected",
        checklist: { sandbox: false, noNetwork: true, license: true, i18n: true, presence: false },
        note: "Falta a caixa isolada.",
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body.app.versions[0]!.reviewedBy).toBe(`moderator:${operator.id}`);
    });

    it("cannot take the approval from the version a live app stands on", async () => {
      await approve("quadro");
      await asMachine("PUT", "/api/admin/apps", { appId: "quadro", status: "live" });
      const response = await asMachine<{ error: string }>("PUT", "/api/admin/app-review", {
        appId: "quadro",
        version: "1.0.0",
        reviewStatus: "withdrawn",
        checklist: FULL_CHECKLIST,
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe("version-in-use");
      expect((await appOf("quadro")).versions[0]!.reviewStatus).toBe("approved");
    });

    it("an unknown version is a 404", async () => {
      const response = await asMachine("PUT", "/api/admin/app-review", {
        appId: "quadro",
        version: "2.0.0",
        reviewStatus: "rejected",
        checklist: FULL_CHECKLIST,
      });
      expect(response.status).toBe(404);
    });
  });

  describe("per server switches", () => {
    async function operatorSwitch(serverId: string, appId: string, value: boolean | null) {
      return asMachine<{ error?: string; changed?: boolean; operatorEnabled?: boolean | null }>(
        "PUT",
        "/api/admin/server-apps",
        { serverId, appId, operatorEnabled: value },
      );
    }

    it("turns an app on and off for one server, audited, and null is undecided", async () => {
      const on = await operatorSwitch(privateId, "quadro", true);
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject({ operatorEnabled: true, changed: true });
      const same = await operatorSwitch(privateId, "quadro", true);
      expect(same.body.changed).toBe(false);
      await operatorSwitch(privateId, "quadro", false);
      await operatorSwitch(privateId, "quadro", null);
      const row = await getPool().query<{ operator_enabled: boolean | null }>(
        `SELECT operator_enabled FROM server_apps WHERE server_id = $1 AND app_id = 'quadro'`,
        [privateId],
      );
      expect(row.rows[0]!.operator_enabled).toBeNull();

      const rows = await auditRows();
      expect(rows.map((r) => [r.action, r.server_id, r.before, r.after])).toEqual([
        ["operator-server", privateId, { operatorEnabled: null }, { operatorEnabled: true }],
        ["operator-server", privateId, { operatorEnabled: true }, { operatorEnabled: false }],
        ["operator-server", privateId, { operatorEnabled: false }, { operatorEnabled: null }],
      ]);
      expect(frames.filter((f) => (f.data as { serverId: string | null }).serverId === privateId)).toHaveLength(3);
    });

    it("a null on a server that never had a row writes nothing", async () => {
      const response = await operatorSwitch(privateId, "quadro", null);
      expect(response.body.changed).toBe(false);
      expect(await auditRows()).toHaveLength(0);
    });

    it("keeps the owner's switch when the operator moves theirs", async () => {
      await operatorSwitch(privateId, "quadro", true);
      await getPool().query(
        `UPDATE server_apps SET owner_enabled = FALSE WHERE server_id = $1`,
        [privateId],
      );
      await operatorSwitch(privateId, "quadro", false);
      const row = await getPool().query<{ owner_enabled: boolean | null }>(
        `SELECT owner_enabled FROM server_apps WHERE server_id = $1`,
        [privateId],
      );
      expect(row.rows[0]!.owner_enabled).toBe(false);
    });

    it("a public community is locked until the app is unlocked for communities", async () => {
      const locked = await operatorSwitch(communityId, "quadro", true);
      expect(locked.status).toBe(409);
      expect(locked.body.error).toBe("community-locked");
      const none = await getPool().query(`SELECT 1 FROM server_apps WHERE server_id = $1`, [
        communityId,
      ]);
      expect(none.rowCount).toBe(0);
      expect(await auditRows()).toHaveLength(0);

      await asMachine("PUT", "/api/admin/apps", { appId: "quadro", communityUnlocked: true });
      const open = await operatorSwitch(communityId, "quadro", true);
      expect(open.status).toBe(200);

      // Unlocked for one app is not unlocked for the other.
      const other = await operatorSwitch(communityId, "sala-de-jogos", true);
      expect(other.status).toBe(409);
    });

    it("turning a community OFF is never refused, even when the app is locked", async () => {
      await asMachine("PUT", "/api/admin/apps", { appId: "quadro", communityUnlocked: true });
      await operatorSwitch(communityId, "quadro", true);
      await asMachine("PUT", "/api/admin/apps", { appId: "quadro", communityUnlocked: false });
      const off = await operatorSwitch(communityId, "quadro", false);
      expect(off.status).toBe(200);
    });

    it("an unknown server or app is a 404", async () => {
      expect(
        (await operatorSwitch("00000000-0000-4000-8000-000000000001", "quadro", true)).status,
      ).toBe(404);
      expect((await operatorSwitch(privateId, "nao-existe", true)).status).toBe(404);
    });
  });

  describe("an app's servers", () => {
    interface ServerList {
      servers: {
        id: string;
        name: string;
        memberCount: number;
        isCommunity: boolean;
        operatorEnabled: boolean | null;
        ownerEnabled: boolean | null;
        locked: boolean;
      }[];
      matched: number;
      enabledCount: number;
      limit: number;
      offset: number;
    }

    async function servers(query: string) {
      const response = await asMachine<ServerList>(
        "GET",
        `/api/admin/app-servers?appId=quadro${query}`,
      );
      expect(response.status).toBe(200);
      return response.body;
    }

    it("lists every server with its switches, the community locked, switched-on first", async () => {
      await asMachine("PUT", "/api/admin/server-apps", {
        serverId: otherPrivateId,
        appId: "quadro",
        operatorEnabled: true,
      });
      const body = await servers("");
      expect(body.matched).toBe(3);
      expect(body.enabledCount).toBe(1);
      expect(body.servers[0]).toMatchObject({
        id: otherPrivateId,
        operatorEnabled: true,
        locked: false,
      });
      const community = body.servers.find((s) => s.id === communityId)!;
      expect(community).toMatchObject({ isCommunity: true, locked: true, operatorEnabled: null });
      const turma = body.servers.find((s) => s.id === privateId)!;
      expect(turma.memberCount).toBe(1);
    });

    it("searches by name or by id, filters to the ones on, and pages", async () => {
      await asMachine("PUT", "/api/admin/server-apps", {
        serverId: otherPrivateId,
        appId: "quadro",
        operatorEnabled: true,
      });
      expect((await servers("&q=sand")).servers.map((s) => s.name)).toEqual(["Sandbox"]);
      expect((await servers(`&q=${privateId}`)).servers.map((s) => s.id)).toEqual([privateId]);
      expect((await servers("&q=%25")).matched).toBe(0);
      const on = await servers("&on=1");
      expect(on.servers.map((s) => s.id)).toEqual([otherPrivateId]);
      expect(on.matched).toBe(1);
      const page1 = await servers("&limit=2&offset=0");
      const page2 = await servers("&limit=2&offset=2");
      expect(page1.servers).toHaveLength(2);
      expect(page2.servers).toHaveLength(1);
      expect(page1.matched).toBe(3);
      expect(new Set([...page1.servers, ...page2.servers].map((s) => s.id)).size).toBe(3);
    });

    it("an unlocked app shows the community as switchable", async () => {
      await asMachine("PUT", "/api/admin/apps", { appId: "quadro", communityUnlocked: true });
      const body = await servers("");
      expect(body.servers.find((s) => s.id === communityId)!.locked).toBe(false);
    });

    it("an unknown app is a 404", async () => {
      const response = await asMachine("GET", "/api/admin/app-servers?appId=nao-existe");
      expect(response.status).toBe(404);
    });
  });

  describe("ending sessions", () => {
    let channelSeq = 0;

    /** A live session of `appId` in a fresh channel of `serverId`. */
    async function liveSession(serverId: string, appId: string, hostId?: string): Promise<string> {
      channelSeq += 1;
      const channel = await getPool().query<{ id: string }>(
        `INSERT INTO channels (server_id, name, type) VALUES ($1, $2, 'text') RETURNING id`,
        [serverId, `sala${channelSeq}`],
      );
      const session = await getPool().query<{ id: string }>(
        `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version, host_user_id)
         VALUES ($1, $2, $3, '1.0.0', $4) RETURNING id`,
        [serverId, channel.rows[0]!.id, appId, hostId ?? null],
      );
      return session.rows[0]!.id;
    }

    async function sessionRow(id: string) {
      const rows = await getPool().query<{
        status: string;
        end_reason: string | null;
        ended_by: string | null;
        state: unknown;
      }>(`SELECT status, end_reason, ended_by, state FROM app_sessions WHERE id = $1`, [id]);
      return rows.rows[0]!;
    }

    async function goLive(appId: string) {
      await approve(appId);
      await asMachine("PUT", "/api/admin/apps", { appId, status: "live", globalEnabled: true });
    }

    it("Desligar em todos turns the master off and ends every live session of THAT app only", async () => {
      await goLive("quadro");
      await goLive("sala-de-jogos");
      const a = await liveSession(privateId, "quadro");
      const b = await liveSession(otherPrivateId, "quadro");
      const other = await liveSession(privateId, "sala-de-jogos");
      await asMachine("PUT", "/api/admin/server-apps", { serverId: privateId, appId: "quadro", operatorEnabled: true });

      const response = await asMachine<{ sessionsEnded: number; app: AppView }>(
        "POST",
        "/api/admin/app-disable-everywhere",
        { appId: "quadro" },
      );
      expect(response.status).toBe(200);
      expect(response.body.sessionsEnded).toBe(2);
      expect(response.body.app).toMatchObject({ globalEnabled: false, status: "live", liveSessions: 0 });

      for (const id of [a, b]) {
        expect(await sessionRow(id)).toMatchObject({ status: "ended", end_reason: "app-disabled", ended_by: null, state: {} });
      }
      expect((await sessionRow(other)).status).toBe("live");
      // The per server switches stay as they were: the master back on brings the same servers back.
      const server = await getPool().query<{ operator_enabled: boolean }>(
        `SELECT operator_enabled FROM server_apps WHERE server_id = $1 AND app_id = 'quadro'`,
        [privateId],
      );
      expect(server.rows[0]!.operator_enabled).toBe(true);

      const audit = (await auditRows()).filter((r) => r.action === "disable-everywhere");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_kind: "dashboard",
        actor_user_id: null,
        app_id: "quadro",
        before: { globalEnabled: true, serversOn: 1 },
        after: { globalEnabled: false },
      });
      const counted = await getPool().query<{ sessions_ended: number }>(
        `SELECT sessions_ended FROM app_admin_audit WHERE action = 'disable-everywhere'`,
      );
      expect(counted.rows[0]!.sessions_ended).toBe(2);
      expect(frames.at(-1)).toEqual({ topic: APPS_BUS_TOPIC, data: { appId: "quadro", serverId: null } });
    });

    it("is audited and safe to repeat: the second call ends nothing and says 0", async () => {
      await goLive("quadro");
      await liveSession(privateId, "quadro");
      await asMachine("POST", "/api/admin/app-disable-everywhere", { appId: "quadro" });
      const again = await asMachine<{ sessionsEnded: number }>("POST", "/api/admin/app-disable-everywhere", {
        appId: "quadro",
      });
      expect(again.status).toBe(200);
      expect(again.body.sessionsEnded).toBe(0);
      const counts = await getPool().query<{ sessions_ended: number }>(
        `SELECT sessions_ended FROM app_admin_audit WHERE action = 'disable-everywhere' ORDER BY id`,
      );
      expect(counts.rows.map((r) => r.sessions_ended)).toEqual([1, 0]);
    });

    it("works with no session, an app already off, an unknown app (404) and a bad body (400)", async () => {
      const off = await asMachine<{ sessionsEnded: number }>("POST", "/api/admin/app-disable-everywhere", { appId: "quadro" });
      expect(off.status).toBe(200);
      expect(off.body.sessionsEnded).toBe(0);
      expect((await asMachine("POST", "/api/admin/app-disable-everywhere", { appId: "nao-existe" })).status).toBe(404);
      expect((await asMachine("POST", "/api/admin/app-disable-everywhere", {})).status).toBe(400);
    });

    it("a moderator does it as themselves, a non-moderator and a wrong token get the 404", async () => {
      await goLive("quadro");
      const id = await liveSession(privateId, "quadro");
      expect((await asUser(ana, "POST", "/api/admin/app-disable-everywhere", { appId: "quadro" })).status).toBe(404);
      expect(
        (await asMachine("POST", "/api/admin/app-disable-everywhere", { appId: "quadro" }, WRONG_TOKEN)).status,
      ).toBe(404);
      expect((await sessionRow(id)).status).toBe("live");

      const done = await asUser<{ sessionsEnded: number }>(operator, "POST", "/api/admin/app-disable-everywhere", {
        appId: "quadro",
      });
      expect(done.status).toBe(200);
      expect(done.body.sessionsEnded).toBe(1);
      expect(await sessionRow(id)).toMatchObject({ end_reason: "app-disabled", ended_by: operator.id });
      const audit = (await auditRows()).filter((r) => r.action === "disable-everywhere");
      expect(audit[0]).toMatchObject({ actor_kind: "moderator", actor_user_id: operator.id });
    });

    it("the operator ends one session with the reason operator, and again is a no-op", async () => {
      const id = await liveSession(privateId, "quadro", ana.id);
      const response = await asMachine<{ ended: boolean; appId: string; serverId: string }>(
        "POST",
        "/api/admin/app-session-end",
        { sessionId: id },
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ended: true, appId: "quadro", serverId: privateId });
      expect(await sessionRow(id)).toMatchObject({ status: "ended", end_reason: "operator", ended_by: null, state: {} });

      const again = await asUser<{ ended: boolean }>(operator, "POST", "/api/admin/app-session-end", { sessionId: id });
      expect(again.status).toBe(200);
      expect(again.body.ended).toBe(false);
      expect((await sessionRow(id)).ended_by).toBeNull();
    });

    it("ending one session never touches the apps flag or another session, and needs a real id", async () => {
      const a = await liveSession(privateId, "quadro");
      const b = await liveSession(otherPrivateId, "quadro");
      // The `apps` flag is off everywhere in this suite; an operator still ends it.
      expect((await asMachine("POST", "/api/admin/app-session-end", { sessionId: a })).status).toBe(200);
      expect((await sessionRow(b)).status).toBe("live");
      expect((await asMachine("POST", "/api/admin/app-session-end", { sessionId: "00000000-0000-4000-8000-000000000001" })).status).toBe(404);
      expect((await asMachine("POST", "/api/admin/app-session-end", { sessionId: "nope" })).status).toBe(400);
      expect((await asUser(ana, "POST", "/api/admin/app-session-end", { sessionId: b })).status).toBe(404);
      expect((await sessionRow(b)).status).toBe("live");
    });

    it("taking the app away from one server ends that server's sessions and records the count on its audit row", async () => {
      await goLive("quadro");
      for (const serverId of [privateId, otherPrivateId]) {
        await asMachine("PUT", "/api/admin/server-apps", { serverId, appId: "quadro", operatorEnabled: true });
      }
      const here = await liveSession(privateId, "quadro");
      const there = await liveSession(otherPrivateId, "quadro");

      const off = await asMachine<{ sessionsEnded: number; changed: boolean }>("PUT", "/api/admin/server-apps", {
        serverId: privateId,
        appId: "quadro",
        operatorEnabled: false,
      });
      expect(off.body).toMatchObject({ changed: true, sessionsEnded: 1 });
      expect(await sessionRow(here)).toMatchObject({ status: "ended", end_reason: "app-disabled" });
      expect((await sessionRow(there)).status).toBe("live");
      const audit = await getPool().query<{ sessions_ended: number }>(
        `SELECT sessions_ended FROM app_admin_audit WHERE action = 'operator-server' AND after = '{"operatorEnabled": false}'::jsonb`,
      );
      expect(audit.rows.map((r) => r.sessions_ended)).toEqual([1]);

      // Turning it ON, or a repeat of off, ends nothing.
      const live2 = await liveSession(privateId, "quadro");
      await asMachine("PUT", "/api/admin/server-apps", { serverId: privateId, appId: "quadro", operatorEnabled: false });
      expect((await sessionRow(live2)).status).toBe("live");
    });
  });

  describe("the empty catalog", () => {
    it("is an empty list, which is a self-host", async () => {
      await getPool().query(`DELETE FROM apps`);
      const list = await listApps();
      expect(list.apps).toEqual([]);
      expect(list.liveSessions).toBe(0);
    });
  });

  describe("the sibling hint", () => {
    it("reaches a handler on another instance and ignores garbage", async () => {
      const seen: unknown[] = [];
      onAppsChanged((hint, origin) => seen.push([hint, origin]));
      const hub = createMemoryHub();
      const sibling = createMemoryTransport(hub);
      setBusTransport(createMemoryTransport(hub));
      sibling.publish({
        origin: "another-instance",
        topic: APPS_BUS_TOPIC,
        data: { appId: "quadro", serverId: privateId },
      });
      sibling.publish({ origin: "another-instance", topic: APPS_BUS_TOPIC, data: "nope" });
      sibling.publish({
        origin: "another-instance",
        topic: APPS_BUS_TOPIC,
        data: { appId: "quadro" },
      });
      expect(seen).toEqual([
        [{ appId: "quadro", serverId: privateId }, "another-instance"],
        [{ appId: "quadro", serverId: null }, "another-instance"],
      ]);
    });
  });
});
