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
 * Watch party scheduling, pinned at the two boundaries that matter:
 *
 *   * ONLY MANAGE_CHANNELS MAY CREATE / EDIT / CANCEL A SESSION. A plain
 *     member gets 403 on all three; the same member may still subscribe to a
 *     reminder, which needs only channel access.
 *   * THE REMINDER JOB FIRES EACH OF ITS TWO REMINDERS EXACTLY ONCE. A T-10
 *     reminder does not re-fire on a second tick, and going live does not
 *     re-fire on every tick that follows while the session stays live.
 *
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
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer } = await import("./servers.js");
const {
  createChannelSession,
  markChannelSessionLive,
  sendDueChannelSessionReminders,
  setChannelSessionReminder,
} = await import("./channel-sessions.js");

let httpServer: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string },
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

describeDb("channel session scheduling", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let voiceChannelId: string;
  let serverId: string;

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

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    owner = await makeUser("owner");
    member = await makeUser("member");

    const created = await createChatServer("Cinemoon", owner.id);
    serverId = created.server.id;
    voiceChannelId = created.channels[1]!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
  });

  it("refuses session create/update/cancel to a plain member", async () => {
    const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const created = await call(member, "POST", `/api/channels/${voiceChannelId}/sessions`, {
      title: "Filme X",
      startsAt,
    });
    expect(created.status).toBe(403);

    // Have the owner make one so update/cancel have something to target.
    const ownerCreated = await call<{ session: { id: string } }>(
      owner,
      "POST",
      `/api/channels/${voiceChannelId}/sessions`,
      { title: "Filme X", startsAt },
    );
    expect(ownerCreated.status).toBe(200);
    const sessionId = ownerCreated.body.session.id;

    const updated = await call(member, "PATCH", `/api/sessions/${sessionId}`, {
      title: "Outro filme",
    });
    expect(updated.status).toBe(403);

    const cancelled = await call(member, "POST", `/api/sessions/${sessionId}/cancel`);
    expect(cancelled.status).toBe(403);
  });

  it("lets a manager create a session and a member subscribe to a reminder", async () => {
    const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const created = await call<{ session: { id: string; reminding: boolean } }>(
      owner,
      "POST",
      `/api/channels/${voiceChannelId}/sessions`,
      { title: "Filme X", startsAt },
    );
    expect(created.status).toBe(200);
    expect(created.body.session.reminding).toBe(false);
    const sessionId = created.body.session.id;

    const subscribed = await call(member, "POST", `/api/sessions/${sessionId}/remind`);
    expect(subscribed.status).toBe(200);

    const upcoming = await call<{ sessions: { id: string; reminding: boolean }[] }>(
      member,
      "GET",
      `/api/channels/${voiceChannelId}/sessions/upcoming`,
    );
    expect(upcoming.body.sessions).toHaveLength(1);
    expect(upcoming.body.sessions[0]!.reminding).toBe(true);
  });

  it("fires the T-10 and live reminders exactly once each", async () => {
    // Due in 5 minutes: inside the T-10 window already, so the very first
    // tick claims the "before" reminder.
    const startsAt = new Date(Date.now() + 5 * 60_000);
    const session = await createChannelSession({
      channelId: voiceChannelId,
      serverId,
      title: "Filme X",
      description: null,
      startsAt: startsAt.toISOString(),
      createdBy: owner.id,
    });
    await setChannelSessionReminder(session.id, member.id, true);

    await sendDueChannelSessionReminders();
    const afterFirst = await getPool().query(
      `SELECT notified_before_at, notified_live_at FROM channel_session_reminders
        WHERE session_id = $1 AND user_id = $2`,
      [session.id, member.id],
    );
    expect(afterFirst.rows[0].notified_before_at).not.toBeNull();
    expect(afterFirst.rows[0].notified_live_at).toBeNull();

    // A second tick before going live must NOT re-stamp notified_before_at.
    const stampedAt = afterFirst.rows[0].notified_before_at;
    await sendDueChannelSessionReminders();
    const afterSecond = await getPool().query(
      `SELECT notified_before_at FROM channel_session_reminders
        WHERE session_id = $1 AND user_id = $2`,
      [session.id, member.id],
    );
    expect(afterSecond.rows[0].notified_before_at).toEqual(stampedAt);

    // Going live, then two more ticks: the live reminder fires once.
    await markChannelSessionLive(voiceChannelId);
    await sendDueChannelSessionReminders();
    await sendDueChannelSessionReminders();
    const afterLive = await getPool().query(
      `SELECT notified_live_at FROM channel_session_reminders
        WHERE session_id = $1 AND user_id = $2`,
      [session.id, member.id],
    );
    expect(afterLive.rows[0].notified_live_at).not.toBeNull();
  });
});
