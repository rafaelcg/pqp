import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Reporting, pinned at its permission boundaries.
 *
 * The interesting failures in this feature are all disclosure failures, and
 * every one of them is asserted here rather than left to a route reading
 * correctly:
 *
 *   * a server's owner and admins must never see a report about a conversation
 *     — that is the whole reason `channelVisibleSql` has no role escape hatch
 *     on its conversation branch, and a report is a *copy* of the content, so
 *     leaking it here would defeat the predicate entirely;
 *   * a plain member must not be able to read a queue at all;
 *   * a reporter must not be able to file a report about something they cannot
 *     see, or the endpoint becomes an existence oracle for message ids;
 *   * the report must outlive the message it is about, because deleting that
 *     message is the first thing both a moderator and an offender do.
 *
 * Route-level checks go through the real router with only the identity layer
 * stubbed, the same way api.test.ts does — a service function that scopes
 * correctly is worth nothing if the route in front of it does not gate.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

/** The identity the next HTTP request will authenticate as. */
let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  verifyAuthHeader: async () => null,
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer, createChannel } = await import(
  "./servers.js"
);
const { createMessage, deleteMessage } = await import("./messages.js");
const { openConversation } = await import("./dms.js");
const {
  createReport,
  isInstanceModerator,
  listInstanceReports,
  listReportsByReporter,
  listServerReports,
  ReportTargetNotVisibleError,
  resolveReport,
} = await import("./reports.js");

let httpServer: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const PAGE = { limit: 25 };

