import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * CHAMAR A ATENÇÃO, ON TWO MACHINES.
 *
 * Production runs two API machines with `CLUSTER_BUS=postgres`, so every rule
 * here is exercised the way production meets it: the sender's socket on A, the
 * other person's on B, real Postgres, the real LISTEN/NOTIFY bus, the real
 * `chat.ts` on both sides, and the `nudge` flag turned on by a
 * `feature_flags` row written after `startFeatureFlags()` (never the
 * environment: CLAUDE.md pitfalls 9 and 12). Only the push vendor and the push
 * module's "is this person connected" probe are stubbed.
 *
 * Two instances are two module graphs (`vi.resetModules()`), as in
 * `voice-notes-cluster.test.ts`.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.CLUSTER_BUS = "postgres";
process.env.VOICE_REGISTRY = "postgres";
delete process.env.NUDGE;
process.env.VAPID_PUBLIC_KEY = "test-public-key";
process.env.VAPID_PRIVATE_KEY = "test-private-key";
process.env.VAPID_SUBJECT = "mailto:push@example.test";

interface Instance {
  bus: typeof import("../lib/bus.js");
  db: typeof import("../db.js");
  chat: typeof import("./chat.js");
  flags: typeof import("../lib/flags.js");
  sockets: typeof import("./sockets.js");
  status: typeof import("./status.js");
  push: typeof import("../services/push.js");
  nudge: typeof import("../services/nudge.js");
  limits: typeof import("../lib/cluster-rate-limit.js");
  users: typeof import("../services/users.js");
  servers: typeof import("../services/servers.js");
  dms: typeof import("../services/dms.js");
  friends: typeof import("../services/friends.js");
  blocks: typeof import("../services/blocks.js");
  preferences: typeof import("../services/preferences.js");
  messages: typeof import("../services/messages.js");
  transport: ReturnType<typeof import("../lib/bus-postgres.js").createPostgresBusTransport>;
}

const booted: Instance[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = await import("../lib/bus.js");
  const db = await import("../db.js");
  const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
  const instance = {
    bus,
    db,
    chat: await import("./chat.js"),
    flags: await import("../lib/flags.js"),
    sockets: await import("./sockets.js"),
    status: await import("./status.js"),
    push: await import("../services/push.js"),
    nudge: await import("../services/nudge.js"),
    limits: await import("../lib/cluster-rate-limit.js"),
    users: await import("../services/users.js"),
    servers: await import("../services/servers.js"),
    dms: await import("../services/dms.js"),
    friends: await import("../services/friends.js"),
    blocks: await import("../services/blocks.js"),
    preferences: await import("../services/preferences.js"),
    messages: await import("../services/messages.js"),
    transport: createPostgresBusTransport(DATABASE_URL),
  };
  await db.initDb();
  bus.setBusTransport(instance.transport);
  await instance.transport.whenConnected();
  await instance.flags.startFeatureFlags();
  booted.push(instance);
  return instance;
}

interface Frame {
  type: string;
  reason?: string;
  retryAfterMs?: number;
  nonce?: string;
  systemKind?: string;
  message?: { id: string; body: string; authorId: string; systemKind?: string | null };
}

