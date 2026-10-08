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
import { noteByteBudget } from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * VOICE NOTES, THE CONTRACT: mint, claim, read, sweep, on a real Postgres.
 *
 * The flag is set the way production sets it, through a per-server override
 * row written after `startFeatureFlags()`, and never through the environment
 * (CLAUDE.md pitfalls 9 and 12: a test that flips the env exercises a path
 * production does not take). `VOICE_NOTES` is deleted before anything runs.
 *
 * Storage is faked the same way `services/attachments.test.ts` fakes it: the
 * signature is proved against MinIO elsewhere, and what matters here is what
 * the service does with a HEAD's answer.
 */

const storage = vi.hoisted(() => ({
  objects: new Map<string, { contentLength: number; contentType: string }>(),
  deletedKeys: [] as string[],
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => true,
  presignPut: (key: string) => `https://storage.test/${key}?sig=put`,
  presignGet: (key: string) => `https://storage.test/${key}?sig=get`,
  headObject: async (key: string) => storage.objects.get(key) ?? null,
  deleteObject: async (key: string) => {
    storage.deletedKeys.push(key);
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

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createPqpServer } = await import("../services/servers.js");
const { listConversations, openConversation } = await import("../services/dms.js");
const { createMessage, deleteMessage } = await import("../services/messages.js");
const {
  createPendingAttachment,
  getAttachmentForViewer,
  listAttachmentsForMessages,
  sweepOrphanedAttachments,
} = await import("../services/attachments.js");
const {
  noteShapeAllowed,
  NoteTooLargeError,
  VoiceNoteContentTypeError,
  VoiceNotesDisabledError,
} = await import("../services/voice-notes.js");
const {
  resetFeatureFlagsForTests,
  setGlobalFlag,
  setServerFlagOverride,
  startFeatureFlags,
} = await import("../lib/flags.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { buildPushPayload } = await import("../services/push.js");

/** 64 one-byte peaks, base64: 88 characters. */
const WAVEFORM = Buffer.alloc(64, 100).toString("base64");

describeDb("voice notes", () => {
  let http: Server;
  let baseUrl: string;
  let alice: DbUser;
  let bob: DbUser;
  let serverId: string;
  let otherServerId: string;
  let channelId: string;
  let otherChannelId: string;
  let dmChannelId: string;

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
    storage.objects.clear();
    storage.deletedKeys.length = 0;
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
    await getPool().query(
      `UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`,
    );

    const created = await createPqpServer("Voz", alice.id);
    serverId = created.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, bob.id],
    );
    const channel = await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' ORDER BY position LIMIT 1`,
      [serverId],
    );
    channelId = channel.rows[0]!.id;

    const other = await createPqpServer("Outro", alice.id);
    otherServerId = other.server.id;
    const otherChannel = await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' ORDER BY position LIMIT 1`,
      [otherServerId],
    );
    otherChannelId = otherChannel.rows[0]!.id;

    dmChannelId = (await openConversation(alice.id, [bob.id])).channelId;

    // Flags read the database from here on, with nothing stored: off.
    await startFeatureFlags();
    actor = alice;
  });

  const turnOnFor = (id: string, enabled: boolean | null = true) =>
    setServerFlagOverride("voice_notes", id, enabled, { kind: "dashboard" });

  async function mintNote(
    options: {
      channel?: string;
      durationMs?: number;
      byteSize?: number;
      realBytes?: number;
      contentType?: "audio/webm" | "audio/mp4" | "audio/ogg" | "audio/mpeg";
      uploader?: DbUser;
    } = {},
  ) {
    const contentType = options.contentType ?? "audio/webm";
    const byteSize = options.byteSize ?? 20_000;
    const pending = await createPendingAttachment({
      channelId: options.channel ?? channelId,
      uploaderId: (options.uploader ?? alice).id,
      filename: "voice.webm",
      contentType: contentType as "audio/webm",
      byteSize,
      voice: { durationMs: options.durationMs ?? 12_000, waveform: WAVEFORM },
    });
    storage.objects.set(pending.attachment.storage_key!, {
      contentLength: options.realBytes ?? byteSize,
      contentType,
    });
    return pending.attachment;
  }

  async function mintPhoto(channel = channelId) {
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

  async function post(path: string, body: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function config(query = "") {
    const response = await fetch(`${baseUrl}/api/attachments/config${query}`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { enabled: boolean; voiceNotes: boolean };
  }

  const countRows = async (table: string) =>
    Number(
      (await getPool().query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`)).rows[0]!
        .n,
    );

  describe("the flag", () => {
    it("is off by default, and the environment is not what turns it on here", async () => {
      expect(process.env.VOICE_NOTES).toBeUndefined();
      expect((await config(`?serverId=${serverId}`)).voiceNotes).toBe(false);
      await expect(mintNote()).rejects.toBeInstanceOf(VoiceNotesDisabledError);
      expect(await countRows("message_attachments")).toBe(0);
      expect(await countRows("message_attachment_voice")).toBe(0);
    });

    it("refuses the mint over HTTP with a 403 while off", async () => {
      const response = await post(`/api/channels/${channelId}/attachments`, {
        filename: "voice.webm",
        contentType: "audio/webm",
        byteSize: 20_000,
        voice: { durationMs: 12_000, waveform: WAVEFORM },
      });
      expect(response.status).toBe(403);
      expect(await countRows("message_attachments")).toBe(0);
    });

    it("a per-server override turns it on for that server only", async () => {
      await turnOnFor(serverId);
      expect((await config(`?serverId=${serverId}`)).voiceNotes).toBe(true);
      expect((await config(`?serverId=${otherServerId}`)).voiceNotes).toBe(false);
      // No server, or a malformed one, reads the global value: off.
      expect((await config()).voiceNotes).toBe(false);
      expect((await config("?serverId=banana")).voiceNotes).toBe(false);

      const response = await post(`/api/channels/${channelId}/attachments`, {
        filename: "voice.webm",
        contentType: "audio/webm",
        byteSize: 20_000,
        voice: { durationMs: 12_000, waveform: WAVEFORM },
      });
      expect(response.status).toBe(201);
      expect(response.body.attachmentId).toEqual(expect.any(String));

      await expect(mintNote({ channel: otherChannelId })).rejects.toBeInstanceOf(
        VoiceNotesDisabledError,
      );
      // A conversation has no server and reads the global value.
      await expect(mintNote({ channel: dmChannelId })).rejects.toBeInstanceOf(
        VoiceNotesDisabledError,
      );
    });

    it("a server override off beats the global value on, and DMs follow the global", async () => {
      await setGlobalFlag("voice_notes", true, { kind: "dashboard" });
      await turnOnFor(otherServerId, false);
      await expect(mintNote({ channel: dmChannelId })).resolves.toBeTruthy();
      await expect(mintNote()).resolves.toBeTruthy();
      await expect(mintNote({ channel: otherChannelId })).rejects.toBeInstanceOf(
        VoiceNotesDisabledError,
      );
      expect((await config()).voiceNotes).toBe(true);
      expect((await config(`?serverId=${otherServerId}`)).voiceNotes).toBe(false);
    });

    it("does not gate an ordinary audio upload", async () => {
      const pending = await createPendingAttachment({
        channelId,
        uploaderId: alice.id,
        filename: "song.webm",
        contentType: "audio/webm",
        byteSize: 5_000_000,
      });
      expect(pending.attachment.voice_duration_ms ?? null).toBeNull();
    });
  });

  describe("the mint", () => {
    beforeEach(async () => {
      await turnOnFor(serverId);
    });

    it("writes the side row in the same statement, consent on and no transcript", async () => {
      const row = await mintNote({ durationMs: 12_345 });
      expect(row.voice_duration_ms).toBe(12_345);
      expect(row.voice_waveform).toBe(WAVEFORM);
      expect(row.storage_key).toMatch(/\.webm$/);
      const side = await getPool().query(
        `SELECT duration_ms, waveform, codec, verified_duration_ms, transcribe_allowed,
                transcript_status, transcript_text, playback_key
           FROM message_attachment_voice WHERE attachment_id = $1`,
        [row.id],
      );
      expect(side.rows[0]).toEqual({
        duration_ms: 12_345,
        waveform: WAVEFORM,
        codec: null,
        verified_duration_ms: null,
        transcribe_allowed: true,
        transcript_status: "none",
        transcript_text: null,
        playback_key: null,
      });
    });

    it("holds the bytes to 16 KiB a started second plus 32 KiB", async () => {
      const budget = noteByteBudget(12_000);
      await expect(mintNote({ durationMs: 12_000, byteSize: budget })).resolves.toBeTruthy();
      await expect(
        mintNote({ durationMs: 12_000, byteSize: budget + 1 }),
      ).rejects.toBeInstanceOf(NoteTooLargeError);

      // Over HTTP the same refusal is a 413, and nothing is stored.
      const before = await countRows("message_attachments");
      const response = await post(`/api/channels/${channelId}/attachments`, {
        filename: "voice.webm",
        contentType: "audio/webm",
        byteSize: noteByteBudget(2_000) + 1,
        voice: { durationMs: 2_000, waveform: WAVEFORM },
      });
      expect(response.status).toBe(413);
      expect(await countRows("message_attachments")).toBe(before);
    });

    it("refuses a voice block on a container no recorder produces", async () => {
      await expect(mintNote({ contentType: "audio/mpeg" })).rejects.toBeInstanceOf(
        VoiceNoteContentTypeError,
      );
      const response = await post(`/api/channels/${channelId}/attachments`, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
        byteSize: 20_000,
        voice: { durationMs: 12_000, waveform: WAVEFORM },
      });
      expect(response.status).toBe(400);
    });

    it("the database refuses what the schema would, if anything got past it", async () => {
      const row = await mintPhoto();
      await expect(
        getPool().query(
          `INSERT INTO message_attachment_voice (attachment_id, duration_ms, waveform)
           VALUES ($1, 299, 'AA==')`,
          [row.id],
        ),
      ).rejects.toThrow(/check/i);
      await expect(
        getPool().query(
          `INSERT INTO message_attachment_voice (attachment_id, duration_ms, waveform)
           VALUES ($1, 1000, $2)`,
          [row.id, "A".repeat(129)],
        ),
      ).rejects.toThrow(/check/i);
    });
  });

  describe("the claim", () => {
    beforeEach(async () => {
      await turnOnFor(serverId);
    });

    it("sends a note alone, with no text, and the message carries `voice`", async () => {
      const note = await mintNote({ durationMs: 12_000 });
      const message = await createMessage(channelId, alice, "", null, [note.id]);
      expect(message).not.toBeNull();
      expect(message!.attachments).toHaveLength(1);
      expect(message!.attachments[0]).toMatchObject({
        id: note.id,
        contentType: "audio/webm",
        voice: { durationMs: 12_000, waveform: WAVEFORM },
      });
    });

    it("refuses a note with text beside it, and leaves the note unclaimed", async () => {
      const note = await mintNote();
      expect(await createMessage(channelId, alice, "olha isso", null, [note.id])).toBeNull();
      expect(await countRows("messages")).toBe(0);
      const row = await getPool().query(
        `SELECT message_id FROM message_attachments WHERE id = $1`,
        [note.id],
      );
      expect(row.rows[0]!.message_id).toBeNull();
    });

    it("refuses a note with another attachment, even one that failed to upload", async () => {
      const note = await mintNote();
      const photo = await mintPhoto();
      expect(await createMessage(channelId, alice, "", null, [note.id, photo.id])).toBeNull();

      const missing = await mintPhoto();
      storage.objects.delete(missing.storage_key!);
      expect(await createMessage(channelId, alice, "", null, [note.id, missing.id])).toBeNull();

      const second = await mintNote();
      expect(await createMessage(channelId, alice, "", null, [note.id, second.id])).toBeNull();
      expect(await countRows("messages")).toBe(0);
    });

    it("drops a note whose stored bytes outgrew the budget", async () => {
      const note = await mintNote({
        durationMs: 1_000,
        byteSize: 1_000,
        realBytes: noteByteBudget(1_000) + 1,
      });
      // The store ignored the signed length; the HEAD catches it, and with
      // nothing left the message is not sent.
      expect(await createMessage(channelId, alice, "", null, [note.id])).toBeNull();
    });

    it("leaves every other attachment's rules alone", async () => {
      const a = await mintPhoto();
      const b = await mintPhoto();
      const message = await createMessage(channelId, alice, "fotos", null, [a.id, b.id]);
      expect(message!.attachments).toHaveLength(2);
      expect(message!.attachments.every((entry) => entry.voice === undefined)).toBe(true);
    });

    it("the shape rule is one reusable function", () => {
      const note = { voice_duration_ms: 1000 };
      const file = { voice_duration_ms: null };
      expect(noteShapeAllowed({ attachments: [note], requestedCount: 1, body: "" })).toBe(true);
      expect(noteShapeAllowed({ attachments: [note], requestedCount: 1, body: " \n " })).toBe(true);
      expect(noteShapeAllowed({ attachments: [note], requestedCount: 1, body: "oi" })).toBe(false);
      expect(noteShapeAllowed({ attachments: [note], requestedCount: 2, body: "" })).toBe(false);
      expect(noteShapeAllowed({ attachments: [note, file], requestedCount: 2, body: "" })).toBe(false);
      expect(noteShapeAllowed({ attachments: [file, file], requestedCount: 2, body: "oi" })).toBe(true);
      expect(noteShapeAllowed({ attachments: [], requestedCount: 3, body: "" })).toBe(true);
    });
  });

  describe("reads", () => {
    beforeEach(async () => {
      await turnOnFor(serverId);
    });

    it("history and the URL refresh both return `voice`; other attachments do not", async () => {
      const note = await mintNote({ durationMs: 4_200 });
      const voiceMessage = await createMessage(channelId, alice, "", null, [note.id]);
      const photo = await mintPhoto();
      const photoMessage = await createMessage(channelId, alice, "", null, [photo.id]);

      const byMessage = await listAttachmentsForMessages([voiceMessage!.id, photoMessage!.id]);
      expect(byMessage.get(voiceMessage!.id)![0]!.voice).toEqual({
        durationMs: 4_200,
        waveform: WAVEFORM,
      });
      expect(byMessage.get(photoMessage!.id)![0]).not.toHaveProperty("voice");

      const refreshed = await getAttachmentForViewer(note.id, bob.id);
      expect(refreshed?.voice?.durationMs).toBe(4_200);
    });

    it("the DM list's last message says it was a voice note, and how long", async () => {
      await setGlobalFlag("voice_notes", true, { kind: "dashboard" });
      const note = await mintNote({ channel: dmChannelId, durationMs: 9_000 });
      await createMessage(dmChannelId, alice, "", null, [note.id]);
      const [row] = await listConversations(bob.id, dmChannelId);
      expect(row!.lastMessage).toMatchObject({
        preview: "",
        isAttachment: true,
        isGif: false,
        isVoice: true,
        voiceDurationMs: 9_000,
      });
    });
  });

  describe("the sweep", () => {
    beforeEach(async () => {
      await turnOnFor(serverId);
    });

    it("takes the side row with an abandoned note", async () => {
      const note = await mintNote();
      await getPool().query(
        `UPDATE message_attachments SET created_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
        [note.id],
      );
      expect(await sweepOrphanedAttachments()).toBe(1);
      expect(storage.deletedKeys).toEqual([note.storage_key]);
      expect(await countRows("message_attachment_voice")).toBe(0);
    });

    it("takes the side row with a deleted message's note", async () => {
      const note = await mintNote();
      const message = await createMessage(channelId, alice, "", null, [note.id]);
      await getPool().query(
        `UPDATE message_attachments SET created_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
        [note.id],
      );
      expect(await sweepOrphanedAttachments()).toBe(0);
      expect(await deleteMessage(message!.id)).toBe(true);
      await sweepOrphanedAttachments();
      expect(await countRows("message_attachments")).toBe(0);
      expect(await countRows("message_attachment_voice")).toBe(0);
    });
  });
});

describe("the push for a voice note", () => {
  const base = {
    channelKind: "dm" as const,
    mention: false,
    reply: false,
    dmDetails: true,
    channelId: "00000000-0000-4000-8000-000000000001",
    serverId: null,
    channelName: null,
    serverName: null,
    authorName: "Alice",
    locale: "pt-BR" as const,
  };

  it("says what it is and how long, in both languages", () => {
    expect(buildPushPayload({ ...base, voiceDurationMs: 12_400 })).toMatchObject({
      title: "Alice",
      body: "Mensagem de voz · 0:12",
    });
    expect(
      buildPushPayload({ ...base, locale: "en", voiceDurationMs: 65_000 }),
    ).toMatchObject({ title: "Alice", body: "Voice message · 1:05" });
    expect(
      buildPushPayload({ ...base, channelKind: "group", voiceDurationMs: 3_000 }),
    ).toMatchObject({ body: "Mensagem de voz · 0:03" });
  });

  it("keeps the generic copy when the recipient hides DM details", () => {
    expect(
      buildPushPayload({ ...base, dmDetails: false, voiceDurationMs: 12_000 }),
    ).toMatchObject({ title: "pqp", body: "Mensagem nova" });
  });

  it("is the ordinary copy for anything that is not a note", () => {
    expect(buildPushPayload(base)).toMatchObject({ body: "Te mandou uma mensagem" });
  });
});
