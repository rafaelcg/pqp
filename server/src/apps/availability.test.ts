import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testCatalogEntry, testManifest, type TestManifestOptions } from "./testing.js";

/**
 * `appAvailability` (PLAN D10), every reason, against a real Postgres and the
 * real runtime flag snapshot (never the environment: pitfalls 9 and 12). The
 * flag `apps` is turned on for ONE server by an override row, the way the
 * operator does it, so a second server proves the flag is per server.
 * Scratch database only (`TEST_DATABASE_URL`).
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.APPS;
delete process.env.LOCADORA_SHARE;
process.env.APPS_ORIGIN = "https://apps.example.test";

const { getPool, initDb, closePool } = await import("../db.js");
const flags = await import("../lib/flags.js");
const { loadAppCatalog } = await import("./catalog.js");
const { appAvailability, appShareAllowed, evaluateAvailability, emulatorRoomEnabled } =
  await import("./availability.js");
const { upsertUser } = await import("../services/users.js");
const { createServer } = await import("../services/servers.js");

const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => getPool().query<T>(text, values);

describeDb("appAvailability", () => {
  let serverId: string;
  let otherServerId: string;

  /** Publish an app the way the loader and an operator would leave it: live, released here. */
  async function publish(
    options: TestManifestOptions = {},
    switches: {
      status?: string;
      global?: boolean;
      operator?: boolean | null;
      owner?: boolean | null;
      communityUnlocked?: boolean;
    } = {},
  ): Promise<string> {
    const manifest = testManifest(options);
    await loadAppCatalog({ entries: [testCatalogEntry(manifest)], dev: false });
    await q(
      `UPDATE apps SET status = $2, global_enabled = $3, community_unlocked = $4 WHERE id = $1`,
      [
        manifest.id,
        switches.status ?? "live",
        switches.global ?? true,
        switches.communityUnlocked ?? false,
      ],
    );
    const operator = switches.operator === undefined ? true : switches.operator;
    await q(
      `INSERT INTO server_apps (server_id, app_id, operator_enabled, owner_enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (server_id, app_id)
       DO UPDATE SET operator_enabled = EXCLUDED.operator_enabled, owner_enabled = EXCLUDED.owner_enabled`,
      [serverId, manifest.id, operator, switches.owner ?? null],
    );
    return manifest.id;
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
    const owner = await upsertUser({
      clerkId: `clerk_avail_${Date.now()}_${Math.random()}`,
      displayName: "Owner",
      avatarUrl: null,
    });
    serverId = (await createServer("Hall", owner.id)).server.id;
    otherServerId = (await createServer("Other", owner.id)).server.id;
    flags.resetFeatureFlagsForTests();
    await flags.startFeatureFlags();
    await flags.setServerFlagOverride("apps", serverId, true, { kind: "dashboard" });
  });

  afterEach(() => {
    process.env.APPS_ORIGIN = "https://apps.example.test";
  });

  afterAll(async () => {
    flags.resetFeatureFlagsForTests();
    await closePool();
  });

  it("is available when every gate holds", async () => {
    const id = await publish();
    expect(await appAvailability(serverId, id)).toEqual({ available: true, reason: null });
    expect(await appAvailability(serverId, id, { channelType: "voice" })).toEqual({
      available: true,
      reason: null,
    });
  });

  it("flag-off: the flag is per server", async () => {
    const id = await publish();
    await q(
      `INSERT INTO server_apps (server_id, app_id, operator_enabled) VALUES ($1, $2, TRUE)`,
      [otherServerId, id],
    );
    expect(await appAvailability(otherServerId, id)).toEqual({
      available: false,
      reason: "flag-off",
    });
    await flags.setServerFlagOverride("apps", serverId, false, { kind: "dashboard" });
    expect((await appAvailability(serverId, id)).reason).toBe("flag-off");
  });

  it("not-live: unknown app, draft, review, retired", async () => {
    expect((await appAvailability(serverId, "no-such-app")).reason).toBe("not-live");
    for (const status of ["draft", "review", "retired"]) {
      const id = await publish({ id: `app-${status}` }, { status });
      expect((await appAvailability(serverId, id)).reason).toBe("not-live");
    }
  });

  it("not-live: a live app with no current version", async () => {
    const id = await publish();
    await q(`UPDATE apps SET current_version = NULL WHERE id = $1`, [id]);
    expect((await appAvailability(serverId, id)).reason).toBe("not-live");
  });

  it("global-off: the master switch", async () => {
    const id = await publish({}, { global: false });
    expect((await appAvailability(serverId, id)).reason).toBe("global-off");
  });

  it("not-allowed-here: no row, undecided and false all mean off", async () => {
    const id = await publish({}, { operator: null });
    expect((await appAvailability(serverId, id)).reason).toBe("not-allowed-here");
    await q(`UPDATE server_apps SET operator_enabled = FALSE WHERE app_id = $1`, [id]);
    expect((await appAvailability(serverId, id)).reason).toBe("not-allowed-here");
    await q(`DELETE FROM server_apps WHERE app_id = $1`, [id]);
    expect((await appAvailability(serverId, id)).reason).toBe("not-allowed-here");
  });

  it("owner-off: the owner removes what the operator allowed, never the reverse", async () => {
    const id = await publish({}, { owner: false });
    expect((await appAvailability(serverId, id)).reason).toBe("owner-off");
    // owner TRUE without the operator's release is still off.
    await q(`UPDATE server_apps SET operator_enabled = NULL, owner_enabled = TRUE WHERE app_id = $1`, [
      id,
    ]);
    expect((await appAvailability(serverId, id)).reason).toBe("not-allowed-here");
  });

  it("community-locked: a public community needs the app's own safety decision", async () => {
    const id = await publish();
    await q(`UPDATE servers SET is_community = TRUE WHERE id = $1`, [serverId]);
    expect((await appAvailability(serverId, id)).reason).toBe("community-locked");
    await q(`UPDATE apps SET community_unlocked = TRUE WHERE id = $1`, [id]);
    expect(await appAvailability(serverId, id)).toEqual({ available: true, reason: null });
  });

  it("emulator-off: an emulator app also needs emulator_room, which is off or unregistered", async () => {
    const id = await publish({ id: "pqp-retro", category: "emulator" });
    expect((await appAvailability(serverId, id)).reason).toBe("emulator-off");
    expect(emulatorRoomEnabled(serverId)).toBe(false);
  });

  it("channel-type: the channel's type must be one the manifest lists", async () => {
    const id = await publish({ channelTypes: ["voice"] });
    expect((await appAvailability(serverId, id, { channelType: "text" })).reason).toBe(
      "channel-type",
    );
    expect((await appAvailability(serverId, id, { channelType: "forum" })).reason).toBe(
      "channel-type",
    );
    expect(await appAvailability(serverId, id, { channelType: "voice" })).toEqual({
      available: true,
      reason: null,
    });
  });

  it("no-origin: without APPS_ORIGIN nothing can run", async () => {
    const id = await publish();
    delete process.env.APPS_ORIGIN;
    expect(await appAvailability(serverId, id)).toEqual({ available: false, reason: "no-origin" });
    process.env.APPS_ORIGIN = "not a url";
    expect((await appAvailability(serverId, id)).reason).toBe("no-origin");
  });

  it("names the first failing gate, in the documented order", async () => {
    const id = await publish(
      { channelTypes: ["voice"] },
      { global: false, operator: false, owner: false },
    );
    await q(`UPDATE servers SET is_community = TRUE WHERE id = $1`, [serverId]);
    delete process.env.APPS_ORIGIN;
    const ask = async () => (await appAvailability(serverId, id, { channelType: "text" })).reason;
    expect(await ask()).toBe("global-off");
    await q(`UPDATE apps SET global_enabled = TRUE WHERE id = $1`, [id]);
    expect(await ask()).toBe("not-allowed-here");
    await q(`UPDATE server_apps SET operator_enabled = TRUE WHERE app_id = $1`, [id]);
    expect(await ask()).toBe("owner-off");
    await q(`UPDATE server_apps SET owner_enabled = NULL WHERE app_id = $1`, [id]);
    expect(await ask()).toBe("community-locked");
    await q(`UPDATE apps SET community_unlocked = TRUE WHERE id = $1`, [id]);
    expect(await ask()).toBe("channel-type");
    expect((await appAvailability(serverId, id, { channelType: "voice" })).reason).toBe("no-origin");
  });

  it("evaluateAvailability is the same decision over rows already read", async () => {
    const id = await publish();
    const row = (
      await q(
        `SELECT a.id, a.status, a.current_version, a.global_enabled, a.community_unlocked,
                v.manifest, sa.operator_enabled, sa.owner_enabled
           FROM apps a
           LEFT JOIN app_versions v ON v.app_id = a.id AND v.version = a.current_version
           LEFT JOIN server_apps sa ON sa.server_id = $1 AND sa.app_id = a.id
          WHERE a.id = $2`,
        [serverId, id],
      )
    ).rows[0] as unknown as Parameters<typeof evaluateAvailability>[1];
    expect(evaluateAvailability(serverId, row, { isCommunity: false })).toEqual({
      available: true,
      reason: null,
    });
    expect(evaluateAvailability(serverId, row, { isCommunity: true }).reason).toBe(
      "community-locked",
    );
  });

  describe("appShareAllowed (D14)", () => {
    it("is true for every app but an emulator, which needs locadora_share on the server", async () => {
      expect(appShareAllowed(serverId, { category: "tool" })).toBe(true);
      expect(appShareAllowed(serverId, { category: "game" })).toBe(true);
      expect(appShareAllowed(serverId, { category: "emulator" })).toBe(false);

      await flags.setServerFlagOverride("locadora_share", serverId, true, { kind: "dashboard" });
      expect(appShareAllowed(serverId, { category: "emulator" })).toBe(true);
      expect(appShareAllowed(otherServerId, { category: "emulator" })).toBe(false);
    });

    it("locadora_share is per server and off by default", () => {
      expect(flags.FEATURE_FLAGS.locadora_share.perServer).toBe(true);
      expect(flags.FEATURE_FLAGS.locadora_share.codeDefault).toBe(false);
      expect(flags.isEnabled("locadora_share", { serverId })).toBe(false);
    });
  });
});