function recordingSocket() {
  const received: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

type Recording = ReturnType<typeof recordingSocket>;

const ofType = (rec: Recording, type: string) =>
  rec.received.filter((frame) => frame.type === type);

describeDb("chamar a atenção across two instances on the Postgres bus", () => {
  let a: Instance;
  let b: Instance;
  let seq = 0;
  const pushed: Array<{ userId: string; title: string; body: string }> = [];

  const makeUser = (name: string) =>
    a.users.upsertUser({
      clerkId: `clerk_${name}_${Date.now()}_${seq++}`,
      displayName: name,
      avatarUrl: null,
    });

  /** Two friends and the 1:1 between them. */
  async function friendsInDm(left: string, right: string) {
    const one = await makeUser(left);
    const two = await makeUser(right);
    await a.friends.sendFriendRequest(one.id, two.id);
    expect(await a.friends.acceptFriendRequest(two.id, one.id)).toBe(true);
    const { channelId } = await a.dms.openConversation(one.id, [two.id]);
    return { one, two, channelId };
  }

  /** `sender` nudges on `on`, from a fresh socket unless one is given. */
  async function nudge(
    on: Instance,
    sender: DbUser,
    channelId: string,
    options: { rec?: Recording; nonce?: string } = {},
  ): Promise<Recording> {
    const rec = options.rec ?? recordingSocket();
    await on.chat.handleChatMessage(
      { socket: rec.socket, user: sender },
      { type: "nudge", channelId, ...(options.nonce ? { nonce: options.nonce } : {}) },
    );
    return rec;
  }

  const refusal = (rec: Recording) => ofType(rec, "nudge-refused").at(-1);

  async function countNudges(channelId: string): Promise<number> {
    const result = await a.db.getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE channel_id = $1 AND system_kind = 'nudge'`,
      [channelId],
    );
    return result.rows[0]!.n;
  }

  async function resetBudgets(): Promise<void> {
    for (const instance of [a, b]) {
      instance.nudge.resetNudgeStateForTests();
    }
    await a.limits.resetSharedRateLimit("nudge.conversation");
    await a.limits.resetSharedRateLimit("nudge.sender");
  }

  beforeAll(async () => {
    a = await bootInstance();
    b = await bootInstance();
    expect(a.bus.isBusEnabled() && b.bus.isBusEnabled()).toBe(true);
    expect(a.bus.INSTANCE_ID).not.toBe(b.bus.INSTANCE_ID);
    await a.db.getPool().query(
      `TRUNCATE users, servers, feature_flags, feature_flag_overrides, feature_flag_audit,
                rate_limit_buckets
       RESTART IDENTITY CASCADE`,
    );
    a.push.setLiveSocketProbeForTests(() => false);
    a.push.setPushSenderForTests(async (subscription, payload) => {
      const parsed = JSON.parse(payload) as { title: string; body: string };
      pushed.push({ userId: subscription.user_id, title: parsed.title, body: parsed.body });
    });
  }, 30_000);

  beforeEach(async () => {
    pushed.length = 0;
    await resetBudgets();
  });

  afterAll(async () => {
    for (const instance of booted) {
      instance.push.setPushSenderForTests(null);
      instance.push.setLiveSocketProbeForTests(null);
      await instance.transport.close().catch(() => {});
      instance.flags.resetFeatureFlagsForTests();
      await instance.db.closePool().catch(() => {});
    }
  });

  it("flag off (the default): refused as unavailable on every machine, nothing stored", async () => {
    const { one, channelId } = await friendsInDm("Ana", "Beto");
    expect(a.flags.isEnabled("nudge")).toBe(false);
    const rec = await nudge(a, one, channelId);
    expect(refusal(rec)).toMatchObject({ type: "nudge-refused", channelId, reason: "unavailable" });
    expect(ofType(rec, "message-broadcast")).toHaveLength(0);
    expect(await countNudges(channelId)).toBe(0);
    expect(a.nudge.nudgeMetrics()).toMatchObject({ enabled: false });
    expect(a.nudge.nudgeMetrics().refused.unavailable).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("flag on by a feature_flags row: both machines pick it up", async () => {
    await a.flags.setGlobalFlag("nudge", true, { kind: "dashboard" });
    expect(a.flags.isEnabled("nudge")).toBe(true);
    await vi.waitFor(() => expect(b.flags.isEnabled("nudge")).toBe(true), { timeout: 5_000 });
  }, 30_000);

  it("a nudge sent on A lands on B: the open DM gets the message, the stored row is a nudge", async () => {
    const { one: alice, two: bob, channelId } = await friendsInDm("Alice", "Bob");

    // Bob is looking at the conversation, on B.
    const viewer = recordingSocket();
    await b.chat.handleChatMessage(
      { socket: viewer.socket, user: bob },
      { type: "join-channel", channelId },
    );

    const sender = await nudge(a, alice, channelId, { nonce: "nudge-1" });
    expect(refusal(sender)).toBeUndefined();
    const echo = ofType(sender, "message-broadcast");
    expect(echo).toHaveLength(1);
    expect(echo[0]!.nonce).toBe("nudge-1");
    expect(echo[0]!.message).toMatchObject({ body: "📳", authorId: alice.id, systemKind: "nudge" });

    await vi.waitFor(() => expect(ofType(viewer, "message-broadcast")).toHaveLength(1), {
      timeout: 5_000,
    });
    const remote = ofType(viewer, "message-broadcast")[0]!.message!;
    expect(remote.id).toBe(echo[0]!.message!.id);
    expect(remote.systemKind).toBe("nudge");

    // History, the way a reload reads it.
    const page = await b.messages.listMessages(channelId, { viewerId: bob.id });
    const stored = page.messages.map((row) => b.messages.mapMessage(row));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ body: "📳", systemKind: "nudge" });
    expect(a.nudge.nudgeMetrics().sent).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("the same nonce again is the same message: echoed, not refused, not stored twice", async () => {
    const { one: alice, channelId } = await friendsInDm("Carla", "Davi");
    const first = await nudge(a, alice, channelId, { nonce: "replay-me" });
    expect(ofType(first, "message-broadcast")).toHaveLength(1);
    // On the other machine, inside the cooldown: a replay of a landed nudge.
    const again = await nudge(b, alice, channelId, { nonce: "replay-me" });
    expect(refusal(again)).toBeUndefined();
    expect(ofType(again, "message-broadcast")[0]!.message!.id).toBe(
      ofType(first, "message-broadcast")[0]!.message!.id,
    );
    expect(await countNudges(channelId)).toBe(1);
  }, 30_000);

  it("a receiver not looking at the DM, on B, is told it was a nudge; the push says so", async () => {
    const { one: alice, two: bob, channelId } = await friendsInDm("Edu", "Fabi");
    const bobElsewhere = recordingSocket();
    b.sockets.setAuthenticatedSocket(bobElsewhere.socket, bob);
    await a.push.savePushSubscription(bob.id, {
      endpoint: `https://push.example/${bob.id}`,
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    });
    await a.push.savePushSettings(bob.id, { dmDetails: true });

    await nudge(a, alice, channelId);
    await vi.waitFor(() => expect(ofType(bobElsewhere, "channel-activity")).toHaveLength(1), {
      timeout: 5_000,
    });
    expect(ofType(bobElsewhere, "channel-activity")[0]).toMatchObject({
      channelId,
      kind: "dm",
      systemKind: "nudge",
    });
    await vi.waitFor(() => expect(pushed).toHaveLength(1), { timeout: 5_000 });
    expect(pushed[0]).toEqual({ userId: bob.id, title: "Edu", body: "chamou tua atenção! 📳" });
    b.sockets.deleteAuthenticatedSocket(bobElsewhere.socket);
  }, 30_000);

  it("an ordinary message's activity carries no kind, so that frame is unchanged", async () => {
    const { one: alice, two: bob, channelId } = await friendsInDm("Gabi", "Hugo");
    const bobElsewhere = recordingSocket();
    b.sockets.setAuthenticatedSocket(bobElsewhere.socket, bob);
    await a.chat.handleChatMessage(
      { socket: recordingSocket().socket, user: alice },
      { type: "message-create", channelId, body: "📳" },
    );
    await vi.waitFor(() => expect(ofType(bobElsewhere, "channel-activity")).toHaveLength(1), {
      timeout: 5_000,
    });
    expect(ofType(bobElsewhere, "channel-activity")[0]!.systemKind).toBeUndefined();
    b.sockets.deleteAuthenticatedSocket(bobElsewhere.socket);
  }, 30_000);

  it("a muted conversation gets the line and no push", async () => {
    const { one: alice, two: bob, channelId } = await friendsInDm("Ivo", "Jana");
    await a.push.savePushSubscription(bob.id, {
      endpoint: `https://push.example/${bob.id}`,
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    });
    await a.preferences.mergePreferences(bob.id, {
      notifications: { channels: { [channelId]: "none" } },
    });
    const sender = await nudge(a, alice, channelId);
    expect(ofType(sender, "message-broadcast")).toHaveLength(1);
    expect(await countNudges(channelId)).toBe(1);
    // A second, unmuted friend nudged right after, whose push does land:
    // proves the silence is the mute and not a slow vendor.
    const other = await makeUser("Kika");
    await a.friends.sendFriendRequest(alice.id, other.id);
    await a.friends.acceptFriendRequest(other.id, alice.id);
    const { channelId: otherDm } = await a.dms.openConversation(alice.id, [other.id]);
    await a.push.savePushSubscription(other.id, {
      endpoint: `https://push.example/${other.id}`,
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    });
    await nudge(a, alice, otherDm);
    await vi.waitFor(() => expect(pushed.map((push) => push.userId)).toContain(other.id), {
      timeout: 5_000,
    });
    // dmDetails is off for this one: the sender stays unnamed.
    expect(pushed.find((push) => push.userId === other.id)).toMatchObject({
      title: "pqp",
      body: "Alguém chamou tua atenção! 📳",
    });
    expect(pushed.filter((push) => push.userId === bob.id)).toHaveLength(0);
  }, 30_000);

  it("cooldown: a second nudge inside 10 s is refused with the wait, on the other machine too", async () => {
    const { one: alice, channelId } = await friendsInDm("Kaio", "Lia");
    const first = await nudge(a, alice, channelId);
    expect(ofType(first, "message-broadcast")).toHaveLength(1);

    const sameMachine = await nudge(a, alice, channelId);
    expect(refusal(sameMachine)).toMatchObject({ reason: "cooldown" });
    expect(refusal(sameMachine)!.retryAfterMs).toBeGreaterThan(0);
    expect(refusal(sameMachine)!.retryAfterMs).toBeLessThanOrEqual(10_000);

    // A second tab on B has a fresh in-memory bucket. The shared row is what
    // refuses it, and it still says how long.
    const otherMachine = await nudge(b, alice, channelId);
    expect(refusal(otherMachine)).toMatchObject({ reason: "cooldown" });
    expect(refusal(otherMachine)!.retryAfterMs).toBeGreaterThan(0);
    expect(refusal(otherMachine)!.retryAfterMs).toBeLessThanOrEqual(10_000);
    expect(await countNudges(channelId)).toBe(1);
  }, 30_000);

  it("the sender burst: five across conversations, then cooldown", async () => {
    const sender = await makeUser("Mel");
    const channels: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const friend = await makeUser(`Amigo${i}`);
      await a.friends.sendFriendRequest(sender.id, friend.id);
      await a.friends.acceptFriendRequest(friend.id, sender.id);
      channels.push((await a.dms.openConversation(sender.id, [friend.id])).channelId);
    }
    for (const channelId of channels.slice(0, 5)) {
      expect(refusal(await nudge(a, sender, channelId))).toBeUndefined();
    }
    const sixth = await nudge(a, sender, channels[5]!);
    expect(refusal(sixth)).toMatchObject({ reason: "cooldown" });
    expect(refusal(sixth)!.retryAfterMs).toBeGreaterThan(0);
  }, 30_000);

  it("three unanswered in a row, then refused; a reply resets it", async () => {
    const { one: alice, two: bob, channelId } = await friendsInDm("Nina", "Otto");
    for (let i = 0; i < 3; i += 1) {
      expect(refusal(await nudge(a, alice, channelId))).toBeUndefined();
      await resetBudgets();
    }
    const fourth = await nudge(a, alice, channelId);
    expect(refusal(fourth)).toMatchObject({ reason: "unanswered" });
    expect(await countNudges(channelId)).toBe(3);

    // Bob answers, from B.
    await b.chat.handleChatMessage(
      { socket: recordingSocket().socket, user: bob },
      { type: "message-create", channelId, body: "fala!" },
    );
    await resetBudgets();
    expect(refusal(await nudge(a, alice, channelId))).toBeUndefined();
    expect(await countNudges(channelId)).toBe(4);
  }, 30_000);

  it("Não perturbe on B is seen from A: busy, nothing stored", async () => {
    const { one: alice, two: bob, channelId } = await friendsInDm("Paulo", "Quel");
    await a.preferences.mergePreferences(bob.id, { status: "dnd" });
    const bobStatus = recordingSocket();
    await b.status.registerStatusSocket(bobStatus.socket, bob.id);
    await vi.waitFor(() => expect(a.status.resolveStatus(bob.id)).toBe("dnd"), {
      timeout: 5_000,
    });
    const rec = await nudge(a, alice, channelId);
    expect(refusal(rec)).toMatchObject({ reason: "busy" });
    expect(await countNudges(channelId)).toBe(0);

    // Bob is back: the refusal spent no cooldown, so the next try lands at once.
    await b.preferences.mergePreferences(bob.id, { status: "online" });
    b.status.applyManualStatus(bob.id, "online");
    await vi.waitFor(() => expect(a.status.resolveStatus(bob.id)).not.toBe("dnd"), {
      timeout: 5_000,
    });
    expect(refusal(await nudge(a, alice, channelId))).toBeUndefined();
    expect(await countNudges(channelId)).toBe(1);
    b.status.unregisterStatusSocket(bobStatus.socket);
  }, 30_000);

  it("the sender's own switch off: self-off", async () => {
    const { one: alice, channelId } = await friendsInDm("Rui", "Sol");
    await a.preferences.mergePreferences(alice.id, { allowNudges: false });
    expect(refusal(await nudge(a, alice, channelId))).toMatchObject({ reason: "self-off" });
    expect(await countNudges(channelId)).toBe(0);
  }, 30_000);

  it("the receiver's switch off: the neutral unavailable", async () => {
    const { one: alice, two: bob, channelId } = await friendsInDm("Tati", "Ugo");
    await a.preferences.mergePreferences(bob.id, { allowNudges: false });
    expect(refusal(await nudge(a, alice, channelId))).toMatchObject({ reason: "unavailable" });
    expect(await countNudges(channelId)).toBe(0);
  }, 30_000);

  it("a block in either direction: unavailable, no line, no push", async () => {
    const first = await friendsInDm("Vera", "Wil");
    await a.push.savePushSubscription(first.two.id, {
      endpoint: `https://push.example/${first.two.id}`,
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    });
    await a.blocks.blockUser(first.two.id, first.one.id);
    expect(refusal(await nudge(a, first.one, first.channelId))).toMatchObject({
      reason: "unavailable",
    });

    const second = await friendsInDm("Xica", "Yuri");
    await a.blocks.blockUser(second.one.id, second.two.id);
    expect(refusal(await nudge(a, second.one, second.channelId))).toMatchObject({
      reason: "unavailable",
    });
    expect(await countNudges(first.channelId)).toBe(0);
    expect(await countNudges(second.channelId)).toBe(0);
    expect(pushed).toHaveLength(0);
  }, 30_000);

  it("not friends, a group conversation, a server channel: unavailable", async () => {
    const owner = await makeUser("Zeca");
    const stranger = await makeUser("Ari");
    const third = await makeUser("Bia");
    const { server, channels } = await a.servers.createServer("Sala", owner.id);
    for (const user of [stranger, third]) {
      await a.db.getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [server.id, user.id],
      );
    }
    // A 1:1 through a shared server, no friendship.
    const { channelId: strangerDm } = await a.dms.openConversation(owner.id, [stranger.id]);
    expect(refusal(await nudge(a, owner, strangerDm))).toMatchObject({ reason: "unavailable" });

    await a.friends.sendFriendRequest(owner.id, stranger.id);
    await a.friends.acceptFriendRequest(stranger.id, owner.id);
    await resetBudgets();
    const { channelId: group } = await a.dms.openConversation(owner.id, [stranger.id, third.id]);
    expect(refusal(await nudge(a, owner, group))).toMatchObject({ reason: "unavailable" });

    await resetBudgets();
    const text = channels.find((channel) => channel.type === "text")!.id;
    expect(refusal(await nudge(a, owner, text))).toMatchObject({ reason: "unavailable" });

    // Somebody who is not in the 1:1 at all.
    await resetBudgets();
    const { one, channelId } = await friendsInDm("Caio", "Dani");
    expect(one.id).not.toBe(third.id);
    expect(refusal(await nudge(a, third, channelId))).toMatchObject({ reason: "unavailable" });

    for (const id of [strangerDm, group, text, channelId]) {
      expect(await countNudges(id)).toBe(0);
    }
  }, 30_000);

  it("an ordinary message can never claim the kind: message-create stays a message", async () => {
    const { one: alice, channelId } = await friendsInDm("Enzo", "Flor");
    const rec = recordingSocket();
    await a.chat.handleChatMessage(
      { socket: rec.socket, user: alice },
      // A forged field on a create frame is stripped by the schema.
      { type: "message-create", channelId, body: "📳", systemKind: "nudge" },
    );
    expect(ofType(rec, "message-broadcast")[0]!.message!.systemKind ?? null).toBeNull();
    expect(await countNudges(channelId)).toBe(0);
  }, 30_000);
});
