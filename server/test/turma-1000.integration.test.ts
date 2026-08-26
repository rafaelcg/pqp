import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TURMA_1000_BADGE } from "@pqp/shared";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Turma dos 1000 stamp (DB-backed)", () => {
  let db: typeof import("../dist/db.js");
  let users: typeof import("../dist/services/users.js");
  let badges: typeof import("../dist/services/badges.js");
  let feedback: typeof import("../dist/services/feedback.js");

  beforeAll(async () => {
    db = await import("../dist/db.js");
    await db.initDb();
    users = await import("../dist/services/users.js");
    badges = await import("../dist/services/badges.js");
    feedback = await import("../dist/services/feedback.js");
  });

  afterEach(async () => {
    await db.getPool().query(
      `DELETE FROM users WHERE clerk_id LIKE 'test_turma_%'`,
    );
    await db.getPool().query(`DELETE FROM user_badges WHERE badge = $1`, [
      TURMA_1000_BADGE,
    ]);
  });

  const makeUser = (name: string) =>
    users.upsertUser({
      clerkId: `test_turma_${randomUUID()}`,
      displayName: name,
      avatarUrl: null,
    });

  async function humanCount(): Promise<number> {
    const result = await db.getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users
        WHERE NOT is_webhook AND NOT is_character`,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function setCreatedAt(userId: string, at: string): Promise<void> {
    await db.getPool().query(`UPDATE users SET created_at = $2 WHERE id = $1`, [
      userId,
      at,
    ]);
  }

  async function ordinalOf(userId: string): Promise<number | null> {
    const result = await db.getPool().query<{ ordinal: number | null }>(
      `SELECT ordinal FROM user_badges WHERE user_id = $1 AND badge = $2`,
      [userId, TURMA_1000_BADGE],
    );
    return result.rows[0]?.ordinal ?? null;
  }

  it("refuses while there are fewer humans than the threshold", async () => {
    const n = await humanCount();
    const result = await badges.stampTurma1000({ minHumans: n + 1, take: 3 });
    expect(result).toEqual({ status: "too_soon", granted: 0 });
  });

  it("numbers the oldest humans by created_at then id, and skips the house cast", async () => {
    const early = await makeUser("TurmaEarly");
    const mid = await makeUser("TurmaMid");
    const late = await makeUser("TurmaLate");
    const cast = await makeUser("TurmaCast");
    const hook = await makeUser("TurmaHook");

    // Dates older than anything a normal test fixture would use, so a `take`
    // of 3 lands on these three even when the shared database already has
    // other humans.
    await setCreatedAt(early.id, "0001-03-01T00:00:00Z");
    await setCreatedAt(mid.id, "0001-03-02T00:00:00Z");
    await setCreatedAt(late.id, "0001-03-03T00:00:00Z");
    await db.getPool().query(
      `UPDATE users SET is_character = TRUE, created_at = $2 WHERE id = $1`,
      [cast.id, "0001-01-01T00:00:00Z"],
    );
    await db.getPool().query(
      `UPDATE users SET is_webhook = TRUE, created_at = $2 WHERE id = $1`,
      [hook.id, "0001-01-02T00:00:00Z"],
    );

    const result = await badges.stampTurma1000({ minHumans: 3, take: 3 });
    expect(result).toEqual({ status: "granted", granted: 3 });
    expect(await ordinalOf(early.id)).toBe(1);
    expect(await ordinalOf(mid.id)).toBe(2);
    expect(await ordinalOf(late.id)).toBe(3);
    expect(await ordinalOf(cast.id)).toBeNull();
    expect(await ordinalOf(hook.id)).toBeNull();

    expect(await feedback.listUserAchievements(early.id)).toEqual([
      { badge: TURMA_1000_BADGE, name: "Turma dos 1000", ordinal: 1 },
    ]);
  });

  it("is a no-op the second time, including after a stamped user is deleted", async () => {
    const a = await makeUser("TurmaKeep");
    const b = await makeUser("TurmaKeepB");
    const doomed = await makeUser("TurmaDoomed");
    await setCreatedAt(a.id, "0001-04-01T00:00:00Z");
    await setCreatedAt(b.id, "0001-04-02T00:00:00Z");
    await setCreatedAt(doomed.id, "0001-04-03T00:00:00Z");

    await badges.stampTurma1000({ minHumans: 3, take: 3 });
    expect(await ordinalOf(doomed.id)).toBe(3);

    await db.getPool().query(`DELETE FROM users WHERE id = $1`, [doomed.id]);
    expect(await badges.stampTurma1000({ minHumans: 3, take: 3 })).toEqual({
      status: "already",
      granted: 0,
    });

    const bornAfter = await makeUser("TurmaAfter");
    await setCreatedAt(bornAfter.id, "0001-04-04T00:00:00Z");
    expect(await badges.stampTurma1000({ minHumans: 3, take: 3 })).toEqual({
      status: "already",
      granted: 0,
    });
    expect(await ordinalOf(bornAfter.id)).toBeNull();
  });
});
