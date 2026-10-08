import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbUser } from "../db.js";

/**
 * VOICE NOTE TRANSCRIPTION AND TRANSCODE, end to end in one process, on a
 * real Postgres: the enqueue inside the message transaction, the worker's
 * claim, lease and budget, the flag re-check before the provider, the reads,
 * the lazy route and the cleanup of the AAC copy.
 *
 * Flags are set the way production sets them, through rows written after
 * `startFeatureFlags()`: per-server overrides for server channels, the global
 * row for conversations (which have no server). Never the environment
 * (CLAUDE.md pitfalls 9 and 12). The provider is the replay provider, so no
 * network and no key. Storage is an in-memory bucket that keeps the bytes,
 * because the worker reads them back. The real cross-process path (an API
 * process enqueues, a worker process runs, the frame reaches the API's socket
 * over the bus) is `speech-two-process.test.ts`.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "speech", "fixtures");
const WEBM = readFileSync(join(FIXTURES, "note.webm"));
const M4A = readFileSync(join(FIXTURES, "note.m4a"));

const storage = vi.hoisted(() => ({
  objects: new Map<string, { contentLength: number; contentType: string; body?: Buffer }>(),
  deletedKeys: [] as string[],
  puts: [] as string[],
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => true,
  presignPut: (key: string) => `https://storage.test/${key}?sig=put`,
  presignGet: (key: string) => `https://storage.test/${key}?sig=get`,
  headObject: async (key: string) => {
    const object = storage.objects.get(key);
    return object ? { contentLength: object.contentLength, contentType: object.contentType } : null;
  },
  getObjectPrefix: async (key: string, length: number) =>
    storage.objects.get(key)?.body?.subarray(0, length) ?? null,
  putObject: async (key: string, body: Buffer, contentType: string) => {
    storage.puts.push(key);
    storage.objects.set(key, { contentLength: body.length, contentType, body });
  },
  deleteObject: async (key: string) => {
    storage.deletedKeys.push(key);
    storage.objects.delete(key);
  },
}));

const frames = vi.hoisted(() => [] as Array<{ channelId: string; message: Record<string, unknown> }>);
vi.mock(import("../ws/chat.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  broadcastToChannel: ((channelId: string, message: Record<string, unknown>) => {
    frames.push({ channelId, message });
  }) as never,
}));

let actor: DbUser | null = null;
vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () => (actor ? { user: actor, ageGate: "passed" as const } : null),
  verifyAuthHeader: async () => null,
}));

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.VOICE_NOTES;
delete process.env.VOICE_NOTE_TRANSCRIPTION;
delete process.env.VOICE_STT_PROVIDER;
delete process.env.VOICE_STT_DAILY_SECONDS;

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer: createPqpServer, deleteChannel } = await import("./servers.js");
const { openConversation } = await import("./dms.js");
const { createMessage } = await import("./messages.js");
const { createPendingAttachment, listAttachmentsForMessages } = await import("./attachments.js");
const { mergePreferences } = await import("./preferences.js");
const { runSpeechJobsTick, resetSpeechJobMetricsForTests, speechJobMetrics, cleanTranscript } =
  await import("./speech-worker.js");
const { claimSpeechJobs } = await import("./speech-jobs.js");
const { isFfmpegAvailable } = await import("../speech/transcode.js");
const { setSttProviderForTests } = await import("../speech/select.js");
const { createReplayProvider } = await import("../speech/providers/replay.js");
const { resetFeatureFlagsForTests, setGlobalFlag, setServerFlagOverride, startFeatureFlags } =
  await import("../lib/flags.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");

const WAVEFORM = Buffer.alloc(64, 100).toString("base64");
const ffmpeg = await isFfmpegAvailable();

describeDb("voice note speech jobs", () => {
  let http: Server;
  let baseUrl: string;
  let alice: DbUser;
  let bob: DbUser;
  let serverId: string;
  let channelId: string;
  let dmChannelId: string;
  let calls: Array<{ language?: string; format?: string }>;
  let replayText: string;
  let replayNoSpeech: number;

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
    setSttProviderForTests(undefined);
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    storage.objects.clear();
    storage.deletedKeys.length = 0;
    storage.puts.length = 0;
    frames.length = 0;
    delete process.env.VOICE_STT_DAILY_SECONDS;
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    resetSpeechJobMetricsForTests();
    calls = [];
    replayText = "oi, tudo bem? te ligo mais tarde";
    replayNoSpeech = 0.02;
    setSttProviderForTests({
      id: "replay",
      transcribe: (audio, opts) => {
        calls.push({ language: opts.language, format: opts.format });
        return createReplayProvider({
          cues: [{ start: 0, end: 1.5, text: replayText, noSpeechProb: replayNoSpeech }],
          language: opts.language ?? "pt",
        }).transcribe(audio, opts);
      },
    });
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members, user_preferences,
                message_attachments, speech_jobs, speech_usage_daily, feature_flags,
                feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({ clerkId: "clerk_alice", displayName: "Alice", avatarUrl: null });
    bob = await upsertUser({ clerkId: "clerk_bob", displayName: "Bob", avatarUrl: null });
    await getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);
    const created = await createPqpServer("Voz", alice.id);
    serverId = created.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, bob.id],
    );
    channelId = (
      await getPool().query<{ id: string }>(
        `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' ORDER BY position LIMIT 1`,
        [serverId],
      )
    ).rows[0]!.id;
    dmChannelId = (await openConversation(alice.id, [bob.id])).channelId;
    await startFeatureFlags();
    // Voice notes on everywhere; transcription is what each test decides.
    await setGlobalFlag("voice_notes", true, { kind: "dashboard" });
    actor = bob;
  });

  const transcriptionOnFor = (id: string, enabled: boolean | null = true) =>
    setServerFlagOverride("voice_note_transcription", id, enabled, { kind: "dashboard" });
  const transcriptionGlobally = (enabled: boolean | null) =>
    setGlobalFlag("voice_note_transcription", enabled, { kind: "dashboard" });

  /** Mint a note with real container bytes behind it, then send it. */
  async function sendNote(
    channel: string,
    options: { bytes?: Buffer; contentType?: "audio/webm" | "audio/mp4"; durationMs?: number; author?: DbUser } = {},
  ) {
    const bytes = options.bytes ?? WEBM;
    const contentType = options.contentType ?? "audio/webm";
    const author = options.author ?? alice;
    const pending = await createPendingAttachment({
      channelId: channel,
      uploaderId: author.id,
      filename: contentType === "audio/mp4" ? "voice.m4a" : "voice.webm",
      contentType,
      byteSize: bytes.length,
      voice: { durationMs: options.durationMs ?? 1_500, waveform: WAVEFORM },
    });
    storage.objects.set(pending.attachment.storage_key!, {
      contentLength: bytes.length,
      contentType,
      body: bytes,
    });
    const message = await createMessage(channel, author, "", null, [pending.attachment.id]);
    expect(message).not.toBeNull();
    return { message: message!, attachmentId: pending.attachment.id, storageKey: pending.attachment.storage_key! };
  }

  const jobsFor = async (attachmentId: string) =>
    (
      await getPool().query<{ kind: string; status: string; language_hint: string | null; attempts: number }>(
        `SELECT kind, status, language_hint, attempts FROM speech_jobs
          WHERE attachment_id = $1 ORDER BY kind`,
        [attachmentId],
      )
    ).rows;

  const voiceRow = async (attachmentId: string) =>
    (
      await getPool().query<{
        transcript_status: string;
        transcript_text: string | null;
        transcript_language: string | null;
        transcript_provider: string | null;
        verified_duration_ms: number | null;
        codec: string | null;
        playback_key: string | null;
        playback_content_type: string | null;
      }>(
        `SELECT transcript_status, transcript_text, transcript_language, transcript_provider,
                verified_duration_ms, codec, playback_key, playback_content_type
           FROM message_attachment_voice WHERE attachment_id = $1`,
        [attachmentId],
      )
    ).rows[0]!;

  /** Run ticks until nothing is due (transcodes only where ffmpeg exists). */
  async function drain(): Promise<void> {
    for (let i = 0; i < 10 && (await runSpeechJobsTick()) > 0; i++);
  }

  async function postTranscript(attachmentId: string) {
    const response = await fetch(`${baseUrl}/api/attachments/${attachmentId}/transcript`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  async function readVoice(messageId: string) {
    return (await listAttachmentsForMessages([messageId])).get(messageId)![0]!.voice!;
  }

  describe("eager, in a conversation", () => {
    it("queues at send, in the message transaction, and the worker writes and announces the text", async () => {
      await transcriptionGlobally(true);
      const { message, attachmentId } = await sendNote(dmChannelId);

      // The message as it was broadcast already says a transcript is coming.
      expect(message.attachments[0]!.voice!.transcript).toEqual({ status: "pending", text: null, language: null });
      expect(await jobsFor(attachmentId)).toEqual([
        // A 1.5 s clip carries the sender's locale (pt by default).
        { kind: "voice_note", status: "queued", language_hint: "pt", attempts: 0 },
        { kind: "voice_transcode", status: "queued", language_hint: null, attempts: 0 },
      ]);

      await drain();

      expect(calls).toEqual([{ language: "pt", format: "webm" }]);
      const row = await voiceRow(attachmentId);
      expect(row).toMatchObject({
        transcript_status: "done",
        transcript_text: "oi, tudo bem? te ligo mais tarde",
        transcript_language: "pt",
        transcript_provider: "replay",
        codec: "opus",
      });
      // Read from the container headers, not taken from the client.
      expect(row.verified_duration_ms).toBeGreaterThan(1_400);
      expect(row.verified_duration_ms).toBeLessThan(1_650);

      const transcriptFrames = frames.filter((frame) => frame.message.type === "voice-note-transcript");
      expect(transcriptFrames).toEqual([
        {
          channelId: dmChannelId,
          message: {
            type: "voice-note-transcript",
            channelId: dmChannelId,
            messageId: message.id,
            attachmentId,
            transcript: { status: "done", text: "oi, tudo bem? te ligo mais tarde", language: "pt" },
          },
        },
      ]);
      expect((await readVoice(message.id)).transcript).toEqual({
        status: "done",
        text: "oi, tudo bem? te ligo mais tarde",
        language: "pt",
      });
      expect(speechJobMetrics().done).toBe(1);
      // The budget was charged by the container's length, rounded up.
      const usage = await getPool().query(`SELECT seconds, calls FROM speech_usage_daily`);
      expect(usage.rows).toEqual([{ seconds: 2, calls: 1 }]);
    });

    it("mine=false at mint means no transcription job, and the note offers none", async () => {
      await transcriptionGlobally(true);
      await mergePreferences(alice.id, { voiceTranscription: { mine: false } });
      const { message, attachmentId } = await sendNote(dmChannelId);
      expect((await jobsFor(attachmentId)).map((job) => job.kind)).toEqual(["voice_transcode"]);
      expect(message.attachments[0]!.voice!.transcript).toBeUndefined();
      // Nor can anybody ask for one afterwards.
      expect((await postTranscript(attachmentId)).status).toBe(403);
      await drain();
      expect(calls).toEqual([]);
    });

    it("needs a recipient who reads transcripts", async () => {
      await transcriptionGlobally(true);
      await mergePreferences(bob.id, { voiceTranscription: { show: false } });
      const { attachmentId } = await sendNote(dmChannelId);
      expect((await jobsFor(attachmentId)).map((job) => job.kind)).toEqual(["voice_transcode"]);
    });

    it("sends no language hint past four seconds", async () => {
      await transcriptionGlobally(true);
      await mergePreferences(alice.id, { locale: "en" });
      const short = await sendNote(dmChannelId);
      expect((await jobsFor(short.attachmentId))[0]!.language_hint).toBe("en");
      const long = await sendNote(dmChannelId, { durationMs: 6_000 });
      expect((await jobsFor(long.attachmentId))[0]!.language_hint).toBeNull();
    });

    it("an AAC note gets no transcode job", async () => {
      await transcriptionGlobally(true);
      const { attachmentId } = await sendNote(dmChannelId, { bytes: M4A, contentType: "audio/mp4" });
      expect((await jobsFor(attachmentId)).map((job) => job.kind)).toEqual(["voice_note"]);
      await drain();
      expect(await voiceRow(attachmentId)).toMatchObject({ transcript_status: "done", codec: "aac" });
    });
  });

  describe("the flag", () => {
    it("off at send: nothing is queued but the transcode", async () => {
      const { attachmentId } = await sendNote(dmChannelId);
      expect((await jobsFor(attachmentId)).map((job) => job.kind)).toEqual(["voice_transcode"]);
    });

    it("flipped off while the job is queued: no provider call, the job is dropped, the note is back to none", async () => {
      await transcriptionGlobally(true);
      const { attachmentId } = await sendNote(dmChannelId);
      expect((await voiceRow(attachmentId)).transcript_status).toBe("pending");

      await transcriptionGlobally(false);
      await drain();

      expect(calls).toEqual([]);
      expect(await getPool().query(`SELECT * FROM speech_usage_daily`)).toMatchObject({ rowCount: 0 });
      expect((await jobsFor(attachmentId)).map((job) => job.kind)).not.toContain("voice_note");
      expect((await voiceRow(attachmentId)).transcript_status).toBe("none");
      expect(speechJobMetrics().droppedFlagOff).toBe(1);
      expect(frames.filter((frame) => frame.message.type === "voice-note-transcript")).toEqual([]);
    });

    it("off hides a stored transcript on read, and on comes back with it", async () => {
      await transcriptionGlobally(true);
      const { message } = await sendNote(dmChannelId);
      await drain();
      expect((await readVoice(message.id)).transcript?.status).toBe("done");
      await transcriptionGlobally(false);
      expect((await readVoice(message.id)).transcript).toBeUndefined();
      await transcriptionGlobally(true);
      expect((await readVoice(message.id)).transcript?.text).toBe("oi, tudo bem? te ligo mais tarde");
    });
  });

  describe("lazy, in a server channel", () => {
    it("nothing runs at send; a request queues it once and everybody reads the answer", async () => {
      await transcriptionOnFor(serverId);
      const { message, attachmentId } = await sendNote(channelId);
      expect((await jobsFor(attachmentId)).map((job) => job.kind)).toEqual(["voice_transcode"]);
      expect(message.attachments[0]!.voice!.transcript).toEqual({ status: "none", text: null, language: null });

      const first = await postTranscript(attachmentId);
      expect(first).toEqual({ status: 202, body: { transcript: { status: "pending", text: null, language: null } } });
      // A second request while it is queued is the same job.
      expect((await postTranscript(attachmentId)).status).toBe(202);
      expect((await jobsFor(attachmentId)).filter((job) => job.kind === "voice_note")).toHaveLength(1);

      await drain();
      expect(calls).toHaveLength(1);

      actor = alice;
      const settled = await postTranscript(attachmentId);
      expect(settled).toEqual({
        status: 200,
        body: { transcript: { status: "done", text: "oi, tudo bem? te ligo mais tarde", language: "pt" } },
      });
      expect(calls).toHaveLength(1);
      // The frame went to the channel, so everybody viewing it saw it at once.
      expect(frames.find((frame) => frame.message.type === "voice-note-transcript")?.channelId).toBe(channelId);
    });

    it("403 with the flag off for that server, 404 for a stranger or a bad id", async () => {
      const { attachmentId } = await sendNote(channelId);
      expect((await postTranscript(attachmentId)).status).toBe(403);
      await transcriptionOnFor(serverId);
      const stranger = await upsertUser({ clerkId: "clerk_carol", displayName: "Carol", avatarUrl: null });
      actor = stranger;
      expect((await postTranscript(attachmentId)).status).toBe(404);
      actor = bob;
      expect((await postTranscript("not-a-uuid")).status).toBe(404);
    });

    it("applies the send-time eligibility: the asker reads transcripts, and in a conversation a recipient does", async () => {
      await transcriptionOnFor(serverId);
      await transcriptionGlobally(true);
      // Bob turned transcripts off: his request sends nothing out.
      await mergePreferences(bob.id, { voiceTranscription: { show: false } });
      const inChannel = await sendNote(channelId);
      expect((await postTranscript(inChannel.attachmentId)).status).toBe(403);

      // In the conversation nobody but the sender reads transcripts, so the
      // sender cannot ask for one either: the eager rule said no, and so does this.
      const inDm = await sendNote(dmChannelId);
      expect((await jobsFor(inDm.attachmentId)).map((job) => job.kind)).toEqual(["voice_transcode"]);
      actor = alice;
      expect((await postTranscript(inDm.attachmentId)).status).toBe(403);
      await drain();
      expect(calls).toEqual([]);
    });
  });

  describe("settling without text", () => {
    it("no provider configured settles unavailable, with no call and no budget", async () => {
      setSttProviderForTests(null);
      await transcriptionGlobally(true);
      const { message, attachmentId } = await sendNote(dmChannelId);
      await drain();
      expect(await voiceRow(attachmentId)).toMatchObject({ transcript_status: "unavailable", transcript_text: null });
      expect((await readVoice(message.id)).transcript).toEqual({ status: "unavailable", text: null, language: null });
      expect(await getPool().query(`SELECT * FROM speech_usage_daily`)).toMatchObject({ rowCount: 0 });
      expect(frames.find((frame) => frame.message.type === "voice-note-transcript")?.message.transcript).toEqual({
        status: "unavailable",
        text: null,
        language: null,
      });
    });

    it("an exhausted daily budget settles unavailable without calling the provider", async () => {
      process.env.VOICE_STT_DAILY_SECONDS = "3";
      await transcriptionGlobally(true);
      const first = await sendNote(dmChannelId);
      const second = await sendNote(dmChannelId);
      await drain();
      const statuses = [
        (await voiceRow(first.attachmentId)).transcript_status,
        (await voiceRow(second.attachmentId)).transcript_status,
      ].sort();
      // Two seconds each against three: one fits, one does not.
      expect(statuses).toEqual(["done", "unavailable"]);
      expect(calls).toHaveLength(1);
      const usage = await getPool().query(`SELECT seconds, calls, refused FROM speech_usage_daily`);
      expect(usage.rows).toEqual([{ seconds: 2, calls: 1, refused: 1 }]);
      expect(speechJobMetrics().overBudget).toBe(1);
    });

    it("what Whisper marked as no speech is dropped as no_speech", async () => {
      replayNoSpeech = 0.93;
      replayText = "Obrigado por assistir!";
      await transcriptionGlobally(true);
      const { attachmentId } = await sendNote(dmChannelId);
      await drain();
      expect(await voiceRow(attachmentId)).toMatchObject({ transcript_status: "no_speech", transcript_text: null });
    });

    it("collapses a Whisper loop", () => {
      const cleaned = cleanTranscript({
        text: "",
        segments: [{ start: 0, end: 2, text: "oi " + "tchau ".repeat(30) + "fim", noSpeechProb: 0.1 }],
        durationMs: 2_000,
      });
      expect(cleaned.noSpeech).toBe(false);
      expect(cleaned.text.split("tchau").length - 1).toBeLessThan(10);
    });
  });

  describe("the queue", () => {
    it("a crashed worker's lease expires and the next claim finishes the job", async () => {
      await transcriptionGlobally(true);
      const { attachmentId } = await sendNote(dmChannelId);

      // A worker claims and dies: no settle, no retry, the lease still live.
      const [claimed] = await claimSpeechJobs(["voice_note"], 1, "dead-worker");
      expect(claimed!.attachment_id).toBe(attachmentId);
      expect(await claimSpeechJobs(["voice_note"], 1, "other")).toEqual([]);
      expect(await runSpeechJobsTick()).toBeLessThanOrEqual(1); // only the transcode, if ffmpeg
      expect((await voiceRow(attachmentId)).transcript_status).toBe("pending");

      // Its lease runs out.
      await getPool().query(
        `UPDATE speech_jobs SET lease_expires_at = NOW() - INTERVAL '1 second'
          WHERE attachment_id = $1 AND kind = 'voice_note'`,
        [attachmentId],
      );
      await drain();
      expect((await voiceRow(attachmentId)).transcript_status).toBe("done");
      const job = (await jobsFor(attachmentId)).find((row) => row.kind === "voice_note")!;
      expect(job).toMatchObject({ status: "done", attempts: 2 });
      // The dead worker coming back cannot settle what is no longer its job.
      const late = await getPool().query(
        `UPDATE speech_jobs SET status = 'failed' WHERE id = $1 AND leased_by = 'dead-worker' AND status = 'running'`,
        [claimed!.id],
      );
      expect(late.rowCount).toBe(0);
    });

    it("a job whose worker died on its last attempt is failed, not reclaimed forever", async () => {
      await transcriptionGlobally(true);
      const { attachmentId } = await sendNote(dmChannelId);
      await getPool().query(
        `UPDATE speech_jobs SET status = 'running', leased_by = 'dead-worker', attempts = 3,
                lease_expires_at = NOW() - INTERVAL '1 second'
          WHERE attachment_id = $1 AND kind = 'voice_note'`,
        [attachmentId],
      );
      await drain();
      expect(calls).toEqual([]);
      expect((await jobsFor(attachmentId)).find((row) => row.kind === "voice_note")).toMatchObject({
        status: "failed",
        attempts: 3,
      });
      expect((await voiceRow(attachmentId)).transcript_status).toBe("failed");
    });
  });

  describe.skipIf(!ffmpeg)("the AAC copy (needs ffmpeg; skipped where it is absent)", () => {
    it("a webm note gets a playbackUrl, announced with voice-note-updated, and dies with its channel", async () => {
      const { message, attachmentId, storageKey } = await sendNote(channelId);
      expect(message.attachments[0]!.voice!.playbackUrl).toBeUndefined();
      await drain();

      const row = await voiceRow(attachmentId);
      expect(row.playback_key).toBe(storageKey.replace(/\.webm$/, ".playback.m4a"));
      expect(row.playback_content_type).toBe("audio/mp4");
      expect(storage.puts).toEqual([row.playback_key]);
      const copy = storage.objects.get(row.playback_key!)!;
      expect(copy.contentType).toBe("audio/mp4");
      expect(copy.body!.toString("latin1", 4, 8)).toBe("ftyp");

      expect((await readVoice(message.id)).playbackUrl).toBe(`https://storage.test/${row.playback_key}?sig=get`);
      expect(frames.filter((frame) => frame.message.type === "voice-note-updated")).toEqual([
        {
          channelId,
          message: { type: "voice-note-updated", channelId, messageId: message.id, attachmentId, playbackReady: true },
        },
      ]);

      // Channel delete reads every key a row names, the copy included.
      await deleteChannel(channelId);
      await vi.waitFor(() => {
        expect(storage.deletedKeys).toEqual(expect.arrayContaining([storageKey, row.playback_key]));
      });
    });

    it("an AAC note is never transcoded", async () => {
      const { attachmentId } = await sendNote(channelId, { bytes: M4A, contentType: "audio/mp4" });
      await drain();
      expect((await voiceRow(attachmentId)).playback_key).toBeNull();
      expect(storage.puts).toEqual([]);
    });
  });

  it("the copy's key is reserved before the upload, so a delete that lands mid-transcode still finds it", async () => {
    // Without ffmpeg this still checks the delete side: a reserved key is
    // read by every delete path even before the copy is confirmed.
    const { attachmentId, storageKey } = await sendNote(channelId);
    const reserved = storageKey.replace(/\.webm$/, ".playback.m4a");
    await getPool().query(`UPDATE message_attachment_voice SET playback_key = $2 WHERE attachment_id = $1`, [
      attachmentId,
      reserved,
    ]);
    await deleteChannel(channelId);
    await vi.waitFor(() => {
      expect(storage.deletedKeys).toEqual(expect.arrayContaining([storageKey, reserved]));
    });
  });
});
