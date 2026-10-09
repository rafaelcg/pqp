import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbUser } from "../db.js";

/**
 * `voiceNotes` on `GET /api/admin/metrics`, on a real Postgres.
 *
 * Rows are written with SQL, with the ages and statuses each case needs,
 * because the thing under test is what the queries make of the tables and not
 * how a note gets there. Two cases do go through the real mint and claim
 * (`refusals`), since a counter wired to a branch nothing exercises is the
 * pitfall-12 shape. The flag is set the way production sets it, through rows
 * after `startFeatureFlags()`, never through the environment.
 */

const storage = vi.hoisted(() => ({
  objects: new Map<string, { contentLength: number; contentType: string }>(),
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => true,
  presignPut: (key: string) => `https://storage.test/${key}?sig=put`,
  presignGet: (key: string) => `https://storage.test/${key}?sig=get`,
  headObject: async (key: string) => storage.objects.get(key) ?? null,
  deleteObject: async () => {},
}));

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.VOICE_NOTES;
delete process.env.CLUSTER_BUS;
delete process.env.VOICE_STT_DAILY_SECONDS;

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { openConversation } = await import("./dms.js");
const { createServer: createPqpServer } = await import("./servers.js");
const { createPendingAttachment } = await import("./attachments.js");
const { createMessage } = await import("./messages.js");
const { voiceNoteMetrics } = await import("./voice-note-metrics.js");
const { getAdminMetrics, resetAdminMetricsCache } = await import("./metrics.js");
const { resetVoiceNoteRefusalsForTests, VOICE_NOTE_REFUSAL_REASONS } = await import(
  "./voice-notes.js"
);
const { resetFeatureFlagsForTests, setGlobalFlag, startFeatureFlags } = await import(
  "../lib/flags.js"
);

const WAVEFORM = Buffer.alloc(64, 100).toString("base64");

