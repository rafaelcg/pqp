import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compareSemver } from "./catalog.js";
import { testCatalogEntry, testManifest } from "./testing.js";

/**
 * The catalog loader against a real Postgres: insert-only, a changed hash is
 * refused, existing rows are never touched, and the dev convenience exists in
 * development and nowhere else. Scratch database only (`TEST_DATABASE_URL`).
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { loadAppCatalog, enableDevAppsForServer, devAppsConvenienceEnabled } = await import(
  "./catalog.js"
);
const { upsertUser } = await import("../services/users.js");
const { createServer } = await import("../services/servers.js");

const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => getPool().query<T>(text, values);

describe("compareSemver", () => {
  it("orders core versions and puts a prerelease before its release", () => {
    const sorted = ["1.10.0", "1.2.0", "1.2.0-rc.1", "1.2.0-beta.11", "1.2.0-beta.2", "0.9.9"].sort(
      compareSemver,
    );
    expect(sorted).toEqual(["0.9.9", "1.2.0-beta.2", "1.2.0-beta.11", "1.2.0-rc.1", "1.2.0", "1.10.0"]);
  });
});

describeDb("the app catalog loader", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await q(`TRUNCATE app_admin_audit, app_sessions, app_session_participants, server_apps,
                      app_versions, apps RESTART IDENTITY CASCADE`);
    await q(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    await q(`DELETE FROM app_publishers WHERE id <> 'pqp'`);
    await q(`UPDATE app_publishers SET suspended_at = NULL`);
  });

  afterAll(async () => {
    await closePool();
  });

  const apps = async () => (await q(`SELECT * FROM apps ORDER BY id`)).rows;
  const versions = async () =>
    (await q(`SELECT * FROM app_versions ORDER BY app_id, version`)).rows;
  const audit = async () =>
    (await q(`SELECT * FROM app_admin_audit ORDER BY id`)).rows;

  it("inserts a new app as a draft, off everywhere, and its version as pending review", async () => {
    const entry = testCatalogEntry(testManifest());
    const result = await loadAppCatalog({ entries: [entry], dev: false });

    expect(result).toMatchObject({ appsInserted: 1, versionsInserted: 1, currentVersionsSet: 1 });
    expect(result.refused).toEqual([]);
    const [app] = await apps();
    expect(app).toMatchObject({
      id: "pqp-eco",
      publisher_id: "pqp",
      status: "draft",
      global_enabled: false,
      community_unlocked: false,
      current_version: "1.0.0",
    });
    const [version] = await versions();
    expect(version).toMatchObject({
      app_id: "pqp-eco",
      version: "1.0.0",
      review_status: "pending",
      source: "repo",
      manifest_sha256: entry.manifestSha256,
    });
    expect((version!.manifest as { id: string }).id).toBe("pqp-eco");
    expect((await q(`SELECT 1 FROM server_apps`)).rowCount).toBe(0);
  });

  it("writes one catalog-load audit row per insert, and none the second time", async () => {
    const entry = testCatalogEntry(testManifest());
    await loadAppCatalog({ entries: [entry], dev: false });
    const first = await audit();
    expect(first).toHaveLength(2);
    expect(first.map((row) => [row.action, row.actor_kind, row.app_id, row.app_version])).toEqual([
      ["catalog-load", "boot", "pqp-eco", null],
      ["catalog-load", "boot", "pqp-eco", "1.0.0"],
    ]);

    const again = await loadAppCatalog({ entries: [entry], dev: false });
    expect(again).toMatchObject({ appsInserted: 0, versionsInserted: 0, currentVersionsSet: 0 });
    expect(await audit()).toHaveLength(2);
  });

  it("refuses a known version whose hash changed, loudly, and writes nothing", async () => {
    const original = testCatalogEntry(testManifest());
    await loadAppCatalog({ entries: [original], dev: false });
    const changed = {
      manifest: testManifest({ players: { max: 4 } }),
      manifestSha256: "b".repeat(64),
    };
    const errors: string[] = [];
    const spy = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const result = await loadAppCatalog({ entries: [changed], dev: false });
      expect(result.refused).toEqual([
        { appId: "pqp-eco", version: "1.0.0", reason: "hash-changed" },
      ]);
    } finally {
      console.error = spy;
    }
    expect(errors.join("\n")).toContain("hash-changed");
    const [version] = await versions();
    expect(version!.manifest_sha256).toBe(original.manifestSha256);
    expect((version!.manifest as { players: { max: number } }).players.max).toBe(8);
  });

  it("never touches the status, switches, review or current version of an existing app", async () => {
    await loadAppCatalog({ entries: [testCatalogEntry(testManifest())], dev: false });
    await q(
      `UPDATE apps SET status = 'live', global_enabled = TRUE, community_unlocked = TRUE
        WHERE id = 'pqp-eco'`,
    );
    await q(
      `UPDATE app_versions SET review_status = 'approved', reviewed_by = 'rafael', review_note = 'ok'
        WHERE app_id = 'pqp-eco'`,
    );
    const before = { apps: await apps(), versions: await versions() };

    // A newer version arrives: it is inserted pending, and nothing else moves.
    const next = testCatalogEntry(testManifest({ version: "1.1.0" }));
    const result = await loadAppCatalog({
      entries: [testCatalogEntry(testManifest()), next],
      dev: false,
    });
    expect(result).toMatchObject({ appsInserted: 0, versionsInserted: 1, currentVersionsSet: 0 });

    const app = (await apps())[0]!;
    expect(app).toMatchObject({
      status: "live",
      global_enabled: true,
      community_unlocked: true,
      current_version: "1.0.0",
    });
    const rows = await versions();
    expect(rows[0]).toEqual(before.versions[0]);
    expect(rows[1]).toMatchObject({
      version: "1.1.0",
      review_status: "pending",
      reviewed_by: null,
    });
    expect(app!.updated_at).toEqual(before.apps[0]!.updated_at);
  });

  it("gives an app with no current version the newest version a load inserted", async () => {
    await loadAppCatalog({
      entries: [
        testCatalogEntry(testManifest({ version: "1.2.0" })),
        testCatalogEntry(testManifest({ version: "1.10.0" })),
        testCatalogEntry(testManifest({ version: "1.9.0" })),
      ],
      dev: false,
    });
    expect((await apps())[0]!.current_version).toBe("1.10.0");
    expect(await versions()).toHaveLength(3);
  });

  it("refuses an unknown or suspended publisher, an invalid manifest and a malformed entry", async () => {
    const stranger = testCatalogEntry(testManifest({ id: "stranger-app", publisher: "stranger" }));
    await q(`INSERT INTO app_publishers (id, display_name) VALUES ('suspended-co', 'Suspended')`);
    await q(`UPDATE app_publishers SET suspended_at = NOW() WHERE id = 'suspended-co'`);
    const suspended = testCatalogEntry(
      testManifest({ id: "suspended-app", publisher: "suspended-co" }),
    );
    const invalid = { manifest: { id: "broken-app", version: "1.0.0" }, manifestSha256: "c".repeat(64) };
    const malformed = { manifest: testManifest({ id: "no-hash-app" }) };

    const spy = console.error;
    console.error = () => {};
    let result;
    try {
      result = await loadAppCatalog({
        entries: [stranger, suspended, invalid, malformed],
        dev: false,
      });
    } finally {
      console.error = spy;
    }
    expect(result.refused.map((r) => r.reason)).toEqual([
      "unknown-publisher",
      "unknown-publisher",
      "invalid-manifest",
      "invalid-entry",
    ]);
    expect(await apps()).toHaveLength(0);
  });

  it("refuses an id that belongs to another publisher", async () => {
    await q(`INSERT INTO app_publishers (id, display_name) VALUES ('other-co', 'Other')`);
    await loadAppCatalog({ entries: [testCatalogEntry(testManifest({ id: "eco-app" }))], dev: false });
    const spy = console.error;
    console.error = () => {};
    try {
      const result = await loadAppCatalog({
        entries: [
          testCatalogEntry(testManifest({ id: "eco-app", version: "2.0.0", publisher: "other-co" })),
        ],
        dev: false,
      });
      expect(result.refused[0]?.reason).toBe("publisher-mismatch");
    } finally {
      console.error = spy;
    }
    expect(await versions()).toHaveLength(1);
  });

  it("two loads at once write one set of rows", async () => {
    const entry = testCatalogEntry(testManifest());
    const results = await Promise.all([
      loadAppCatalog({ entries: [entry], dev: false }),
      loadAppCatalog({ entries: [entry], dev: false }),
      loadAppCatalog({ entries: [entry], dev: false }),
    ]);
    expect(results.reduce((n, r) => n + r.versionsInserted, 0)).toBe(1);
    expect(await versions()).toHaveLength(1);
    expect(await audit()).toHaveLength(2);
  });

  describe("the dev convenience", () => {
    it("makes pqp apps live and released on one server in development", async () => {
      const owner = await upsertUser({
        clerkId: `clerk_catalog_${Date.now()}`,
        displayName: "Dev",
        avatarUrl: null,
      });
      const { server } = await createServer("Sandbox test", owner.id);
      const { server: other } = await createServer("Other hall", owner.id);

      const result = await loadAppCatalog({
        entries: [testCatalogEntry(testManifest())],
        dev: true,
      });
      expect(result.devEnabled).toBe(1);
      expect((await apps())[0]).toMatchObject({
        status: "live",
        global_enabled: true,
        community_unlocked: true,
      });

      const env = { DEV_AUTH_BYPASS: "true", NODE_ENV: "development" } as NodeJS.ProcessEnv;
      expect(await enableDevAppsForServer(server.id, env)).toBe(1);
      const released = (await q(`SELECT server_id, operator_enabled FROM server_apps`)).rows;
      expect(released).toEqual([{ server_id: server.id, operator_enabled: true }]);
      expect(released.some((row) => row.server_id === other.id)).toBe(false);
    });

    it("does nothing in production, and the release refuses to run there", async () => {
      const owner = await upsertUser({
        clerkId: `clerk_catalog_prod_${Date.now()}`,
        displayName: "Prod",
        avatarUrl: null,
      });
      const { server } = await createServer("Prod hall", owner.id);

      expect(devAppsConvenienceEnabled({ DEV_AUTH_BYPASS: "true", NODE_ENV: "production" })).toBe(
        false,
      );
      expect(devAppsConvenienceEnabled({ NODE_ENV: "development" })).toBe(false);
      expect(devAppsConvenienceEnabled({ DEV_AUTH_BYPASS: "true", NODE_ENV: "development" })).toBe(
        true,
      );

      const result = await loadAppCatalog({
        entries: [testCatalogEntry(testManifest())],
        dev: devAppsConvenienceEnabled({ DEV_AUTH_BYPASS: "true", NODE_ENV: "production" }),
      });
      expect(result.devEnabled).toBe(0);
      expect((await apps())[0]).toMatchObject({ status: "draft", global_enabled: false });

      const env = { DEV_AUTH_BYPASS: "true", NODE_ENV: "production" } as NodeJS.ProcessEnv;
      expect(await enableDevAppsForServer(server.id, env)).toBe(0);
      expect((await q(`SELECT 1 FROM server_apps`)).rowCount).toBe(0);
    });
  });
});