describeDb("reports", () => {
  let owner: { id: string; clerk_id: string };
  let admin: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let nuisance: { id: string; clerk_id: string };
  let outsider: { id: string; clerk_id: string };
  let operator: { id: string; clerk_id: string };

  let serverId: string;
  let channelId: string;
  let privateChannelId: string;
  let dmChannelId: string;

  beforeAll(async () => {
    await initDb();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetApiRateLimits();
    delete process.env.INSTANCE_MODERATOR_CLERK_IDS;

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    owner = await makeUser("owner");
    admin = await makeUser("admin");
    member = await makeUser("member");
    nuisance = await makeUser("nuisance");
    outsider = await makeUser("outsider");
    operator = await makeUser("operator");

    const created = await createChatServer("Reports", owner.id);
    serverId = created.server.id;
    channelId = created.channels.find((c) => c.type === "text")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`,
      [serverId, admin.id, member.id, nuisance.id],
    );
    privateChannelId = (await createChannel(serverId, "secret", "text", true))
      .id;

    // A conversation between two people who share the server — which is what
    // makes them reachable at all — and which the server's owner and admin are
    // nevertheless not part of.
    dmChannelId = (await openConversation(member.id, [nuisance.id])).channelId;
  });

  async function dbUser(userId: string) {
    const result = await getPool().query(`SELECT * FROM users WHERE id = $1`, [
      userId,
    ]);
    return result.rows[0]!;
  }

  async function say(
    channel: string,
    authorId: string,
    body: string,
  ): Promise<string> {
    const created = await createMessage(channel, await dbUser(authorId), body);
    expect(created).not.toBeNull();
    return created!.id;
  }

  // --------------------------------------------------------------- routing

  it("files a server-channel report into that server's queue", async () => {
    const messageId = await say(channelId, nuisance.id, "buy followers");
    const { report, duplicate } = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "spam",
      details: "third time today",
    });

    expect(duplicate).toBe(false);
    expect(report.contextKind).toBe("server");
    expect(report.reportedUserId).toBe(nuisance.id);
    expect(report.contentSnapshot).toBe("buy followers");
    expect(report.status).toBe("open");

    const queue = await listServerReports(serverId, PAGE);
    expect(queue.reports.map((r) => r.id)).toEqual([report.id]);
  });

  /**
   * The crux. A conversation has no owner, so a report about one has no server
   * id to be filed under — and the server-scoped query is `server_id = $1`,
   * which cannot match a NULL however the query is later rewritten.
   */
  it("keeps a conversation report out of every server queue", async () => {
    const messageId = await say(dmChannelId, nuisance.id, "leave me alone");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "harassment",
    });

    expect(report.contextKind).toBe("dm");

    const queue = await listServerReports(serverId, PAGE);
    expect(queue.reports).toEqual([]);

    // It is not lost — it went to the instance queue, which no server role
    // reaches.
    const instance = await listInstanceReports(PAGE);
    expect(instance.reports.map((r) => r.id)).toEqual([report.id]);
  });

  it("stores no server id on a conversation report, at the row level", async () => {
    const messageId = await say(dmChannelId, nuisance.id, "leave me alone");
    await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "harassment",
    });

    const rows = await getPool().query<{
      server_id: string | null;
      context_kind: string;
    }>(`SELECT server_id, context_kind FROM reports`);
    expect(rows.rows).toEqual([{ server_id: null, context_kind: "dm" }]);
  });

  it("refuses a row that claims a conversation context and a server", async () => {
    // The permission story rests on this constraint, so it is asserted rather
    // than assumed: no future code path may write the combination that would
    // put a DM report into a server queue.
    await expect(
      getPool().query(
        `INSERT INTO reports (reporter_id, subject_type, context_kind,
           reported_user_id, server_id, content_snapshot, reason)
         VALUES ($1, 'message', 'dm', $2, $3, 'smuggled', 'harassment')`,
        [member.id, nuisance.id, serverId],
      ),
    ).rejects.toThrow();
  });

  // ----------------------------------------------------------- visibility

  it("refuses a report about a message the reporter cannot see", async () => {
    const messageId = await say(privateChannelId, owner.id, "internal only");

    await expect(
      createReport({
        subjectType: "message",
        reporterId: member.id,
        messageId,
        reason: "spam",
      }),
    ).rejects.toBeInstanceOf(ReportTargetNotVisibleError);

    expect((await listServerReports(serverId, PAGE)).reports).toEqual([]);
  });

  it("answers the same 404 for an unseeable message and a nonexistent one", async () => {
    const messageId = await say(privateChannelId, owner.id, "internal only");

    const hidden = await call(member, "POST", "/api/reports", {
      subjectType: "message",
      messageId,
      reason: "spam",
    });
    const absent = await call(member, "POST", "/api/reports", {
      subjectType: "message",
      messageId: "00000000-0000-0000-0000-000000000000",
      reason: "spam",
    });

    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(hidden.body).toEqual(absent.body);
  });

  it("refuses a user report about somebody the reporter shares nothing with", async () => {
    await expect(
      createReport({
        subjectType: "user",
        reporterId: outsider.id,
        userId: nuisance.id,
        reason: "harassment",
      }),
    ).rejects.toBeInstanceOf(ReportTargetNotVisibleError);
  });

  it("refuses a user report aimed at a server the reporter is not in", async () => {
    await expect(
      createReport({
        subjectType: "user",
        reporterId: outsider.id,
        userId: nuisance.id,
        serverId,
        reason: "harassment",
      }),
    ).rejects.toBeInstanceOf(ReportTargetNotVisibleError);
  });

  // -------------------------------------------------------------- evidence

  it("survives deletion of the reported message", async () => {
    const messageId = await say(channelId, nuisance.id, "the offending text");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "harassment",
    });

    // The single most likely thing to happen next, from either side.
    await deleteMessage(messageId);

    const queue = await listServerReports(serverId, PAGE);
    expect(queue.reports).toHaveLength(1);
    const survivor = queue.reports[0]!;
    expect(survivor.id).toBe(report.id);
    expect(survivor.messageId).toBeNull();
    expect(survivor.messageDeleted).toBe(true);
    // The evidence itself is still readable.
    expect(survivor.contentSnapshot).toBe("the offending text");
    expect(survivor.reportedUserName).toContain("nuisance");
  });

  // ------------------------------------------------------------ duplicates

  it("collapses a repeat report of the same message into the first one", async () => {
    const messageId = await say(channelId, nuisance.id, "buy followers");
    const first = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "spam",
    });
    const second = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "harassment",
      details: "trying again with a different reason",
    });

    expect(second.duplicate).toBe(true);
    expect(second.report.id).toBe(first.report.id);
    // The first report is untouched — a second attempt does not get to rewrite
    // what a moderator has already started reading.
    expect(second.report.reason).toBe("spam");
    expect((await listServerReports(serverId, PAGE)).reports).toHaveLength(1);
  });

  it("collapses a repeat report of the same user in the same server", async () => {
    const first = await createReport({
      subjectType: "user",
      reporterId: member.id,
      userId: nuisance.id,
      serverId,
      reason: "harassment",
    });
    const second = await createReport({
      subjectType: "user",
      reporterId: member.id,
      userId: nuisance.id,
      serverId,
      reason: "harassment",
    });

    expect(second.duplicate).toBe(true);
    expect(second.report.id).toBe(first.report.id);
  });

  it("collapses a repeat user report with no context, where NULLs would not", async () => {
    // Postgres treats NULLs as distinct in a unique index, so the dedupe index
    // folds a null server id into a sentinel. Without that this is two rows.
    const first = await createReport({
      subjectType: "user",
      reporterId: member.id,
      userId: nuisance.id,
      reason: "harassment",
    });
    const second = await createReport({
      subjectType: "user",
      reporterId: member.id,
      userId: nuisance.id,
      reason: "harassment",
    });

    expect(second.duplicate).toBe(true);
    expect(second.report.id).toBe(first.report.id);
  });

  it("lets a different reporter file about the same message", async () => {
    const messageId = await say(channelId, nuisance.id, "buy followers");
    await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "spam",
    });
    await createReport({
      subjectType: "message",
      reporterId: owner.id,
      messageId,
      reason: "spam",
    });

    expect((await listServerReports(serverId, PAGE)).reports).toHaveLength(2);
  });

  it("lets the same reporter file again once the first is resolved", async () => {
    const messageId = await say(channelId, nuisance.id, "buy followers");
    const first = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "spam",
    });
    await resolveReport(first.report.id, owner.id, "dismissed", "not spam");

    const again = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "spam",
    });

    // A repeat offence after a decision is the most useful thing a queue can
    // show, so it is a new row rather than a duplicate.
    expect(again.duplicate).toBe(false);
    expect(again.report.id).not.toBe(first.report.id);
  });

  // ----------------------------------------------------------- resolution

  it("records who closed a report, when, and why", async () => {
    const messageId = await say(channelId, nuisance.id, "buy followers");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "spam",
    });

    const resolved = await resolveReport(
      report.id,
      admin.id,
      "actioned",
      "removed and warned",
    );
    expect(resolved?.status).toBe("actioned");
    expect(resolved?.resolvedByName).toBe("admin");
    expect(resolved?.resolutionNote).toBe("removed and warned");
    expect(resolved?.resolvedAt).not.toBeNull();

    // Nothing reopens: a second close finds no open row.
    expect(await resolveReport(report.id, owner.id, "dismissed")).toBeNull();
  });

  // -------------------------------------------------------------- reporter

  it("shows a reporter their own report without naming the moderator", async () => {
    const messageId = await say(channelId, nuisance.id, "buy followers");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "spam",
    });
    await resolveReport(report.id, admin.id, "actioned", "removed and warned");

    const mine = await listReportsByReporter(member.id, PAGE);
    expect(mine.reports).toHaveLength(1);
    expect(mine.reports[0]!.status).toBe("actioned");
    // The narrow shape: no moderator name, no note, no snapshot.
    expect(Object.keys(mine.reports[0]!)).not.toContain("resolvedByName");
    expect(Object.keys(mine.reports[0]!)).not.toContain("contentSnapshot");

    // And somebody else's report is not theirs to see.
    expect((await listReportsByReporter(owner.id, PAGE)).reports).toEqual([]);
  });

  // ----------------------------------------------------- instance operator

  it("names instance moderators from the environment, not from any role", async () => {
    expect(isInstanceModerator({ clerk_id: owner.clerk_id })).toBe(false);

    process.env.INSTANCE_MODERATOR_CLERK_IDS = `${operator.clerk_id}, someone_else`;
    expect(isInstanceModerator({ clerk_id: operator.clerk_id })).toBe(true);
    // Owning a server grants nothing here.
    expect(isInstanceModerator({ clerk_id: owner.clerk_id })).toBe(false);
  });

  // ------------------------------------------------------------- the routes

  it("lets a manager open a server's queue and refuses a plain member", async () => {
    const messageId = await say(channelId, nuisance.id, "buy followers");
    await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "spam",
    });

    for (const manager of [owner, admin]) {
      const res = await call<{ reports: unknown[] }>(
        manager,
        "GET",
        `/api/servers/${serverId}/reports`,
      );
      expect(res.status).toBe(200);
      expect(res.body.reports).toHaveLength(1);
    }

    expect(
      (await call(member, "GET", `/api/servers/${serverId}/reports`)).status,
    ).toBe(403);
    // A non-member gets 404, not 403 — the server's existence is not confirmed.
    expect(
      (await call(outsider, "GET", `/api/servers/${serverId}/reports`)).status,
    ).toBe(404);
  });

  it("does not show a server admin the instance queue", async () => {
    const messageId = await say(dmChannelId, nuisance.id, "leave me alone");
    await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "harassment",
    });

    // The DM report is nowhere in the server queue…
    const serverQueue = await call<{ reports: unknown[] }>(
      owner,
      "GET",
      `/api/servers/${serverId}/reports`,
    );
    expect(serverQueue.status).toBe(200);
    expect(serverQueue.body.reports).toEqual([]);

    // …and the queue that does hold it is closed to every one of them.
    for (const person of [owner, admin, member, outsider]) {
      expect((await call(person, "GET", "/api/reports/instance")).status).toBe(
        404,
      );
    }

    process.env.INSTANCE_MODERATOR_CLERK_IDS = operator.clerk_id;
    const instance = await call<{ reports: unknown[] }>(
      operator,
      "GET",
      "/api/reports/instance",
    );
    expect(instance.status).toBe(200);
    expect(instance.body.reports).toHaveLength(1);
    // Still nothing for the server's owner, even with the queue switched on.
    expect((await call(owner, "GET", "/api/reports/instance")).status).toBe(404);
  });

  it("refuses to let a server manager resolve a conversation report", async () => {
    const messageId = await say(dmChannelId, nuisance.id, "leave me alone");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "harassment",
    });

    const attempt = await call(owner, "PATCH", `/api/reports/${report.id}`, {
      status: "dismissed",
    });
    expect(attempt.status).toBe(404);

    process.env.INSTANCE_MODERATOR_CLERK_IDS = operator.clerk_id;
    const allowed = await call(operator, "PATCH", `/api/reports/${report.id}`, {
      status: "dismissed",
      note: "handled out of band",
    });
    expect(allowed.status).toBe(200);
  });

  it("answers 201 for a new report and 200 for a duplicate", async () => {
    const messageId = await say(channelId, nuisance.id, "buy followers");
    const body = { subjectType: "message", messageId, reason: "spam" };

    expect((await call(member, "POST", "/api/reports", body)).status).toBe(201);
    expect((await call(member, "POST", "/api/reports", body)).status).toBe(200);
  });

  it("writes an audit entry when a server report is closed", async () => {
    const messageId = await say(channelId, nuisance.id, "buy followers");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: member.id,
      messageId,
      reason: "spam",
    });

    const res = await call(admin, "PATCH", `/api/reports/${report.id}`, {
      status: "actioned",
      note: "deleted the message",
    });
    expect(res.status).toBe(200);

    const audit = await getPool().query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE action = 'report.resolve'`,
    );
    expect(audit.rows).toEqual([
      { action: "report.resolve", actor_id: admin.id },
    ]);

    // And a second close is a conflict rather than a silent overwrite.
    expect(
      (
        await call(owner, "PATCH", `/api/reports/${report.id}`, {
          status: "dismissed",
        })
      ).status,
    ).toBe(409);
  });

  it("rejects a report id that is not a number without touching the database", async () => {
    expect((await call(owner, "PATCH", "/api/reports/nonsense", {})).status).toBe(
      404,
    );
  });
});
