import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The activation funnel, pinned against a real database.
 *
 * Three things a mocked pool could not check and that matter most: every step
 * stamps once and NEVER moves once stamped (a wrong idempotency check corrupts
 * the funnel silently, forever); the cohort counts and conversions are computed
 * correctly from a seeded set of accounts; and the fire sites that are reachable
 * from a service call actually write a row. The steps that only fire from an
 * HTTP route or a WS handler (age gate, handle, first message, first voice,
 * first watch party) are covered here at the seam -- `recordActivationStep`
 * itself -- plus the fire-site edits and `tsc`; driving the full router/socket
 * for each would be a harness test, not a funnel test.
 */

// TEST_DATABASE_URL wins; see the note in api.test.ts and acquisition.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const {
  recordActivationStep,
  resetActivationMemo,
  activationFunnel,
  ACTIVATION_STEPS,
} = await import("./activation.js");

const STEP_COLUMN: Record<string, string> = {
  signup: "signup_at",
  age_gate: "age_gate_at",
  handle: "handle_at",
  first_join: "first_join_at",
  first_message: "first_message_at",
  first_voice: "first_voice_at",
  first_watch_party: "first_watch_party_at",
};

/** A bare account with NO activation row yet -- direct insert, so `upsertUser`'s
 *  own `signup` stamp does not get in the way of a per-step test. */
