import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Runtime feature flags (`lib/flags.ts`) in one process, against a real
 * Postgres. The cross-process half is `flags-cluster.test.ts` (two module
 * graphs over real LISTEN/NOTIFY) and `flags-two-process.test.ts` (two real
 * API processes).
 *
 * The property everything here protects: WITH NO ROW, A FLAG ANSWERS EXACTLY
 * WHAT ITS OLD ENVIRONMENT READER ANSWERED. That is the self-host promise and
 * the reason a deploy of this change moves nothing in production. The old
 * readers are copied below verbatim and compared value for value.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const flags = await import("./flags.js");
const {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  bindFlagDefault,
  isEnabled,
  resolveFlag,
  resetFeatureFlagsForTests,
  setFeatureFlagOverrideSchema,
  setFeatureFlagSchema,
} = flags;

// ---------------------------------------------------------- the old readers

const offWords = (raw: string | undefined) => {
  const value = raw?.trim().toLowerCase();
  return value !== "false" && value !== "0" && value !== "off";
};

const OLD_READERS: Record<string, (raw: string | undefined) => boolean> = {
  // `watchPartyWaitlistCampaignEnabled` before, with `isLiveHlsEnabled` false.
  watch_party_waitlist: (raw) => {
    const value = (raw ?? "").trim().toLowerCase();
    if (value === "on" || value === "true" || value === "1") return true;
    if (value === "off" || value === "false" || value === "0") return false;
    return false;
  },
  live_hls_camera: offWords,
  live_hls_camera_480: offWords,
  live_hls_voice_track: (raw) => raw === "true",
  live_hls_mic_archive: (raw) => raw === "true",
  live_hls_reap_orphans: offWords,
  hls_sharer_resume_hold: (raw) => {
    const value = (raw ?? "").trim().toLowerCase();
    return !(value === "off" || value === "false" || value === "0");
  },
  livekit_region_require_cap: (raw) => {
    const value = (raw ?? "").trim().toLowerCase();
    return value === "true" || value === "1" || value === "on";
  },
  voice_mesh_resume_requires_cap: (raw) => raw === "true",
  turn_prefer_static: (raw) => raw === "true",
  read_cache: offWords,
  community_home: (raw) => raw === "true",
  community_home_vip: (raw) => raw === "true",
};

const SAMPLES = [
  undefined,
  "",
  "true",
  "TRUE",
  " true ",
  "false",
  "FALSE",
  "0",
  "1",
  "on",
  "off",
  "OFF",
  "yes",
  "banana",
];

function envName(key: keyof typeof FEATURE_FLAGS): string {
  return FEATURE_FLAGS[key].env;
}

function clearFlagEnv(): void {
  for (const key of FEATURE_FLAG_KEYS) {
    delete process.env[envName(key)];
  }
  delete process.env.FEATURE_FLAGS_TTL_MS;
}

