import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

// DB-backed like acl.integration.test.ts: runs only when DATABASE_URL is set.
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("feedback + caça-bugs badge (DB-backed)", () => {
  let db: typeof import("../dist/db.js");
  let users: typeof import("../dist/services/users.js");
  let feedback: typeof import("../dist/services/feedback.js");

  beforeAll(async () => {
    db = await import("../dist/db.js");
    await db.initDb();
    users = await import("../dist/services/users.js");
    feedback = await import("../dist/services/feedback.js");
  });

  const makeUser = (name: string) =>
    users.upsertUser({
      clerkId: `test_${randomUUID()}`,
      displayName: name,
      avatarUrl: null,
    });

  it("stores feedback and lists it newest-first", async () => {
    const author = await makeUser("Feedbacker");
    const first = await feedback.createFeedback(author.id, {
      kind: "idea",
      body: "make it louder",
    });
    const second = await feedback.createFeedback(author.id, {
      kind: "bug",
      body: "it is too loud",
    });

    const { items } = await feedback.listFeedback({ limit: 50 });
    const ids = items.map((item) => item.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(items.find((item) => item.id === second.id)?.status).toBe("open");
  });

  it("confirming a bug grants the caça-bugs badge exactly once", async () => {
    const hunter = await makeUser("Hunter");
    const bugA = await feedback.createFeedback(hunter.id, {
      kind: "bug",
      body: "chip stretches across the cell",
    });
    const bugB = await feedback.createFeedback(hunter.id, {
      kind: "bug",
      body: "another one",
    });

    expect(await feedback.listUserAchievements(hunter.id)).toEqual([]);

    const confirmed = await feedback.resolveFeedback(bugA.id, "confirmed");
    expect(confirmed?.status).toBe("confirmed");
    expect(await feedback.listUserAchievements(hunter.id)).toEqual([
      { badge: "caca-bugs", name: "Caça-bugs", ordinal: null },
    ]);

    // A second confirmed catch changes nothing — the badge is idempotent.
    await feedback.resolveFeedback(bugB.id, "confirmed");
    expect(await feedback.listUserAchievements(hunter.id)).toHaveLength(1);
  });

  it("confirming an idea grants nothing, and closing grants nothing", async () => {
    const thinker = await makeUser("Thinker");
    const idea = await feedback.createFeedback(thinker.id, {
      kind: "idea",
      body: "voice notes",
    });
    const bug = await feedback.createFeedback(thinker.id, {
      kind: "bug",
      body: "not actually a bug",
    });

    await feedback.resolveFeedback(idea.id, "confirmed");
    await feedback.resolveFeedback(bug.id, "closed");
    expect(await feedback.listUserAchievements(thinker.id)).toEqual([]);
  });

  it("returns null for a feedback id that does not exist", async () => {
    expect(await feedback.resolveFeedback("999999999", "closed")).toBeNull();
  });
});