async function bareUser(clerkId: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO users (clerk_id, display_name) VALUES ($1, $2) RETURNING id`,
    [clerkId, "Test"],
  );
  return result.rows[0]!.id;
}

async function stepAt(userId: string, step: string): Promise<Date | null> {
  const column = STEP_COLUMN[step]!;
  const result = await getPool().query<Record<string, Date | null>>(
    `SELECT ${column} AS ts FROM user_activation WHERE user_id = $1`,
    [userId],
  );
  return (result.rows[0]?.ts as Date | null) ?? null;
}

/** Seed a full activation row with explicit per-step timestamps (or NULL). */
async function seedActivation(
  clerkId: string,
  steps: Partial<Record<string, string>>,
): Promise<void> {
  const userId = await bareUser(clerkId);
  const columns = ["user_id"];
  const values: unknown[] = [userId];
  const placeholders = ["$1"];
  let i = 2;
  for (const step of ACTIVATION_STEPS) {
    const interval = steps[step];
    columns.push(STEP_COLUMN[step]!);
    if (interval) {
      values.push(interval);
      placeholders.push(`now() - $${i}::interval`);
      i += 1;
    } else {
      placeholders.push("NULL");
    }
  }
  await getPool().query(
    `INSERT INTO user_activation (${columns.join(", ")})
     VALUES (${placeholders.join(", ")})`,
    values,
  );
}

describeDb("recordActivationStep", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetActivationMemo();
  });

  afterAll(async () => {
    await closePool();
  });

  it("stamps every step, and a re-stamp never moves the timestamp", async () => {
    for (const step of ACTIVATION_STEPS) {
      const userId = await bareUser(`clerk-${step}`);

      await recordActivationStep(userId, step);
      const first = await stepAt(userId, step);
      expect(first, `${step} was stamped`).not.toBeNull();

      // Force the second call past the in-process memo, so it reaches the DB
      // and the idempotency guarantee is the ON CONFLICT COALESCE, not the memo.
      resetActivationMemo();
      await recordActivationStep(userId, step);
      const second = await stepAt(userId, step);
      expect(second!.getTime(), `${step} did not move`).toBe(first!.getTime());
    }
  });

  it("stamps different steps into the same row without disturbing each other", async () => {
    const userId = await bareUser("clerk-multi");
    await recordActivationStep(userId, "signup");
    const signup = await stepAt(userId, "signup");
    resetActivationMemo();
    await recordActivationStep(userId, "first_message");

    expect(await stepAt(userId, "first_message")).not.toBeNull();
    // The earlier step is untouched, and only one row exists.
    expect((await stepAt(userId, "signup"))!.getTime()).toBe(signup!.getTime());
    const rows = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM user_activation WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("the in-process memo short-circuits a repeat without a second write", async () => {
    const userId = await bareUser("clerk-memo");
    await recordActivationStep(userId, "signup");
    const first = await stepAt(userId, "signup");
    // No resetActivationMemo(): the memo should skip the DB entirely, and even
    // if it did not, COALESCE would keep the value. Either way it must not move.
    await recordActivationStep(userId, "signup");
    expect((await stepAt(userId, "signup"))!.getTime()).toBe(first!.getTime());
  });
});

describeDb("activationFunnel", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetActivationMemo();
  });

  afterAll(async () => {
    await closePool();
  });

  it("counts each step by signup cohort and computes conversion", async () => {
    // Ten accounts signed up two days ago (inside both windows), progressing to
    // varying depths.
    const recent: Array<Partial<Record<string, string>>> = [
      // 8 reach the age gate
      ...Array.from({ length: 8 }, () => ({ signup: "2 days", age_gate: "2 days" })),
      // 2 signed up but never cleared the gate
      ...Array.from({ length: 2 }, () => ({ signup: "2 days" })),
    ];
    // Of the 8 gated: 5 got a handle, 6 joined, 4 messaged, 2 voiced, 1 hosted.
    for (let k = 0; k < 5; k++) recent[k]!.handle = "2 days";
    for (let k = 0; k < 6; k++) recent[k]!.first_join = "2 days";
    for (let k = 0; k < 4; k++) recent[k]!.first_message = "2 days";
    for (let k = 0; k < 2; k++) recent[k]!.first_voice = "2 days";
    recent[0]!.first_watch_party = "2 days";

    for (let k = 0; k < recent.length; k++) {
      await seedActivation(`recent-${k}`, recent[k]!);
    }

    // Three signed up 20 days ago: inside the 30-day window, outside the 7-day.
    await seedActivation("mid-0", { signup: "20 days", age_gate: "20 days" });
    await seedActivation("mid-1", { signup: "20 days", age_gate: "20 days" });
    await seedActivation("mid-2", { signup: "20 days" });

    // Two signed up 100 days ago: outside both windows, must not be counted even
    // though they reached every step.
    await seedActivation("old-0", {
      signup: "100 days",
      age_gate: "100 days",
      handle: "100 days",
      first_join: "100 days",
      first_message: "100 days",
      first_voice: "100 days",
      first_watch_party: "100 days",
    });
    await seedActivation("old-1", { signup: "100 days", age_gate: "100 days" });

    const funnel = await activationFunnel();

    // 7-day cohort: exactly the ten recent accounts.
    expect(funnel.window7d).toEqual({
      signup: 10,
      ageGate: 8,
      handle: 5,
      firstJoin: 6,
      firstMessage: 4,
      firstVoice: 2,
      firstWatchParty: 1,
    });

    // 30-day cohort: the ten recent + three mid, none of the old ones.
    expect(funnel.window30d).toEqual({
      signup: 13,
      ageGate: 10,
      handle: 5,
      firstJoin: 6,
      firstMessage: 4,
      firstVoice: 2,
      firstWatchParty: 1,
    });

    // Conversion is a share of the previous step, on the 30-day cohort.
    expect(funnel.conversion30d.signupToAgeGate).toBeCloseTo(10 / 13, 3);
    expect(funnel.conversion30d.ageGateToHandle).toBeCloseTo(5 / 10, 3);
    expect(funnel.conversion30d.firstMessageToFirstVoice).toBeCloseTo(2 / 4, 3);
    expect(funnel.conversion30d.signupToFirstMessage).toBeCloseTo(4 / 13, 3);
  });

  it("is all-zero and divide-by-zero-safe with no accounts", async () => {
    const funnel = await activationFunnel();
    expect(funnel.window7d.signup).toBe(0);
    expect(funnel.window30d.firstWatchParty).toBe(0);
    // No cohort => every conversion is 0, not NaN.
    expect(funnel.conversion30d.signupToFirstMessage).toBe(0);
    expect(funnel.conversion30d.signupToAgeGate).toBe(0);
  });
});

describeDb("activation fire-site wiring", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetActivationMemo();
  });

  afterAll(async () => {
    await closePool();
  });

  it("upsertUser stamps `signup` for a genuinely new account", async () => {
    const user = await upsertUser({
      clerkId: "clerk-signup-wiring",
      displayName: "Ana",
      avatarUrl: null,
    });
    expect(await stepAt(user.id, "signup")).not.toBeNull();
  });

  it("createServer stamps `first_join` for the owner", async () => {
    const owner = await upsertUser({
      clerkId: "clerk-owner-wiring",
      displayName: "Bia",
      avatarUrl: null,
    });
    await createServer("Bia's server", owner.id);
    expect(await stepAt(owner.id, "first_join")).not.toBeNull();
  });
});