describe("the registry", () => {
  afterEach(() => {
    clearFlagEnv();
    resetFeatureFlagsForTests();
  });

  it("covers exactly the flags the old readers did", () => {
    expect(Object.keys(OLD_READERS).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
  });

  it("answers, with no row, exactly what every old env reader answered", () => {
    // The waitlist's code default is bound to `isLiveHlsEnabled`; here it is
    // false, which is what the copied reader assumes.
    bindFlagDefault("watch_party_waitlist", () => false);
    for (const key of FEATURE_FLAG_KEYS) {
      for (const raw of SAMPLES) {
        if (raw === undefined) {
          delete process.env[envName(key)];
        } else {
          process.env[envName(key)] = raw;
        }
        expect(
          { key, raw, value: isEnabled(key) },
        ).toEqual({ key, raw, value: OLD_READERS[key]!(raw) });
      }
      delete process.env[envName(key)];
    }
  });

  it("a bound default is followed only when the environment says nothing", () => {
    let live = true;
    bindFlagDefault("watch_party_waitlist", () => live);
    expect(resolveFlag("watch_party_waitlist")).toEqual({ value: true, source: "default" });
    live = false;
    expect(isEnabled("watch_party_waitlist")).toBe(false);
    process.env.WATCH_PARTY_WAITLIST = "on";
    expect(resolveFlag("watch_party_waitlist")).toEqual({ value: true, source: "env" });
  });

  it("the write schemas refuse a key nobody registered", () => {
    expect(setFeatureFlagSchema.safeParse({ key: "made_up", enabled: true }).success).toBe(false);
    expect(
      setFeatureFlagSchema.safeParse({ key: "live_hls_camera_480", enabled: null }).success,
    ).toBe(true);
    expect(
      setFeatureFlagOverrideSchema.safeParse({
        key: "watch_party_waitlist",
        serverId: "not-a-uuid",
        enabled: true,
      }).success,
    ).toBe(false);
  });
});

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");

describeDb("runtime flags against Postgres", () => {
  let serverId: string;
  let otherServerId: string;
  let moderatorId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    clearFlagEnv();
    resetFeatureFlagsForTests();
    bindFlagDefault("watch_party_waitlist", () => false);
    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE feature_flags, feature_flag_overrides, feature_flag_audit`);
    const owner = await upsertUser({
      clerkId: "clerk-flags-owner",
      displayName: "Dona",
      avatarUrl: null,
    });
    moderatorId = owner.id;
    const created = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Cinemoon', $1), ('Outro', $1) RETURNING id`,
      [owner.id],
    );
    serverId = created.rows[0]!.id;
    otherServerId = created.rows[1]!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearFlagEnv();
    resetFeatureFlagsForTests();
  });

  it("override beats global beats env beats default", async () => {
    await flags.startFeatureFlags();
    process.env.WATCH_PARTY_WAITLIST = "off";
    expect(resolveFlag("watch_party_waitlist", { serverId })).toEqual({
      value: false,
      source: "env",
    });

    await flags.setGlobalFlag("watch_party_waitlist", true, { kind: "dashboard" });
    expect(resolveFlag("watch_party_waitlist", { serverId })).toEqual({
      value: true,
      source: "global",
    });

    await flags.setServerFlagOverride("watch_party_waitlist", serverId, false, {
      kind: "moderator",
      userId: moderatorId,
    });
    expect(resolveFlag("watch_party_waitlist", { serverId })).toEqual({
      value: false,
      source: "server",
    });
    // Another server, and no server at all, still get the global answer.
    expect(isEnabled("watch_party_waitlist", { serverId: otherServerId })).toBe(true);
    expect(isEnabled("watch_party_waitlist")).toBe(true);

    // Clearing the override hands that server back to the global row...
    await flags.setServerFlagOverride("watch_party_waitlist", serverId, null, {
      kind: "dashboard",
    });
    expect(resolveFlag("watch_party_waitlist", { serverId }).source).toBe("global");
    // ...and clearing the global row hands everybody back to the variable.
    await flags.setGlobalFlag("watch_party_waitlist", null, { kind: "dashboard" });
    expect(resolveFlag("watch_party_waitlist", { serverId })).toEqual({
      value: false,
      source: "env",
    });
    delete process.env.WATCH_PARTY_WAITLIST;
    expect(resolveFlag("watch_party_waitlist", { serverId }).source).toBe("default");
  });

  it("a global row beats a variable that says the opposite, both ways", async () => {
    await flags.startFeatureFlags();
    process.env.LIVE_HLS_CAMERA_480 = "false";
    await flags.setGlobalFlag("live_hls_camera_480", true, { kind: "dashboard" });
    expect(isEnabled("live_hls_camera_480")).toBe(true);
    process.env.TURN_PREFER_STATIC = "true";
    await flags.setGlobalFlag("turn_prefer_static", false, { kind: "dashboard" });
    expect(isEnabled("turn_prefer_static")).toBe(false);
  });

  it("refuses a per-server override for a flag that has none, and an unknown server", async () => {
    await expect(
      flags.setServerFlagOverride("live_hls_camera_480", serverId, true, { kind: "dashboard" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      flags.setServerFlagOverride(
        "watch_party_waitlist",
        "00000000-0000-4000-8000-000000000009",
        true,
        { kind: "dashboard" },
      ),
    ).rejects.toMatchObject({ status: 404 });
    const audit = await getPool().query(`SELECT 1 FROM feature_flag_audit`);
    expect(audit.rowCount).toBe(0);
  });

  it("audits every change with its actor, and a write that changes nothing is not a flip", async () => {
    await flags.startFeatureFlags();
    await flags.setGlobalFlag("community_home", true, { kind: "moderator", userId: moderatorId });
    await flags.setGlobalFlag("community_home", true, { kind: "dashboard" });
    await flags.setGlobalFlag("community_home", false, { kind: "dashboard" });
    await flags.setServerFlagOverride("watch_party_waitlist", serverId, true, {
      kind: "dashboard",
    });

    const list = await flags.listFeatureFlags();
    expect(list.audit.map((entry) => [entry.key, entry.previous, entry.next, entry.actorKind])).toEqual([
      ["watch_party_waitlist", null, true, "dashboard"],
      ["community_home", true, false, "dashboard"],
      ["community_home", null, true, "moderator"],
    ]);
    expect(list.audit[2]!.actorName).toBe("Dona");
    expect(list.audit[0]!.serverName).toBe("Cinemoon");

    const home = list.flags.find((flag) => flag.key === "community_home")!;
    expect(home).toMatchObject({
      env: "COMMUNITY_HOME_ENABLED",
      envSet: false,
      envDefault: false,
      stored: { enabled: false },
      effective: false,
      source: "global",
    });
    const waitlist = list.flags.find((flag) => flag.key === "watch_party_waitlist")!;
    expect(waitlist.overrides).toEqual([
      expect.objectContaining({ serverId, serverName: "Cinemoon", enabled: true }),
    ]);

    const metrics = await flags.featureFlagMetrics();
    expect(metrics.flipsSinceBoot).toBe(3);
    expect(metrics.flips24h).toBe(3);
    expect(metrics.flips24hByKey).toEqual({ community_home: 2, watch_party_waitlist: 1 });
    expect(metrics.values.watch_party_waitlist).toEqual({
      effective: false,
      source: "default",
      serverOverrides: 1,
    });
    expect(metrics.values.community_home!.source).toBe("global");
  });

  it("never consults the database before startFeatureFlags", async () => {
    await getPool().query(
      `INSERT INTO feature_flags (key, enabled) VALUES ('live_hls_voice_track', TRUE)`,
    );
    const spy = vi.spyOn(getPool(), "query");
    expect(isEnabled("live_hls_voice_track")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    await flags.startFeatureFlags();
    expect(isEnabled("live_hls_voice_track")).toBe(true);
  });

  it("with no bus, a row another process wrote is seen once the TTL has passed", async () => {
    process.env.FEATURE_FLAGS_TTL_MS = "100";
    await flags.startFeatureFlags();
    expect(isEnabled("live_hls_mic_archive")).toBe(false);

    // Written behind this process's back, as a sibling with no bus would.
    await getPool().query(
      `INSERT INTO feature_flags (key, enabled) VALUES ('live_hls_mic_archive', TRUE)`,
    );
    expect(isEnabled("live_hls_mic_archive")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The first stale read answers from the snapshot and starts the reload.
    isEnabled("live_hls_mic_archive");
    await vi.waitFor(() => expect(isEnabled("live_hls_mic_archive")).toBe(true), {
      timeout: 2_000,
    });
  });

  it("database down: keeps the last known answer, and backs off instead of querying on every read", async () => {
    process.env.FEATURE_FLAGS_TTL_MS = "50";
    process.env.LIVE_HLS_CAMERA = "false";
    await flags.startFeatureFlags();
    await flags.setGlobalFlag("live_hls_camera", true, { kind: "dashboard" });
    expect(isEnabled("live_hls_camera")).toBe(true);

    const pool = getPool();
    const spy = vi.spyOn(pool, "query").mockImplementation((() =>
      Promise.reject(new Error("connection refused"))) as never);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Stale now: the read answers the last snapshot and the reload fails.
    expect(isEnabled("live_hls_camera")).toBe(true);
    await vi.waitFor(() => expect(flags.featureFlagCacheStats().loadFailures).toBe(1));
    expect(isEnabled("live_hls_camera")).toBe(true);
    // Inside the back-off, a burst of reads is not a burst of queries.
    const callsBefore = spy.mock.calls.length;
    for (let i = 0; i < 100; i += 1) {
      isEnabled("live_hls_camera");
    }
    expect(spy.mock.calls.length).toBe(callsBefore);
    expect(await flags.reloadFeatureFlags()).toBe(false);
    expect(isEnabled("live_hls_camera")).toBe(true);
  });

  it("database down before the first load: the environment answers", async () => {
    await getPool().query(
      `INSERT INTO feature_flags (key, enabled) VALUES ('live_hls_camera', FALSE)`,
    );
    vi.spyOn(getPool(), "query").mockImplementation((() =>
      Promise.reject(new Error("connection refused"))) as never);
    await flags.startFeatureFlags();
    expect(resolveFlag("live_hls_camera")).toEqual({ value: true, source: "default" });
    process.env.LIVE_HLS_CAMERA = "off";
    expect(resolveFlag("live_hls_camera")).toEqual({ value: false, source: "env" });
  });

  it("the converted readers follow the row", async () => {
    const { liveHlsCamera480Enabled, liveHlsConfig } = await import(
      "../voice/hls-egress.js"
    );
    const { regionCapRequired } = await import("../voice/regions.js");
    const { isCommunityHomeEnabled, isCommunityHomeVipEnabled } = await import(
      "../services/community-home.js"
    );
    await flags.startFeatureFlags();
    expect(liveHlsCamera480Enabled()).toBe(true);
    expect(liveHlsConfig().cameraHeight).toBe(480);
    await flags.setGlobalFlag("live_hls_camera_480", false, { kind: "dashboard" });
    expect(liveHlsCamera480Enabled()).toBe(false);
    expect(liveHlsConfig().cameraHeight).toBe(360);

    expect(regionCapRequired()).toBe(false);
    await flags.setGlobalFlag("livekit_region_require_cap", true, { kind: "dashboard" });
    expect(regionCapRequired()).toBe(true);

    // VIP still needs the main switch, exactly as with the variables.
    await flags.setGlobalFlag("community_home_vip", true, { kind: "dashboard" });
    expect(isCommunityHomeVipEnabled()).toBe(false);
    await flags.setGlobalFlag("community_home", true, { kind: "dashboard" });
    expect(isCommunityHomeEnabled()).toBe(true);
    expect(isCommunityHomeVipEnabled()).toBe(true);
  });
});
