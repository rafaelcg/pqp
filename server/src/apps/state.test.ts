import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@pqp/shared";
import { testManifest } from "./testing.js";
import { applyMergePatch, compactBytes, containsNul, stateCap } from "./state.js";

/**
 * The session state: the merge itself (the RFC 7396 appendix, line by line),
 * the byte cap, and the coalescing writer driven by a fake clock against a real
 * Postgres. Scratch database only (`TEST_DATABASE_URL`).
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

describe("applyMergePatch (RFC 7396, appendix A)", () => {
  const cases: Array<[string, string, string]> = [
    ['{"a":"b"}', '{"a":"c"}', '{"a":"c"}'],
    ['{"a":"b"}', '{"b":"c"}', '{"a":"b","b":"c"}'],
    ['{"a":"b"}', '{"a":null}', "{}"],
    ['{"a":"b","b":"c"}', '{"a":null}', '{"b":"c"}'],
    ['{"a":["b"]}', '{"a":"c"}', '{"a":"c"}'],
    ['{"a":"c"}', '{"a":["b"]}', '{"a":["b"]}'],
    ['{"a":{"b":"c"}}', '{"a":{"b":"d","c":null}}', '{"a":{"b":"d"}}'],
    ['{"a":[{"b":"c"}]}', '{"a":[1]}', '{"a":[1]}'],
    ['["a","b"]', '["c","d"]', '["c","d"]'],
    ['{"a":"b"}', '["c"]', '["c"]'],
    ['{"a":"foo"}', "null", "null"],
    ['{"a":"foo"}', '"bar"', '"bar"'],
    ['{"e":null}', '{"a":1}', '{"e":null,"a":1}'],
    ["[1,2]", '{"a":"b","c":null}', '{"a":"b"}'],
    ["{}", '{"a":{"bb":{"ccc":null}}}', '{"a":{"bb":{}}}'],
  ];
  it.each(cases)("%s + %s = %s", (target, patch, expected) => {
    expect(JSON.stringify(applyMergePatch(JSON.parse(target), JSON.parse(patch)))).toBe(expected);
  });

  it("changes neither argument", () => {
    const target = { a: { b: 1 } } as JsonValue;
    const patch = { a: { b: null, c: 2 } } as JsonValue;
    const before = JSON.stringify([target, patch]);
    applyMergePatch(target, patch);
    expect(JSON.stringify([target, patch])).toBe(before);
  });

  it("keeps `__proto__` as an own data key and never touches a prototype", () => {
    const out = applyMergePatch({}, JSON.parse('{"__proto__":{"polluted":1},"a":1}')) as Record<
      string,
      JsonValue
    >;
    expect(Object.keys(out).sort()).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":1},"a":1}');
  });
});

describe("the cap and the NUL check", () => {
  it("counts compact UTF-8 bytes of the parsed value", () => {
    expect(compactBytes(JSON.parse('{ "k" : "1234567890" }'))).toBe(18);
    expect(compactBytes({ e: "é" })).toBe('{"e":"é"}'.length + 1);
    expect(compactBytes(JSON.parse("1e-300"))).toBe(6);
  });

  it("is the manifest's maxBytes, never above the platform's 16384", () => {
    expect(stateCap(testManifest({ state: { maxBytes: 100 } }))).toBe(100);
    expect(stateCap(testManifest({ state: { maxBytes: 16384 } }))).toBe(16384);
  });

  it("finds U+0000 in a string, a key, an array and a nested object", () => {
    expect(containsNul("a\u0000b")).toBe(true);
    expect(containsNul({ ["k\u0000"]: 1 })).toBe(true);
    expect(containsNul({ a: [{ b: "x\u0000" }] })).toBe(true);
    expect(containsNul({ a: "plain", b: [1, null, true] })).toBe(false);
  });
});

describeDb("the coalescing writer", () => {
  const dbMod = import("../db.js");
  let getPool: (typeof import("../db.js"))["getPool"];
  let createStateWriter: (typeof import("./state.js"))["createStateWriter"];
  let sessionId: string;

  const manifest = testManifest({
    state: { maxBytes: 200, maxWritesPerSecond: 10, writers: "participants" },
  });

  beforeAll(async () => {
    const db = await dbMod;
    getPool = db.getPool;
    await db.initDb();
    ({ createStateWriter } = await import("./state.js"));
  });

  afterAll(async () => {
    await (await dbMod).closePool();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query(`TRUNCATE app_sessions, app_session_participants, app_versions, apps,
                              channels, servers, users RESTART IDENTITY CASCADE`);
    await pool.query(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    const { upsertUser } = await import("../services/users.js");
    const { createServer } = await import("../services/servers.js");
    const { loadAppCatalog } = await import("./catalog.js");
    const { testCatalogEntry } = await import("./testing.js");
    const user = await upsertUser({ clerkId: `clerk_state_${Date.now()}`, displayName: "U", avatarUrl: null });
    const { server, channels } = await createServer("Hall", user.id);
    await loadAppCatalog({ entries: [testCatalogEntry(manifest)], dev: false });
    sessionId = (
      await pool.query<{ id: string }>(
        `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version, started_by, host_user_id)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
        [server.id, channels[0]!.id, manifest.id, manifest.version, user.id],
      )
    ).rows[0]!.id;
    hostId = user.id;
  });

  let hostId: string;

  /** A writer whose clock and timers the test drives. */
  function rig(overrides: Partial<Parameters<typeof createStateWriter>[0]> = {}) {
    const clock = { t: 1_000 };
    const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
    const committed: Array<{ rev: number; value: JsonValue }> = [];
    const refused: Array<{ code: string; patch: JsonValue }> = [];
    let writes = 0;
    let coalesced = 0;
    const writer = createStateWriter({
      manifest,
      sessionId,
      now: () => clock.t,
      schedule: (run, delayMs) => {
        const handle = { at: clock.t + delayMs, run, live: true };
        timers.push(handle);
        return handle;
      },
      cancel: (handle) => {
        (handle as { live: boolean }).live = false;
      },
      committed: (_id, rev, value) => committed.push({ rev, value }),
      refused: (item, code) => refused.push({ code, patch: item.patch }),
      onWrite: () => {
        writes += 1;
      },
      onCoalesced: (n) => {
        coalesced += n;
      },
      ...overrides,
    });
    /** Move the clock and run every timer that is due, then wait for the write. */
    async function advance(ms: number): Promise<void> {
      clock.t += ms;
      for (const timer of timers.filter((entry) => entry.live && entry.at <= clock.t)) {
        timer.live = false;
        timer.run();
      }
      await writer.idle();
      await new Promise((resolve) => setImmediate(resolve));
      await writer.idle();
    }
    return { writer, clock, timers, committed, refused, advance, counts: () => ({ writes, coalesced }) };
  }

  const player = (patch: JsonValue, baseRev?: number) => ({
    userId: "00000000-0000-4000-8000-000000000001",
    role: "player" as const,
    baseRev,
    patch,
    socket: {},
  });
  const host = (patch: JsonValue) => ({ ...player(patch), userId: hostId });
  const row = async () =>
    (
      await getPool().query<{ state: JsonValue; state_rev: string }>(
        `SELECT state, state_rev FROM app_sessions WHERE id = $1`,
        [sessionId],
      )
    ).rows[0]!;

  it("a synchronous burst is one write, in arrival order, the last value winning", async () => {
    const t = rig();
    for (let i = 0; i < 10; i += 1) {
      t.writer.submit(host({ x: i, [`k${i}`]: true }));
    }
    await t.advance(0);
    expect(t.counts()).toEqual({ writes: 1, coalesced: 9 });
    expect(t.committed).toHaveLength(1);
    expect(t.committed[0]!.rev).toBe(1);
    const stored = await row();
    expect(stored.state_rev).toBe("1");
    expect((stored.state as Record<string, JsonValue>).x).toBe(9);
    expect(Object.keys(stored.state as object).sort()).toEqual(
      ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "x"].sort(),
    );
  });

  it("holds writes to maxWritesPerSecond: a window of 100 ms, then the waiting patches go together", async () => {
    const t = rig();
    t.writer.submit(host({ a: 1 }));
    await t.advance(0);
    expect(t.committed.map((c) => c.rev)).toEqual([1]);

    // 50 ms later, three more: they wait for the window that opened at 0.
    await t.advance(50);
    t.writer.submit(host({ a: 2 }));
    t.writer.submit(host({ b: 1 }));
    t.writer.submit(host({ a: 3 }));
    await t.advance(49);
    expect(t.committed).toHaveLength(1);
    await t.advance(1);
    expect(t.committed.map((c) => c.rev)).toEqual([1, 2]);
    expect((await row()).state).toEqual({ a: 3, b: 1 });
  });

  it("never exceeds the rate however fast patches arrive", async () => {
    const t = rig();
    for (let ms = 0; ms < 1000; ms += 5) {
      t.writer.submit(host({ n: ms }));
      await t.advance(5);
    }
    await t.advance(200);
    expect(t.counts().writes).toBeLessThanOrEqual(11);
    expect(t.counts().writes).toBeGreaterThanOrEqual(9);
    expect((await row()).state).toEqual({ n: 995 });
  });

  it("a compare-and-set is written alone and at once, or refused as rate-limited", async () => {
    const t = rig();
    t.writer.submit(host({ a: 1 }));
    await t.advance(0);
    // Inside the window: refused, nothing written.
    t.writer.submit(host({ a: 2 }));
    t.writer.submit(player({ a: 9 }, 1));
    expect(t.refused).toEqual([{ code: "rate-limited", patch: { a: 9 } }]);
    await t.advance(100);
    // Window open again: the waiting patch went through first (rev 2); now a
    // CAS on the right revision applies and a stale one is stale-rev.
    expect((await row()).state_rev).toBe("2");
    // That write opened a window of its own: the CAS waits it out.
    await t.advance(100);
    t.writer.submit(player({ a: 3 }, 2));
    await t.advance(0);
    expect((await row()).state).toEqual({ a: 3 });
    await t.advance(100);
    t.writer.submit(player({ a: 4 }, 2));
    await t.advance(0);
    expect(t.refused.at(-1)).toEqual({ code: "stale-rev", patch: { a: 4 } });
    expect((await row()).state).toEqual({ a: 3 });
  });

  it("refuses the patch that would pass the cap and keeps applying the rest of the batch", async () => {
    const t = rig();
    t.writer.submit(host({ keep: "yes" }));
    t.writer.submit(host({ big: "x".repeat(300) }));
    t.writer.submit(host({ also: "kept" }));
    await t.advance(0);
    expect(t.refused).toEqual([{ code: "too-large", patch: { big: "x".repeat(300) } }]);
    expect((await row()).state).toEqual({ keep: "yes", also: "kept" });
    expect(t.committed).toHaveLength(1);
  });

  it("holds at most 100 waiting patches", async () => {
    const t = rig();
    for (let i = 0; i < 105; i += 1) {
      t.writer.submit(host({ i }));
    }
    expect(t.refused.filter((r) => r.code === "rate-limited")).toHaveLength(5);
    await t.advance(0);
    expect((await row()).state).toEqual({ i: 99 });
  });

  it("a session that ended refuses everything as `ended`", async () => {
    const t = rig();
    await getPool().query(
      `UPDATE app_sessions SET status = 'ended', ended_at = NOW(), end_reason = 'host' WHERE id = $1`,
      [sessionId],
    );
    t.writer.submit(host({ a: 1 }));
    await t.advance(0);
    expect(t.refused).toEqual([{ code: "ended", patch: { a: 1 } }]);
    expect(t.committed).toEqual([]);
  });

  it("a pool that cannot hand out a connection tells every sender unavailable", async () => {
    const t = rig();
    const connect = vi.spyOn(getPool(), "connect").mockRejectedValueOnce(new Error("pool down"));
    t.writer.submit(host({ a: 1 }));
    t.writer.submit(player({ b: 2 }));
    await t.advance(0);
    connect.mockRestore();
    expect(t.refused.map((r) => r.code)).toEqual(["unavailable", "unavailable"]);
    expect((await row()).state_rev).toBe("0");
  });

  it("dispose drops what waits and stops the timer", async () => {
    const t = rig();
    t.writer.submit(host({ a: 1 }));
    t.writer.dispose();
    expect(t.timers.every((timer) => !timer.live)).toBe(true);
    await t.advance(1000);
    expect((await row()).state_rev).toBe("0");
  });
});
