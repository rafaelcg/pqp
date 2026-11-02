import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { reportContextSchema } from "@pqp/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Reporting a Baú post or a Baú comment, pinned at the boundaries that matter.
 *
 *   * YOU CANNOT REPORT WHAT YOU CANNOT READ. A members-only (VIP) post is
 *     reportable by the VIP cargo and staff and by nobody else; a non-member,
 *     a plain member, your own words, a draft and a hidden comment are all the
 *     same 404.
 *   * A COMMUNITY'S BAÚ REPORT GOES TO THE INSTANCE QUEUE, never to the owner
 *     who runs the Baú. Any other server's goes to its own queue.
 *   * THE REPORT OUTLIVES THE POST: the words are copied at report time.
 *   * THE OPERATOR CAN OPEN THE VIP POST, and only through the report, with an
 *     audit row (server-scoped) or the log line (instance queue).
 *
 * Run with the flags production sets: Baú and its VIP half on, communities on.
 * Same harness as community-home.test.ts: the real router with only the
 * identity layer stubbed.
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
const { createServer: createChatServer } = await import("../services/servers.js");
const { createReport, ReportFloodError, REPORTS_PER_HOUR } = await import(
  "../services/reports.js"
);

let httpServer: Server;
let baseUrl: string;

type Person = { id: string; clerk_id: string };

