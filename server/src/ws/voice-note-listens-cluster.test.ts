import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * A LISTEN ON ONE INSTANCE, SEEN ON THE OTHER.
 *
 * Production runs two API machines with `CLUSTER_BUS=postgres` and
 * `VOICE_REGISTRY=postgres`, so the delivery that matters is the one that
 * crosses: the listener's request lands on machine A, and the author's socket
 * (or the listener's OTHER device) is on machine B. A design that delivered to
 * "the sockets in my map" would pass every single-process test and tell nobody
 * here. Pitfall 12 says to run the flags production runs, so this is the real
 * Postgres transport, the real route, the real service, `chat.ts` on both
 * sides, and `voice_notes` turned on by override rows after
 * `startFeatureFlags()`.
 *
 * Two instances are two module graphs (`vi.resetModules()`), the technique
 * `voice-notes-cluster.test.ts` uses. Only storage and token verification are
 * faked.
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

let actor: DbUser | null = null;

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

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.CLUSTER_BUS = "postgres";
process.env.VOICE_REGISTRY = "postgres";
delete process.env.VOICE_NOTES;

interface Instance {
  bus: typeof import("../lib/bus.js");
  db: typeof import("../db.js");
  api: typeof import("../api/index.js");
  sockets: typeof import("./sockets.js");
  flags: typeof import("../lib/flags.js");
  attachments: typeof import("../services/attachments.js");
  messages: typeof import("../services/messages.js");
  users: typeof import("../services/users.js");
  servers: typeof import("../services/servers.js");
  dms: typeof import("../services/dms.js");
  transport: ReturnType<typeof import("../lib/bus-postgres.js").createPostgresBusTransport>;
  http: Server;
  baseUrl: string;
}

const booted: Instance[] = [];

/** One "machine": its own module graph, bus connection and HTTP listener. */
async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = await import("../lib/bus.js");
  const db = await import("../db.js");
  const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
  await import("./chat.js");
  const api = await import("../api/index.js");
  const sockets = await import("./sockets.js");
  const flags = await import("../lib/flags.js");
  const attachments = await import("../services/attachments.js");
  const messages = await import("../services/messages.js");
  const users = await import("../services/users.js");
  const servers = await import("../services/servers.js");
  const dms = await import("../services/dms.js");
  await db.initDb();
  // What `startClusterBus` in index.ts does for CLUSTER_BUS=postgres.
  const transport = createPostgresBusTransport(DATABASE_URL);
  bus.setBusTransport(transport);
  await transport.whenConnected();
  await flags.startFeatureFlags();
  const http = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    void api.handleApi(req, res, pathname);
  });
  await new Promise<void>((done) => http.listen(0, done));
  const baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const instance = {
    bus,
    db,
    api,
    sockets,
    flags,
    attachments,
    messages,
    users,
    servers,
    dms,
    transport,
    http,
    baseUrl,
  };
  booted.push(instance);
  return instance;
}

/** A socket held by one instance, recording what it is sent. */
function connect(instance: Instance, user: DbUser) {
  const received: Array<Record<string, unknown>> = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(JSON.parse(payload)),
    on: () => {},
  } as unknown as WebSocket;
  instance.sockets.setAuthenticatedSocket(socket, user);
  return received;
}

const listened = (frames: Array<Record<string, unknown>>) =>
  frames.filter((frame) => frame.type === "voice-note-listened");

const WAVEFORM = Buffer.alloc(64, 90).toString("base64");

/** The window in which a frame that was NOT going to arrive would have. */
const QUIET_MS = 600;
const settle = () => new Promise((done) => setTimeout(done, QUIET_MS));

