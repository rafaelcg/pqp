import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbUser } from "../db.js";
import type { World } from "./testing-world.js";
import type { TestBucket } from "./testing-bucket.js";

/**
 * SAVES NA CONTA, the server half (`locadora-saves.ts`, the routes in
 * `api/locadora-save-routes.ts`): the gate (404 with the flag off, outside a
 * seat, without storage), the presigned write and its HEAD-checked commit, the
 * rev that refuses a stale write, the quota and the size caps, the battery
 * save's history and its restore, the deletes, the read-only month after the
 * flag goes off, the write budget and the sweep. The routes run through the
 * real router; the bucket is an in-memory stand-in on a local port
 * (`testing-bucket.ts`). Scratch database only (`TEST_DATABASE_URL`).
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.APPS_ORIGIN = "https://apps.example.test";
delete process.env.APPS;
delete process.env.LOCADORA_SAVE_SYNC;
delete process.env.EMULATOR_ROOM;

const db = await import("../db.js");
const flags = await import("../lib/flags.js");
const users = await import("../services/users.js");
const servers = await import("../services/servers.js");
const roles = await import("../services/roles.js");
const catalog = await import("./catalog.js");
const sockets = await import("../ws/sockets.js");
const saves = await import("./locadora-saves.js");
const { appsConfigForServer } = await import("./config.js");
const { resetRateLimits } = await import("../lib/rate-limit.js");
const { createRouter } = await import("../lib/router.js");
const { registerAppRoutes } = await import("../api/app-routes.js");
const { HttpError } = await import("../lib/http.js");
const { HttpErrorWithDetail } = await import("../lib/route-results.js");
const { buildWorld, publishTestApp } = await import("./testing-world.js");
const { startTestBucket } = await import("./testing-bucket.js");

const modules = { db, users, servers, roles, flags, catalog, sockets };
const q = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  db.getPool().query<T>(text, values);

const BASE = "/api/apps/pqp-locadora/saves";
const GAME = "A".repeat(43);
const OTHER_GAME = "B".repeat(43);
const DEVICE = { deviceKind: "computer", deviceId: "device-aaaaaaaaaaaa" } as const;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describeDb("Saves na conta (locadora_save_sync)", () => {
  const router = createRouter();
  registerAppRoutes(router);
  let bucket: TestBucket;
  let world: World;
  let sessionId: string;

  async function call(method: "GET" | "POST" | "DELETE", path: string, user: DbUser, body?: unknown) {
    const url = new URL(`http://localhost${path}`);
    const route = router.match(method, url.pathname);
    if (!route) throw new HttpError(404, "no route");
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    const out = await route.handler({ url, user, req } as never, route.params);
    return JSON.parse(JSON.stringify(out ?? null));
  }

  /** The status the route answered with, 200 for a success. */
  async function status(promise: Promise<unknown>): Promise<number> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpError) return error.status;
      if ((error as { name?: string }).name === "ZodError") return 400;
      throw error;
    }
    return 200;
  }

  async function detailOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpErrorWithDetail) return { status: error.status, error: error.message, ...error.detail };
      throw error;
    }
    throw new Error("expected a refusal");
  }

  async function putTo(url: string, body: Buffer, contentType: string) {
    const res = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: new Uint8Array(body) });
    expect(res.ok).toBe(true);
  }

  function uploadBody(extra: Record<string, unknown> & { bytes: Buffer }) {
    const { bytes, ...rest } = extra;
    return {
      sessionId,
      gameKey: GAME,
      kind: "state",
      slot: 1,
      baseRev: 0,
      size: bytes.length,
      sha256: sha(bytes),
      thumbSize: 0,
      platform: "nes",
      core: "fceumm",
      coreVersion: "4.2.3",
      ...DEVICE,
      ...rest,
    };
  }

  /** Upload, PUT and commit one save; returns the committed row. */
  async function write(
    user: DbUser,
    options: { bytes?: Buffer; thumb?: Buffer; kind?: string; slot?: number; baseRev?: number; gameKey?: string } = {},
  ) {
    const bytes = options.bytes ?? randomBytes(64);
    const thumb = options.thumb ?? null;
    const upload = await call(
      "POST",
      `${BASE}/upload`,
      user,
      uploadBody({
        bytes,
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.slot !== undefined ? { slot: options.slot } : {}),
        ...(options.baseRev !== undefined ? { baseRev: options.baseRev } : {}),
        ...(options.gameKey ? { gameKey: options.gameKey } : {}),
        thumbSize: thumb ? thumb.length : 0,
      }),
    );
    await putTo(upload.put.url, bytes, upload.put.contentType);
    if (thumb) await putTo(upload.thumbPut.url, thumb, upload.thumbPut.contentType);
    return call("POST", `${BASE}/uploads/${upload.uploadId}/commit`, user, { sessionId });
  }

  async function seat(user: DbUser, role: "player" | "spectator" = "player", inSession = sessionId) {
    await q(
      `INSERT INTO app_session_participants (session_id, user_id, seat_id, role)
       VALUES ($1, $2, $3, $4)`,
      [inSession, user.id, `seat${randomBytes(9).toString("hex")}`, role],
    );
  }

  beforeAll(async () => {
    bucket = await startTestBucket();
    bucket.configure();
    await db.initDb();
  }, 30_000);

  beforeEach(async () => {
    await q(`TRUNCATE locadora_save_uploads, locadora_save_history, locadora_saves, locadora_save_salts,
                      app_sessions, app_session_participants, server_apps, app_versions, apps,
                      feature_flags, feature_flag_overrides, messages RESTART IDENTITY CASCADE`);
    await q(`INSERT INTO app_publishers (id, display_name, kind) VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`);
    bucket.objects.clear();
    bucket.configure();
    resetRateLimits();
    flags.resetFeatureFlagsForTests();
    await flags.startFeatureFlags();
    world = await buildWorld(modules);
    await publishTestApp(modules, world.serverId, { id: "pqp-locadora" });
    for (const key of ["apps", "emulator_room", "locadora_save_sync"] as const) {
      await flags.setServerFlagOverride(key, world.serverId, true, { kind: "dashboard" });
    }
    const session = await q<{ id: string }>(
      `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version)
       VALUES ($1, $2, 'pqp-locadora', '1.0.0') RETURNING id`,
      [world.serverId, world.channels.general],
    );
    sessionId = session.rows[0]!.id;
    await seat(world.member);
  });

  afterAll(async () => {
    flags.resetFeatureFlagsForTests();
    await bucket.close();
    await db.closePool();
  });

  describe("the gate", () => {
    it("is a 404 on every route with the flag off and nothing used before", async () => {
      await flags.setServerFlagOverride("locadora_save_sync", world.serverId, false, { kind: "dashboard" });
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member))).toBe(404);
      expect(await status(call("GET", `${BASE}?sessionId=${sessionId}&gameKey=${GAME}`, world.member))).toBe(404);
      expect(await status(call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: randomBytes(8) })))).toBe(404);
      expect(await status(call("DELETE", `${BASE}?sessionId=${sessionId}`, world.member))).toBe(404);
    });

    it("needs apps and emulator_room on the session's server as well", async () => {
      await flags.setServerFlagOverride("emulator_room", world.serverId, false, { kind: "dashboard" });
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member))).toBe(404);
      await flags.setServerFlagOverride("emulator_room", world.serverId, true, { kind: "dashboard" });
      await flags.setServerFlagOverride("apps", world.serverId, false, { kind: "dashboard" });
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member))).toBe(404);
    });

    it("is a 404 for somebody without a player seat: not seated, a spectator, a seat left, an ended session", async () => {
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.owner))).toBe(404);
      await seat(world.insider, "spectator");
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.insider))).toBe(404);
      await q(`UPDATE app_session_participants SET left_at = NOW() WHERE user_id = $1`, [world.member.id]);
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member))).toBe(404);
      await q(`UPDATE app_session_participants SET left_at = NULL WHERE user_id = $1`, [world.member.id]);
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member))).toBe(200);
      await q(`UPDATE app_sessions SET status = 'ended', ended_at = NOW(), end_reason = 'host' WHERE id = $1`, [sessionId]);
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member))).toBe(404);
    });

    it("is a 404 in another app's session", async () => {
      await publishTestApp(modules, world.serverId, { id: "pqp-eco" });
      const other = await q<{ id: string }>(
        `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version) VALUES ($1, $2, 'pqp-eco', '1.0.0') RETURNING id`,
        [world.serverId, world.channels.lobby],
      );
      await seat(world.member, "player", other.rows[0]!.id);
      expect(await status(call("GET", `${BASE}/status?sessionId=${other.rows[0]!.id}`, world.member))).toBe(404);
    });

    it("is a 404 without storage, whatever the flags say", async () => {
      const endpoint = process.env.S3_ENDPOINT;
      delete process.env.S3_ENDPOINT;
      try {
        expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member))).toBe(404);
      } finally {
        process.env.S3_ENDPOINT = endpoint;
      }
    });

    it("the config says saveSync only for Locadora and only where the flag is on", async () => {
      await publishTestApp(modules, world.serverId, { id: "pqp-eco" });
      const on = await appsConfigForServer(world.serverId);
      expect(on.apps.find((app) => app.id === "pqp-locadora")?.saveSync).toBe(true);
      expect(on.apps.find((app) => app.id === "pqp-eco")?.saveSync).toBe(false);
      await flags.setServerFlagOverride("locadora_save_sync", world.serverId, false, { kind: "dashboard" });
      const off = await appsConfigForServer(world.serverId);
      expect(off.apps.find((app) => app.id === "pqp-locadora")?.saveSync).toBe(false);
    });
  });

  describe("status", () => {
    it("creates one salt per account on first use and keeps it", async () => {
      const first = await call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member);
      expect(first).toEqual({ mode: "on", salt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), usage: { used: 0, cap: 8 * 1024 * 1024 } });
      const again = await call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member);
      expect(again.salt).toBe(first.salt);
      await seat(world.insider);
      const other = await call("GET", `${BASE}/status?sessionId=${sessionId}`, world.insider);
      expect(other.salt).not.toBe(first.salt);
    });
  });

  describe("writing", () => {
    it("a presigned PUT and a commit make rev 1, listed without any object name, and the GET serves the bytes", async () => {
      const bytes = randomBytes(300);
      const thumb = randomBytes(40);
      const { save, usage } = await write(world.member, { bytes, thumb });
      expect(save).toMatchObject({ kind: "state", slot: 1, rev: 1, size: 300, sha256: sha(bytes), hasThumb: true, deviceKind: "computer" });
      expect(usage.used).toBe(340);
      const listed = await call("GET", `${BASE}?sessionId=${sessionId}&gameKey=${GAME}`, world.member);
      expect(listed.saves).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain("locadora-saves/");
      expect(JSON.stringify(listed)).not.toContain(world.member.id);
      const down = await call("GET", `${BASE}/${save.id}/download?sessionId=${sessionId}`, world.member);
      const body = Buffer.from(await (await fetch(down.url)).arrayBuffer());
      expect(body.equals(bytes)).toBe(true);
      const picture = Buffer.from(await (await fetch(down.thumbUrl)).arrayBuffer());
      expect(picture.equals(thumb)).toBe(true);
      // the other game's list is its own
      const other = await call("GET", `${BASE}?sessionId=${sessionId}&gameKey=${OTHER_GAME}`, world.member);
      expect(other.saves).toEqual([]);
    });

    it("a second write names rev 1 and makes rev 2; the replaced state's objects are deleted", async () => {
      const first = await write(world.member);
      const keysBefore = [...bucket.objects.keys()];
      const second = await write(world.member, { baseRev: 1 });
      expect(second.save.rev).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const key of keysBefore) expect(bucket.objects.has(key)).toBe(false);
      expect(second.save.id).toBe(first.save.id);
    });

    it("a stale rev is 409 stale_rev with what is on the account now, at the upload and at the commit", async () => {
      await write(world.member);
      const early = await detailOf(call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: randomBytes(8), baseRev: 0 })));
      expect(early).toMatchObject({ status: 409, error: "stale_rev", save: expect.objectContaining({ rev: 1 }) });

      // two devices both start from rev 1; the second commit loses
      const bytesA = randomBytes(20);
      const bytesB = randomBytes(30);
      const a = await call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: bytesA, baseRev: 1 }));
      const b = await call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: bytesB, baseRev: 1 }));
      await putTo(a.put.url, bytesA, a.put.contentType);
      await putTo(b.put.url, bytesB, b.put.contentType);
      const won = await call("POST", `${BASE}/uploads/${a.uploadId}/commit`, world.member, { sessionId });
      expect(won.save.rev).toBe(2);
      const lost = await detailOf(call("POST", `${BASE}/uploads/${b.uploadId}/commit`, world.member, { sessionId }));
      expect(lost).toMatchObject({ status: 409, error: "stale_rev", save: expect.objectContaining({ rev: 2, sha256: sha(bytesA) }) });
      // the loser's object and upload row are gone
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(Number((await q(`SELECT count(*) AS n FROM locadora_save_uploads`)).rows[0]!.n)).toBe(0);
      const stored = [...bucket.objects.values()].map((object) => sha(object.body));
      expect(stored).not.toContain(sha(bytesB));
    });

    it("refuses a commit whose bytes never arrived, or arrived at another length", async () => {
      const bytes = randomBytes(50);
      const upload = await call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes }));
      expect(await status(call("POST", `${BASE}/uploads/${upload.uploadId}/commit`, world.member, { sessionId }))).toBe(400);
      await putTo(upload.put.url, randomBytes(49), upload.put.contentType);
      expect(await status(call("POST", `${BASE}/uploads/${upload.uploadId}/commit`, world.member, { sessionId }))).toBe(400);
    });

    it("refuses a commit of somebody else's upload", async () => {
      const bytes = randomBytes(50);
      const upload = await call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes }));
      await putTo(upload.put.url, bytes, upload.put.contentType);
      await seat(world.insider);
      expect(await status(call("POST", `${BASE}/uploads/${upload.uploadId}/commit`, world.insider, { sessionId }))).toBe(404);
    });

    it("caps a state at 1 MB, a battery save at 256 KB and a thumbnail at 16 KB", async () => {
      const big = { size: 1024 * 1024 + 1, sha256: "a".repeat(64) };
      expect(await status(call("POST", `${BASE}/upload`, world.member, { ...uploadBody({ bytes: randomBytes(1) }), ...big }))).toBe(400);
      expect(
        await status(
          call("POST", `${BASE}/upload`, world.member, { ...uploadBody({ bytes: randomBytes(1) }), kind: "sram", slot: 0, size: 256 * 1024 + 1 }),
        ),
      ).toBe(400);
      expect(
        await status(call("POST", `${BASE}/upload`, world.member, { ...uploadBody({ bytes: randomBytes(1) }), thumbSize: 16 * 1024 + 1 })),
      ).toBe(400);
      // a battery save in a slot other than 0, and a stray key
      expect(await status(call("POST", `${BASE}/upload`, world.member, { ...uploadBody({ bytes: randomBytes(1) }), kind: "sram", slot: 2 }))).toBe(400);
      expect(await status(call("POST", `${BASE}/upload`, world.member, { ...uploadBody({ bytes: randomBytes(1) }), romName: "x" }))).toBe(400);
    });

    it("keeps an account to 8 MB, uploads in flight included", async () => {
      const mb = 1024 * 1024;
      // eight full slots across two games is exactly 8 MB
      for (const [game, slot] of [
        [GAME, 0], [GAME, 1], [GAME, 2], [GAME, 3],
        [OTHER_GAME, 0], [OTHER_GAME, 1], [OTHER_GAME, 2], [OTHER_GAME, 3],
      ] as const) {
        await write(world.member, { bytes: randomBytes(mb), gameKey: game, slot });
      }
      const usage = (await call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member)).usage;
      expect(usage.used).toBe(8 * mb);
      expect(await status(call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: randomBytes(1), slot: 4 })))).toBe(413);
      // replacing a state frees its own bytes first, so an overwrite still fits
      expect((await write(world.member, { bytes: randomBytes(mb), slot: 1, baseRev: 1 })).save.rev).toBe(2);
    });

    it("spends at most 30 writes a minute per account", async () => {
      for (let i = 0; i < 30; i++) {
        expect(await status(call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: randomBytes(4), slot: (i % 4) + 1 })))).toBe(200);
      }
      expect(await status(call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: randomBytes(4) })))).toBe(429);
    });
  });

  describe("the battery save's history", () => {
    it("keeps the three previous versions, deletes the rest, and a restore brings the newest back", async () => {
      const versions = [1, 2, 3, 4, 5].map(() => randomBytes(128));
      let rev = 0;
      for (const bytes of versions) {
        rev = (await write(world.member, { bytes, kind: "sram", slot: 0, baseRev: rev })).save.rev;
      }
      expect(rev).toBe(5);
      const listed = (await call("GET", `${BASE}?sessionId=${sessionId}&gameKey=${GAME}`, world.member)).saves;
      expect(listed[0]).toMatchObject({ kind: "sram", rev: 5, history: 3 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // the current one plus three older ones are in the bucket; the two oldest are gone
      const stored = new Set([...bucket.objects.values()].map((object) => sha(object.body)));
      expect(stored).toEqual(new Set(versions.slice(1).map(sha)));
      expect((await call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member)).usage.used).toBe(4 * 128);

      expect(await status(call("POST", `${BASE}/${listed[0].id}/restore`, world.member, { sessionId, baseRev: 4 }))).toBe(409);
      const { save } = await call("POST", `${BASE}/${listed[0].id}/restore`, world.member, { sessionId, baseRev: 5 });
      expect(save).toMatchObject({ rev: 6, sha256: sha(versions[3]!), history: 3 });
      const down = await call("GET", `${BASE}/${save.id}/download?sessionId=${sessionId}`, world.member);
      expect(Buffer.from(await (await fetch(down.url)).arrayBuffer()).equals(versions[3]!)).toBe(true);
    });
  });

  describe("deleting", () => {
    it("one save, one game, or every save on the account, with their objects", async () => {
      const a = await write(world.member, { slot: 1, thumb: randomBytes(10) });
      await write(world.member, { slot: 2 });
      await write(world.member, { gameKey: OTHER_GAME, slot: 1 });
      expect(bucket.objects.size).toBe(4);

      const one = await call("DELETE", `${BASE}/${a.save.id}?sessionId=${sessionId}`, world.member);
      expect(one.deleted).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bucket.objects.size).toBe(2);
      expect(await status(call("DELETE", `${BASE}/${a.save.id}?sessionId=${sessionId}`, world.member))).toBe(404);

      const game = await call("DELETE", `${BASE}?sessionId=${sessionId}&gameKey=${GAME}`, world.member);
      expect(game.deleted).toBe(1);
      const all = await call("DELETE", `${BASE}?sessionId=${sessionId}`, world.member);
      expect(all).toEqual({ deleted: 1, usage: { used: 0, cap: 8 * 1024 * 1024 } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bucket.objects.size).toBe(0);
    });

    it("never touches another account's saves", async () => {
      await seat(world.insider);
      const theirs = await write(world.insider);
      expect(await status(call("DELETE", `${BASE}/${theirs.save.id}?sessionId=${sessionId}`, world.member))).toBe(404);
      expect(await status(call("GET", `${BASE}/${theirs.save.id}/download?sessionId=${sessionId}`, world.member))).toBe(404);
      await call("DELETE", `${BASE}?sessionId=${sessionId}`, world.member);
      expect((await call("GET", `${BASE}?sessionId=${sessionId}&gameKey=${GAME}`, world.insider)).saves).toHaveLength(1);
    });
  });

  describe("the flag turned off", () => {
    it("keeps reads and deletes for 30 days for an account that used it, and refuses writes", async () => {
      const { save } = await write(world.member);
      await flags.setServerFlagOverride("locadora_save_sync", world.serverId, false, { kind: "dashboard" });
      const status1 = await call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member);
      expect(status1.mode).toBe("read-only");
      expect((await call("GET", `${BASE}?sessionId=${sessionId}&gameKey=${GAME}`, world.member)).saves).toHaveLength(1);
      expect(await status(call("GET", `${BASE}/${save.id}/download?sessionId=${sessionId}`, world.member))).toBe(200);
      expect(await status(call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: randomBytes(4), baseRev: 1 })))).toBe(404);
      // a person who never used it sees nothing at all
      await seat(world.insider);
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.insider))).toBe(404);
      // 31 days after the last use with the flag on, it is gone
      await q(`UPDATE locadora_save_salts SET last_on_at = NOW() - interval '31 days'`);
      expect(await status(call("GET", `${BASE}/status?sessionId=${sessionId}`, world.member))).toBe(404);
    });
  });

  describe("the sweep and the account", () => {
    it("deletes saves unwritten for 365 days and uploads never committed, with their objects", async () => {
      await write(world.member, { slot: 1 });
      const keep = await write(world.member, { slot: 2 });
      await q(`UPDATE locadora_saves SET updated_at = NOW() - interval '366 days' WHERE id <> $1`, [keep.save.id]);
      const pending = await call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: randomBytes(9), slot: 3 }));
      await putTo(pending.put.url, randomBytes(9), pending.put.contentType);
      await q(`UPDATE locadora_save_uploads SET created_at = NOW() - interval '2 hours'`);
      expect(await saves.sweepLocadoraSaves()).toEqual({ saves: 1, uploads: 1 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bucket.objects.size).toBe(1);
      expect((await call("GET", `${BASE}?sessionId=${sessionId}&gameKey=${GAME}`, world.member)).saves.map((s: { slot: number }) => s.slot)).toEqual([2]);
    });

    it("names every object of an account, so deleting the account deletes them", async () => {
      await write(world.member, { slot: 1, thumb: randomBytes(5) });
      await write(world.member, { kind: "sram", slot: 0 });
      await write(world.member, { kind: "sram", slot: 0, baseRev: 1 });
      await call("POST", `${BASE}/upload`, world.member, uploadBody({ bytes: randomBytes(9), slot: 3 }));
      const keys = await saves.accountLocadoraSaveKeys(world.member.id);
      // state + thumb, sram now + sram history, the upload in flight
      expect(keys).toHaveLength(5);
      for (const key of keys) expect(key.startsWith(`locadora-saves/${world.member.id}/`)).toBe(true);
    });
  });
});
