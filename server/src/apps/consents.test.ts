import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbUser } from "../db.js";
import type { World } from "./testing-world.js";

/**
 * WHAT A PERSON ACCEPTED, and the per-app id an app is handed for those who
 * ticked the box (PLAN D11). The routes run through the real router the way
 * `handleApi` reaches them; the snapshot goes through the real socket handlers
 * with the cluster bus and the voice registry on, as production runs
 * (pitfall 12). Scratch database only (`TEST_DATABASE_URL`).
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.CLUSTER_BUS = "postgres";
process.env.VOICE_REGISTRY = "postgres";
process.env.APPS_ORIGIN = "https://apps.example.test";
process.env.CLERK_SECRET_KEY = "sk_test_consents_secret";
delete process.env.APPS;

const db = await import("../db.js");
const bus = await import("../lib/bus.js");
const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
const flags = await import("../lib/flags.js");
const users = await import("../services/users.js");
const servers = await import("../services/servers.js");
const roles = await import("../services/roles.js");
const catalog = await import("./catalog.js");
const sockets = await import("../ws/sockets.js");
const wsApps = await import("../ws/apps.js");
const sessions = await import("./sessions.js");
const { createRouter } = await import("../lib/router.js");
const { registerAppRoutes } = await import("../api/app-routes.js");
const { HttpError } = await import("../lib/http.js");
const { deriveAppUserId } = await import("./identity.js");
const { buildWorld, publishTestApp, recordingSocket } = await import("./testing-world.js");

const modules = { db, users, servers, roles, flags, catalog, sockets };
const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => db.getPool().query<T>(text, values);

describe("deriveAppUserId", () => {
  const user = "5b7b9f4e-8c0d-4f0a-9d6e-2a1c4d3b8e11";

  it("is stable for one app and one person, and URL-safe", () => {
    const first = deriveAppUserId("pqp-bingo", user);
    expect(first).toBe(deriveAppUserId("pqp-bingo", user));
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("differs per app and per person, so two apps cannot be joined up", () => {
    const base = deriveAppUserId("pqp-bingo", user);
    expect(deriveAppUserId("pqp-poll", user)).not.toBe(base);
    expect(deriveAppUserId("pqp-bingo", "5b7b9f4e-8c0d-4f0a-9d6e-2a1c4d3b8e12")).not.toBe(base);
  });

  it("never contains the pqp id", () => {
    expect(deriveAppUserId("pqp-bingo", user)).not.toContain(user);
  });

  it("follows the secret it is derived from", () => {
    const before = deriveAppUserId("pqp-bingo", user);
    const secret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "sk_test_another_secret";
    try {
      expect(deriveAppUserId("pqp-bingo", user)).not.toBe(before);
    } finally {
      process.env.CLERK_SECRET_KEY = secret;
    }
  });

  it("has no id at all without a secret (fail closed)", () => {
    const secret = process.env.CLERK_SECRET_KEY;
    const bypass = process.env.DEV_AUTH_BYPASS;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.DEV_AUTH_BYPASS;
    try {
      expect(deriveAppUserId("pqp-bingo", user)).toBeNull();
    } finally {
      process.env.CLERK_SECRET_KEY = secret;
      if (bypass !== undefined) process.env.DEV_AUTH_BYPASS = bypass;
    }
  });
});

describeDb("the consent routes and the derived id on the wire", () => {
  const router = createRouter();
  registerAppRoutes(router);
  let transport: ReturnType<typeof createPostgresBusTransport>;
  let world: World;
  let plainApp: string;
  let idApp: string;

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    user: DbUser,
    body?: unknown,
  ) {
    const url = new URL(`http://localhost${path}`);
    const route = router.match(method, url.pathname);
    expect(route, `${method} ${path} is mounted`).not.toBeNull();
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    const out = await route!.handler({ url, user, req } as never, route!.params);
    return JSON.parse(JSON.stringify(out));
  }

  async function refused(promise: Promise<unknown>): Promise<number> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpError) return error.status;
      if ((error as { name?: string }).name === "ZodError") return 400;
      throw error;
    }
    return 200;
  }

  beforeAll(async () => {
    await db.initDb();
    transport = createPostgresBusTransport(DATABASE_URL!);
    bus.setBusTransport(transport);
    await transport.whenConnected();
  }, 30_000);

  beforeEach(async () => {
    await q(`TRUNCATE app_admin_audit, app_sessions, app_session_participants, app_consents,
                      server_apps, app_versions, apps, feature_flags, feature_flag_overrides,
                      messages RESTART IDENTITY CASCADE`);
    await q(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    flags.resetFeatureFlagsForTests();
    await flags.startFeatureFlags();
    sessions.resetAppSessionLimitsForTests();
    wsApps.resetAppsWsForTests();
    world = await buildWorld(modules);
    plainApp = await publishTestApp(modules, world.serverId, { id: "pqp-plain" });
    idApp = await publishTestApp(modules, world.serverId, {
      id: "pqp-bingo",
      capabilities: { identity: "user-id" },
      notice: "Your score is kept.",
    });
    await flags.setServerFlagOverride("apps", world.serverId, true, { kind: "dashboard" });
  });

  afterAll(async () => {
    flags.resetFeatureFlagsForTests();
    await transport.close().catch(() => {});
    await db.closePool();
  });

  describe("accepting and revoking", () => {
    it("starts empty", async () => {
      expect(await call("GET", "/api/me/app-consents", world.member)).toEqual({ consents: [] });
    });

    it("an accepted app is listed with its name and notice in each language", async () => {
      await call("POST", `/api/apps/${idApp}/consent`, world.member, { identityGranted: false });
      const { consents } = await call("GET", "/api/me/app-consents", world.member);
      expect(consents).toEqual([
        expect.objectContaining({
          appId: idApp,
          acceptedVersion: "1.0.0",
          identityGranted: false,
          identity: "user-id",
          stale: false,
          names: expect.objectContaining({ "pt-BR": "Eco", en: "Eco" }),
          notices: expect.objectContaining({ en: "Your score is kept." }),
        }),
      ]);
    });

    it("the id box is honoured only for an app that asks for the id", async () => {
      const plain = await call("POST", `/api/apps/${plainApp}/consent`, world.member, {
        identityGranted: true,
      });
      expect(plain.identityGranted).toBe(false);
      const withId = await call("POST", `/api/apps/${idApp}/consent`, world.member, {
        identityGranted: true,
      });
      expect(withId.identityGranted).toBe(true);
    });

    it("revoking takes it off the list and the next acceptance starts clean", async () => {
      await call("POST", `/api/apps/${idApp}/consent`, world.member, { identityGranted: true });
      expect((await call("DELETE", `/api/apps/${idApp}/consent`, world.member)).revoked).toBe(true);
      expect((await call("GET", "/api/me/app-consents", world.member)).consents).toEqual([]);
      const row = (await q(`SELECT identity_granted, revoked_at FROM app_consents`)).rows[0]!;
      expect(row.identity_granted).toBe(false);
      expect(row.revoked_at).not.toBeNull();
      // idempotent
      expect((await call("DELETE", `/api/apps/${idApp}/consent`, world.member)).revoked).toBe(false);
      // accepting again brings it back
      await call("POST", `/api/apps/${idApp}/consent`, world.member, {});
      expect((await call("GET", "/api/me/app-consents", world.member)).consents).toHaveLength(1);
    });

    it("is per person: one person's acceptance is nobody else's", async () => {
      await call("POST", `/api/apps/${idApp}/consent`, world.member, { identityGranted: true });
      expect((await call("GET", "/api/me/app-consents", world.owner)).consents).toEqual([]);
      expect((await call("DELETE", `/api/apps/${idApp}/consent`, world.owner)).revoked).toBe(false);
      expect((await call("GET", "/api/me/app-consents", world.member)).consents).toHaveLength(1);
    });

    it("an app that does not exist, or a malformed id, is a 404; a stray key is a 400", async () => {
      expect(await refused(call("POST", "/api/apps/pqp-nope/consent", world.member, {}))).toBe(404);
      expect(await refused(call("POST", "/api/apps/NOT_AN_ID/consent", world.member, {}))).toBe(404);
      expect(await refused(call("DELETE", "/api/apps/NOT_AN_ID/consent", world.member))).toBe(404);
      expect(
        await refused(call("POST", `/api/apps/${idApp}/consent`, world.member, { admin: true })),
      ).toBe(400);
    });

    it("a version that asks for something different makes the acceptance stale", async () => {
      await call("POST", `/api/apps/${idApp}/consent`, world.member, {});
      await publishTestApp(modules, world.serverId, {
        id: "pqp-bingo",
        version: "1.1.0",
        capabilities: { identity: "user-id", share: "pane" },
        channelTypes: ["text", "voice"],
      });
      await q(`UPDATE apps SET current_version = '1.1.0' WHERE id = 'pqp-bingo'`);
      const { consents } = await call("GET", "/api/me/app-consents", world.member);
      expect(consents[0]).toMatchObject({ acceptedVersion: "1.0.0", stale: true });
    });

    it("a version with the same capabilities keeps the acceptance", async () => {
      await call("POST", `/api/apps/${idApp}/consent`, world.member, {});
      await publishTestApp(modules, world.serverId, {
        id: "pqp-bingo",
        version: "1.0.1",
        capabilities: { identity: "user-id" },
      });
      await q(`UPDATE apps SET current_version = '1.0.1' WHERE id = 'pqp-bingo'`);
      const { consents } = await call("GET", "/api/me/app-consents", world.member);
      expect(consents[0]).toMatchObject({ stale: false });
    });
  });

  describe("the id an app is handed in app-session", () => {
    async function seat(app: string, ...people: DbUser[]) {
      sessions.resetAppSessionLimitsForTests();
      const session = await sessions.startAppSession(world.owner, world.channels.general, app);
      const recs = [];
      for (const person of people) {
        const rec = recordingSocket(modules, person);
        await wsApps.handleAppFrame(rec.socket, person, { type: "app-join", sessionId: session.id });
        recs.push(rec);
      }
      return { sessionId: session.id, recs };
    }
    const snapshot = (rec: ReturnType<typeof recordingSocket>) =>
      rec.ofType("app-session").at(-1) as unknown as {
        participants: Array<{ userId: string; appUserId?: string }>;
      };

    it("only the people who ticked the box carry one, and it is the derived id", async () => {
      await call("POST", `/api/apps/${idApp}/consent`, world.member, { identityGranted: true });
      await call("POST", `/api/apps/${idApp}/consent`, world.owner, { identityGranted: false });
      const { recs } = await seat(idApp, world.member, world.owner, world.manager);
      const participants = snapshot(recs[2]!).participants;
      const of = (user: DbUser) => participants.find((p) => p.userId === user.id)!;
      expect(of(world.member).appUserId).toBe(deriveAppUserId(idApp, world.member.id));
      expect(of(world.owner).appUserId).toBeUndefined();
      expect(of(world.manager).appUserId).toBeUndefined();
    });

    it("an app that does not ask for the id never sends one, even to a person who ticked", async () => {
      await q(
        `INSERT INTO app_consents (user_id, app_id, accepted_version, identity_granted)
         VALUES ($1, $2, '1.0.0', TRUE)`,
        [world.member.id, plainApp],
      );
      const { recs } = await seat(plainApp, world.member);
      expect(JSON.stringify(snapshot(recs[0]!))).not.toContain("appUserId");
    });

    it("a revoked consent stops the id on the next snapshot", async () => {
      await call("POST", `/api/apps/${idApp}/consent`, world.member, { identityGranted: true });
      await call("DELETE", `/api/apps/${idApp}/consent`, world.member);
      const { recs } = await seat(idApp, world.member);
      expect(snapshot(recs[0]!).participants[0]).not.toHaveProperty("appUserId");
    });

    it("the pqp user id the page needs is on the frame, the derived id is never the same string", async () => {
      await call("POST", `/api/apps/${idApp}/consent`, world.member, { identityGranted: true });
      const { recs } = await seat(idApp, world.member);
      const mine = snapshot(recs[0]!).participants[0]!;
      expect(mine.appUserId).not.toBe(mine.userId);
      expect(mine.appUserId).not.toContain(mine.userId);
    });
  });
});
