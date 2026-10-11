import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * "DIGITANDO…" REACHES THE CONVERSATION LIST, ON EVERY MACHINE.
 *
 * Before Conversas a typing frame went only to sockets with the channel open,
 * so a list could never say somebody was typing. Now a conversation's frame is
 * also addressed to every other participant's sockets, by account.
 *
 * Run the way production runs: a real Postgres, `CLUSTER_BUS=postgres` with two
 * machines (the typist on A, most participants' sockets on B), the real
 * `chat.ts`. What it pins: the participants get it on both machines, a viewer
 * gets it exactly once, a blocker and an outsider never do, the typist never
 * hears themself, a server channel reaches nobody who is not looking at it,
 * and closing a conversation stops its frames at once.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.CLUSTER_BUS = "postgres";

interface Instance {
  bus: typeof import("../lib/bus.js");
  db: typeof import("../db.js");
  chat: typeof import("./chat.js");
  sockets: typeof import("./sockets.js");
  users: typeof import("../services/users.js");
  servers: typeof import("../services/servers.js");
  dms: typeof import("../services/dms.js");
  blocks: typeof import("../services/blocks.js");
  typing: typeof import("../services/conversation-typing.js");
  transport: ReturnType<typeof import("../lib/bus-postgres.js").createPostgresBusTransport>;
}

const booted: Instance[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = await import("../lib/bus.js");
  const db = await import("../db.js");
  const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
  const chat = await import("./chat.js");
  const sockets = await import("./sockets.js");
  const users = await import("../services/users.js");
  const servers = await import("../services/servers.js");
  const dms = await import("../services/dms.js");
  const blocks = await import("../services/blocks.js");
  const typing = await import("../services/conversation-typing.js");
  await db.initDb();
  const transport = createPostgresBusTransport(DATABASE_URL);
  bus.setBusTransport(transport);
  await transport.whenConnected();
  const instance = { bus, db, chat, sockets, users, servers, dms, blocks, typing, transport };
  booted.push(instance);
  return instance;
}

function recordingSocket() {
  const received: string[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (payload: string | Buffer) => received.push(payload.toString()),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

type Recording = ReturnType<typeof recordingSocket>;

function typingFrames(rec: Recording): Array<{ channelId: string; userId: string }> {
  return rec.received
    .map((raw) => JSON.parse(raw) as { type: string; channelId: string; userId: string })
    .filter((frame) => frame.type === "typing-broadcast");
}

describeDb("conversation typing reaches the participants' lists across two instances", () => {
  let a: Instance;
  let b: Instance;
  let alice: DbUser; // the typist, on A
  let bob: DbUser; // participant, list only, on B
  let carol: DbUser; // participant, viewing the group, on A
  let dave: DbUser; // participant who blocked alice, on B
  let erin: DbUser; // not a participant, on B
  let group: string;
  let dm: string;
  let serverChannel: string;
  const recs = new Map<string, Recording>();
  const typist = recordingSocket();

  const makeUser = (name: string) =>
    a.users.upsertUser({
      clerkId: `clerk_${name}_${Date.now()}`,
      displayName: name,
      avatarUrl: null,
    });

  async function aliceTypes(channelId: string): Promise<void> {
    a.chat.resetChatRateLimits();
    await a.chat.handleChatMessage(
      { socket: typist.socket, user: alice },
      { type: "join-channel", channelId },
    );
    for (const rec of recs.values()) {
      rec.received.length = 0;
    }
    typist.received.length = 0;
    await a.chat.handleChatMessage(
      { socket: typist.socket, user: alice },
      { type: "typing", channelId },
    );
  }

  beforeAll(async () => {
    a = await bootInstance();
    b = await bootInstance();
    expect(a.bus.isBusEnabled() && b.bus.isBusEnabled()).toBe(true);

    await a.db.getPool().query(
      `TRUNCATE users, servers RESTART IDENTITY CASCADE`,
    );
    alice = await makeUser("alice");
    bob = await makeUser("bob");
    carol = await makeUser("carol");
    dave = await makeUser("dave");
    erin = await makeUser("erin");
    await a.db.getPool().query(
      `UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`,
    );
    const { server, channels } = await a.servers.createServer("Sala", alice.id);
    serverChannel = channels.find((channel) => channel.type === "text")!.id;
    for (const user of [bob, carol, dave, erin]) {
      await a.db.getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [server.id, user.id],
      );
    }
    group = (await a.dms.openConversation(alice.id, [bob.id, carol.id, dave.id])).channelId;
    dm = (await a.dms.openConversation(alice.id, [bob.id])).channelId;
    await a.blocks.blockUser(dave.id, alice.id);

    a.sockets.setAuthenticatedSocket(typist.socket, alice);
    for (const [user, instance] of [
      [bob, b],
      [carol, a],
      [dave, b],
      [erin, b],
    ] as const) {
      const rec = recordingSocket();
      recs.set(user.id, rec);
      instance.sockets.setAuthenticatedSocket(rec.socket, user);
    }
    // Carol has the group open.
    await a.chat.handleChatMessage(
      { socket: recs.get(carol.id)!.socket, user: carol },
      { type: "join-channel", channelId: group },
    );
  }, 30_000);

  beforeEach(() => {
    a.typing.resetConversationTypingAudience();
    b.typing.resetConversationTypingAudience();
  });

  afterAll(async () => {
    for (const instance of booted) {
      await instance.transport.close().catch(() => {});
      await instance.db.closePool().catch(() => {});
    }
  });

  it("a group: every participant's list hears it once, a blocker and an outsider never", async () => {
    await aliceTypes(group);
    await vi.waitFor(() => expect(typingFrames(recs.get(bob.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
    expect(typingFrames(recs.get(bob.id)!)[0]).toMatchObject({
      channelId: group,
      userId: alice.id,
    });
    // Viewing the group: the viewer copy, not a second list copy.
    expect(typingFrames(recs.get(carol.id)!)).toHaveLength(1);
    // Give the bus time to deliver anything it was going to.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(typingFrames(recs.get(carol.id)!)).toHaveLength(1);
    expect(typingFrames(recs.get(dave.id)!)).toEqual([]);
    expect(typingFrames(recs.get(erin.id)!)).toEqual([]);
    expect(typingFrames(typist)).toEqual([]);
  }, 30_000);

  it("a 1:1 reaches the other person's list on the other machine", async () => {
    await aliceTypes(dm);
    await vi.waitFor(() => expect(typingFrames(recs.get(bob.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const other of [carol, dave, erin]) {
      expect(typingFrames(recs.get(other.id)!)).toEqual([]);
    }
  }, 30_000);

  it("a server channel stays with the people looking at it", async () => {
    await aliceTypes(serverChannel);
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const other of [bob, carol, dave, erin]) {
      expect(typingFrames(recs.get(other.id)!)).toEqual([]);
    }
    // The answer is memoised: asking again costs no query and still says no.
    await expect(
      a.typing.conversationTypingAudience(serverChannel, alice.id),
    ).resolves.toBeNull();
  }, 30_000);

  it("a block lands at once, not after the cache window, and so does lifting it", async () => {
    await aliceTypes(group);
    await vi.waitFor(() => expect(typingFrames(recs.get(bob.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
    // The audience is cached now. Bob blocks Alice on the machine that holds
    // her socket (the one that answers her typing).
    await a.blocks.blockUser(bob.id, alice.id);
    await aliceTypes(group);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(typingFrames(recs.get(bob.id)!)).toEqual([]);
    await a.blocks.unblockUser(bob.id, alice.id);
    await aliceTypes(group);
    await vi.waitFor(() => expect(typingFrames(recs.get(bob.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
  }, 30_000);

  it("a warm cache rides on the one bus frame; a cold one sends the list copy once", async () => {
    // Cold: the viewers' frame and then the list-only frame. Bob (a list on
    // the other machine) still hears it exactly once.
    await aliceTypes(dm);
    await vi.waitFor(() => expect(typingFrames(recs.get(bob.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(typingFrames(recs.get(bob.id)!)).toHaveLength(1);
    // Warm: same answer, one frame.
    await aliceTypes(dm);
    await vi.waitFor(() => expect(typingFrames(recs.get(bob.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(typingFrames(recs.get(bob.id)!)).toHaveLength(1);
  }, 30_000);

  it("closing the conversation stops its frames at once, not after the cache window", async () => {
    await aliceTypes(dm);
    await vi.waitFor(() => expect(typingFrames(recs.get(bob.id)!)).toHaveLength(1), {
      timeout: 5_000,
    });
    // Bob closes the 1:1. The route evicts his view, which drops the cached
    // audience on every machine.
    await b.dms.hideConversation(dm, bob.id);
    b.chat.evictChannelViewers(dm, { onlyUserIds: [bob.id] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await aliceTypes(dm);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(typingFrames(recs.get(bob.id)!)).toEqual([]);
  }, 30_000);
});
