import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * A ROLE MENTION HAS TO REACH THE PEOPLE IN THE ROLE, LIVE AND BY PUSH.
 *
 * `recordMentions` has always written `message_mentions` rows for the members
 * of a mentioned role, so the badge you get after a refresh was right. The two
 * paths that run while the message is still fresh matched the typed tokens
 * against usernames only: the `channel-activity` frame's `mention` flag and
 * the push recipient list. A role name is nobody's username, so `@mods`
 * notified no one.
 *
 * Run the way production runs: a real Postgres, `CLUSTER_BUS=postgres` with
 * two machines (the sender on A, most recipients' sockets on B, one on A), the
 * real `chat.ts` and the real `sendChannelPush`, and `mention_ids_from_db`
 * turned on by a `feature_flags` row after `startFeatureFlags()` rather than by
 * the environment (CLAUDE.md pitfalls 9 and 12). Only the push vendor and the
 * "is this person connected" probe are stubbed.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.CLUSTER_BUS = "postgres";
delete process.env.MENTION_IDS_FROM_DB;
process.env.VAPID_PUBLIC_KEY = "test-public-key";
process.env.VAPID_PRIVATE_KEY = "test-private-key";
process.env.VAPID_SUBJECT = "mailto:push@example.test";

interface Instance {
  bus: typeof import("../lib/bus.js");
  db: typeof import("../db.js");
  chat: typeof import("./chat.js");
  flags: typeof import("../lib/flags.js");
  push: typeof import("../services/push.js");
  sockets: typeof import("./sockets.js");
  users: typeof import("../services/users.js");
  servers: typeof import("../services/servers.js");
  roles: typeof import("../services/roles.js");
  blocks: typeof import("../services/blocks.js");
  preferences: typeof import("../services/preferences.js");
  transport: ReturnType<typeof import("../lib/bus-postgres.js").createPostgresBusTransport>;
}

const booted: Instance[] = [];

/** One "machine": its own module graph, its own Postgres bus connection. */
async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = await import("../lib/bus.js");
  const db = await import("../db.js");
  const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
  const chat = await import("./chat.js");
  const flags = await import("../lib/flags.js");
  const push = await import("../services/push.js");
  const sockets = await import("./sockets.js");
  const users = await import("../services/users.js");
  const servers = await import("../services/servers.js");
  const roles = await import("../services/roles.js");
  const blocks = await import("../services/blocks.js");
  const preferences = await import("../services/preferences.js");
  await db.initDb();
  const transport = createPostgresBusTransport(DATABASE_URL);
  bus.setBusTransport(transport);
  await transport.whenConnected();
  await flags.startFeatureFlags();
  const instance = {
    bus,
    db,
    chat,
    flags,
    push,
    sockets,
    users,
    servers,
    roles,
    blocks,
    preferences,
    transport,
  };
  booted.push(instance);
  return instance;
}

