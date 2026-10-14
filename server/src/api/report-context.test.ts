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
import { MISSED_CALL_BODY, reportContextSchema } from "@pqp/shared";

/**
 * `GET /api/reports/:id/context`, pinned at its disclosure boundaries on a
 * real Postgres. The scenario mirrors report #36: a minutes-old account that
 * cold-called strangers, was blocked by the person who reported it, and owns a
 * two-member server.
 *
 * The failures worth a test are all disclosures:
 *   * anybody who may not read the queue the report lives in gets a 404, the
 *     same one a report that does not exist gets;
 *   * a server's staff see that server and nothing else of the account;
 *   * nobody reads a conversation between the reported user and a third party.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createChatServer, createChannel } = await import(
  "../services/servers.js"
);
const { createMessage } = await import("../services/messages.js");
const { openConversation } = await import("../services/dms.js");
const { createReport } = await import("../services/reports.js");

let httpServer: Server;
let baseUrl: string;

type Person = { id: string; clerk_id: string };

async function call<T = Record<string, unknown>>(
  as: Person | null,
  method: string,
  path: string,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describeDb("report context", () => {
  let owner: Person; // owns Alpha
  let admin: Person; // admin in Alpha
  let reporter: Person;
  let nuisance: Person; // the reported account
  let stranger1: Person;
  let stranger2: Person;
  let friend: Person;
  let bystander: Person; // plain member of Alpha
  let betaOwner: Person; // owns Beta, unrelated
  let operator: Person; // instance moderator

  let alphaId: string;
  let alphaChannel: string;
  let slurServerId: string;
  let slurChannel: string;
  let betaId: string;

  const SECRET_DM = "SECRET-DM-BETWEEN-NUISANCE-AND-STRANGER";

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

  async function dbUser(userId: string) {
    const result = await getPool().query(`SELECT * FROM users WHERE id = $1`, [
      userId,
    ]);
    return result.rows[0]!;
  }

  async function say(channel: string, who: Person, body: string) {
    const created = await createMessage(channel, await dbUser(who.id), body);
    expect(created).not.toBeNull();
    return created!.id;
  }

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetApiRateLimits();
    process.env.INSTANCE_MODERATOR_CLERK_IDS = "clerk_operator";

    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await make("owner");
    admin = await make("admin");
    reporter = await make("reporter");
    nuisance = await make("nuisance");
    stranger1 = await make("stranger1");
    stranger2 = await make("stranger2");
    friend = await make("friend");
    bystander = await make("bystander");
    betaOwner = await make("betaowner");
    operator = await make("operator");

    const alpha = await createChatServer("Alpha", owner.id);
    alphaId = alpha.server.id;
    alphaChannel = alpha.channels.find((c) => c.type === "text")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       SELECT $1, u, r FROM (VALUES ($2::uuid, 'admin'), ($3::uuid, 'member'),
         ($4::uuid, 'member'), ($5::uuid, 'member'), ($6::uuid, 'member'),
         ($7::uuid, 'member')) AS t(u, r)`,
      [
        alphaId,
        admin.id,
        reporter.id,
        nuisance.id,
        stranger1.id,
        stranger2.id,
        bystander.id,
      ],
    );
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [alphaId, friend.id],
    );

    // The account with a slur for a name: two members, owned by the nuisance.
    const slur = await createChatServer("SLUR-NAMED-SERVER", nuisance.id);
    slurServerId = slur.server.id;
    slurChannel = slur.channels.find((c) => c.type === "text")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [slurServerId, stranger1.id],
    );

    const beta = await createChatServer("Beta", betaOwner.id);
    betaId = beta.server.id;

    // Six minutes old.
    await getPool().query(
      `UPDATE users SET created_at = NOW() - interval '6 minutes',
              last_country = 'BR' WHERE id = $1`,
      [nuisance.id],
    );
  });

  /** The report #36 shape: an account report from nowhere in particular. */
  async function coldCallScenario() {
    // They start conversations with strangers, and a friend (not counted).
    for (const person of [stranger1, stranger2, reporter]) {
      const convo = await openConversation(nuisance.id, [person.id]);
      await say(convo.channelId, nuisance, MISSED_CALL_BODY);
    }
    const strangerConvo = (await openConversation(nuisance.id, [stranger1.id]))
      .channelId;
    await say(strangerConvo, nuisance, SECRET_DM);
    await say(strangerConvo, stranger1, "who are you");

    const [lo, hi] =
      nuisance.id < friend.id ? [nuisance.id, friend.id] : [friend.id, nuisance.id];
    await getPool().query(
      `INSERT INTO friendships (low_user_id, high_user_id, status, requested_by, accepted_at)
       VALUES ($1, $2, 'accepted', $1, NOW())`,
      [lo, hi],
    );
    const friendConvo = await openConversation(nuisance.id, [friend.id]);
    await say(friendConvo.channelId, nuisance, MISSED_CALL_BODY);

    // Somebody ELSE began this conversation and the account only called back:
    // not outreach, so neither signal counts it.
    const inbound = (await openConversation(bystander.id, [nuisance.id]))
      .channelId;
    await say(inbound, bystander, "hi, who is this?");
    await say(inbound, nuisance, MISSED_CALL_BODY);

    // The reporter talked to them too, then blocked them.
    const reporterConvo = (await openConversation(reporter.id, [nuisance.id]))
      .channelId;
    await say(reporterConvo, reporter, "stop calling me");
    await getPool().query(
      `INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2), ($3, $2)`,
      [reporter.id, nuisance.id, stranger2.id],
    );

    // A message in the community server, and in the slur server.
    await say(alphaChannel, nuisance, "hello from alpha");
    await say(slurChannel, nuisance, "words in the slur server");

    const { report } = await createReport({
      subjectType: "user",
      reporterId: reporter.id,
      userId: nuisance.id,
      reason: "illegal_content",
    });
    return report;
  }

  // ------------------------------------------------------------------ gating

  it("answers 404 to every caller who may not read the queue the report is in", async () => {
    const report = await coldCallScenario();
    const path = `/api/reports/${report.id}/context`;
    // An instance-queue report: a server owner, an admin, the reporter, the
    // reported account and a stranger all get the same 404.
    for (const who of [owner, admin, reporter, nuisance, bystander, betaOwner]) {
      expect((await call(who, "GET", path)).status).toBe(404);
    }
    expect((await call(null, "GET", path)).status).toBe(401);
    // And a report that does not exist, or is not a number, is the same answer.
    expect((await call(operator, "GET", "/api/reports/99999/context")).status).toBe(404);
    expect((await call(operator, "GET", "/api/reports/abc/context")).status).toBe(404);
    expect((await call(operator, "GET", path)).status).toBe(200);
  });

  it("is absent for everyone when no instance moderator is configured", async () => {
    const report = await coldCallScenario();
    delete process.env.INSTANCE_MODERATOR_CLERK_IDS;
    expect(
      (await call(operator, "GET", `/api/reports/${report.id}/context`)).status,
    ).toBe(404);
  });

  // ------------------------------------------------------------ the account

  it("lets an instance moderator judge an account report with no details", async () => {
    const report = await coldCallScenario();
    // A second report against the same account, and a ban elsewhere.
    await createReport({
      subjectType: "user",
      reporterId: stranger1.id,
      userId: nuisance.id,
      reason: "harassment",
    });
    await getPool().query(
      `INSERT INTO server_bans (server_id, user_id, banned_by, reason)
       VALUES ($1, $2, $3, 'cold calls')`,
      [betaId, nuisance.id, betaOwner.id],
    );
    await getPool().query(
      `INSERT INTO member_timeouts (server_id, user_id, issued_by, expires_at)
       VALUES ($1, $2, $3, NOW() + interval '1 hour')`,
      [alphaId, nuisance.id, owner.id],
    );

    const res = await call(operator, "GET", `/api/reports/${report.id}/context`);
    expect(res.status).toBe(200);
    const ctx = reportContextSchema.parse(res.body);

    expect(ctx.lens).toBe("instance");
    expect(ctx.account?.displayName).toBe("nuisance");
    expect(ctx.account?.lastCountry).toBe("BR");
    const ageMs = Date.now() - new Date(ctx.account!.createdAt).getTime();
    expect(ageMs).toBeGreaterThan(5 * 60_000);
    expect(ageMs).toBeLessThan(10 * 60_000);

    // Three conversations opened with people who are not friends: the friend
    // does not count. Every one began with a call record.
    expect(ctx.signals?.dmsStarted.total).toBe(3);
    expect(ctx.signals?.dmsStarted.firstHour).toBe(3);
    expect(ctx.signals?.callsPlaced.total).toBe(3);
    expect(ctx.signals?.callsPlaced.firstHour).toBe(3);
    expect(ctx.signals?.blockedByCount).toBe(2);
    expect(ctx.signals?.reporterBlockedAt).not.toBeNull();

    expect(ctx.otherReports).toHaveLength(1);
    expect(ctx.otherReports[0]).toMatchObject({
      status: "open",
      reason: "harassment",
      subjectType: "user",
    });
    expect(ctx.sanctions.bans.map((b) => b.serverName)).toEqual(["Beta"]);
    expect(ctx.sanctions.timeouts.map((t) => t.serverName)).toEqual(["Alpha"]);

    // The one conversation the reporter is in: theirs, with the call record.
    expect(ctx.conversation?.map((m) => m.body)).toEqual([
      MISSED_CALL_BODY,
      "stop calling me",
    ]);
    expect(ctx.conversation?.map((m) => m.party)).toEqual([
      "reported",
      "reporter",
    ]);
    expect(ctx.conversation?.[0]?.isCall).toBe(true);

    expect(ctx.serverMessages.map((m) => m.serverName).sort()).toEqual([
      "Alpha",
      "SLUR-NAMED-SERVER",
    ]);
    expect(ctx.ownedServers).toEqual([
      expect.objectContaining({ name: "SLUR-NAMED-SERVER", memberCount: 2 }),
    ]);
    expect(ctx.actions.canTerminate).toBe(true);
    // The report belongs to no server, so there is no server to act in.
    expect(ctx.actions.server).toBeNull();
  });

  it("never carries a conversation between the reported account and a third party", async () => {
    const report = await coldCallScenario();
    const res = await call(operator, "GET", `/api/reports/${report.id}/context`);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET_DM);
    expect(text).not.toContain("who are you");
    expect(text).not.toContain("stranger1");
    expect(text).not.toContain("stranger2");
  });

  it("answers an account that has since gone with no account and no error", async () => {
    const report = await coldCallScenario();
    await getPool().query(`DELETE FROM users WHERE id = $1`, [nuisance.id]);
    const res = await call(operator, "GET", `/api/reports/${report.id}/context`);
    expect(res.status).toBe(200);
    const ctx = reportContextSchema.parse(res.body);
    expect(ctx.account).toBeNull();
    expect(ctx.signals).toBeNull();
    expect(ctx.actions.canTerminate).toBe(false);
  });

  // ------------------------------------------------------------ server staff

  it("gives a server's staff that server and nothing else of the account", async () => {
    await coldCallScenario();
    // A report filed inside Alpha lands in Alpha's queue.
    const { report } = await createReport({
      subjectType: "user",
      reporterId: reporter.id,
      userId: nuisance.id,
      serverId: alphaId,
      reason: "harassment",
    });
    // Another Alpha report and a report in the slur server's own queue.
    await createReport({
      subjectType: "user",
      reporterId: stranger2.id,
      userId: nuisance.id,
      serverId: alphaId,
      reason: "spam",
    });
    await createReport({
      subjectType: "user",
      reporterId: stranger1.id,
      userId: nuisance.id,
      serverId: slurServerId,
      reason: "hate_speech",
    });
    await getPool().query(
      `INSERT INTO server_bans (server_id, user_id) VALUES ($1, $2)`,
      [betaId, nuisance.id],
    );

    for (const who of [owner, admin]) {
      const res = await call(who, "GET", `/api/reports/${report.id}/context`);
      expect(res.status).toBe(200);
      const ctx = reportContextSchema.parse(res.body);
      expect(ctx.lens).toBe("server");
      expect(ctx.account?.displayName).toBe("nuisance");
      // Reaches outside the server: absent, not filtered.
      expect(ctx.account?.lastCountry).toBeNull();
      expect(ctx.signals).toBeNull();
      expect(ctx.conversation).toBeNull();
      expect(ctx.ownedServers).toEqual([]);
      expect(ctx.actions.canTerminate).toBe(false);
      expect(ctx.sanctions.bans).toEqual([]);
      // Alpha's own queue only: the slur server's report is not theirs.
      expect(ctx.otherReports.map((r) => r.reason)).toEqual(["spam"]);
      expect(ctx.serverMessages.map((m) => m.serverName)).toEqual(["Alpha"]);
      expect(JSON.stringify(res.body)).not.toContain("words in the slur server");
      expect(ctx.actions.server).toMatchObject({
        id: alphaId,
        canBan: true,
        canTimeout: true,
        alreadyBanned: false,
      });
    }
  });

  it("refuses staff of a different server, and plain members, with the same 404", async () => {
    await coldCallScenario();
    const { report } = await createReport({
      subjectType: "user",
      reporterId: reporter.id,
      userId: nuisance.id,
      serverId: alphaId,
      reason: "harassment",
    });
    const path = `/api/reports/${report.id}/context`;
    for (const who of [betaOwner, bystander, reporter, nuisance, stranger1]) {
      expect((await call(who, "GET", path)).status).toBe(404);
    }
    expect((await call(admin, "GET", path)).status).toBe(200);
  });

  it("shows an instance moderator the account but offers no server action without standing", async () => {
    await coldCallScenario();
    const { report } = await createReport({
      subjectType: "user",
      reporterId: reporter.id,
      userId: nuisance.id,
      serverId: alphaId,
      reason: "harassment",
    });
    const res = await call(operator, "GET", `/api/reports/${report.id}/context`);
    const ctx = reportContextSchema.parse(res.body);
    expect(ctx.lens).toBe("instance");
    expect(ctx.actions.canTerminate).toBe(true);
    expect(ctx.actions.server).toMatchObject({
      id: alphaId,
      canBan: false,
      canTimeout: false,
    });
  });

  it("does not offer a ban on the owner of the report's server", async () => {
    // The reported account is the server's owner: nobody acts on the owner.
    const { report } = await createReport({
      subjectType: "user",
      reporterId: reporter.id,
      userId: owner.id,
      serverId: alphaId,
      reason: "harassment",
    });
    const res = await call(admin, "GET", `/api/reports/${report.id}/context`);
    const ctx = reportContextSchema.parse(res.body);
    expect(ctx.actions.server).toMatchObject({ canBan: false, canTimeout: false });
  });

  // ------------------------------------------------------- message reports

  it("brings five messages either side of a reported server message", async () => {
    for (let i = 1; i <= 7; i += 1) {
      await say(alphaChannel, bystander, `before ${i}`);
    }
    const reportedId = await say(alphaChannel, nuisance, "the bad one");
    for (let i = 1; i <= 7; i += 1) {
      await say(alphaChannel, bystander, `after ${i}`);
    }
    const { report } = await createReport({
      subjectType: "message",
      reporterId: reporter.id,
      messageId: reportedId,
      reason: "harassment",
    });

    for (const who of [operator, admin]) {
      const res = await call(who, "GET", `/api/reports/${report.id}/context`);
      expect(res.status).toBe(200);
      const ctx = reportContextSchema.parse(res.body);
      expect(ctx.surrounding?.withheld).toBeNull();
      // The reported message itself, in its place, with its author's name and tag.
      expect(ctx.surrounding?.reported).toMatchObject({
        id: reportedId,
        body: "the bad one",
        authorName: "nuisance",
        party: "reported",
      });
      expect(ctx.surrounding?.reported?.authorTag).toMatch(/^nuisance#\d{4}$/);
      expect(ctx.surrounding?.before.map((m) => m.body)).toEqual([
        "before 3",
        "before 4",
        "before 5",
        "before 6",
        "before 7",
      ]);
      expect(ctx.surrounding?.after.map((m) => m.body)).toEqual([
        "after 1",
        "after 2",
        "after 3",
        "after 4",
        "after 5",
      ]);
    }
  });

  it("reads a private channel's neighbours through the staff's own visibility", async () => {
    const privateId = (await createChannel(alphaId, "secret", "text", true)).id;
    const reportedId = await say(privateId, owner, "in private");
    await say(privateId, owner, "more");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: owner.id,
      messageId: reportedId,
      reason: "harassment",
    });
    // An admin holds the role that opens private channels, so they see it.
    // The read goes through `canAccessChannel`, not around it.
    const res = await call(admin, "GET", `/api/reports/${report.id}/context`);
    const ctx = reportContextSchema.parse(res.body);
    expect(ctx.surrounding?.withheld).toBeNull();
    expect(ctx.surrounding?.after.map((m) => m.body)).toEqual(["more"]);
    expect((await call(bystander, "GET", `/api/reports/${report.id}/context`)).status).toBe(404);
  });

  it("shows a 1:1 report's neighbours to the instance and withholds a group's", async () => {
    const convo = (await openConversation(reporter.id, [nuisance.id])).channelId;
    await say(convo, reporter, "hey");
    const bad = await say(convo, nuisance, "you are awful");
    await say(convo, reporter, "stop");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: reporter.id,
      messageId: bad,
      reason: "harassment",
    });
    const res = await call(operator, "GET", `/api/reports/${report.id}/context`);
    const ctx = reportContextSchema.parse(res.body);
    expect(ctx.surrounding?.before.map((m) => m.body)).toEqual(["hey"]);
    expect(ctx.surrounding?.after.map((m) => m.body)).toEqual(["stop"]);

    const group = (
      await openConversation(reporter.id, [nuisance.id, stranger1.id])
    ).channelId;
    await say(group, stranger1, "SECRET-GROUP-THIRD-PARTY");
    const groupBad = await say(group, nuisance, "group insult");
    const { report: groupReport } = await createReport({
      subjectType: "message",
      reporterId: reporter.id,
      messageId: groupBad,
      reason: "harassment",
    });
    const groupRes = await call(
      operator,
      "GET",
      `/api/reports/${groupReport.id}/context`,
    );
    const groupCtx = reportContextSchema.parse(groupRes.body);
    expect(groupCtx.surrounding).toEqual({
      reported: null,
      before: [],
      after: [],
      withheld: "group",
    });
    expect(JSON.stringify(groupRes.body)).not.toContain("SECRET-GROUP-THIRD-PARTY");
  });

  // ------------------------------------------- the reporter, and the thread

  it("counts the whole thread so an unanswered reporter is visible", async () => {
    const convo = (await openConversation(reporter.id, [nuisance.id])).channelId;
    // 25 messages from the reporter (more than the 20 shown), none back.
    for (let i = 1; i <= 25; i += 1) {
      await say(convo, reporter, `are you there ${i}`);
    }
    const { report } = await createReport({
      subjectType: "user",
      reporterId: reporter.id,
      userId: nuisance.id,
      reason: "harassment",
    });
    // Reports this reporter filed before, one dismissed.
    const earlier = await createReport({
      subjectType: "user",
      reporterId: reporter.id,
      userId: stranger1.id,
      reason: "spam",
    });
    await getPool().query(
      `UPDATE reports SET status = 'dismissed', resolved_by = $2, resolved_at = NOW()
       WHERE id = $1::bigint`,
      [earlier.report.id, operator.id],
    );
    const res = await call(operator, "GET", `/api/reports/${report.id}/context`);
    const ctx = reportContextSchema.parse(res.body);
    expect(ctx.conversation).toHaveLength(20);
    expect(ctx.conversationCounts).toEqual({ fromReporter: 25, fromReported: 0 });
    expect(ctx.conversation?.[0]?.authorName).toBe("reporter");
    expect(ctx.reporter).toMatchObject({
      displayName: "reporter",
      filed: 2,
      actioned: 0,
      dismissed: 1,
    });

    // A server's staff get neither the reporter's history nor the thread.
    const { report: serverReport } = await createReport({
      subjectType: "user",
      reporterId: reporter.id,
      userId: nuisance.id,
      serverId: alphaId,
      reason: "harassment",
    });
    const staff = reportContextSchema.parse(
      (await call(admin, "GET", `/api/reports/${serverReport.id}/context`)).body,
    );
    expect(staff.reporter).toBeNull();
    expect(staff.conversationCounts).toBeNull();
  });

  // ------------------------------------------- where a reported message goes

  it("files a message reported from a voice channel's chat into that server's queue", async () => {
    const lobby = (await createChannel(alphaId, "Lobby", "voice")).id;
    const reportedId = await say(lobby, nuisance, "Citrus");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: reporter.id,
      messageId: reportedId,
      reason: "spam",
    });
    // Derived server-side from the message's channel, never from the client.
    expect(report.contextKind).toBe("server");
    const row = await getPool().query(
      `SELECT server_id FROM reports WHERE id = $1::bigint`,
      [report.id],
    );
    expect(row.rows[0].server_id).toBe(alphaId);

    const ctx = reportContextSchema.parse(
      (await call(admin, "GET", `/api/reports/${report.id}/context`)).body,
    );
    expect(ctx.messageServer).toMatchObject({ id: alphaId, channelName: "Lobby" });
    expect(ctx.surrounding?.reported?.body).toBe("Citrus");
  });

  it("keeps a minor_sexual report in the instance queue by design, but still knows the server", async () => {
    const lobby = (await createChannel(alphaId, "Lobby", "voice")).id;
    const reportedId = await say(lobby, nuisance, "Citrus");
    const { report } = await createReport({
      subjectType: "message",
      reporterId: reporter.id,
      messageId: reportedId,
      reason: "minor_sexual",
    });
    // The ONE reason that moves a server-channel message out of its server's
    // queue (`routeByReason`), so the server's own staff never hold it.
    expect(report.contextKind).toBe("none");
    expect((await call(admin, "GET", `/api/reports/${report.id}/context`)).status).toBe(404);

    const ctx = reportContextSchema.parse(
      (await call(operator, "GET", `/api/reports/${report.id}/context`)).body,
    );
    // The row carries no server, but the context says where the message lives
    // and offers the server actions the moderator really has there (none here).
    expect(ctx.messageServer).toMatchObject({ id: alphaId, name: "Alpha", channelName: "Lobby" });
    expect(ctx.actions.server).toMatchObject({ id: alphaId, canBan: false, canTimeout: false });
    expect(ctx.surrounding?.reported?.body).toBe("Citrus");
  });

  it("agrees with the call record the voice server writes", async () => {
    const voice = await import("../ws/voice.js");
    expect(voice.MISSED_CALL_BODY).toBe(MISSED_CALL_BODY);
  });
});
