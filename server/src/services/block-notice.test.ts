import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A block reaches the operators (App Store guideline 1.2): a structured log
 * line, a counter, and one instance-queue ticket per blocked person. None of it
 * may carry message text, and none of it may fail the block.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { blockUser } = await import("./blocks.js");
const {
  BLOCK_REPORT_PLACE,
  BLOCK_REPORTS_PER_DAY,
  blockMetrics,
  noteBlockForOperators,
  resetBlockMetricsForTests,
} = await import("./block-notice.js");
const { listInstanceReports } = await import("./reports.js");

describeDb("telling the operators about a block", () => {
  let nuisance: { id: string };
  let alice: { id: string };
  let bob: { id: string };

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    resetBlockMetricsForTests();
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    nuisance = await makeUser("nuisance");
    alice = await makeUser("alice");
    bob = await makeUser("bob");
  });

  async function openBlockTickets() {
    const { reports } = await listInstanceReports({ status: "open", limit: 50 });
    return reports.filter((report) => report.channelName === BLOCK_REPORT_PLACE);
  }

  it("files one instance-queue ticket naming the blocked account, with no reporter and no text", async () => {
    await blockUser(alice.id, nuisance.id);
    await noteBlockForOperators({
      blockerId: alice.id,
      blockedUserId: nuisance.id,
      surface: "message",
    });

    const tickets = await openBlockTickets();
    expect(tickets).toHaveLength(1);
    const ticket = tickets[0]!;
    expect(ticket.reportedUserId).toBe(nuisance.id);
    expect(ticket.subjectType).toBe("user");
    expect(ticket.contextKind).toBe("none");
    expect(ticket.reason).toBe("other");
    // Nobody filed it: the blocker is not exposed as an accuser.
    expect(ticket.reporterId).toBeNull();
    // A user report carries no message body.
    expect(ticket.contentSnapshot).toBeNull();
    expect(blockMetrics()).toMatchObject({ blocks: 1, reportsFiled: 1 });
  });

  it("does not pile up: a second blocker of the same account adds no second ticket", async () => {
    await blockUser(alice.id, nuisance.id);
    await noteBlockForOperators({ blockerId: alice.id, blockedUserId: nuisance.id });
    await blockUser(bob.id, nuisance.id);
    await noteBlockForOperators({ blockerId: bob.id, blockedUserId: nuisance.id });

    expect(await openBlockTickets()).toHaveLength(1);
    expect(blockMetrics()).toMatchObject({ blocks: 2, reportsFiled: 1 });
  });

  it("re-arms once a moderator has closed the ticket", async () => {
    await blockUser(alice.id, nuisance.id);
    await noteBlockForOperators({ blockerId: alice.id, blockedUserId: nuisance.id });
    const [ticket] = await openBlockTickets();
    await getPool().query(
      `UPDATE reports SET status = 'dismissed', resolved_at = NOW() WHERE id = $1`,
      [ticket!.id],
    );

    await blockUser(bob.id, nuisance.id);
    await noteBlockForOperators({ blockerId: bob.id, blockedUserId: nuisance.id });
    expect(await openBlockTickets()).toHaveLength(1);
  });

  it("logs one structured line with ids and surface and nothing else", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await blockUser(alice.id, nuisance.id);
      await noteBlockForOperators({
        blockerId: alice.id,
        blockedUserId: nuisance.id,
        surface: "profile",
      });
      const lines = log.mock.calls.map((call) => String(call[0]));
      const line = lines.find((one) => one.includes("social.block"));
      expect(line).toBe(
        `[pqp] social.block blocker=${alice.id} blocked=${nuisance.id} surface=profile queued=true capped=false`,
      );
    } finally {
      log.mockRestore();
    }
  });

  it(`stops queueing past ${BLOCK_REPORTS_PER_DAY} blocks in a day, and still counts them`, async () => {
    for (let i = 0; i <= BLOCK_REPORTS_PER_DAY; i++) {
      const target = await upsertUser({
        clerkId: `clerk_target_${i}`,
        displayName: `target${i}`,
        avatarUrl: null,
      });
      await blockUser(alice.id, target.id);
      await noteBlockForOperators({ blockerId: alice.id, blockedUserId: target.id });
    }
    const metrics = blockMetrics();
    expect(metrics.blocks).toBe(BLOCK_REPORTS_PER_DAY + 1);
    expect(metrics.reportsFiled).toBe(BLOCK_REPORTS_PER_DAY);
    expect(metrics.reportsCapped).toBe(1);
    expect(await openBlockTickets()).toHaveLength(BLOCK_REPORTS_PER_DAY);
  });

  it("never throws: a failing queue write is counted and the block stands", async () => {
    await blockUser(alice.id, nuisance.id);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        noteBlockForOperators({
          blockerId: alice.id,
          // Not a uuid: the cap query is fine, the insert is not.
          blockedUserId: "not-a-uuid",
        }),
      ).resolves.toBeUndefined();
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    expect(blockMetrics().failures).toBe(1);
  });
});
