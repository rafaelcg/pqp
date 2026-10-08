import { afterAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * A VOICE NOTE SENT ON ONE INSTANCE, HEARD ON THE OTHER.
 *
 * Production runs two API machines with `CLUSTER_BUS=postgres`, so the
 * delivery that matters is the one that crosses: a note posted to a socket on
 * A has to reach a viewer whose socket is on B still carrying `voice`, or the
 * other machine's half of the room sees a plain audio file (or nothing, if a
 * field on the way drops it). Pitfall 12 says to run the flag production runs,
 * so this is the real Postgres transport (LISTEN/NOTIFY on the test database),
 * real `chat.ts` on both sides, real mint and claim, and the `voice_notes`
 * flag turned on by a per-server override row after `startFeatureFlags()`.
 *
 * Two instances are two module graphs (`vi.resetModules()`), the technique
 * `ws/cluster.test.ts` uses with a memory hub; only the transport differs.
 * Only storage is faked: a HEAD has to answer for the claim to verify.
 */

const storage = vi.hoisted(() => ({
  objects: new Map<string, { contentLength: number; contentType: string }>(),
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => true,
  presignPut: (key: string) => `https://storage.test/${key}?sig=put`,
  presignGet: (key: string) => `https://storage.test/${key}?sig=get`,
  headObject: async (key: string) => storage.objects.get(key) ?? null,
  deleteObject: async (key: string) => {
    storage.objects.delete(key);
  },
}));

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.CLUSTER_BUS = "postgres";
delete process.env.VOICE_NOTES;

interface Instance {
  bus: typeof import("../lib/bus.js");
  db: typeof import("../db.js");
  chat: typeof import("./chat.js");
  flags: typeof import("../lib/flags.js");
  attachments: typeof import("../services/attachments.js");
  users: typeof import("../services/users.js");
  servers: typeof import("../services/servers.js");
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
  const attachments = await import("../services/attachments.js");
  const users = await import("../services/users.js");
  const servers = await import("../services/servers.js");
  await db.initDb();
  // What `startClusterBus` in index.ts does for CLUSTER_BUS=postgres.
  const transport = createPostgresBusTransport(DATABASE_URL);
  bus.setBusTransport(transport);
  await transport.whenConnected();
  await flags.startFeatureFlags();
  const instance = { bus, db, chat, flags, attachments, users, servers, transport };
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

interface BroadcastFrame {
  type: string;
  message?: {
    id: string;
    body: string;
    attachments?: Array<{ id: string; contentType: string; voice?: unknown }>;
  };
}

function broadcasts(received: string[]): BroadcastFrame[] {
  return received
    .map((raw) => JSON.parse(raw) as BroadcastFrame)
    .filter((frame) => frame.type === "message-broadcast");
}

const WAVEFORM = Buffer.alloc(64, 90).toString("base64");

describeDb("voice notes across two instances on the Postgres bus", () => {
  afterAll(async () => {
    for (const instance of booted) {
      await instance.transport.close().catch(() => {});
      instance.flags.resetFeatureFlagsForTests();
      await instance.db.closePool().catch(() => {});
    }
  });

  it("a note sent on A reaches a socket on B carrying `voice`", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    expect(a.bus.isBusEnabled() && b.bus.isBusEnabled()).toBe(true);
    expect(a.bus.INSTANCE_ID).not.toBe(b.bus.INSTANCE_ID);

    await a.db.getPool().query(
      `TRUNCATE users, servers, feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    const alice: DbUser = await a.users.upsertUser({
      clerkId: `clerk_alice_${Date.now()}`,
      displayName: "Alice",
      avatarUrl: null,
    });
    const bob: DbUser = await a.users.upsertUser({
      clerkId: `clerk_bob_${Date.now()}`,
      displayName: "Bob",
      avatarUrl: null,
    });
    const { server, channels } = await a.servers.createServer("Voz", alice.id);
    await a.db.getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [server.id, bob.id],
    );
    const channelId = channels.find((channel) => channel.type === "text")!.id;

    // On for this server through the override row, written on A. Both
    // processes reload it (A on its own write, B from the `flags.changed`
    // frame), so either one would mint.
    await a.flags.setServerFlagOverride("voice_notes", server.id, true, { kind: "dashboard" });
    expect(a.flags.isEnabled("voice_notes", { serverId: server.id })).toBe(true);
    await vi.waitFor(() => {
      expect(b.flags.isEnabled("voice_notes", { serverId: server.id })).toBe(true);
    });

    // Bob is looking at the channel, on B.
    const viewer = recordingSocket();
    await b.chat.handleChatMessage(
      { socket: viewer.socket, user: bob },
      { type: "join-channel", channelId },
    );

    // Alice records on A: mint, upload, send.
    const pending = await a.attachments.createPendingAttachment({
      channelId,
      uploaderId: alice.id,
      filename: "voice.webm",
      contentType: "audio/webm",
      byteSize: 30_000,
      voice: { durationMs: 7_500, waveform: WAVEFORM },
    });
    storage.objects.set(pending.attachment.storage_key!, {
      contentLength: 30_000,
      contentType: "audio/webm",
    });
    const sender = recordingSocket();
    await a.chat.handleChatMessage(
      { socket: sender.socket, user: alice },
      {
        type: "message-create",
        channelId,
        body: "",
        attachmentIds: [pending.attachment.id],
      },
    );

    // The sender's own socket on A: the local pass.
    const local = broadcasts(sender.received);
    expect(local).toHaveLength(1);
    expect(local[0]!.message!.attachments![0]!.voice).toEqual({
      durationMs: 7_500,
      waveform: WAVEFORM,
    });

    // Bob's socket on B: only the bus could have brought it.
    await vi.waitFor(
      () => {
        expect(broadcasts(viewer.received)).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    const remote = broadcasts(viewer.received)[0]!.message!;
    expect(remote.id).toBe(local[0]!.message!.id);
    expect(remote.body).toBe("");
    expect(remote.attachments).toHaveLength(1);
    expect(remote.attachments![0]).toMatchObject({
      id: pending.attachment.id,
      contentType: "audio/webm",
      voice: { durationMs: 7_500, waveform: WAVEFORM },
    });
  }, 30_000);
});
