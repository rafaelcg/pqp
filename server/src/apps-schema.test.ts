import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The apps tables (schema.sql, "apps") against a real Postgres, before any
 * service reads them: the boot behaviour pitfall 22 cares about, and the
 * constraints the session engine will rely on without re-testing them.
 * Scratch database only (`TEST_DATABASE_URL`): this suite drops and recreates
 * the apps tables and truncates `users` and `servers`.
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("./db.js");
const { upsertUser } = await import("./services/users.js");
const { createServer } = await import("./services/servers.js");

const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => getPool().query<T>(text, values);

const count = async (text: string, values: unknown[] = []) =>
  Number((await q<{ n: string }>(text, values)).rows[0]!.n);

const APP_TABLES = [
  "app_publishers",
  "apps",
  "app_versions",
  "server_apps",
  "app_sessions",
  "app_session_participants",
  "app_consents",
  "app_admin_audit",
];

const SHA = "a".repeat(64);
const SEAT_A = "seatAAAAAAAAAAAAAAAA"; // 20 chars
const SEAT_B = "seatBBBBBBBBBBBBBBBB";

/** Everything the apps DDL defines, as text, to compare two runs. */
async function appsCatalog(): Promise<string> {
  const columns = await q(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position`,
    [APP_TABLES],
  );
  const indexes = await q(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY($1)
      ORDER BY tablename, indexname`,
    [APP_TABLES],
  );
  const constraints = await q(
    `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = ANY (SELECT ($1::text[])[i]::regclass FROM generate_subscripts($1::text[], 1) AS i)
      ORDER BY 1, 2`,
    [APP_TABLES],
  );
  return JSON.stringify([columns.rows, indexes.rows, constraints.rows]);
}

