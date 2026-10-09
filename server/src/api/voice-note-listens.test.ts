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
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * VOICE NOTE LISTENS: the receipt write, the two reads it feeds, the frame, and
 * the two holes PR 968 left (edit, and the claim's flag check), on a real
 * Postgres.
 *
 * The flag is set the way production sets it, through a per-server override
 * row written after `startFeatureFlags()`, and never through the environment
 * (CLAUDE.md pitfalls 9 and 12). `VOICE_NOTES` is deleted before anything runs.
 * The two-instance delivery lives in `ws/voice-note-listens-cluster.test.ts`;
 * here there is one process, so a frame reaching a socket proves the local
 * half only.
 */

const storage = vi.hoisted(() => ({
  configured: true,
  objects: new Map<string, { contentLength: number; contentType: string }>(),
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => storage.configured,
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
delete process.env.VOICE_NOTES;
delete process.env.CLUSTER_BUS;

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createPqpServer } = await import("../services/servers.js");
const { openConversation } = await import("../services/dms.js");
const { createMessage } = await import("../services/messages.js");
const { createPendingAttachment } = await import("../services/attachments.js");
const { noteEditAllowed } = await import("../services/voice-notes.js");
const {
  resetFeatureFlagsForTests,
  setGlobalFlag,
  setServerFlagOverride,
  startFeatureFlags,
} = await import("../lib/flags.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { deleteAuthenticatedSocket, setAuthenticatedSocket } = await import(
  "../ws/sockets.js"
);

/** 64 one-byte peaks, base64: 88 characters. */
const WAVEFORM = Buffer.alloc(64, 100).toString("base64");
const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000";

interface Listen {
  userId: string;
  listenedAt: string;
}
interface MessageWithVoice {
  id: string;
  attachments?: Array<{
    id: string;
    voice?: { listenedByMe?: boolean; listenedBy?: Listen[] };
  }>;
}

describeDb("voice note listens", () => {
  let http: Server;
  let baseUrl: string;
  let alice: DbUser;
  let bob: DbUser;
  let carol: DbUser;
  let dave: DbUser;
  let serverId: string;
  let channelId: string;
  let dmChannelId: string;
  let groupChannelId: string;
  const sockets: WebSocket[] = [];

  /** A connected socket for an account, recording every frame it is sent. */
  function connect(user: DbUser) {
    const received: Array<Record<string, unknown>> = [];
    const socket = {
      readyState: 1,
      send: (payload: string) => received.push(JSON.parse(payload)),
      on: () => {},
    } as unknown as WebSocket;
    setAuthenticatedSocket(socket, user);
    sockets.push(socket);
    return received;
  }

  const listened = (frames: Array<Record<string, unknown>>) =>
    frames.filter((frame) => frame.type === "voice-note-listened");

  beforeAll(async () => {
    await initDb();
    http = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => http.listen(0, done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => http.close(() => done()));
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    for (const socket of sockets.splice(0)) {
      deleteAuthenticatedSocket(socket);
    }
    storage.objects.clear();
    storage.configured = true;
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members,
                message_attachments, feature_flags, feature_flag_overrides,
                feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({ clerkId: "clerk_alice", displayName: "Alice", avatarUrl: null });
    bob = await upsertUser({ clerkId: "clerk_bob", displayName: "Bob", avatarUrl: null });
    carol = await upsertUser({ clerkId: "clerk_carol", displayName: "Carol", avatarUrl: null });
    dave = await upsertUser({ clerkId: "clerk_dave", displayName: "Dave", avatarUrl: null });
    await getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);

    const created = await createPqpServer("Voz", alice.id);
    serverId = created.server.id;
    for (const member of [bob, carol]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, member.id],
      );
    }
    const channel = await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' ORDER BY position LIMIT 1`,
      [serverId],
    );
    channelId = channel.rows[0]!.id;

    dmChannelId = (await openConversation(alice.id, [bob.id])).channelId;
    groupChannelId = (await openConversation(alice.id, [bob.id, carol.id])).channelId;

    // Flags read the database from here on, with nothing stored: off. Then on
    // for the server through an override row and for conversations through the
    // global value, which is what a DM reads.
    await startFeatureFlags();
    await setServerFlagOverride("voice_notes", serverId, true, { kind: "dashboard" });
    await setGlobalFlag("voice_notes", true, { kind: "dashboard" });
    actor = alice;
  });

  async function mintNote(channel: string, uploader: DbUser = alice) {
    const pending = await createPendingAttachment({
      channelId: channel,
      uploaderId: uploader.id,
      filename: "voice.webm",
      contentType: "audio/webm",
      byteSize: 20_000,
      voice: { durationMs: 12_000, waveform: WAVEFORM },
    });
    storage.objects.set(pending.attachment.storage_key!, {
      contentLength: 20_000,
      contentType: "audio/webm",
    });
    return pending.attachment;
  }

  /** A claimed note: the attachment id and the message it rides on. */
  async function sendNote(channel: string, author: DbUser = alice) {
    const note = await mintNote(channel, author);
    const message = await createMessage(channel, author, "", null, [note.id]);
    expect(message).not.toBeNull();
    return { attachmentId: note.id, messageId: message!.id };
  }

  async function mintPhoto(channel: string) {
    const pending = await createPendingAttachment({
      channelId: channel,
      uploaderId: alice.id,
      filename: "a.png",
      contentType: "image/png",
      byteSize: 1000,
    });
    storage.objects.set(pending.attachment.storage_key!, {
      contentLength: 1000,
      contentType: "image/png",
    });
    return pending.attachment;
  }

  async function listen(as: DbUser, attachmentId: string) {
    actor = as;
    const response = await fetch(`${baseUrl}/api/attachments/${attachmentId}/listened`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
    });
    return { status: response.status, text: await response.text() };
  }

  /** History as `as` reads it, over HTTP, so the viewer wiring is covered too. */
  async function history(as: DbUser, channel: string) {
    actor = as;
    const response = await fetch(`${baseUrl}/api/channels/${channel}/messages`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: MessageWithVoice[] };
    return body.messages;
  }

  const voiceOf = async (as: DbUser, channel: string, messageId: string) =>
    (await history(as, channel)).find((message) => message.id === messageId)!.attachments![0]!
      .voice!;

  const listenRows = async () =>
    (
      await getPool().query<{ attachment_id: string; user_id: string; listened_at: Date }>(
        `SELECT attachment_id, user_id, listened_at FROM voice_note_listens
         ORDER BY listened_at`,
      )
    ).rows;

  describe("POST /api/attachments/:id/listened", () => {
    it("answers 204 and records one row", async () => {
      const { attachmentId } = await sendNote(channelId);
      const response = await listen(bob, attachmentId);
      expect(response).toEqual({ status: 204, text: "" });
      const rows = await listenRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ attachment_id: attachmentId, user_id: bob.id });
    });

    it("is idempotent: a replay is a 204 that changes nothing and sends nothing", async () => {
      const { attachmentId } = await sendNote(dmChannelId);
      const alicesSocket = connect(alice);
      expect((await listen(bob, attachmentId)).status).toBe(204);
      const first = (await listenRows())[0]!;
      expect(listened(alicesSocket)).toHaveLength(1);

      expect((await listen(bob, attachmentId)).status).toBe(204);
      expect((await listen(bob, attachmentId)).status).toBe(204);
      const rows = await listenRows();
      expect(rows).toHaveLength(1);
      // The first play is the one that counts; a replay does not move it.
      expect(rows[0]!.listened_at.getTime()).toBe(first.listened_at.getTime());
      expect(listened(alicesSocket)).toHaveLength(1);
    });

    it("listening to your own note is a 204 no-op: no row, no frame", async () => {
      const { attachmentId } = await sendNote(dmChannelId);
      const own = connect(alice);
      expect((await listen(alice, attachmentId)).status).toBe(204);
      expect(await listenRows()).toHaveLength(0);
      expect(listened(own)).toHaveLength(0);
    });

    it("is rate limited per account", async () => {
      const { attachmentId } = await sendNote(channelId);
      let last = 204;
      for (let i = 0; i < 61 && last === 204; i += 1) {
        last = (await listen(bob, attachmentId)).status;
      }
      expect(last).toBe(429);
      // Another account has its own bucket.
      expect((await listen(carol, attachmentId)).status).toBe(204);
    });

    it("is a 404 for everything the caller may not hear, and records nothing", async () => {
      const server = await sendNote(channelId);
      const dm = await sendNote(dmChannelId);
      const photo = await mintPhoto(channelId);
      await createMessage(channelId, alice, "foto", null, [photo.id]);
      const unclaimed = await mintNote(channelId);

      // Not a member of the server, not a participant of the conversation.
      expect((await listen(dave, server.attachmentId)).status).toBe(404);
      expect((await listen(dave, dm.attachmentId)).status).toBe(404);
      expect((await listen(carol, dm.attachmentId)).status).toBe(404);
      // Visible, but not a voice note.
      expect((await listen(bob, photo.id)).status).toBe(404);
      // A note no message carries yet is not content anyone can see.
      expect((await listen(bob, unclaimed.id)).status).toBe(404);
      expect((await listen(bob, NO_SUCH_ID)).status).toBe(404);
      expect((await listen(bob, "not-a-uuid")).status).toBe(404);
      expect(await listenRows()).toHaveLength(0);
    });

    it("a participant who left the conversation can no longer record a listen", async () => {
      const { attachmentId } = await sendNote(groupChannelId);
      await getPool().query(
        `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
        [groupChannelId, carol.id],
      );
      expect((await listen(carol, attachmentId)).status).toBe(404);
      expect(await listenRows()).toHaveLength(0);
    });

    it("goes with the note when it is deleted", async () => {
      const { attachmentId } = await sendNote(channelId);
      await listen(bob, attachmentId);
      await getPool().query(`DELETE FROM message_attachments WHERE id = $1`, [attachmentId]);
      expect(await listenRows()).toHaveLength(0);
    });
  });

  describe("reads", () => {
    it("`listenedByMe` follows the viewer, and `listenedBy` never exists in a server channel", async () => {
      const { attachmentId, messageId } = await sendNote(channelId);

      expect(await voiceOf(bob, channelId, messageId)).toMatchObject({ listenedByMe: false });
      await listen(bob, attachmentId);
      const bobs = await voiceOf(bob, channelId, messageId);
      expect(bobs.listenedByMe).toBe(true);
      expect(await voiceOf(carol, channelId, messageId)).toMatchObject({ listenedByMe: false });

      // The author: her own note counts as heard, and she is told nothing else.
      const authors = await voiceOf(alice, channelId, messageId);
      expect(authors.listenedByMe).toBe(true);
      for (const voice of [bobs, authors, await voiceOf(carol, channelId, messageId)]) {
        expect(voice).not.toHaveProperty("listenedBy");
      }
    });

    it("a 1:1 conversation shows the author who listened, and nobody else", async () => {
      const { attachmentId, messageId } = await sendNote(dmChannelId);

      // Nobody yet: an empty list, which is not the same as absent.
      expect((await voiceOf(alice, dmChannelId, messageId)).listenedBy).toEqual([]);
      await listen(bob, attachmentId);

      const authors = await voiceOf(alice, dmChannelId, messageId);
      expect(authors.listenedBy).toEqual([
        { userId: bob.id, listenedAt: expect.any(String) },
      ]);
      expect(Number.isNaN(Date.parse(authors.listenedBy![0]!.listenedAt))).toBe(false);
      expect(authors.listenedByMe).toBe(true);

      const listeners = await voiceOf(bob, dmChannelId, messageId);
      expect(listeners.listenedByMe).toBe(true);
      expect(listeners).not.toHaveProperty("listenedBy");
    });

    it("a group conversation lists listeners in the order they listened", async () => {
      const { attachmentId, messageId } = await sendNote(groupChannelId);
      await listen(carol, attachmentId);
      await listen(bob, attachmentId);
      const authors = await voiceOf(alice, groupChannelId, messageId);
      expect(authors.listenedBy!.map((entry) => entry.userId)).toEqual([carol.id, bob.id]);
      expect(await voiceOf(bob, groupChannelId, messageId)).not.toHaveProperty("listenedBy");
    });

    it("a listener who has since left the conversation is no longer listed", async () => {
      const { attachmentId, messageId } = await sendNote(groupChannelId);
      await listen(carol, attachmentId);
      await listen(bob, attachmentId);
      await getPool().query(
        `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
        [groupChannelId, carol.id],
      );
      const authors = await voiceOf(alice, groupChannelId, messageId);
      expect(authors.listenedBy!.map((entry) => entry.userId)).toEqual([bob.id]);
    });

    it("a conversation of eleven or more shows no receipts at all", async () => {
      const { attachmentId, messageId } = await sendNote(groupChannelId);
      for (let i = 0; i < 8; i += 1) {
        const extra = await upsertUser({
          clerkId: `clerk_extra_${i}`,
          displayName: `Extra ${i}`,
          avatarUrl: null,
        });
        await getPool().query(
          `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
          [groupChannelId, extra.id],
        );
      }
      // alice, bob, carol and eight more: eleven.
      expect(
        (
          await getPool().query(`SELECT 1 FROM channel_members WHERE channel_id = $1`, [
            groupChannelId,
          ])
        ).rows,
      ).toHaveLength(11);

      expect((await listen(bob, attachmentId)).status).toBe(204);
      const authors = await voiceOf(alice, groupChannelId, messageId);
      expect(authors).not.toHaveProperty("listenedBy");
      // The listener's own state is unaffected by the size of the room.
      expect((await voiceOf(bob, groupChannelId, messageId)).listenedByMe).toBe(true);
    });

    it("a block hides the listener from the author's receipts, not from their own dot", async () => {
      const { attachmentId, messageId } = await sendNote(dmChannelId);
      await getPool().query(
        `INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2)`,
        [alice.id, bob.id],
      );
      const alicesSocket = connect(alice);
      const bobsSocket = connect(bob);
      expect((await listen(bob, attachmentId)).status).toBe(204);

      expect((await voiceOf(alice, dmChannelId, messageId)).listenedBy).toEqual([]);
      expect((await voiceOf(bob, dmChannelId, messageId)).listenedByMe).toBe(true);
      expect(listened(alicesSocket)).toHaveLength(0);
      expect(listened(bobsSocket)).toHaveLength(1);
    });

    it("pins carry the viewer's state too", async () => {
      const { attachmentId, messageId } = await sendNote(channelId);
      await listen(bob, attachmentId);
      await getPool().query(`UPDATE messages SET pinned_at = NOW(), pinned_by = $2 WHERE id = $1`, [
        messageId,
        alice.id,
      ]);
      actor = bob;
      const response = await fetch(`${baseUrl}/api/channels/${channelId}/pins`, {
        headers: { Authorization: "Bearer test" },
      });
      const body = (await response.json()) as { messages: MessageWithVoice[] };
      expect(body.messages[0]!.attachments![0]!.voice!.listenedByMe).toBe(true);
    });

    it("a photo gains no `voice`", async () => {
      const photo = await mintPhoto(channelId);
      const message = await createMessage(channelId, alice, "foto", null, [photo.id]);
      const page = await history(bob, channelId);
      expect(page.find((entry) => entry.id === message!.id)!.attachments![0]).not.toHaveProperty(
        "voice",
      );
    });
  });

  describe("the frame", () => {
    it("in a conversation: the author's sockets and the listener's, and nobody else", async () => {
      const { attachmentId, messageId } = await sendNote(dmChannelId);
      const author = [connect(alice), connect(alice)];
      const listener = [connect(bob), connect(bob)];
      const bystander = connect(carol);

      expect((await listen(bob, attachmentId)).status).toBe(204);

      for (const frames of [...author, ...listener]) {
        expect(listened(frames)).toEqual([
          {
            type: "voice-note-listened",
            channelId: dmChannelId,
            messageId,
            attachmentId,
            userId: bob.id,
            listenedAt: expect.any(String),
          },
        ]);
      }
      expect(listened(bystander)).toHaveLength(0);
      expect(listened(author[0]!)[0]!.listenedAt).toBe(
        (await listenRows())[0]!.listened_at.toISOString(),
      );
    });

    it("in a group conversation the other participants are not told", async () => {
      const { attachmentId } = await sendNote(groupChannelId);
      const authors = connect(alice);
      const listener = connect(bob);
      const other = connect(carol);
      await listen(bob, attachmentId);
      expect(listened(authors)).toHaveLength(1);
      expect(listened(listener)).toHaveLength(1);
      expect(listened(other)).toHaveLength(0);
    });

    it("in a server channel the author receives nothing; the listener's own sockets do", async () => {
      const { attachmentId } = await sendNote(channelId);
      const authors = connect(alice);
      const listener = [connect(bob), connect(bob)];
      const other = connect(carol);

      expect((await listen(bob, attachmentId)).status).toBe(204);

      expect(listened(authors)).toHaveLength(0);
      expect(listened(other)).toHaveLength(0);
      for (const frames of listener) {
        expect(listened(frames)).toHaveLength(1);
      }
      // And it is still recorded: the dot has to survive a reload.
      expect(await listenRows()).toHaveLength(1);
    });

    it("in a conversation of eleven or more the author is not told", async () => {
      const { attachmentId } = await sendNote(groupChannelId);
      for (let i = 0; i < 8; i += 1) {
        const extra = await upsertUser({
          clerkId: `clerk_extra_${i}`,
          displayName: `Extra ${i}`,
          avatarUrl: null,
        });
        await getPool().query(
          `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
          [groupChannelId, extra.id],
        );
      }
      const authors = connect(alice);
      const listener = connect(bob);
      await listen(bob, attachmentId);
      expect(listened(authors)).toHaveLength(0);
      expect(listened(listener)).toHaveLength(1);
    });
  });

  describe("editing a voice message", () => {
    async function patch(as: DbUser, messageId: string, body: string) {
      actor = as;
      const response = await fetch(`${baseUrl}/api/messages/${messageId}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }

    it("refuses to add text, in a server channel and in a conversation", async () => {
      for (const channel of [channelId, dmChannelId]) {
        const { messageId } = await sendNote(channel);
        const response = await patch(alice, messageId, "olha isso");
        expect(response.status).toBe(400);
        const stored = await getPool().query<{ body: string; edited_at: Date | null }>(
          `SELECT body, edited_at FROM messages WHERE id = $1`,
          [messageId],
        );
        expect(stored.rows[0]).toMatchObject({ body: "", edited_at: null });
      }
    });

    it("refuses it even when storage is off and the note's file cannot be listed", async () => {
      const { messageId } = await sendNote(channelId);
      storage.configured = false;
      expect((await patch(alice, messageId, "olha isso")).status).toBe(400);
    });

    it("still lets another message's caption be edited", async () => {
      const photo = await mintPhoto(channelId);
      const message = await createMessage(channelId, alice, "foto", null, [photo.id]);
      const response = await patch(alice, message!.id, "foto nova");
      expect(response.status).toBe(200);
    });

    it("the rule is one reusable function", () => {
      expect(noteEditAllowed({ hasNote: true, body: "oi" })).toBe(false);
      expect(noteEditAllowed({ hasNote: true, body: "  \n " })).toBe(true);
      expect(noteEditAllowed({ hasNote: false, body: "oi" })).toBe(true);
    });
  });

  describe("the claim re-checks the flag", () => {
    it("a note minted while on is refused once the server override goes off", async () => {
      const note = await mintNote(channelId);
      await setServerFlagOverride("voice_notes", serverId, false, { kind: "dashboard" });

      expect(await createMessage(channelId, alice, "", null, [note.id])).toBeNull();
      const row = await getPool().query<{ message_id: string | null }>(
        `SELECT message_id FROM message_attachments WHERE id = $1`,
        [note.id],
      );
      // Nothing was claimed: the sweeper takes it.
      expect(row.rows[0]!.message_id).toBeNull();
      expect(
        (await getPool().query(`SELECT 1 FROM messages WHERE channel_id = $1`, [channelId])).rows,
      ).toHaveLength(0);
    });

    it("turning it back on lets the same note through", async () => {
      const note = await mintNote(channelId);
      await setServerFlagOverride("voice_notes", serverId, false, { kind: "dashboard" });
      expect(await createMessage(channelId, alice, "", null, [note.id])).toBeNull();
      await setServerFlagOverride("voice_notes", serverId, true, { kind: "dashboard" });
      expect(await createMessage(channelId, alice, "", null, [note.id])).not.toBeNull();
    });

    it("a conversation follows the global value", async () => {
      const note = await mintNote(dmChannelId);
      await setGlobalFlag("voice_notes", false, { kind: "dashboard" });
      expect(await createMessage(dmChannelId, alice, "", null, [note.id])).toBeNull();
    });

    it("a per-server override does not reach a conversation", async () => {
      const note = await mintNote(dmChannelId);
      await setGlobalFlag("voice_notes", false, { kind: "dashboard" });
      await setServerFlagOverride("voice_notes", serverId, true, { kind: "dashboard" });
      expect(await createMessage(dmChannelId, alice, "", null, [note.id])).toBeNull();
    });

    it("costs an ordinary message nothing and never blocks one", async () => {
      await setServerFlagOverride("voice_notes", serverId, false, { kind: "dashboard" });
      await setGlobalFlag("voice_notes", false, { kind: "dashboard" });
      const photo = await mintPhoto(channelId);
      expect(await createMessage(channelId, alice, "foto", null, [photo.id])).not.toBeNull();
      expect(await createMessage(channelId, alice, "oi")).not.toBeNull();
    });
  });
});