describeDb("a voice note listen across two instances on the Postgres bus", () => {
  afterAll(async () => {
    for (const instance of booted) {
      await new Promise<void>((done) => instance.http.close(() => done()));
      await instance.transport.close().catch(() => {});
      instance.flags.resetFeatureFlagsForTests();
      await instance.db.closePool().catch(() => {});
    }
  });

  it("the listener on A: the author's socket on B, and the listener's second socket on B, both get it", async () => {
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
    await a.db.getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);
    const { server, channels } = await a.servers.createServer("Voz", alice.id);
    await a.db.getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [server.id, bob.id],
    );
    const serverChannelId = channels.find((channel) => channel.type === "text")!.id;
    const conversationId = (await a.dms.openConversation(alice.id, [bob.id])).channelId;

    // On for the server through an override row and for conversations through
    // the global value, written on A. B reloads from the `flags.changed` frame.
    await a.flags.setServerFlagOverride("voice_notes", server.id, true, { kind: "dashboard" });
    await a.flags.setGlobalFlag("voice_notes", true, { kind: "dashboard" });
    await vi.waitFor(() => {
      expect(b.flags.isEnabled("voice_notes", { serverId: server.id })).toBe(true);
      expect(b.flags.isEnabled("voice_notes", { serverId: null })).toBe(true);
    });

    async function sendNote(channelId: string) {
      const pending = await a.attachments.createPendingAttachment({
        channelId,
        uploaderId: alice.id,
        filename: "voice.webm",
        contentType: "audio/webm",
        byteSize: 20_000,
        voice: { durationMs: 12_000, waveform: WAVEFORM },
      });
      storage.objects.set(pending.attachment.storage_key!, {
        contentLength: 20_000,
        contentType: "audio/webm",
      });
      const message = await a.messages.createMessage(channelId, alice, "", null, [
        pending.attachment.id,
      ]);
      expect(message).not.toBeNull();
      return { attachmentId: pending.attachment.id, messageId: message!.id };
    }

    /** Bob's request, handled by A. */
    async function bobListensOnA(attachmentId: string) {
      actor = bob;
      const response = await fetch(`${a.baseUrl}/api/attachments/${attachmentId}/listened`, {
        method: "POST",
        headers: { Authorization: "Bearer test" },
      });
      return response.status;
    }

    // ---- a conversation: Alice's socket is on B, Bob's second device is on B.
    const note = await sendNote(conversationId);
    const authorOnB = connect(b, alice);
    const listenerOnA = connect(a, bob);
    const listenerOnB = connect(b, bob);

    expect(await bobListensOnA(note.attachmentId)).toBe(204);

    const expected = {
      type: "voice-note-listened",
      channelId: conversationId,
      messageId: note.messageId,
      attachmentId: note.attachmentId,
      userId: bob.id,
      listenedAt: expect.any(String),
    };
    // Only the bus could have brought either of these.
    await vi.waitFor(
      () => {
        expect(listened(authorOnB)).toHaveLength(1);
        expect(listened(listenerOnB)).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    expect(listened(authorOnB)[0]).toEqual(expected);
    expect(listened(listenerOnB)[0]).toEqual(expected);
    // A's own socket got it locally, exactly once: the loop guard dropped the
    // echo of the instance's own publish.
    expect(listened(listenerOnA)).toEqual([expected]);

    // A replay is a 204 and a silence, on both machines.
    expect(await bobListensOnA(note.attachmentId)).toBe(204);
    await settle();
    expect(listened(authorOnB)).toHaveLength(1);
    expect(listened(listenerOnB)).toHaveLength(1);
    expect(listened(listenerOnA)).toHaveLength(1);

    // ---- a server channel: the author is told nothing, anywhere.
    const channelNote = await sendNote(serverChannelId);
    const authorOnBToo = connect(b, alice);
    const authorOnA = connect(a, alice);
    const beforeOnB = listened(listenerOnB).length;
    expect(await bobListensOnA(channelNote.attachmentId)).toBe(204);

    // The listener's second socket, on B, does hear it: that is how the dot
    // clears on their other device.
    await vi.waitFor(
      () => {
        expect(listened(listenerOnB)).toHaveLength(beforeOnB + 1);
      },
      { timeout: 5_000 },
    );
    expect(listened(listenerOnB).at(-1)).toMatchObject({
      channelId: serverChannelId,
      attachmentId: channelNote.attachmentId,
    });
    await settle();
    expect(listened(authorOnBToo)).toHaveLength(0);
    expect(listened(authorOnA)).toHaveLength(0);
    // The conversation frame from before is the only one the author's other
    // socket ever saw.
    expect(listened(authorOnB)).toHaveLength(1);
  }, 30_000);
});