describeDb("apps tables", () => {
  let ownerId: string;
  let otherId: string;
  let serverId: string;
  let channelId: string;
  let channel2Id: string;

  /** An app and its first version, in one transaction (the FK is deferred). */
  async function seedApp(id = "eco", version = "1.0.0", extra = "") {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO apps (id, publisher_id, status, current_version)
         VALUES ($1, 'pqp', 'live', $2)`,
        [id, version],
      );
      await client.query(
        `INSERT INTO app_versions (app_id, version, manifest, manifest_sha256, entry_sha256)
         VALUES ($1, $2, '{}'::jsonb, $3, $3)`,
        [id, version, SHA],
      );
      if (extra) {
        await client.query(extra);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  const startSession = async (
    channel: string,
    overrides: { state?: string; status?: "live" | "ended" } = {},
  ) =>
    (
      await q<{ id: string }>(
        `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version, started_by, host_user_id, state)
         VALUES ($1, $2, 'eco', '1.0.0', $3, $3, $4::jsonb) RETURNING id`,
        [serverId, channel, ownerId, overrides.state ?? "{}"],
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    await initDb({ mode: "always" });
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    // Cascades into every apps table through the owner and server FKs, and
    // takes the `pqp` publisher with it: the next boot's every-time sweep is
    // what puts it back, which is also what this exercises.
    await q("TRUNCATE users, servers RESTART IDENTITY CASCADE");
    await initDb();
    ownerId = (await upsertUser({ clerkId: "apps_owner", displayName: "Ana", avatarUrl: null })).id;
    otherId = (await upsertUser({ clerkId: "apps_other", displayName: "Bia", avatarUrl: null })).id;
    const created = await createServer("Apps", ownerId);
    serverId = created.server.id;
    const text = created.channels.filter((c) => c.type === "text");
    channelId = text[0]!.id;
    channel2Id = (
      await q<{ id: string }>(
        `INSERT INTO channels (server_id, name, type) VALUES ($1, 'segundo', 'text') RETURNING id`,
        [serverId],
      )
    ).rows[0]!.id;
  });

  describe("boot", () => {
    it("applies on a database that ran the previous schema, and a second run changes nothing", async () => {
      // A database that last ran `main` before this change: no apps tables, a
      // stored hash that differs from the file's.
      await q(`DROP TABLE IF EXISTS ${[...APP_TABLES].reverse().join(", ")} CASCADE`);
      await q("UPDATE schema_boot_state SET schema_hash = 'previous-main' WHERE id = 1");
      const first = await initDb();
      expect(first.outcome).toBe("applied");
      for (const table of APP_TABLES) {
        expect(await count(`SELECT (to_regclass($1) IS NOT NULL)::int AS n`, [table]), table).toBe(1);
      }
      const before = await appsCatalog();

      // Unchanged file, default mode: skipped.
      const second = await initDb();
      expect(second.outcome).toBe("skipped");
      // The rollback mode re-runs the whole file: still nothing different.
      const third = await initDb({ mode: "always" });
      expect(third.outcome).toBe("applied");
      expect(await appsCatalog()).toBe(before);
      expect(await count(`SELECT count(*) AS n FROM app_publishers WHERE id = 'pqp'`)).toBe(1);
    });

    it("creates the tables empty on a fresh database, with the first-party publisher once", async () => {
      await q(`DROP TABLE IF EXISTS ${[...APP_TABLES].reverse().join(", ")} CASCADE`);
      await q("DELETE FROM schema_boot_state");
      const result = await initDb();
      expect(result.outcome).toBe("applied");
      expect(await count(`SELECT count(*) AS n FROM apps`)).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM app_sessions`)).toBe(0);
      const publishers = await q<{ id: string; kind: string; owner_user_id: string | null }>(
        `SELECT id, kind, owner_user_id FROM app_publishers`,
      );
      expect(publishers.rows).toEqual([{ id: "pqp", kind: "first_party", owner_user_id: null }]);
      // Every boot after, applied or skipped, leaves exactly that one row.
      await initDb({ mode: "always" });
      await initDb();
      expect(await count(`SELECT count(*) AS n FROM app_publishers`)).toBe(1);
    });

    it("the every-boot sweep puts the publisher back when a skipped boot finds it gone", async () => {
      await q(`DELETE FROM app_publishers`);
      const result = await initDb();
      expect(result.outcome).toBe("skipped");
      expect(await count(`SELECT count(*) AS n FROM app_publishers WHERE id = 'pqp'`)).toBe(1);
    });
  });

  describe("cascades", () => {
    it("every foreign key onto users, servers, channels or messages has an index that starts with its column and covers every row", async () => {
      // Deleting a server, channel, message or account looks its dependants up
      // by the FK column. An index that only covers live or unfinished rows
      // leaves that delete scanning every retained one.
      const fks = await q<{ tbl: string; col: string; ref: string }>(
        `SELECT c.conrelid::regclass::text AS tbl,
                a.attname AS col,
                c.confrelid::regclass::text AS ref
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f'
            AND c.conrelid = ANY (SELECT ($1::text[])[i]::regclass FROM generate_subscripts($1::text[], 1) AS i)
            AND c.confrelid::regclass::text IN ('users', 'servers', 'channels', 'messages')`,
        [APP_TABLES],
      );
      expect(fks.rows.length).toBeGreaterThanOrEqual(12);
      for (const fk of fks.rows) {
        const found = await q<{ pred: string | null }>(
          `SELECT pg_get_expr(i.indpred, i.indrelid) AS pred
             FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
            WHERE i.indrelid = $1::regclass AND a.attname = $2 AND i.indisvalid`,
          [fk.tbl, fk.col],
        );
        const covering = found.rows.filter(
          (row) => row.pred === null || /^\(?\w+ IS NOT NULL\)?$/.test(row.pred),
        );
        expect(covering.length, `${fk.tbl}.${fk.col} -> ${fk.ref}`).toBeGreaterThan(0);
      }
    });
  });

  describe("apps and versions", () => {
    it("refuses an id that is not a lowercase slug", async () => {
      for (const bad of ["Eco", "e", "-eco", "eco-", "eco_app", "9eco"]) {
        await expect(
          q(`INSERT INTO apps (id, publisher_id) VALUES ($1, 'pqp')`, [bad]),
          bad,
        ).rejects.toMatchObject({ code: "23514" });
      }
    });

    it("current_version must name an existing version of the same app, checked at commit", async () => {
      // A version that does not exist: the insert itself is accepted (the FK
      // is deferred) and the COMMIT is what fails.
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO apps (id, publisher_id, current_version) VALUES ('eco', 'pqp', '9.9.9')`,
        );
        await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
      expect(await count(`SELECT count(*) AS n FROM apps`)).toBe(0);

      // Another app's version does not count either.
      await seedApp("eco", "1.0.0");
      const other = await getPool().connect();
      try {
        await other.query("BEGIN");
        await other.query(`INSERT INTO apps (id, publisher_id) VALUES ('enquete', 'pqp')`);
        await other.query(`UPDATE apps SET current_version = '1.0.0' WHERE id = 'enquete'`);
        await expect(other.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
      } finally {
        await other.query("ROLLBACK").catch(() => {});
        other.release();
      }

      // The app and its first version in one transaction commits, and an app
      // with no version yet (NULL) is allowed.
      await q(`INSERT INTO apps (id, publisher_id) VALUES ('enquete', 'pqp')`);
      expect(await count(`SELECT count(*) AS n FROM apps`)).toBe(2);
    });

    it("rolling current_version back to an older version of the same app works", async () => {
      await seedApp("eco", "1.0.0");
      await q(
        `INSERT INTO app_versions (app_id, version, manifest, manifest_sha256, entry_sha256)
         VALUES ('eco', '1.1.0', '{}'::jsonb, $1, $1)`,
        [SHA],
      );
      await q(`UPDATE apps SET current_version = '1.1.0' WHERE id = 'eco'`);
      await q(`UPDATE apps SET current_version = '1.0.0' WHERE id = 'eco'`);
      const row = await q<{ current_version: string }>(`SELECT current_version FROM apps`);
      expect(row.rows[0]!.current_version).toBe("1.0.0");
    });

    it("refuses a version row with a bad hash or a duplicate version", async () => {
      await seedApp("eco", "1.0.0");
      await expect(
        q(
          `INSERT INTO app_versions (app_id, version, manifest, manifest_sha256, entry_sha256)
           VALUES ('eco', '1.2.0', '{}'::jsonb, 'nope', $1)`,
          [SHA],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        q(
          `INSERT INTO app_versions (app_id, version, manifest, manifest_sha256, entry_sha256)
           VALUES ('eco', '1.0.0', '{}'::jsonb, $1, $1)`,
          [SHA],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("server_apps cascades when its server is deleted, and its app when the app is", async () => {
      await seedApp("eco", "1.0.0");
      await q(`INSERT INTO server_apps (server_id, app_id, operator_enabled) VALUES ($1, 'eco', TRUE)`, [
        serverId,
      ]);
      expect(await count(`SELECT count(*) AS n FROM server_apps`)).toBe(1);
      await q(`DELETE FROM servers WHERE id = $1`, [serverId]);
      expect(await count(`SELECT count(*) AS n FROM server_apps`)).toBe(0);
      // The app itself is not a server's: it stays.
      expect(await count(`SELECT count(*) AS n FROM apps`)).toBe(1);

      const second = (await createServer("Outro", otherId)).server.id;
      await q(`INSERT INTO server_apps (server_id, app_id) VALUES ($1, 'eco')`, [second]);
      const row = await q<{ operator_enabled: boolean | null; owner_enabled: boolean | null }>(
        `SELECT operator_enabled, owner_enabled FROM server_apps WHERE server_id = $1`,
        [second],
      );
      // Undecided is NULL, which availability reads as off.
      expect(row.rows[0]).toEqual({ operator_enabled: null, owner_enabled: null });
    });
  });

  describe("sessions", () => {
    beforeEach(async () => {
      await seedApp("eco", "1.0.0");
    });

    it("refuses a second live session in one channel and allows one after the first ended", async () => {
      const first = await startSession(channelId);
      await expect(startSession(channelId)).rejects.toMatchObject({ code: "23505" });
      // Another channel is free.
      await startSession(channel2Id);
      await q(
        `UPDATE app_sessions SET status = 'ended', ended_at = now(), end_reason = 'host' WHERE id = $1`,
        [first],
      );
      await startSession(channelId);
      expect(
        await count(`SELECT count(*) AS n FROM app_sessions WHERE channel_id = $1`, [channelId]),
      ).toBe(2);
      expect(
        await count(
          `SELECT count(*) AS n FROM app_sessions WHERE channel_id = $1 AND status = 'live'`,
          [channelId],
        ),
      ).toBe(1);
    });

    it("pins a version that exists: an unknown (app, version) is refused", async () => {
      await expect(
        q(
          `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version)
           VALUES ($1, $2, 'eco', '9.9.9')`,
          [serverId, channelId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("keeps state at 16384 bytes and refuses 16385", async () => {
      // The CHECK counts the state as Postgres prints jsonb, which puts a space
      // after a colon: `{"k": ""}` is 9 bytes around the string.
      const overhead = Buffer.byteLength('{"k": ""}');
      const at = `{"k": "${"x".repeat(16384 - overhead)}"}`;
      const over = `{"k": "${"x".repeat(16385 - overhead)}"}`;
      const id = await startSession(channelId, { state: at });
      const stored = await q<{ n: number }>(
        `SELECT octet_length(state::text) AS n FROM app_sessions WHERE id = $1`,
        [id],
      );
      expect(stored.rows[0]!.n).toBe(16384);
      await expect(
        q(`UPDATE app_sessions SET state = $2::jsonb WHERE id = $1`, [id, over]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(startSession(channel2Id, { state: over })).rejects.toMatchObject({
        code: "23514",
      });
      // Multi-byte text counts in bytes, not characters: 8200 two-byte
      // characters is 16400 bytes of text.
      const wide = JSON.stringify({ k: "é".repeat(8200) });
      await expect(
        q(`UPDATE app_sessions SET state = $2::jsonb WHERE id = $1`, [id, wide]),
      ).rejects.toMatchObject({ code: "23514" });
      // The compact form is NOT what is measured: a state that is 16384 bytes
      // of JSON.stringify output is over once Postgres prints it. Code that
      // caps state has to count the canonical form.
      const compact = JSON.stringify({ k: "x".repeat(16384 - Buffer.byteLength('{"k":""}')) });
      expect(Buffer.byteLength(compact)).toBe(16384);
      await expect(
        q(`UPDATE app_sessions SET state = $2::jsonb WHERE id = $1`, [id, compact]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("ended_at and end_reason are set if and only if the session is ended", async () => {
      const live = await startSession(channelId);
      // Ended with no timestamp, or no reason.
      await expect(
        q(`UPDATE app_sessions SET status = 'ended', end_reason = 'host' WHERE id = $1`, [live]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        q(`UPDATE app_sessions SET status = 'ended', ended_at = now() WHERE id = $1`, [live]),
      ).rejects.toMatchObject({ code: "23514" });
      // Live with a timestamp, or with a reason.
      await expect(
        q(`UPDATE app_sessions SET ended_at = now() WHERE id = $1`, [live]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        q(`UPDATE app_sessions SET end_reason = 'host' WHERE id = $1`, [live]),
      ).rejects.toMatchObject({ code: "23514" });
      // A reason outside the list.
      await expect(
        q(
          `UPDATE app_sessions SET status = 'ended', ended_at = now(), end_reason = 'because' WHERE id = $1`,
          [live],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      // Both together, with a known reason.
      await q(
        `UPDATE app_sessions SET status = 'ended', ended_at = now(), end_reason = 'flag-off' WHERE id = $1`,
        [live],
      );
    });

    it("a session's channel deleted takes the session and its seats", async () => {
      const id = await startSession(channelId);
      await q(
        `INSERT INTO app_session_participants (session_id, user_id, seat_id, role)
         VALUES ($1, $2, $3, 'player')`,
        [id, ownerId, SEAT_A],
      );
      await q(`DELETE FROM channels WHERE id = $1`, [channelId]);
      expect(await count(`SELECT count(*) AS n FROM app_sessions`)).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM app_session_participants`)).toBe(0);
    });

    it("a deleted host account leaves the session (host NULL) for the handoff", async () => {
      // The session lives in somebody else's server: the owner's own server
      // goes with the owner's account.
      const second = (await createServer("Outro", otherId)).server;
      const channel = (
        await q<{ id: string }>(
          `INSERT INTO channels (server_id, name, type) VALUES ($1, 'c', 'text') RETURNING id`,
          [second.id],
        )
      ).rows[0]!.id;
      const id = (
        await q<{ id: string }>(
          `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version, started_by, host_user_id)
           VALUES ($1, $2, 'eco', '1.0.0', $3, $3) RETURNING id`,
          [second.id, channel, ownerId],
        )
      ).rows[0]!.id;
      await q(`DELETE FROM users WHERE id = $1`, [ownerId]);
      const row = await q<{ host_user_id: string | null; started_by: string | null }>(
        `SELECT host_user_id, started_by FROM app_sessions WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]).toEqual({ host_user_id: null, started_by: null });
    });
  });

  describe("participants", () => {
    let sessionId: string;

    beforeEach(async () => {
      await seedApp("eco", "1.0.0");
      sessionId = await startSession(channelId);
    });

    const seat = (session: string, user: string, seatId: string, role = "player") =>
      q(
        `INSERT INTO app_session_participants (session_id, user_id, seat_id, role)
         VALUES ($1, $2, $3, $4)`,
        [session, user, seatId, role],
      );

    it("accepts the 16 to 32 character URL-safe alphabet and nothing else", async () => {
      await seat(sessionId, ownerId, "a".repeat(16));
      await seat(sessionId, otherId, "B_-9".repeat(8)); // 32
      const bad = ["a".repeat(15), "a".repeat(33), `${"a".repeat(15)}=`, `${"a".repeat(15)} `, `${"a".repeat(15)}.`, ""];
      const third = (await upsertUser({ clerkId: "apps_third", displayName: "Cris", avatarUrl: null })).id;
      for (const value of bad) {
        await expect(seat(sessionId, third, value), JSON.stringify(value)).rejects.toMatchObject({
          code: "23514",
        });
      }
    });

    it("refuses a role other than player or spectator", async () => {
      await expect(seat(sessionId, ownerId, SEAT_A, "host")).rejects.toMatchObject({
        code: "23514",
      });
      await seat(sessionId, ownerId, SEAT_A, "spectator");
    });

    it("one seat per person per session, and a seat id is unique within its session", async () => {
      await seat(sessionId, ownerId, SEAT_A);
      await expect(seat(sessionId, ownerId, SEAT_B)).rejects.toMatchObject({ code: "23505" });
      await expect(seat(sessionId, otherId, SEAT_A)).rejects.toMatchObject({ code: "23505" });
      await seat(sessionId, otherId, SEAT_B);
    });

    it("participants cascade when the session row is deleted", async () => {
      await seat(sessionId, ownerId, SEAT_A);
      await seat(sessionId, otherId, SEAT_B, "spectator");
      expect(await count(`SELECT count(*) AS n FROM app_session_participants`)).toBe(2);
      await q(`DELETE FROM app_sessions WHERE id = $1`, [sessionId]);
      expect(await count(`SELECT count(*) AS n FROM app_session_participants`)).toBe(0);
    });

    it("a deleted account takes its seat but not the session", async () => {
      await seat(sessionId, otherId, SEAT_B);
      await q(`DELETE FROM users WHERE id = $1`, [otherId]);
      expect(await count(`SELECT count(*) AS n FROM app_session_participants`)).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM app_sessions`)).toBe(1);
    });
  });

  describe("consents and audit", () => {
    it("a consent is one row per person and app, and goes with either", async () => {
      await seedApp("eco", "1.0.0");
      await q(`INSERT INTO app_consents (user_id, app_id, accepted_version) VALUES ($1, 'eco', '1.0.0')`, [
        otherId,
      ]);
      await expect(
        q(`INSERT INTO app_consents (user_id, app_id, accepted_version) VALUES ($1, 'eco', '1.0.0')`, [
          otherId,
        ]),
      ).rejects.toMatchObject({ code: "23505" });
      const row = await q<{ identity_granted: boolean; revoked_at: string | null }>(
        `SELECT identity_granted, revoked_at FROM app_consents`,
      );
      expect(row.rows[0]).toEqual({ identity_granted: false, revoked_at: null });
      await q(`DELETE FROM users WHERE id = $1`, [otherId]);
      expect(await count(`SELECT count(*) AS n FROM app_consents`)).toBe(0);
    });

    it("an audit row outlives the server and the person it names, and refuses an unknown action", async () => {
      await q(
        `INSERT INTO app_admin_audit (actor_kind, actor_user_id, action, app_id, server_id)
         VALUES ('dashboard', $1, 'operator-server', 'eco', $2)`,
        [otherId, serverId],
      );
      await expect(
        q(`INSERT INTO app_admin_audit (actor_kind, action, app_id) VALUES ('dashboard', 'poof', 'eco')`),
      ).rejects.toMatchObject({ code: "23514" });
      await q(`DELETE FROM servers WHERE id = $1`, [serverId]);
      await q(`DELETE FROM users WHERE id = $1`, [otherId]);
      const row = await q<{ server_id: string | null; actor_user_id: string | null }>(
        `SELECT server_id, actor_user_id FROM app_admin_audit`,
      );
      expect(row.rows).toEqual([{ server_id: null, actor_user_id: null }]);
    });
  });
});