function recordingSocket() {
  const received: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(payload),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

type Recording = ReturnType<typeof recordingSocket>;

function activity(rec: Recording): Array<{ type: string; mention: boolean }> {
  return rec.received
    .map((raw) => JSON.parse(raw) as { type: string; mention: boolean })
    .filter((frame) => frame.type === "channel-activity");
}

describeDb("role mentions notify, live and by push, across two instances", () => {
  let a: Instance;
  let b: Instance;
  let alice: DbUser;
  let bob: DbUser;
  let carol: DbUser;
  let dave: DbUser;
  let erin: DbUser;
  let frank: DbUser;
  let erinUsername: string;
  let channelId: string;
  let serverId: string;
  const pushed: string[] = [];
  const sockets = new Map<string, Recording>();

  const makeUser = (name: string) =>
    a.users.upsertUser({
      clerkId: `clerk_${name}_${Date.now()}`,
      displayName: name,
      avatarUrl: null,
    });

  async function say(body: string): Promise<void> {
    pushed.length = 0;
    for (const rec of sockets.values()) {
      rec.received.length = 0;
    }
    await a.chat.handleChatMessage(
      { socket: recordingSocket().socket, user: alice },
      { type: "message-create", channelId, body },
    );
  }

  beforeAll(async () => {
    a = await bootInstance();
    b = await bootInstance();
    expect(a.bus.isBusEnabled() && b.bus.isBusEnabled()).toBe(true);

    await a.db.getPool().query(
      `TRUNCATE users, servers, feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    alice = await makeUser("alice");
    bob = await makeUser("bob");
    carol = await makeUser("carol");
    dave = await makeUser("dave");
    erin = await makeUser("erin");
    frank = await makeUser("frank");
    const { server, channels } = await a.servers.createServer("Staff", alice.id);
    serverId = server.id;
    channelId = channels.find((channel) => channel.type === "text")!.id;
    for (const user of [bob, carol, dave, erin, frank]) {
      await a.db.getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, user.id],
      );
    }
    erinUsername = (
      await a.db.getPool().query<{ username: string }>(
        `SELECT username FROM users WHERE id = $1`,
        [erin.id],
      )
    ).rows[0]!.username;

    // A mentionable role: bob, carol, dave and frank are in it, erin is not.
    const role = await a.roles.createRole(serverId, {
      name: "mods",
      mentionable: true,
      permissions: 0n,
    });
    for (const user of [bob, carol, dave, frank]) {
      await a.roles.assignRole(serverId, user.id, role.id);
    }

    // Carol muted the whole server; dave blocked the author.
    await a.preferences.mergePreferences(carol.id, {
      notifications: { servers: { [serverId]: "none" } },
    });
    await a.blocks.blockUser(dave.id, alice.id);

    // Sockets, none of them looking at the channel. Frank is on the sender's
    // machine; everybody else is on the other one, so their frames can only
    // have come over the bus.
    for (const user of [bob, carol, dave, erin]) {
      const rec = recordingSocket();
      sockets.set(user.id, rec);
      b.sockets.setAuthenticatedSocket(rec.socket, user);
    }
    const frankSocket = recordingSocket();
    sockets.set(frank.id, frankSocket);
    a.sockets.setAuthenticatedSocket(frankSocket.socket, frank);

    // Push: everyone has a subscription and nobody is "connected" as far as the
    // push module is concerned, so only the recipient rules decide.
    for (const user of [bob, carol, dave, erin, frank]) {
      await a.push.savePushSubscription(user.id, {
        endpoint: `https://push.example/${user.id}`,
        keys: { p256dh: "p256dh-key", auth: "auth-key" },
      });
    }
    a.push.setLiveSocketProbeForTests(() => false);
    a.push.setPushSenderForTests(async (subscription) => {
      pushed.push(subscription.user_id);
    });
  }, 30_000);

  afterAll(async () => {
    for (const instance of booted) {
      instance.push.setPushSenderForTests(null);
      instance.push.setLiveSocketProbeForTests(null);
      await instance.transport.close().catch(() => {});
      instance.flags.resetFeatureFlagsForTests();
      await instance.db.closePool().catch(() => {});
    }
  });

  it("flag off: the role is recorded for the badge but notifies nobody live or by push", async () => {
    expect(a.flags.isEnabled("mention_ids_from_db")).toBe(false);

    // erin is named by username in the same message, which is what proves the
    // push for this message has finished: pushes are ordered, and her name is
    // the one path that worked before.
    await say(`ping @mods and @${erinUsername}`);
    await vi.waitFor(() => expect(pushed).toContain(erin.id), { timeout: 5_000 });
    await vi.waitFor(() => expect(activity(sockets.get(erin.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });

    expect(pushed).toEqual([erin.id]);
    // Everyone else is told something arrived, but not that it was for them.
    expect(activity(sockets.get(erin.id)!)[0]!.mention).toBe(true);
    expect(activity(sockets.get(bob.id)!).map((f) => f.mention)).toEqual([false]);
    expect(activity(sockets.get(carol.id)!).map((f) => f.mention)).toEqual([false]);
    expect(activity(sockets.get(frank.id)!).map((f) => f.mention)).toEqual([false]);

    // The badge after a refresh was always right; that is the disagreement.
    const rows = await a.db.getPool().query<{ user_id: string }>(
      `SELECT user_id FROM message_mentions
        WHERE message_id = (SELECT id FROM messages WHERE channel_id = $1
                            ORDER BY created_at DESC LIMIT 1)`,
      [channelId],
    );
    expect(rows.rows.map((r) => r.user_id).sort()).toEqual(
      [bob.id, carol.id, erin.id, frank.id].sort(),
    );
  }, 30_000);

  it("flag on (a feature_flags row, as production sets it): role members get the mention flag and the push", async () => {
    await a.flags.setGlobalFlag("mention_ids_from_db", true, { kind: "dashboard" });
    expect(a.flags.isEnabled("mention_ids_from_db")).toBe(true);
    await vi.waitFor(() => expect(b.flags.isEnabled("mention_ids_from_db")).toBe(true));

    await say("heads up @mods");
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThanOrEqual(2), {
      timeout: 5_000,
    });
    for (const id of [bob.id, carol.id, erin.id]) {
      await vi.waitFor(() => expect(activity(sockets.get(id)!)).toHaveLength(1), {
        timeout: 5_000,
      });
    }

    // Live: the sibling machine's sockets learn it from the frame's ids.
    expect(activity(sockets.get(bob.id)!).map((f) => f.mention)).toEqual([true]);
    expect(activity(sockets.get(carol.id)!).map((f) => f.mention)).toEqual([true]);
    // And the sender's own machine.
    expect(activity(sockets.get(frank.id)!).map((f) => f.mention)).toEqual([true]);
    // Not in the role: still just an unread dot.
    expect(activity(sockets.get(erin.id)!).map((f) => f.mention)).toEqual([false]);
    // Blocked the author: no activity at all, as for any message.
    expect(activity(sockets.get(dave.id)!)).toEqual([]);

    // Push: bob and frank. Carol muted the server, dave blocked the author,
    // erin is not in the role.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect([...pushed].sort()).toEqual([bob.id, frank.id].sort());
  }, 30_000);

  it("flag on: naming somebody and @everyone behave as they did", async () => {
    await say(`hi @${erinUsername}`);
    await vi.waitFor(() => expect(pushed).toEqual([erin.id]), { timeout: 5_000 });
    await vi.waitFor(() => expect(activity(sockets.get(erin.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
    expect(activity(sockets.get(erin.id)!)[0]!.mention).toBe(true);
    expect(activity(sockets.get(bob.id)!).map((f) => f.mention)).toEqual([false]);

    // The author owns the server, so @everyone is allowed.
    await say("all hands @everyone");
    await vi.waitFor(() => expect(activity(sockets.get(erin.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
    expect(activity(sockets.get(erin.id)!)[0]!.mention).toBe(true);
    expect(activity(sockets.get(bob.id)!)[0]!.mention).toBe(true);
    // Everyone but carol (muted the server), dave (blocked the author) and
    // the author.
    await vi.waitFor(() => expect(pushed).toHaveLength(3), { timeout: 5_000 });
    expect([...pushed].sort()).toEqual([bob.id, erin.id, frank.id].sort());
  }, 30_000);

  it("turning the flag off again returns to today's behaviour", async () => {
    await a.flags.setGlobalFlag("mention_ids_from_db", false, { kind: "dashboard" });
    await say(`again @mods @${erinUsername}`);
    await vi.waitFor(() => expect(pushed).toContain(erin.id), { timeout: 5_000 });
    await vi.waitFor(() => expect(activity(sockets.get(bob.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
    expect(pushed).toEqual([erin.id]);
    expect(activity(sockets.get(bob.id)!)[0]!.mention).toBe(false);
  }, 30_000);
});