describeDb("voiceNotes metrics", () => {
  let alice: DbUser;
  let bob: DbUser;
  let carol: DbUser;
  let dm: string;
  let group: string;
  let serverChannel: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    delete process.env.VOICE_STT_DAILY_SECONDS;
    storage.objects.clear();
    resetFeatureFlagsForTests();
    resetVoiceNoteRefusalsForTests();
    resetAdminMetricsCache();
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members,
                message_attachments, speech_jobs, speech_usage_daily,
                feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({ clerkId: "clerk_alice", displayName: "Alice", avatarUrl: null });
    bob = await upsertUser({ clerkId: "clerk_bob", displayName: "Bob", avatarUrl: null });
    carol = await upsertUser({ clerkId: "clerk_carol", displayName: "Carol", avatarUrl: null });
    await getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);

    const created = await createPqpServer("Voz", alice.id);
    for (const member of [bob, carol]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [created.server.id, member.id],
      );
    }
    const channel = await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' ORDER BY position LIMIT 1`,
      [created.server.id],
    );
    dm = (await openConversation(alice.id, [bob.id])).channelId;
    group = (await openConversation(alice.id, [bob.id, carol.id])).channelId;
    serverChannel = channel.rows[0]!.id;
  });

  interface SeedNote {
    channel: string;
    uploader?: DbUser;
    contentType?: string;
    durationMs?: number;
    verifiedMs?: number | null;
    /** Hours since the note was minted. */
    ageHours?: number;
    /** False: minted and never sent. */
    claimed?: boolean;
    transcript?: "none" | "pending" | "done" | "no_speech" | "failed" | "unavailable";
  }

  let seq = 0;
  async function seedNote(note: SeedNote): Promise<string> {
    seq += 1;
    const pool = getPool();
    const uploader = note.uploader ?? alice;
    const claimed = note.claimed ?? true;
    const age = `${note.ageHours ?? 1} hours`;
    let messageId: string | null = null;
    if (claimed) {
      const message = await pool.query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, '') RETURNING id`,
        [note.channel, uploader.id],
      );
      messageId = message.rows[0]!.id;
    }
    const attachment = await pool.query<{ id: string }>(
      `INSERT INTO message_attachments
         (message_id, channel_id, uploader_id, storage_key, filename, content_type, byte_size, created_at)
       VALUES ($1, $2, $3, $4, 'voice', $5, 1000, now() - $6::interval) RETURNING id`,
      [
        messageId,
        note.channel,
        uploader.id,
        `k/${seq}`,
        note.contentType ?? "audio/webm",
        age,
      ],
    );
    const id = attachment.rows[0]!.id;
    await pool.query(
      `INSERT INTO message_attachment_voice
         (attachment_id, duration_ms, waveform, verified_duration_ms, transcript_status, created_at)
       VALUES ($1, $2, $3, $4, $5, now() - $6::interval)`,
      [id, note.durationMs ?? 10_000, WAVEFORM, note.verifiedMs ?? null, note.transcript ?? "none", age],
    );
    return id;
  }

  async function seedJob(job: {
    kind: "voice_note" | "voice_transcode";
    attachmentId: string;
    status: "queued" | "running" | "done" | "failed";
    attempts?: number;
    /** Seconds ago the job became due. */
    dueAgo?: number;
    /** Seconds ago the lease ran out (running only). */
    leaseExpiredAgo?: number;
    createdAgo?: number;
    /** Seconds ago it settled (done and failed). */
    finishedAgo?: number;
    lastError?: string | null;
  }): Promise<void> {
    await getPool().query(
      `INSERT INTO speech_jobs
         (kind, attachment_id, status, attempts, run_after, lease_expires_at, created_at, finished_at, last_error)
       VALUES ($1, $2, $3, $4,
               now() - make_interval(secs => $5),
               CASE WHEN $6::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $6::float8) END,
               now() - make_interval(secs => $7),
               CASE WHEN $8::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $8::float8) END,
               $9)`,
      [
        job.kind,
        job.attachmentId,
        job.status,
        job.attempts ?? 0,
        job.dueAgo ?? 0,
        job.leaseExpiredAgo ?? null,
        job.createdAgo ?? 0,
        job.finishedAgo ?? null,
        job.lastError ?? null,
      ],
    );
  }

  it("reads zero on an empty database, with the shape intact", async () => {
    const metrics = await voiceNoteMetrics();
    expect(metrics.usage).toMatchObject({
      minted24h: 0,
      minted7d: 0,
      sent24h: 0,
      sent7d: 0,
      byScope24h: { dm: 0, group: 0, server: 0 },
      byScope7d: { dm: 0, group: 0, server: 0 },
      byContentType24h: {},
      byContentType7d: {},
      senders24h: 0,
      senders7d: 0,
      durationSeconds: { total24h: 0, total7d: 0, median24h: null, median7d: null },
      listens24h: 0,
      listeners24h: 0,
      listenedNotes7d: 0,
      listenedShare7d: null,
    });
    for (const kind of ["transcription", "transcode"] as const) {
      expect(metrics.health.queue[kind]).toEqual({
        queued: 0,
        running: 0,
        retrying: 0,
        oldestQueuedSeconds: 0,
        expiredLeases: 0,
      });
      expect(metrics.health.jobs[kind]).toEqual({
        ok24h: 0,
        skipped24h: 0,
        failed24h: 0,
        successRate24h: null,
        p50Seconds: null,
        p95Seconds: null,
      });
    }
    expect(metrics.health.transcripts24h).toEqual({
      none: 0,
      pending: 0,
      done: 0,
      no_speech: 0,
      failed: 0,
      unavailable: 0,
    });
    expect(metrics.health.budget).toEqual({
      dailySeconds: 36_000,
      usedSeconds: 0,
      calls: 0,
      refused: 0,
      usedShare: 0,
      exhausted: false,
    });
    expect(Object.keys(metrics.refusals).sort()).toEqual([...VOICE_NOTE_REFUSAL_REASONS].sort());
  });

  describe("usage", () => {
    it("counts the windows, the scopes, the containers, the senders and the durations", async () => {
      // Inside 24 h: one per scope, three containers, two senders.
      const dmNote = await seedNote({ channel: dm, contentType: "audio/mp4", durationMs: 10_000, ageHours: 2 });
      await seedNote({
        channel: group,
        uploader: bob,
        contentType: "audio/webm;codecs=opus",
        durationMs: 20_000,
        ageHours: 5,
      });
      await seedNote({ channel: serverChannel, contentType: "audio/ogg", durationMs: 30_000, ageHours: 23 });
      // Inside 7 d, outside 24 h.
      await seedNote({ channel: dm, contentType: "audio/webm", durationMs: 40_000, ageHours: 50 });
      // Outside both windows.
      await seedNote({ channel: dm, durationMs: 60_000, ageHours: 24 * 9 });
      // Minted and never sent: counts as minted only.
      await seedNote({ channel: dm, durationMs: 5_000, ageHours: 1, claimed: false });

      const { usage } = await voiceNoteMetrics();
      expect(usage.minted24h).toBe(4);
      expect(usage.minted7d).toBe(5);
      expect(usage.sent24h).toBe(3);
      expect(usage.sent7d).toBe(4);
      expect(usage.byScope24h).toEqual({ dm: 1, group: 1, server: 1 });
      expect(usage.byScope7d).toEqual({ dm: 2, group: 1, server: 1 });
      expect(usage.byContentType24h).toEqual({ "audio/mp4": 1, "audio/webm": 1, "audio/ogg": 1 });
      expect(usage.byContentType7d).toEqual({ "audio/mp4": 1, "audio/webm": 2, "audio/ogg": 1 });
      expect(usage.senders24h).toBe(2);
      expect(usage.senders7d).toBe(2);
      expect(usage.durationSeconds).toEqual({
        total24h: 60,
        total7d: 100,
        median24h: 20,
        median7d: 25,
      });
      void dmNote;
    });

    it("prefers the container's length over the sender's claim", async () => {
      await seedNote({ channel: dm, durationMs: 10_000, verifiedMs: 4_000 });
      const { usage } = await voiceNoteMetrics();
      expect(usage.durationSeconds.total24h).toBe(4);
    });

    it("counts first plays in 24 h and the share of notes heard at least once", async () => {
      const heard = await seedNote({ channel: dm, ageHours: 3 });
      const heardTwice = await seedNote({ channel: group, ageHours: 60 });
      await seedNote({ channel: dm, ageHours: 4 });
      await seedNote({ channel: dm, ageHours: 6 });
      await getPool().query(
        `INSERT INTO voice_note_listens (attachment_id, user_id, listened_at) VALUES
           ($1, $3, now() - interval '1 hour'),
           ($1, $4, now() - interval '2 hours'),
           ($2, $3, now() - interval '30 hours')`,
        [heard, heardTwice, bob.id, carol.id],
      );
      const { usage } = await voiceNoteMetrics();
      // Two plays inside 24 h by two people; the 30 h old one is outside.
      expect(usage.listens24h).toBe(2);
      expect(usage.listeners24h).toBe(2);
      // Two of the four notes were heard, and a note heard by two counts once.
      expect(usage.listenedNotes7d).toBe(2);
      expect(usage.listenedShare7d).toBe(0.5);
    });
  });

  describe("health", () => {
    it("reports the live queue per kind, and how long the oldest DUE job has waited", async () => {
      const a = await seedNote({ channel: dm });
      const b = await seedNote({ channel: dm });
      const c = await seedNote({ channel: dm });
      const d = await seedNote({ channel: dm });
      // Due for 400 s and for 30 s: the oldest wins.
      await seedJob({ kind: "voice_transcode", attachmentId: a, status: "queued", dueAgo: 400 });
      await seedJob({ kind: "voice_transcode", attachmentId: b, status: "queued", dueAgo: 30 });
      // In backoff (run_after in the future): queued and retrying, not due.
      await seedJob({
        kind: "voice_transcode",
        attachmentId: c,
        status: "queued",
        attempts: 1,
        dueAgo: -600,
      });
      // A transcription somebody claimed whose lease is long gone.
      await seedJob({
        kind: "voice_note",
        attachmentId: d,
        status: "running",
        attempts: 1,
        leaseExpiredAgo: 90,
      });

      const { queue } = (await voiceNoteMetrics()).health;
      expect(queue.transcode).toMatchObject({
        queued: 3,
        running: 0,
        retrying: 1,
        expiredLeases: 0,
      });
      expect(queue.transcode.oldestQueuedSeconds).toBeGreaterThanOrEqual(399);
      expect(queue.transcode.oldestQueuedSeconds).toBeLessThan(420);
      expect(queue.transcription).toMatchObject({
        queued: 0,
        running: 1,
        expiredLeases: 1,
        oldestQueuedSeconds: 0,
      });
    });

    it("reports a retry in backoff as waiting, never as stuck", async () => {
      const a = await seedNote({ channel: dm });
      await seedJob({ kind: "voice_note", attachmentId: a, status: "queued", attempts: 2, dueAgo: -60 });
      const { queue } = (await voiceNoteMetrics()).health;
      expect(queue.transcription).toMatchObject({ queued: 1, retrying: 1, oldestQueuedSeconds: 0 });
    });

    it("measures success rate and latency over what settled in 24 h, leaving skipped jobs out", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 8; i += 1) ids.push(await seedNote({ channel: dm }));
      const okDurations = [2, 4, 6, 8]; // seconds from queued to done
      for (const [i, seconds] of okDurations.entries()) {
        await seedJob({
          kind: "voice_transcode",
          attachmentId: ids[i]!,
          status: "done",
          createdAgo: 100 + seconds,
          finishedAgo: 100,
        });
      }
      await seedJob({
        kind: "voice_transcode",
        attachmentId: ids[4]!,
        status: "failed",
        attempts: 3,
        finishedAgo: 50,
        lastError: "ffmpeg exited 1",
      });
      // Settled on purpose without work: neither side of the rate.
      await seedJob({
        kind: "voice_transcode",
        attachmentId: ids[5]!,
        status: "done",
        finishedAgo: 50,
        lastError: "gone",
      });
      // Settled two days ago: outside the window.
      await seedJob({
        kind: "voice_transcode",
        attachmentId: ids[6]!,
        status: "failed",
        finishedAgo: 2 * 24 * 3600,
        lastError: "old",
      });
      // The other kind is counted on its own.
      await seedJob({
        kind: "voice_note",
        attachmentId: ids[7]!,
        status: "failed",
        finishedAgo: 10,
        lastError: "provider 500",
      });

      const { jobs } = (await voiceNoteMetrics()).health;
      expect(jobs.transcode).toMatchObject({ ok24h: 4, skipped24h: 1, failed24h: 1, successRate24h: 0.8 });
      // 2, 4, 6, 8 s: interpolated median 5, p95 7.7.
      expect(jobs.transcode.p50Seconds).toBe(5);
      expect(jobs.transcode.p95Seconds).toBeCloseTo(7.7, 1);
      expect(jobs.transcription).toMatchObject({
        ok24h: 0,
        failed24h: 1,
        successRate24h: 0,
        p50Seconds: null,
        p95Seconds: null,
      });
    });

    it("counts where the last day's notes stand by transcript status", async () => {
      for (const transcript of ["none", "none", "pending", "done", "done", "done", "no_speech", "failed", "unavailable"] as const) {
        await seedNote({ channel: dm, transcript });
      }
      // Outside 24 h, and unsent: neither counts.
      await seedNote({ channel: dm, transcript: "failed", ageHours: 40 });
      await seedNote({ channel: dm, transcript: "failed", claimed: false });
      const { transcripts24h } = (await voiceNoteMetrics()).health;
      expect(transcripts24h).toEqual({
        none: 2,
        pending: 1,
        done: 3,
        no_speech: 1,
        failed: 1,
        unavailable: 1,
      });
    });

    it("reads today's provider budget against the configured limit", async () => {
      process.env.VOICE_STT_DAILY_SECONDS = "1000";
      await getPool().query(
        `INSERT INTO speech_usage_daily (day, seconds, calls, refused)
         VALUES ((now() AT TIME ZONE 'UTC')::date, 250, 9, 0),
                ((now() AT TIME ZONE 'UTC')::date - 1, 999, 99, 99)`,
      );
      expect((await voiceNoteMetrics()).health.budget).toEqual({
        dailySeconds: 1000,
        usedSeconds: 250,
        calls: 9,
        refused: 0,
        usedShare: 0.25,
        exhausted: false,
      });

      await getPool().query(
        `UPDATE speech_usage_daily SET seconds = 990, refused = 3
          WHERE day = (now() AT TIME ZONE 'UTC')::date`,
      );
      expect((await voiceNoteMetrics()).health.budget).toMatchObject({
        usedSeconds: 990,
        refused: 3,
        exhausted: true,
      });
    });

    it("has no share for a budget of zero", async () => {
      process.env.VOICE_STT_DAILY_SECONDS = "0";
      expect((await voiceNoteMetrics()).health.budget).toMatchObject({
        dailySeconds: 0,
        usedShare: null,
      });
    });
  });

  describe("refusals", () => {
    async function flagsOn(global: boolean) {
      await startFeatureFlags();
      await setGlobalFlag("voice_notes", global, { kind: "dashboard" });
    }

    const mint = (overrides: Partial<{ byteSize: number; durationMs: number }> = {}) =>
      createPendingAttachment({
        channelId: dm,
        uploaderId: alice.id,
        filename: "voice.webm",
        contentType: "audio/webm",
        byteSize: overrides.byteSize ?? 20_000,
        voice: { durationMs: overrides.durationMs ?? 12_000, waveform: WAVEFORM },
      });

    it("counts a mint turned away because the flag is off, and one that is too large", async () => {
      await flagsOn(false);
      await expect(mint()).rejects.toThrow();
      await flagsOn(true);
      await expect(mint({ byteSize: 3_000_000, durationMs: 1_000 })).rejects.toThrow();
      const { refusals } = await voiceNoteMetrics();
      expect(refusals["mint-flag-off"]).toBe(1);
      expect(refusals["mint-too-large"]).toBe(1);
      expect(refusals["mint-content-type"]).toBe(0);
    });

    it("counts a claim refused for text beside the note, for a second attachment, and for the flag", async () => {
      await flagsOn(true);
      const note = async () => {
        const pending = await mint();
        storage.objects.set(pending.attachment.storage_key!, {
          contentLength: 20_000,
          contentType: "audio/webm",
        });
        return pending.attachment.id;
      };

      const first = await note();
      expect(await createMessage(dm, alice, "hello", null, [first])).toBeNull();

      const second = await note();
      const third = await note();
      expect(await createMessage(dm, alice, "", null, [second, third])).toBeNull();

      await flagsOn(false);
      expect(await createMessage(dm, alice, "", null, [second])).toBeNull();

      const { refusals } = await voiceNoteMetrics();
      expect(refusals["claim-text-beside-note"]).toBe(1);
      expect(refusals["claim-not-only-attachment"]).toBe(1);
      expect(refusals["claim-flag-off"]).toBe(1);
    });
  });

  it("rides on GET /api/admin/metrics under voiceNotes", async () => {
    await seedNote({ channel: dm });
    const metrics = await getAdminMetrics();
    expect(metrics.voiceNotes.usage.sent24h).toBe(1);
    expect(metrics.voiceNotes.health.queue.transcode.queued).toBe(0);
  });
});