async function call<T = Record<string, any>>(
  as: Person | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
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

describeDb("reporting a Baú post or comment", () => {
  let owner: Person; // owns the community and writes the posts
  let admin: Person; // admin of the PRIVATE server
  let member: Person; // plain member of both
  let vip: Person; // VIP cargo in both
  let outsider: Person; // member of nothing
  let operator: Person; // instance moderator
  let communityId: string;
  let privateId: string;

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
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    process.env.COMMUNITIES_ENABLED = "true";
    process.env.INSTANCE_MODERATOR_CLERK_IDS = "clerk_operator";

    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await make("owner");
    admin = await make("admin");
    member = await make("member");
    vip = await make("vip");
    outsider = await make("outsider");
    operator = await make("operator");

    const community = await createChatServer("Comunidade", owner.id);
    communityId = community.server.id;
    await getPool().query(
      `UPDATE servers SET is_community = TRUE, community_slug = 'comunidade'
        WHERE id = $1`,
      [communityId],
    );
    const priv = await createChatServer("Privado", owner.id);
    privateId = priv.server.id;

    for (const serverId of [communityId, privateId]) {
      for (const person of [member, vip]) {
        await getPool().query(
          `INSERT INTO server_members (server_id, user_id, role)
           VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
          [serverId, person.id],
        );
      }
      await getPool().query(
        `INSERT INTO member_roles (server_id, user_id, role_id)
         SELECT $1, $2, id FROM roles WHERE server_id = $1 AND system_key = 'vip'
         ON CONFLICT DO NOTHING`,
        [serverId, vip.id],
      );
    }
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [privateId, admin.id],
    );
  });

  afterEach(() => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
    delete process.env.COMMUNITIES_ENABLED;
    delete process.env.INSTANCE_MODERATOR_CLERK_IDS;
  });

  const home = (serverId: string) => `/api/servers/${serverId}/home`;

  async function publish(
    serverId: string,
    post: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const res = await call<{ post: { id: string } }>(
      owner,
      "POST",
      `${home(serverId)}/posts`,
      { status: "published", body: "corpo do post", ...post },
    );
    expect(res.status).toBe(201);
    return res.body.post;
  }

  async function comment(
    serverId: string,
    postId: string,
    who: Person,
    body: string,
  ): Promise<{ id: string }> {
    const res = await call<{ comment: { id: string } }>(
      who,
      "POST",
      `${home(serverId)}/posts/${postId}/comments`,
      { body },
    );
    expect(res.status).toBe(201);
    return res.body.comment;
  }

  const reportPost = (who: Person | null, postId: string, reason = "spam") =>
    call(who, "POST", "/api/reports", {
      subjectType: "bau_post",
      postId,
      reason,
    });
  const reportComment = (who: Person | null, commentId: string, reason = "spam") =>
    call(who, "POST", "/api/reports", {
      subjectType: "bau_comment",
      commentId,
      reason,
    });

  // ------------------------------------------------------------ visibility

  it("lets a member report a free post and snapshots it", async () => {
    const post = await publish(communityId, {
      title: "Titulo livre",
      body: "palavras do post",
    });
    const res = await reportPost(member, post.id, "harassment");
    expect(res.status).toBe(201);
    expect(res.body.report).toMatchObject({
      subjectType: "bau_post",
      bauPostId: post.id,
      bauCommentId: null,
      reportedUserName: expect.stringContaining("owner"),
    });
    expect(res.body.report.contentSnapshot).toBe("Titulo livre\n\npalavras do post");
  });

  it("answers the same 404 for a members-only post to everybody the lock keeps out", async () => {
    const post = await publish(communityId, {
      title: "So VIP",
      body: "palavras trancadas",
      visibility: "members",
    });
    // A plain member, somebody in no server at all, and an id that is not a
    // post: indistinguishable.
    expect((await reportPost(member, post.id)).status).toBe(404);
    expect((await reportPost(outsider, post.id)).status).toBe(404);
    expect(
      (await reportPost(member, "00000000-0000-4000-8000-000000000000")).status,
    ).toBe(404);
    // The VIP cargo reads it, so the VIP cargo may report it.
    const filed = await reportPost(vip, post.id);
    expect(filed.status).toBe(201);
    expect(filed.body.report.contentSnapshot).toContain("palavras trancadas");
    // Staff read it too (the owner here is the author: own words are refused).
    expect((await reportPost(owner, post.id)).status).toBe(404);
  });

  it("refuses your own post, your own comment, a draft and a post nobody can see with VIP off", async () => {
    const own = await publish(communityId, { title: "meu" });
    expect((await reportPost(owner, own.id)).status).toBe(404);
    const mine = await comment(communityId, own.id, member, "minha fala");
    expect((await reportComment(member, mine.id)).status).toBe(404);

    const draft = await call<{ post: { id: string } }>(
      owner,
      "POST",
      `${home(communityId)}/posts`,
      { status: "draft", title: "rascunho", body: "ainda nao" },
    );
    expect(draft.status).toBe(201);
    expect((await reportPost(member, draft.body.post.id)).status).toBe(404);

    const vipPost = await publish(communityId, {
      title: "VIP",
      visibility: "members",
    });
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
    expect((await reportPost(vip, vipPost.id)).status).toBe(404);
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    expect((await reportPost(vip, vipPost.id)).status).toBe(201);
  });

  it("is absent with Baú off", async () => {
    const post = await publish(communityId, { title: "x" });
    delete process.env.COMMUNITY_HOME_ENABLED;
    expect((await reportPost(member, post.id)).status).toBe(404);
  });

  it("reports a comment, and hides what the reporter could not read", async () => {
    const free = await publish(communityId, { title: "livre" });
    const said = await comment(communityId, free.id, member, "comentario ofensivo");
    const filed = await reportComment(vip, said.id, "hate_speech");
    expect(filed.status).toBe(201);
    expect(filed.body.report).toMatchObject({
      subjectType: "bau_comment",
      bauCommentId: said.id,
      bauPostId: free.id,
      contentSnapshot: "comentario ofensivo",
    });
    expect(filed.body.report.reportedUserName).toContain("member");

    // Somebody the reporter blocked: the comment is not on their screen, so it
    // is not theirs to report either.
    expect(
      (await call(vip, "POST", "/api/blocks", { userId: member.id })).status,
    ).toBeLessThan(300);
    const second = await comment(communityId, free.id, member, "outro comentario");
    expect((await reportComment(vip, second.id)).status).toBe(404);

    // A comment under a locked VIP post stays locked for a plain member.
    const locked = await publish(communityId, { title: "VIP", visibility: "members" });
    const hidden = await comment(communityId, locked.id, vip, "fala de vip");
    expect((await reportComment(member, hidden.id)).status).toBe(404);
  });

  // --------------------------------------------------------------- rules

  it("treats a second open report of the same post as a duplicate, and files again once closed", async () => {
    const post = await publish(communityId, { title: "dup" });
    const first = await reportPost(member, post.id);
    expect(first.status).toBe(201);
    const second = await reportPost(member, post.id);
    expect(second.status).toBe(200);
    expect(second.body.report.id).toBe(first.body.report.id);

    await getPool().query(
      `UPDATE reports SET status = 'dismissed', resolved_at = NOW()
        WHERE id = $1::bigint`,
      [first.body.report.id],
    );
    expect((await reportPost(member, post.id)).status).toBe(201);
  });

  it("counts a Baú report against the per-hour cap", async () => {
    for (let i = 0; i < REPORTS_PER_HOUR; i += 1) {
      resetApiRateLimits(); // the post composer has its own per-minute budget
      const post = await publish(communityId, { title: `p${i}` });
      await createReport({
        subjectType: "bau_post",
        reporterId: member.id,
        postId: post.id,
        reason: "spam",
      });
    }
    resetApiRateLimits();
    const one = await publish(communityId, { title: "extra" });
    await expect(
      createReport({
        subjectType: "bau_post",
        reporterId: member.id,
        postId: one.id,
        reason: "spam",
      }),
    ).rejects.toBeInstanceOf(ReportFloodError);
  });

  it("keeps the report, with the words, after the post is deleted", async () => {
    const post = await publish(communityId, { title: "apaga", body: "evidencia" });
    const said = await comment(communityId, post.id, member, "fala antes de sumir");
    const onPost = await reportPost(vip, post.id);
    const onComment = await reportComment(vip, said.id);
    expect(onPost.status).toBe(201);
    expect(onComment.status).toBe(201);

    expect(
      (await call(owner, "DELETE", `${home(communityId)}/posts/${post.id}`)).status,
    ).toBeLessThan(300);

    const queue = await call<{ reports: Array<Record<string, any>> }>(
      operator,
      "GET",
      "/api/reports/instance",
    );
    const byId = new Map(queue.body.reports.map((r) => [r.id, r]));
    expect(byId.get(onPost.body.report.id)).toMatchObject({
      bauPostId: null,
      contentSnapshot: "apaga\n\nevidencia",
    });
    expect(byId.get(onComment.body.report.id)).toMatchObject({
      bauPostId: null,
      bauCommentId: null,
      contentSnapshot: "fala antes de sumir",
    });
    // Nothing left to open: the context carries no Baú subject.
    const ctx = await call(
      operator,
      "GET",
      `/api/reports/${onPost.body.report.id}/context`,
    );
    expect(ctx.status).toBe(200);
    expect(reportContextSchema.parse(ctx.body).bau).toBeNull();
  });

  // -------------------------------------------------------------- routing

  it("sends a community's Baú report to the instance queue and never to its owner", async () => {
    const post = await publish(communityId, { title: "denuncia", visibility: "members" });
    const filed = await reportPost(vip, post.id);
    expect(filed.body.report).toMatchObject({ contextKind: "none" });

    const instance = await call<{ reports: Array<{ id: string }> }>(
      operator,
      "GET",
      "/api/reports/instance",
    );
    expect(instance.body.reports.map((r) => r.id)).toContain(filed.body.report.id);

    // The owner reads the server queue of their own community: nothing there.
    const serverQueue = await call<{ reports: Array<{ id: string }> }>(
      owner,
      "GET",
      `/api/servers/${communityId}/reports`,
    );
    expect(serverQueue.status).toBe(200);
    expect(serverQueue.body.reports).toEqual([]);
    // And they cannot read its context.
    expect(
      (await call(owner, "GET", `/api/reports/${filed.body.report.id}/context`)).status,
    ).toBe(404);
  });

  it("sends another server's Baú report to that server's queue, and minor_sexual to the instance", async () => {
    const post = await publish(privateId, { title: "no privado" });
    const filed = await reportPost(member, post.id);
    expect(filed.body.report).toMatchObject({ contextKind: "server" });
    const serverQueue = await call<{ reports: Array<{ id: string }> }>(
      admin,
      "GET",
      `/api/servers/${privateId}/reports`,
    );
    expect(serverQueue.body.reports.map((r) => r.id)).toContain(filed.body.report.id);

    const grave = await publish(privateId, { title: "grave" });
    const minor = await reportPost(member, grave.id, "minor_sexual");
    expect(minor.body.report).toMatchObject({ contextKind: "none" });
    const after = await call<{ reports: Array<{ id: string }> }>(
      admin,
      "GET",
      `/api/servers/${privateId}/reports`,
    );
    expect(after.body.reports.map((r) => r.id)).not.toContain(minor.body.report.id);
  });

  // ------------------------------------------------------ the operator read

  it("opens a members-only post for the operator past the lock, and audits nothing in the community's log", async () => {
    const post = await publish(communityId, {
      title: "Titulo trancado",
      body: "SO PARA VIP",
      teaser: "isca",
      visibility: "members",
    });
    const said = await comment(communityId, post.id, vip, "fala do vip");
    const around = await comment(communityId, post.id, vip, "outra fala");
    // The owner (staff, so they read the locked post) reports the VIP's words.
    const filed = await reportComment(owner, said.id);
    expect(filed.status).toBe(201);

    // The operator is not a member of anything, let alone a VIP.
    const res = await call(
      operator,
      "GET",
      `/api/reports/${filed.body.report.id}/context`,
    );
    expect(res.status).toBe(200);
    const ctx = reportContextSchema.parse(res.body);
    expect(ctx.bau?.serverId).toBe(communityId);
    expect(ctx.bau?.post).toMatchObject({
      id: post.id,
      title: "Titulo trancado",
      body: "SO PARA VIP",
      visibility: "members",
    });
    expect(ctx.bau?.comment?.body).toBe("fala do vip");
    expect(ctx.bau?.commentsAfter.map((c) => c.id)).toEqual([around.id]);

    // A community's own audit log never learns that somebody reported it.
    const audit = await getPool().query(
      `SELECT 1 FROM audit_log WHERE action = 'report.bau_view'`,
    );
    expect(audit.rows).toHaveLength(0);
  });

  it("keeps the VIP lock for everybody else: the normal reads still strip it", async () => {
    const post = await publish(communityId, {
      title: "Trancado",
      body: "SEGREDO-VIP",
      visibility: "members",
    });
    const filed = await reportPost(vip, post.id);
    expect(filed.status).toBe(201);
    // The operator opening the report did not change what a member reads.
    await call(operator, "GET", `/api/reports/${filed.body.report.id}/context`);
    const feed = await call<{ posts: Array<{ body: string | null; locked: boolean }> }>(
      member,
      "GET",
      `${home(communityId)}/posts`,
    );
    expect(feed.body.posts[0]).toMatchObject({ body: null, locked: true });
    // And the operator has no route onto the post that is not a report's.
    expect(
      (await call(operator, "GET", `${home(communityId)}/posts/${post.id}`)).status,
    ).toBe(404);
  });

  it("opens a server-scoped report for that server's staff only, and writes the audit row", async () => {
    const post = await publish(privateId, {
      title: "Privado VIP",
      body: "SEGREDO-PRIVADO",
      visibility: "members",
    });
    const filed = await reportPost(vip, post.id);
    expect(filed.body.report).toMatchObject({ contextKind: "server" });
    const path = `/api/reports/${filed.body.report.id}/context`;

    // A plain member and the reporter cannot read the card.
    expect((await call(member, "GET", path)).status).toBe(404);
    expect((await call(vip, "GET", path)).status).toBe(404);

    const res = await call(admin, "GET", path);
    expect(res.status).toBe(200);
    expect(reportContextSchema.parse(res.body).bau?.post?.body).toBe(
      "SEGREDO-PRIVADO",
    );

    const audit = await getPool().query<{
      server_id: string;
      actor_id: string;
      target_id: string;
    }>(
      `SELECT server_id, actor_id, target_id FROM audit_log
        WHERE action = 'report.bau_view'`,
    );
    expect(audit.rows).toEqual([
      { server_id: privateId, actor_id: admin.id, target_id: post.id },
    ]);
  });
});
