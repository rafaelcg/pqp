import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appsConfigSchema, Permission } from "@pqp/shared";
import { testCatalogEntry, testManifest } from "./testing.js";
import { appsOrigin } from "./origin.js";

/**
 * `GET /api/apps/config?serverId=`: flag off, flag on, the community lock, the
 * emulator gate, what the answer carries and what it never does. The route is
 * exercised through the real router the way `handleApi` reaches it, and the
 * response is parsed with the schema the client will use. Scratch database only
 * (`TEST_DATABASE_URL`).
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.APPS;
process.env.APPS_ORIGIN = "https://apps.example.test/";

const { getPool, initDb, closePool } = await import("../db.js");
const flags = await import("../lib/flags.js");
const { loadAppCatalog } = await import("./catalog.js");
const { createRouter } = await import("../lib/router.js");
const { registerAppRoutes } = await import("../api/app-routes.js");
const { HttpError } = await import("../lib/http.js");
const { upsertUser } = await import("../services/users.js");
const { createServer } = await import("../services/servers.js");

const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => getPool().query<T>(text, values);

describe("appsOrigin", () => {
  it("accepts a bare http(s) origin and drops the trailing slash", () => {
    expect(appsOrigin({ APPS_ORIGIN: "https://pqp-apps.pages.dev" } as NodeJS.ProcessEnv)).toBe(
      "https://pqp-apps.pages.dev",
    );
    expect(appsOrigin({ APPS_ORIGIN: " http://localhost:5175/ " } as NodeJS.ProcessEnv)).toBe(
      "http://localhost:5175",
    );
  });

  it("treats anything else as unset", () => {
    for (const bad of [
      "",
      "   ",
      "pqp-apps.pages.dev",
      "ftp://apps.example",
      "javascript:alert(1)",
      "https://user:pw@apps.example",
      "https://apps.example/base",
      "https://apps.example/?x=1",
      "https://apps.example/#frag",
    ]) {
      expect(appsOrigin({ APPS_ORIGIN: bad } as NodeJS.ProcessEnv), bad).toBeNull();
    }
    expect(appsOrigin({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describeDb("GET /api/apps/config", () => {
  const router = createRouter();
  registerAppRoutes(router);

  let owner: Awaited<ReturnType<typeof upsertUser>>;
  let outsider: Awaited<ReturnType<typeof upsertUser>>;
  let serverId: string;

  async function ask(user: typeof owner, serverIdParam: string | null) {
    const url = new URL("http://localhost/api/apps/config");
    if (serverIdParam !== null) {
      url.searchParams.set("serverId", serverIdParam);
    }
    const route = router.match("GET", url.pathname);
    expect(route, "the route is mounted").not.toBeNull();
    const body = await route!.handler({ url, user } as never, route!.params);
    return appsConfigSchema.parse(JSON.parse(JSON.stringify(body)));
  }

  async function publish(
    manifest = testManifest({
      assets: [{ name: "core", path: "core/core.wasm", sha256: "d".repeat(64), bytes: 1234 }],
      notice: "Plays in your browser.",
    }),
    release = true,
  ) {
    await loadAppCatalog({ entries: [testCatalogEntry(manifest)], dev: false });
    await q(`UPDATE apps SET status = 'live', global_enabled = TRUE WHERE id = $1`, [manifest.id]);
    if (release) {
      await q(
        `INSERT INTO server_apps (server_id, app_id, operator_enabled) VALUES ($1, $2, TRUE)
         ON CONFLICT (server_id, app_id) DO UPDATE SET operator_enabled = TRUE`,
        [serverId, manifest.id],
      );
    }
    return manifest;
  }

  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await q(`TRUNCATE app_admin_audit, app_sessions, app_session_participants, server_apps,
                      app_versions, apps, feature_flags, feature_flag_overrides
                      RESTART IDENTITY CASCADE`);
    await q(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    owner = await upsertUser({
      clerkId: `clerk_cfg_o_${Date.now()}_${Math.random()}`,
      displayName: "Owner",
      avatarUrl: null,
    });
    outsider = await upsertUser({
      clerkId: `clerk_cfg_x_${Date.now()}_${Math.random()}`,
      displayName: "Outsider",
      avatarUrl: null,
    });
    serverId = (await createServer("Hall", owner.id)).server.id;
    flags.resetFeatureFlagsForTests();
    await flags.startFeatureFlags();
  });

  afterEach(() => {
    process.env.APPS_ORIGIN = "https://apps.example.test/";
  });

  afterAll(async () => {
    flags.resetFeatureFlagsForTests();
    await closePool();
  });

  const disabled = { enabled: false, origin: null, apps: [] };

  it("flag off: the quiet disabled answer, whatever the catalog holds", async () => {
    await publish();
    expect(await ask(owner, serverId)).toEqual(disabled);
  });

  it("no serverId, or one that is not a uuid: the disabled answer", async () => {
    await publish();
    await flags.setServerFlagOverride("apps", serverId, true, { kind: "dashboard" });
    expect(await ask(owner, null)).toEqual(disabled);
    expect(await ask(owner, "not-a-uuid")).toEqual(disabled);
  });

  it("a server the caller is not in is a 404, flag or no flag", async () => {
    await publish();
    for (const on of [false, true]) {
      await flags.setServerFlagOverride("apps", serverId, on, { kind: "dashboard" });
      await expect(ask(outsider, serverId)).rejects.toMatchObject({ status: 404 });
    }
    await expect(ask(outsider, serverId)).rejects.toBeInstanceOf(HttpError);
  });

  it("flag on: lists the live app with its URLs, only the i18n keys a client draws, and the verdict", async () => {
    const manifest = await publish();
    await flags.setServerFlagOverride("apps", serverId, true, { kind: "dashboard" });
    const config = await ask(owner, serverId);

    expect(config.enabled).toBe(true);
    expect(config.origin).toBe("https://apps.example.test");
    expect(config.apps).toHaveLength(1);
    const [app] = config.apps;
    expect(app).toMatchObject({
      id: "pqp-eco",
      version: "1.0.0",
      category: "tool",
      icon: "sparkles",
      hostBound: false,
      available: true,
      reason: null,
      shareAllowed: true,
      name: "name",
      description: "description",
      notice: "notice",
      presence: { phrase: "presence.phrase", short: "presence.short" },
      channelTypes: ["text", "voice"],
      players: { min: 1, max: 8, spectators: true },
    });
    expect(app!.entry.url).toBe("https://apps.example.test/pqp-eco/1.0.0/index.html");
    expect(app!.assets).toEqual([
      {
        name: "core",
        url: "https://apps.example.test/pqp-eco/1.0.0/core/core.wasm",
        sha256: "d".repeat(64),
        bytes: 1234,
      },
    ]);
    for (const locale of ["pt-BR", "en", "es"]) {
      expect(Object.keys(app!.i18n[locale]!).sort()).toEqual(
        ["description", "name", "notice", "presence.phrase", "presence.short"].sort(),
      );
    }
    expect(app!.i18n["pt-BR"]!["presence.phrase"]).toBe("{name} tá no Eco");
    // Nothing a client has no use for, and no hash of the bundle's entry.
    const text = JSON.stringify(config);
    expect(text).not.toContain(manifest.entry.sha256);
    expect(text).not.toContain("license");
  });

  it("lists the live app with its reason when the operator has not released it here", async () => {
    await publish(undefined, false);
    await flags.setServerFlagOverride("apps", serverId, true, { kind: "dashboard" });
    const [app] = (await ask(owner, serverId)).apps;
    expect(app).toMatchObject({ available: false, reason: "not-allowed-here" });
  });

  it("never lists a draft, a review or a retired app", async () => {
    const manifest = await publish();
    await flags.setServerFlagOverride("apps", serverId, true, { kind: "dashboard" });
    for (const status of ["draft", "review", "retired"]) {
      await q(`UPDATE apps SET status = $2 WHERE id = $1`, [manifest.id, status]);
      expect((await ask(owner, serverId)).apps, status).toEqual([]);
    }
  });

  it("community lock: a public community sees the app locked until the app is unlocked", async () => {
    const manifest = await publish();
    await flags.setServerFlagOverride("apps", serverId, true, { kind: "dashboard" });
    await q(`UPDATE servers SET is_community = TRUE WHERE id = $1`, [serverId]);
    expect((await ask(owner, serverId)).apps[0]).toMatchObject({
      available: false,
      reason: "community-locked",
    });
    await q(`UPDATE apps SET community_unlocked = TRUE WHERE id = $1`, [manifest.id]);
    expect((await ask(owner, serverId)).apps[0]).toMatchObject({ available: true, reason: null });
  });

  it("emulator gate: an emulator app is unavailable without emulator_room and shareAllowed follows locadora_share", async () => {
    await publish(testManifest({ id: "pqp-retro", category: "emulator", channelTypes: ["voice"] }));
    await flags.setServerFlagOverride("apps", serverId, true, { kind: "dashboard" });
    expect((await ask(owner, serverId)).apps[0]).toMatchObject({
      category: "emulator",
      available: false,
      reason: "emulator-off",
      shareAllowed: false,
    });
    await flags.setServerFlagOverride("locadora_share", serverId, true, { kind: "dashboard" });
    expect((await ask(owner, serverId)).apps[0]).toMatchObject({ shareAllowed: true });
  });

  it("no apps origin: enabled, origin null, every app no-origin and without a URL", async () => {
    await publish();
    await flags.setServerFlagOverride("apps", serverId, true, { kind: "dashboard" });
    delete process.env.APPS_ORIGIN;
    const config = await ask(owner, serverId);
    expect(config).toMatchObject({ enabled: true, origin: null });
    expect(config.apps[0]).toMatchObject({
      available: false,
      reason: "no-origin",
      entry: { url: null },
    });
  });

  it("is a member read: a member without USE_APPS still gets the list", async () => {
    await publish();
    await flags.setServerFlagOverride("apps", serverId, true, { kind: "dashboard" });
    const member = await upsertUser({
      clerkId: `clerk_cfg_m_${Date.now()}_${Math.random()}`,
      displayName: "Member",
      avatarUrl: null,
    });
    await q(`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`, [
      serverId,
      member.id,
    ]);
    await q(
      `UPDATE roles SET permissions = permissions & ~($2::bigint) WHERE server_id = $1 AND is_everyone`,
      [serverId, Permission.USE_APPS.toString()],
    );
    expect((await ask(member, serverId)).apps).toHaveLength(1);
  });
});
