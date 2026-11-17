import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
 * The built-in text filter, end to end on a real Postgres. It is OFF by
 * default (the last describe block pins that, and that the operator and an
 * owner can each turn it on); every other test runs with the operator's flag
 * on globally, which is how a deployment that chose it behaves: a server with
 * NO AutoMod rule still refuses a slur or a threat, on every public surface that
 * carries words (a message, its edit, a story-shaped check, a Baú comment, a
 * profile name), never reads a direct or group message, lets insults and
 * everyday swearing through, the owner can switch it off for their own server,
 * and the operator's `default_text_filter` flag switches it off for everybody. The refusal is the plain sentence the author is meant to read,
 * and what the audit log keeps is the class, never the word.
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

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { setGlobalFlag, setServerFlagOverride } = await import("../lib/flags.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser, getUserById } = await import("../services/users.js");
const { invalidateAutomodCache, resetAutomodUser, resetAutomodAlertCooldown, checkAutomod } =
  await import("../services/automod.js");
const { postChannelMessage } = await import("../ws/index.js");
const { BASELINE_REJECTION_MESSAGE } = await import("@pqp/shared");

let server: Server;
let baseUrl: string;

type Actor = { id: string; clerk_id: string };

async function call<T = Record<string, unknown>>(
  as: Actor | null,
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

describeDb("default text filter", () => {
  let owner: Actor;
  let member: Actor;
  let friend: Actor;

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    // A hit's audit write runs after the refusal returns; let it land first.
    await new Promise((done) => setTimeout(done, 120));
    resetApiRateLimits();
    invalidateAutomodCache();
    resetAutomodUser();
    resetAutomodAlertCooldown();
    // The operator's variable, on: every test below but the last block is a
    // deployment that turned the filter on. `describe("off by default")` unsets it.
    process.env.DEFAULT_TEXT_FILTER = "true";
    process.env.COMMUNITY_HOME_ENABLED = "true";
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    owner = await upsertUser({ clerkId: "clerk_owner", displayName: "Owner", avatarUrl: null });
    member = await upsertUser({ clerkId: "clerk_member", displayName: "Member", avatarUrl: null });
    friend = await upsertUser({ clerkId: "clerk_friend", displayName: "Friend", avatarUrl: null });
  });

  afterEach(async () => {
    await setGlobalFlag("default_text_filter", null, { kind: "dashboard" });
    delete process.env.DEFAULT_TEXT_FILTER;
    delete process.env.COMMUNITY_HOME_ENABLED;
  });

  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Hall" });
    expect(created.status).toBe(201);
    const serverId = created.body.server.id;
    for (const person of [member, friend]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, person.id],
      );
    }
    const text = created.body.channels.find((c) => c.type === "text")!;
    return { serverId, channelId: text.id };
  }

  async function send(as: Actor, channelId: string, body: string) {
    const author = await getUserById(as.id);
    return postChannelMessage({ author: author!, channelId, body });
  }

  const baselinePath = (serverId: string) => `/api/servers/${serverId}/automod/baseline`;

  it("a server with no rule at all refuses a slur and lets everything else through", async () => {
    const { channelId, serverId } = await makeServer();
    const rules = await getPool().query(`SELECT 1 FROM automod_rules WHERE server_id = $1`, [serverId]);
    expect(rules.rowCount).toBe(0);

    const refused = await send(member, channelId, "you stupid faggot");
    expect(refused).toMatchObject({
      ok: false,
      reason: "automod",
      automodMessage: BASELINE_REJECTION_MESSAGE,
    });
    expect(BASELINE_REJECTION_MESSAGE).toBe(
      "This message was not sent: it breaks pqp's rules on abusive language.",
    );

    // Insults, ordinary swearing and ordinary talk land.
    expect((await send(member, channelId, "fuck you, you stupid idiot")).ok).toBe(true);
    expect((await send(member, channelId, "vai tomar no cu")).ok).toBe(true);
    expect((await send(member, channelId, "you are a cunt lol")).ok).toBe(true);
    expect((await send(member, channelId, "this boss is shit")).ok).toBe(true);
    expect((await send(member, channelId, "bom dia, galera")).ok).toBe(true);
    expect((await send(member, channelId, "I'll kill you in this match lol")).ok).toBe(true);
    // A refusal wrote nothing.
    const stored = await getPool().query(`SELECT body FROM messages WHERE channel_id = $1`, [channelId]);
    expect(stored.rows.map((r: { body: string }) => r.body)).not.toContain("you stupid faggot");
  });

  it("refuses the owner too: the baseline has no staff bypass", async () => {
    const { channelId } = await makeServer();
    expect(await send(owner, channelId, "vai se matar")).toMatchObject({
      ok: false,
      reason: "automod",
    });
  });

  it("audits the class, never the word, and says it came from the baseline", async () => {
    const { channelId, serverId } = await makeServer();
    await send(member, channelId, "you nigger");
    await new Promise((done) => setTimeout(done, 300));
    const audit = await getPool().query(
      `SELECT action, reason, changes FROM audit_log WHERE server_id = $1 AND action = 'automod.block'`,
      [serverId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].reason).toBe("baseline");
    const changes = audit.rows[0].changes as Array<{ key: string; new: unknown }>;
    expect(changes.find((c) => c.key === "matched")?.new).toBe("slur");
    expect(JSON.stringify(audit.rows[0])).not.toMatch(/nigg/i);
  });

  it("an edit into a threat is refused with a 422 and the same sentence", async () => {
    const { channelId } = await makeServer();
    const posted = await send(member, channelId, "hello");
    expect(posted.ok).toBe(true);
    const messageId = (posted as { ok: true; message: { id: string } }).message.id;
    const edit = await call<{ error: string }>(member, "PATCH", `/api/messages/${messageId}`, {
      body: "kill yourself",
    });
    expect(edit.status).toBe(422);
    expect(edit.body.error).toBe(BASELINE_REJECTION_MESSAGE);
  });

  it("a direct or group message is NOT read, on send or on edit", async () => {
    await makeServer(); // member and friend share it, so the DM opens
    const opened = await call<{ conversation: { channelId: string } }>(member, "POST", "/api/dms", {
      userIds: [friend.id],
    });
    expect(opened.status).toBe(201);
    const channelId = opened.body.conversation.channelId;
    const sent = await send(member, channelId, "you faggot, kill yourself");
    expect(sent.ok).toBe(true);
    expect((await send(member, channelId, "fuck you, seu arrombado")).ok).toBe(true);
    const messageId = (sent as { ok: true; message: { id: string } }).message.id;
    const edit = await call(member, "PATCH", `/api/messages/${messageId}`, { body: "kys" });
    expect(edit.status).toBe(200);
  });

  it("the words of a story go through the same check", async () => {
    const { serverId } = await makeServer();
    const verdict = await checkAutomod({
      serverId,
      channelId: "",
      parentChannelId: null,
      authorId: member.id,
      memberPerms: 0n,
      body: "te voy a violar",
    });
    expect(verdict).toMatchObject({ baseline: true, matched: "threat" });
    // An insult is not a baseline hit.
    expect(
      await checkAutomod({
        serverId,
        channelId: "",
        parentChannelId: null,
        authorId: member.id,
        memberPerms: 0n,
        body: "chinga tu madre",
      }),
    ).toBeNull();
  });

  it("a Baú comment is refused with a 400 and the sentence", async () => {
    const { serverId } = await makeServer();
    const post = await call<{ post: { id: string } }>(owner, "POST", `/api/servers/${serverId}/home/posts`, {
      status: "published",
      title: "Papo",
      body: "x",
    });
    expect(post.status).toBe(201);
    const path = `/api/servers/${serverId}/home/posts/${post.body.post.id}/comments`;
    const bad = await call<{ error: string }>(member, "POST", path, { body: "you are a faggot" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe(BASELINE_REJECTION_MESSAGE);
    expect((await call(member, "POST", path, { body: "bom post" })).status).toBe(201);
    // A staff post is read as well.
    const badPost = await call<{ error: string }>(owner, "POST", `/api/servers/${serverId}/home/posts`, {
      status: "published",
      title: "faggot",
      body: "x",
    });
    expect(badPost.status).toBe(400);
  });

  it("a profile name, tag name, handle or recado is refused before anything is written", async () => {
    const before = await getUserById(member.id);
    for (const patch of [
      { displayName: "nigger lover" },
      { username: "faggot" },
      { handle: "kys" },
      { customStatus: "vai se matar" },
    ]) {
      const res = await call<{ error: string }>(member, "PATCH", "/api/me", patch);
      expect(res.status, JSON.stringify(patch)).toBe(422);
    }
    const after = await getUserById(member.id);
    expect(after!.display_name).toBe(before!.display_name);
    const ok = await call(member, "PATCH", "/api/me", { displayName: "Maya Chen" });
    expect(ok.status).toBe(200);
    // An insult in a recado is not the baseline's business.
    const insult = await call(member, "PATCH", "/api/me", { customStatus: "fuck you all" });
    expect(insult.status).toBe(200);
  });

  describe("the owner's switch", () => {
    it("reports the operator's answer, and an owner turns it off and on for their server only", async () => {
      const a = await makeServer();
      const first = await call(owner, "GET", baselinePath(a.serverId));
      expect(first.body).toEqual({ instanceEnabled: true, ownerChoice: null, enabled: true });

      const off = await call(owner, "PUT", baselinePath(a.serverId), { enabled: false });
      expect(off.status).toBe(200);
      expect(off.body).toEqual({ instanceEnabled: true, ownerChoice: false, enabled: false });
      expect((await send(member, a.channelId, "you faggot")).ok).toBe(true);

      // Another server is untouched.
      const created = await call<{ server: { id: string }; channels: Array<{ id: string; type: string }> }>(
        owner,
        "POST",
        "/api/servers",
        { name: "Other" },
      );
      const otherChannel = created.body.channels.find((c) => c.type === "text")!.id;
      expect(await send(owner, otherChannel, "you faggot")).toMatchObject({ ok: false });

      // And the switch is its own audit line.
      const audit = await getPool().query(
        `SELECT changes FROM audit_log WHERE server_id = $1 AND action = 'automod.rule_update'`,
        [a.serverId],
      );
      expect(audit.rowCount).toBe(1);
      // Saying "off" again is not a change and is not audited again.
      await call(owner, "PUT", baselinePath(a.serverId), { enabled: false });
      const again = await getPool().query(
        `SELECT 1 FROM audit_log WHERE server_id = $1 AND action = 'automod.rule_update'`,
        [a.serverId],
      );
      expect(again.rowCount).toBe(1);

      const on = await call(owner, "PUT", baselinePath(a.serverId), { enabled: true });
      expect(on.body).toEqual({ instanceEnabled: true, ownerChoice: true, enabled: true });
      expect(await send(member, a.channelId, "you faggot")).toMatchObject({ ok: false });
      // The owner's choice is a row either way, so the operator's flag can no
      // longer flip this server behind the owner's back.
      const rows = await getPool().query(
        `SELECT disabled FROM server_text_filter_settings WHERE server_id = $1`,
        [a.serverId],
      );
      expect(rows.rows).toEqual([{ disabled: false }]);
    });

    it("only Manage Server may change it, and a plain member cannot even read it", async () => {
      const { serverId } = await makeServer();
      expect((await call(member, "PUT", baselinePath(serverId), { enabled: false })).status).toBe(403);
      expect((await call(member, "GET", baselinePath(serverId))).status).toBe(403);
    });

    it("an owner who switched it off still has the owner's own rules running", async () => {
      const { serverId, channelId } = await makeServer();
      await call(owner, "POST", `/api/servers/${serverId}/automod/rules`, {
        kind: "keywords",
        keywords: ["pineapple"],
      });
      await call(owner, "PUT", baselinePath(serverId), { enabled: false });
      expect((await send(member, channelId, "you faggot")).ok).toBe(true);
      expect(await send(member, channelId, "pineapple")).toMatchObject({ ok: false, reason: "automod" });
    });

    it("a profile name follows only the operator's global answer", async () => {
      process.env.DEFAULT_TEXT_FILTER = "false";
      const res = await call(member, "PATCH", "/api/me", { customStatus: "vai se matar" });
      expect(res.status).toBe(200);
    });
  });

  describe("off by default", () => {
    beforeEach(() => {
      delete process.env.DEFAULT_TEXT_FILTER;
    });

    it("with no row and no variable nothing is filtered, on any surface", async () => {
      const { serverId, channelId } = await makeServer();
      // A server message, an edit, a forum-shaped check, a DM, a Bau comment, a name.
      expect((await send(member, channelId, "you faggot, kill yourself")).ok).toBe(true);
      const posted = await send(member, channelId, "hello");
      const messageId = (posted as { ok: true; message: { id: string } }).message.id;
      expect((await call(member, "PATCH", `/api/messages/${messageId}`, { body: "kys" })).status).toBe(200);
      expect(
        await checkAutomod({
          serverId,
          channelId: "",
          parentChannelId: null,
          authorId: member.id,
          memberPerms: 0n,
          body: "te voy a violar",
        }),
      ).toBeNull();
      const opened = await call<{ conversation: { channelId: string } }>(member, "POST", "/api/dms", {
        userIds: [friend.id],
      });
      expect((await send(member, opened.body.conversation.channelId, "you faggot")).ok).toBe(true);
      const post = await call<{ post: { id: string } }>(owner, "POST", `/api/servers/${serverId}/home/posts`, {
        status: "published",
        title: "Papo",
        body: "x",
      });
      const path = `/api/servers/${serverId}/home/posts/${post.body.post.id}/comments`;
      expect((await call(member, "POST", path, { body: "you are a faggot" })).status).toBe(201);
      expect((await call(member, "PATCH", "/api/me", { customStatus: "vai se matar" })).status).toBe(200);
      expect((await call(owner, "GET", baselinePath(serverId))).body).toEqual({
        instanceEnabled: false,
        ownerChoice: null,
        enabled: false,
      });
    });

    it("an owner can turn it on for their server, and it never reaches DMs or other servers", async () => {
      const a = await makeServer();
      const on = await call(owner, "PUT", baselinePath(a.serverId), { enabled: true });
      expect(on.body).toEqual({ instanceEnabled: false, ownerChoice: true, enabled: true });
      expect(await send(member, a.channelId, "you faggot")).toMatchObject({ ok: false, reason: "automod" });
      // An insult still lands: only slurs and threats are on the list.
      expect((await send(member, a.channelId, "fuck you")).ok).toBe(true);

      const created = await call<{ server: { id: string }; channels: Array<{ id: string; type: string }> }>(
        owner,
        "POST",
        "/api/servers",
        { name: "Other" },
      );
      const otherChannel = created.body.channels.find((c) => c.type === "text")!.id;
      expect((await send(owner, otherChannel, "you faggot")).ok).toBe(true);

      const opened = await call<{ conversation: { channelId: string } }>(member, "POST", "/api/dms", {
        userIds: [friend.id],
      });
      expect((await send(member, opened.body.conversation.channelId, "you faggot")).ok).toBe(true);
      // A name has no server: the owner's opt-in does not reach it.
      expect((await call(member, "PATCH", "/api/me", { customStatus: "vai se matar" })).status).toBe(200);

      // And they can turn it back off.
      await call(owner, "PUT", baselinePath(a.serverId), { enabled: false });
      expect((await send(member, a.channelId, "you faggot")).ok).toBe(true);
    });

    it("the operator turns it on for one server from the dashboard, and then for everybody", async () => {
      const a = await makeServer();
      const created = await call<{ server: { id: string }; channels: Array<{ id: string; type: string }> }>(
        owner,
        "POST",
        "/api/servers",
        { name: "Other" },
      );
      const b = {
        serverId: created.body.server.id,
        channelId: created.body.channels.find((c) => c.type === "text")!.id,
      };
      await setServerFlagOverride("default_text_filter", a.serverId, true, { kind: "dashboard" });
      invalidateAutomodCache();
      expect(await send(owner, a.channelId, "you faggot")).toMatchObject({ ok: false });
      expect((await send(owner, b.channelId, "you faggot")).ok).toBe(true);
      expect((await call(owner, "GET", baselinePath(a.serverId))).body).toEqual({
        instanceEnabled: true,
        ownerChoice: null,
        enabled: true,
      });
      // Names have no server, so a per-server override leaves them alone.
      expect((await call(member, "PATCH", "/api/me", { customStatus: "vai se matar" })).status).toBe(200);

      await setGlobalFlag("default_text_filter", true, { kind: "dashboard" });
      invalidateAutomodCache();
      expect(await send(owner, b.channelId, "you faggot")).toMatchObject({ ok: false });
      expect((await call(member, "PATCH", "/api/me", { customStatus: "vai se matar" })).status).toBe(422);

      // The owner's choice still wins on their own server.
      await call(owner, "PUT", baselinePath(b.serverId), { enabled: false });
      expect((await send(owner, b.channelId, "you faggot")).ok).toBe(true);
    });

    it("only the word true turns the variable on", async () => {
      const { channelId } = await makeServer();
      for (const value of ["on", "1", "yes"]) {
        process.env.DEFAULT_TEXT_FILTER = value;
        expect((await send(member, channelId, "you faggot")).ok, value).toBe(true);
      }
      process.env.DEFAULT_TEXT_FILTER = "true";
      expect(await send(member, channelId, "you faggot")).toMatchObject({ ok: false });
    });
  });

  describe("the operator's flag", () => {
    it("turned off, nothing is filtered by default, but an owner who opted in still is", async () => {
      const { serverId, channelId } = await makeServer();
      process.env.DEFAULT_TEXT_FILTER = "false";
      expect((await send(member, channelId, "you faggot")).ok).toBe(true);
      const status = await call(owner, "GET", baselinePath(serverId));
      expect(status.body).toEqual({ instanceEnabled: false, ownerChoice: null, enabled: false });
      process.env.DEFAULT_TEXT_FILTER = "true";
      expect(await send(member, channelId, "you faggot")).toMatchObject({ ok: false });
      await call(owner, "PUT", baselinePath(serverId), { enabled: true });
      process.env.DEFAULT_TEXT_FILTER = "false";
      expect(await send(member, channelId, "you faggot")).toMatchObject({ ok: false });
    });
  });
});
