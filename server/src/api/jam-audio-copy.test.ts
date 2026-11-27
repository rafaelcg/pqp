import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jamAudioSourceSchema,
  jamSongDetailResponseSchema,
  jamUploadTicketSchema,
  publicJamSongDetailSchema,
  type JamSongSummary,
  type JamTrack,
  type PublicJamSongDetail,
} from "@pqp/shared";

/**
 * THE OPUS LISTENING COPY of a jam stem, end to end on a real Postgres and the
 * fake object store of `jam.test.ts` (the real `lib/s3.ts` signs against it),
 * with the flag set the way production sets it: a `feature_flags` row read after
 * `startFeatureFlags()` (pitfall 12), never the environment, and every claim
 * through the real queue (`claimSpeechJobs`). ffmpeg is replaced by a converter
 * that writes a minimal Ogg Opus with chosen facts, so this runs wherever
 * Postgres does; what it pins is the plumbing and the rules:
 *
 *   - flag OFF is the system as it was: no job, no claim, no backfill, no
 *     `audioSources` key in any read, even for a copy that exists;
 *   - flag ON: a FLAC stem queues one job with its track, a lossy one none;
 *     the copy is reserved, uploaded and confirmed in that order and a read
 *     offers it first and the original last, to listeners only;
 *   - every failure is counted, logged and leaves the stem on its FLAC; a copy
 *     whose length is not the original's is never offered;
 *   - a deleted track takes its job and its object with it, on every path;
 *   - the backfill is rate limited, newest and public songs first, idempotent
 *     and resumable, and does nothing with the flag off;
 *   - two workers never make a copy twice.
 *
 * The conversion on real ffmpeg, and that the copy lands where the FLAC does,
 * is `speech/audio-copy.test.ts`; the last block here runs the whole path on
 * real ffmpeg where there is one.
 */

function localTestDatabase(): string | undefined {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    return undefined;
  }
  try {
    const host = new URL(url).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) ? url : undefined;
  } catch {
    return undefined;
  }
}
const DATABASE_URL = localTestDatabase();
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.JAM_CHANNELS;
delete process.env.JAM_PUBLIC;
delete process.env.JAM_AUDIO_COPY;
delete process.env.JAM_AUDIO_COPY_BACKFILL_PER_MINUTE;
delete process.env.READ_CACHE;
delete process.env.CONTENT_SCAN_PROVIDER;
delete process.env.JAM_PUBLIC_MEDIA_BASE_URL;

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  resolveAuthUser: async () => (stubs.actor ? { user: stubs.actor } : null),
  resolveAuthSession: async () =>
    stubs.actor ? { user: stubs.actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createPqpServer } = await import("../services/servers.js");
const { resetSharedRateLimit } = await import("../lib/cluster-rate-limit.js");
const { resetFeatureFlagsForTests, setGlobalFlag, setServerFlagOverride, startFeatureFlags } = await import(
  "../lib/flags.js"
);
const { sweepJamMedia } = await import("../services/jam.js");
const { jamKeysForServer, jamKeysForUser } = await import("../services/jam-keys.js");
const { claimSpeechJobs } = await import("../services/speech-jobs.js");
const { runnableSpeechJobKinds, runSpeechJobsTick, waitForJamAudioCopyJobForTests } = await import(
  "../services/speech-worker.js"
);
const { isJamAudioCopyAvailable } = await import("../speech/audio-copy.js");
const {
  BACKFILL_QUEUE_CAP,
  enqueueJamAudioCopy,
  enqueueMissingJamAudioCopies,
  jamAudioCopyJobMetrics,
  listenKeyFor,
  resetJamAudioCopyJobMetricsForTests,
  runJamAudioCopyJob,
  setJamAudioCopyConverterForTests,
} = await import("../services/jam-audio-copy.js");
const { jamAudioCopyMetrics } = await import("../services/jam-audio-copy-metrics.js");
const { getAdminMetrics, resetAdminMetricsCache } = await import("../services/metrics.js");
const ffmpegHere = await isJamAudioCopyAvailable();

// ------------------------------------------------------------ fake storage

const objects = new Map<string, { type: string; body: Buffer }>();
const storage = {
  failPuts: false,
  failDeletes: false,
  afterCopyPut: null as null | (() => Promise<void>),
};
let s3: Server;
const BUCKET = "jam-audio-copy-test";

function startFakeS3(): Promise<string> {
  s3 = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = decodeURIComponent(url.pathname.replace(`/${BUCKET}/`, ""));
    if (req.method === "PUT") {
      if (storage.failPuts && key.endsWith(".listen.ogg")) {
        req.resume();
        res.writeHead(500).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(key, { type: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
        const hook = key.endsWith(".listen.ogg") ? storage.afterCopyPut : null;
        void (hook ? hook() : Promise.resolve()).then(() => res.writeHead(200).end());
      });
      return;
    }
    const found = objects.get(key);
    if (req.method === "DELETE") {
      if (storage.failDeletes) {
        res.writeHead(500).end();
        return;
      }
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    if (!found) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": found.body.length, "content-type": found.type });
    res.end(req.method === "HEAD" ? undefined : found.body);
  });
  return new Promise((resolve) =>
    s3.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s3.address() as AddressInfo).port}`)),
  );
}

// ---------------------------------------------------- the bytes of the fixtures

/** A FLAC header that says what it says (STREAMINFO), followed by filler: all the job reads before ffmpeg. */
function fakeFlac(totalSamples = 1_440_000, options: { rate?: number; channels?: number; padding?: number } = {}): Buffer {
  const head = Buffer.alloc(42);
  head.write("fLaC", 0, "latin1");
  head[4] = 0;
  head.writeUIntBE(34, 5, 3);
  const rate = BigInt(options.rate ?? 48_000);
  const channels = BigInt((options.channels ?? 1) - 1);
  head.writeBigUInt64BE((rate << 44n) | (channels << 41n) | (15n << 36n) | BigInt(totalSamples), 8 + 10);
  return Buffer.concat([head, Buffer.alloc(options.padding ?? 4_000, 7)]);
}

/** A minimal Ogg Opus: an OpusHead page, then a last page whose granule says how long it is. */
function fakeOgg(options: { preSkip?: number; samples?: number; channels?: number; bytes?: number } = {}): Buffer {
  const preSkip = options.preSkip ?? 312;
  const samples = options.samples ?? 1_440_000;
  const page = (type: number, granule: bigint, body: Buffer) => {
    const header = Buffer.alloc(27 + 1);
    header.write("OggS", 0, "latin1");
    header[5] = type;
    header.writeBigInt64LE(granule, 6);
    header[26] = 1;
    header[27] = Math.min(255, body.length);
    return Buffer.concat([header, body]);
  };
  const opusHead = Buffer.alloc(19);
  opusHead.write("OpusHead", 0, "latin1");
  opusHead[8] = 1;
  opusHead[9] = options.channels ?? 1;
  opusHead.writeUInt16LE(preSkip, 10);
  opusHead.writeUInt32LE(48_000, 12);
  return Buffer.concat([
    page(0x02, 0n, opusHead),
    page(0x04, BigInt(samples + preSkip), Buffer.alloc(options.bytes ?? 600, 9)),
  ]);
}

/** The stand-in for ffmpeg: writes what a good (or chosen) copy looks like. */
function convertsTo(options: Parameters<typeof fakeOgg>[0] = {}) {
  return async (_in: string, out: string) => {
    await writeFile(out, fakeOgg(options));
  };
}

// ------------------------------------------------------------------- harness

type Actor = { id: string; clerk_id: string };

let http: Server;
let baseUrl: string;
let alice: Actor; // owns the server, starts the songs
let bob: Actor; // a member
let eve: Actor; // not a member: the in-app public view
let serverId: string;
let jamId: string;

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(as ? { Authorization: "Bearer test" } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function upload(as: Actor, song: string, contentType: string, bytes: Buffer): Promise<string> {
  const ticket = await call(as, "POST", `/api/jam-songs/${song}/uploads`, {
    kind: "audio",
    contentType,
    byteSize: bytes.length,
  });
  expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
  const parsed = jamUploadTicketSchema.parse(ticket.body);
  const put = await fetch(parsed.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBe(200);
  return parsed.uploadId;
}

/** A track on `song`: a FLAC stem unless said otherwise. */
async function addTrack(
  as: Actor,
  song: string,
  options: { instrument?: string; contentType?: string; bytes?: Buffer; extra?: Record<string, unknown> } = {},
): Promise<JamTrack> {
  const audioUploadId = await upload(
    as,
    song,
    options.contentType ?? "audio/flac",
    options.bytes ?? fakeFlac(),
  );
  const reply = await call<{ track: JamTrack }>(as, "POST", `/api/jam-songs/${song}/tracks`, {
    instrument: options.instrument ?? "guitar",
    audioUploadId,
    durationMs: 30_000,
    peaks: [0.1, 0.5, 0.9],
    ...options.extra,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body.track;
}

async function channelSong(as: Actor, title = "Wonderwall"): Promise<{ song: string; track: JamTrack }> {
  const created = await call<{ song: JamSongSummary }>(as, "POST", `/api/channels/${jamId}/jam-songs`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const song = created.body.song.id;
  return { song, track: await addTrack(as, song) };
}

const copyFlag = (on: boolean | null) => setGlobalFlag("jam_audio_copy", on, { kind: "dashboard" });

async function publicDetail(song: string): Promise<PublicJamSongDetail> {
  const reply = await call<PublicJamSongDetail>(null, "GET", `/api/public/jams/${song}`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return publicJamSongDetailSchema.parse(reply.body);
}

/** The raw JSON of a public read, for the keys it has and lacks. */
async function publicTracksRaw(song: string): Promise<Array<Record<string, unknown>>> {
  const reply = await call<{ tracks: Array<Record<string, unknown>> }>(null, "GET", `/api/public/jams/${song}`);
  return reply.body.tracks;
}

const jobs = async () =>
  (
    await getPool().query<{ track_id: string; status: string; attempts: number; last_error: string | null }>(
      `SELECT track_id::text AS track_id, status, attempts, last_error
         FROM speech_jobs WHERE kind = 'jam_audio_copy' ORDER BY id`,
    )
  ).rows;

const trackRow = async (id: string) =>
  (
    await getPool().query<{
      audio_listen_key: string | null;
      audio_listen_content_type: string | null;
      audio_listen_bytes: string | null;
    }>(`SELECT audio_listen_key, audio_listen_content_type, audio_listen_bytes::text AS audio_listen_bytes FROM jam_tracks WHERE id = $1`, [id])
  ).rows[0]!;

/** Claim the one due job and run it, the way a worker tick does. */
async function runOne() {
  const [job] = await claimSpeechJobs(["jam_audio_copy"], 1);
  expect(job, "a job was due").toBeDefined();
  await runJamAudioCopyJob(job!);
  return job!;
}

const copyObjects = () => [...objects.keys()].filter((key) => key.endsWith(".listen.ogg"));

describeDb("the Opus listening copy of a jam stem", () => {
  beforeAll(async () => {
    const endpoint = await startFakeS3();
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_BUCKET = BUCKET;
    process.env.S3_ACCESS_KEY_ID = "jam-audio-copy-test";
    process.env.S3_SECRET_ACCESS_KEY = "jam-audio-copy-test-secret";
    process.env.S3_FORCE_PATH_STYLE = "true";
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
    await new Promise<void>((done) => s3.close(() => done()));
    for (const name of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE"]) {
      delete process.env[name];
    }
    setJamAudioCopyConverterForTests(null);
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    resetJamAudioCopyJobMetricsForTests();
    resetAdminMetricsCache();
    process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "0";
    delete process.env.JAM_AUDIO_COPY_BACKFILL_PER_MINUTE;
    await resetSharedRateLimit("jam-song");
    await resetSharedRateLimit("jam-upload");
    objects.clear();
    storage.failPuts = false;
    storage.failDeletes = false;
    storage.afterCopyPut = null;
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members, server_bans,
                channel_members, channel_reads, channel_overwrites, roles,
                member_roles, audit_log, member_timeouts, feature_flags,
                feature_flag_overrides, feature_flag_audit, speech_jobs
       RESTART IDENTITY CASCADE`,
    );
    const make = async (name: string) =>
      (await upsertUser({ clerkId: `clerk_jac_${name}`, displayName: name, avatarUrl: null })) as Actor;
    alice = await make("Alice");
    bob = await make("Bob");
    eve = await make("Eve");
    serverId = (await createPqpServer("Banda", alice.id)).server.id;
    await getPool().query(`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`, [
      serverId,
      bob.id,
    ]);
    await startFeatureFlags();
    await setServerFlagOverride("jam_channels", serverId, true, { kind: "dashboard" });
    await setGlobalFlag("jam_public", true, { kind: "dashboard" });
    const channel = await call<{ channel: { id: string } }>(alice, "POST", `/api/servers/${serverId}/channels`, {
      name: "jam",
      type: "jam",
    });
    expect(channel.status).toBe(201);
    jamId = channel.body.channel.id;
    setJamAudioCopyConverterForTests(convertsTo());
  });

  afterEach(() => {
    setJamAudioCopyConverterForTests(null);
  });

  // ------------------------------------------------------------- flag OFF

  describe("with the flag off (the default)", () => {
    it("queues nothing for a new track, backfills nothing, and the kind is not claimable", async () => {
      await channelSong(alice);
      await addTrack(bob, (await channelSong(alice, "Outra")).song, { instrument: "bass" });
      expect(await jobs()).toEqual([]);
      expect(await enqueueMissingJamAudioCopies()).toBe(0);
      expect(await jobs()).toEqual([]);
      expect(await runnableSpeechJobKinds()).not.toContain("jam_audio_copy");
      // Even a hand-made job is not claimed by a tick: the rows wait, untouched.
      const [{ id }] = (await getPool().query<{ id: string }>(`SELECT id::text FROM jam_tracks LIMIT 1`)).rows as [{ id: string }];
      await getPool().query(`INSERT INTO speech_jobs (kind, track_id) VALUES ('jam_audio_copy', $1)`, [id]);
      await runSpeechJobsTick();
      await waitForJamAudioCopyJobForTests();
      expect(await jobs()).toMatchObject([{ status: "queued", attempts: 0 }]);
      expect(jamAudioCopyJobMetrics()).toMatchObject({ made: 0, failed: 0 });
    });

    it("never offers a copy that exists: no audioSources key anywhere, public or in the app", async () => {
      const { song, track } = await channelSong(alice);
      await call(alice, "PUT", `/api/jam-songs/${song}/public`, {});
      // A confirmed copy sits on the row (made while the flag was on, say).
      await getPool().query(
        `UPDATE jam_tracks SET audio_listen_key = audio_key || '.listen.ogg', audio_listen_content_type = 'audio/ogg',
                               audio_listen_bytes = 100 WHERE id = $1`,
        [track.id],
      );
      const tracks = await publicTracksRaw(song);
      expect(tracks).toHaveLength(1);
      expect(Object.keys(tracks[0]!)).not.toContain("audioSources");
      const inApp = await call<{ tracks: Array<Record<string, unknown>> }>(eve, "GET", `/api/jam-songs/${song}`);
      expect(inApp.status).toBe(200);
      expect(Object.keys(inApp.body.tracks[0]!)).not.toContain("audioSources");
    });

    it("the backfill's rest period does not outlive the flag: a track recorded while it was off is found the moment it is on", async () => {
      await copyFlag(true);
      expect(await enqueueMissingJamAudioCopies()).toBe(0); // nothing to do: the pass rests for half an hour
      await copyFlag(false);
      await channelSong(alice); // no job: the flag is off
      expect(await enqueueMissingJamAudioCopies()).toBe(0); // clears the rest
      await copyFlag(true);
      expect(await enqueueMissingJamAudioCopies()).toBe(1);
    });
  });

  // -------------------------------------------------------------- flag ON

  describe("with the flag on", () => {
    beforeEach(async () => {
      await copyFlag(true);
    });

    it("queues one copy with a FLAC stem and none with a lossy one, and a retry is the same job", async () => {
      const { song, track } = await channelSong(alice);
      await addTrack(bob, song, { instrument: "bass", contentType: "audio/webm", bytes: Buffer.from("webm-ish") });
      expect(await jobs()).toEqual([{ track_id: track.id, status: "queued", attempts: 0, last_error: null }]);
      // Enqueueing again is a no-op, and says so.
      expect(await enqueueJamAudioCopy(getPool(), track.id, "audio/flac")).toBe(false);
      expect(await enqueueJamAudioCopy(getPool(), track.id, "audio/mp4")).toBe(false);
      expect(await jobs()).toHaveLength(1);
    });

    it("makes the copy: reserved, uploaded, confirmed; offered first to listeners, never to the channel", async () => {
      const { song, track } = await channelSong(alice);
      await call(alice, "PUT", `/api/jam-songs/${song}/public`, {});
      // Before: the original alone, no key in the read.
      expect(Object.keys((await publicTracksRaw(song))[0]!)).not.toContain("audioSources");

      const job = await runOne();
      const row = await trackRow(track.id);
      expect(row.audio_listen_key).toBe(listenKeyFor((await getPool().query(`SELECT audio_key FROM jam_tracks WHERE id = $1`, [track.id])).rows[0].audio_key));
      expect(row.audio_listen_key).toMatch(/^jam\/.+\.listen\.ogg$/);
      expect(row.audio_listen_content_type).toBe("audio/ogg");
      const bytes = Number(row.audio_listen_bytes);
      expect(bytes).toBe(fakeOgg().length);
      // In the bucket, with the type, under the same prefix as the original.
      expect(objects.get(row.audio_listen_key!)).toMatchObject({ type: "audio/ogg", body: fakeOgg() });
      expect(row.audio_listen_key!.startsWith(`jam/${serverId}/`)).toBe(true);
      expect(await jobs()).toEqual([{ track_id: track.id, status: "done", attempts: 1, last_error: null }]);
      expect(job.attempts).toBe(1);
      expect(jamAudioCopyJobMetrics()).toMatchObject({ made: 1, failed: 0, lengthMismatch: 0 });

      // The public read: copy first, original last, the original still `audioUrl`.
      const detail = await publicDetail(song);
      const pub = detail.tracks[0]!;
      expect(pub.audioSources).toHaveLength(2);
      for (const source of pub.audioSources!) jamAudioSourceSchema.strict().parse(source);
      expect(pub.audioSources![0]).toMatchObject({ contentType: "audio/ogg", codec: "opus", bytes });
      expect(pub.audioSources![0]!.url).toContain(".listen.ogg");
      expect(pub.audioSources![1]).toMatchObject({ contentType: "audio/flac", bytes: fakeFlac().length });
      expect(pub.audioSources![1]!.url).toBe(pub.audioUrl);
      expect(pub.audioContentType).toBe("audio/flac");

      // The in-app public view (a stranger, no membership): the same list.
      const inApp = jamSongDetailResponseSchema.parse(
        (await call(eve, "GET", `/api/jam-songs/${song}`)).body,
      );
      expect(inApp.tracks[0]!.audioSources).toHaveLength(2);
      expect(inApp.tracks[0]!.audioSources![0]).toMatchObject({ contentType: "audio/ogg", codec: "opus" });
      expect(inApp.tracks[0]!.audioUrl).toBe(inApp.tracks[0]!.audioSources![1]!.url);

      // A member of the channel reads the whole song, and the studio's backing stays the FLAC alone.
      const member = jamSongDetailResponseSchema.parse((await call(bob, "GET", `/api/jam-songs/${song}`)).body);
      expect(member.tracks[0]!.audioSources).toBeUndefined();
      expect(member.tracks[0]!.audioContentType).toBe("audio/flac");

      // The operator's read, from the database.
      expect(await jamAudioCopyMetrics()).toMatchObject({
        enabled: true,
        tracks: 1,
        withCopy: 1,
        failed: 0,
        waiting: 0,
        bytes: { original: fakeFlac().length, copy: bytes },
        jobs24h: { made: 1, skipped: 0, failed: 0 },
      });
      expect((await getAdminMetrics()).jamAudioCopy).toMatchObject({ withCopy: 1 });
    });

    it("turning the flag off takes the copy out of the very next read, and on brings it back, nothing made twice", async () => {
      const { song } = await channelSong(alice);
      await call(alice, "PUT", `/api/jam-songs/${song}/public`, {});
      await runOne();
      expect((await publicTracksRaw(song))[0]).toHaveProperty("audioSources");
      await copyFlag(false);
      expect(Object.keys((await publicTracksRaw(song))[0]!)).not.toContain("audioSources");
      await copyFlag(true);
      expect((await publicTracksRaw(song))[0]).toHaveProperty("audioSources");
      expect(await enqueueMissingJamAudioCopies()).toBe(0);
      expect(copyObjects()).toHaveLength(1);
    });

    it("a half-made copy is never offered: the key is on the row before the type is, and the sweep reads it", async () => {
      const { song, track } = await channelSong(alice);
      await call(alice, "PUT", `/api/jam-songs/${song}/public`, {});
      storage.failPuts = true;
      await runOne();
      storage.failPuts = false;
      const reserved = await trackRow(track.id);
      expect(reserved.audio_listen_key).toMatch(/\.listen\.ogg$/);
      expect(reserved.audio_listen_content_type).toBeNull();
      expect(Object.keys((await publicTracksRaw(song))[0]!)).not.toContain("audioSources");
      // Back in the queue with a backoff, one attempt spent, the reason kept.
      expect(await jobs()).toMatchObject([{ status: "queued", attempts: 1 }]);
      expect(jamAudioCopyJobMetrics()).toMatchObject({ retried: 1, failed: 0 });
      // Every delete that reads keys reads it, so a half-made object is never leaked.
      expect(await jamKeysForServer(serverId)).toContain(reserved.audio_listen_key);
      expect(await jamKeysForUser(alice.id)).toContain(reserved.audio_listen_key);
    });

    it("gives up after three attempts: counted, logged, the reservation dropped, the stem plays from its FLAC", async () => {
      const { song, track } = await channelSong(alice);
      await call(alice, "PUT", `/api/jam-songs/${song}/public`, {});
      storage.failPuts = true;
      await getPool().query(`UPDATE speech_jobs SET attempts = 2`);
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      let logs = "";
      try {
        await runOne();
        logs = spy.mock.calls.map((call) => String(call[0])).join("\n");
      } finally {
        spy.mockRestore();
      }
      expect(logs).toMatch(/jamAudioCopy\.failed trackId=\S+ attempt=3 next=gave-up/);
      expect(await jobs()).toMatchObject([{ status: "failed", attempts: 3 }]);
      expect(jamAudioCopyJobMetrics()).toMatchObject({ failed: 1 });
      expect(await trackRow(track.id)).toEqual({
        audio_listen_key: null,
        audio_listen_content_type: null,
        audio_listen_bytes: null,
      });
      expect(copyObjects()).toEqual([]);
      expect(Object.keys((await publicTracksRaw(song))[0]!)).not.toContain("audioSources");
      // The operator sees it, and the number that belongs at zero is not.
      expect(await jamAudioCopyMetrics()).toMatchObject({ tracks: 1, withCopy: 0, failed: 1, waiting: 0 });
      // The backfill does not queue it again behind the operator's back.
      expect(await enqueueMissingJamAudioCopies()).toBe(0);
    });

    it("a copy whose length is not the original's is not offered: the delay was not compensated", async () => {
      const { song, track } = await channelSong(alice);
      await call(alice, "PUT", `/api/jam-songs/${song}/public`, {});
      // 312 samples too long: an encoder whose look-ahead nobody declared.
      setJamAudioCopyConverterForTests(convertsTo({ samples: 1_440_312 }));
      await getPool().query(`UPDATE speech_jobs SET attempts = 2`);
      await runOne();
      expect(jamAudioCopyJobMetrics()).toMatchObject({ failed: 1, lengthMismatch: 1, made: 0 });
      expect(await jobs()).toMatchObject([{ status: "failed", last_error: expect.stringMatching(/length-mismatch length 1440312/) }]);
      expect((await trackRow(track.id)).audio_listen_key).toBeNull();
      expect(copyObjects()).toEqual([]);
      expect(Object.keys((await publicTracksRaw(song))[0]!)).not.toContain("audioSources");
    });

    it("refuses bytes that are not a FLAC, a copy that is not smaller, and a lossy original, each settled and visible", async () => {
      const { track } = await channelSong(alice);
      // Not a FLAC: the first bytes say so before ffmpeg is asked.
      const key = (await getPool().query(`SELECT audio_key FROM jam_tracks WHERE id = $1`, [track.id])).rows[0].audio_key;
      objects.set(key, { type: "audio/flac", body: Buffer.from("this is not a flac, it is long enough to read 42 bytes") });
      await getPool().query(`UPDATE speech_jobs SET attempts = 2`);
      await runOne();
      expect(await jobs()).toMatchObject([{ status: "failed", last_error: "not-flac" }]);

      // A copy as big as the original is no copy.
      await getPool().query(`DELETE FROM speech_jobs`);
      objects.set(key, { type: "audio/flac", body: fakeFlac(1_440_000, { padding: 100 }) });
      await enqueueJamAudioCopy(getPool(), track.id, "audio/flac");
      await runOne();
      expect(await jobs()).toMatchObject([{ status: "done", last_error: "not-smaller" }]);
      expect(copyObjects()).toEqual([]);
      expect(await jamAudioCopyMetrics()).toMatchObject({ skipped: 1, failed: 0, waiting: 0 });

      // A lossy original, if one is queued by hand, is skipped and not converted.
      await getPool().query(`DELETE FROM speech_jobs`);
      await getPool().query(`UPDATE jam_tracks SET audio_content_type = 'audio/webm' WHERE id = $1`, [track.id]);
      await getPool().query(`INSERT INTO speech_jobs (kind, track_id) VALUES ('jam_audio_copy', $1)`, [track.id]);
      await runOne();
      expect(await jobs()).toMatchObject([{ status: "done", last_error: "not-lossless" }]);
    });

    it("a track deleted while its copy encodes: the object just uploaded is deleted, nothing is confirmed", async () => {
      const { track } = await channelSong(alice);
      setJamAudioCopyConverterForTests(async (_in, out) => {
        await writeFile(out, fakeOgg());
        // The author removes the take while ffmpeg runs.
        await getPool().query(`UPDATE jam_tracks SET deleted_at = NOW() WHERE id = $1`, [track.id]);
      });
      await runOne();
      expect(copyObjects()).toEqual([]);
      expect((await trackRow(track.id)).audio_listen_content_type).toBeNull();
      expect(await jobs()).toMatchObject([{ status: "done", last_error: "gone" }]);
    });

    it("a track deleted after the upload and before the confirm still leaves no object behind", async () => {
      const { track } = await channelSong(alice);
      // The delete lands between the PUT and the confirm: the object store runs it as it
      // answers the copy's PUT, so the confirm transaction is the first to see it.
      storage.afterCopyPut = async () => {
        await getPool().query(`UPDATE jam_tracks SET deleted_at = NOW() WHERE id = $1`, [track.id]);
      };
      await runOne();
      expect(copyObjects()).toEqual([]);
      expect((await trackRow(track.id)).audio_listen_content_type).toBeNull();
    });

    it("a queued job for a track that is gone is cancelled by the next pass, and a claimed one stops at once", async () => {
      const { track } = await channelSong(alice);
      await getPool().query(`UPDATE jam_tracks SET deleted_at = NOW() WHERE id = $1`, [track.id]);
      expect(await jobs()).toHaveLength(1);
      await enqueueMissingJamAudioCopies();
      expect(await jobs()).toEqual([]);

      const second = await channelSong(alice, "Outra");
      await getPool().query(`UPDATE jam_tracks SET deleted_at = NOW() WHERE id = $1`, [second.track.id]);
      await runOne();
      expect(await jobs()).toMatchObject([{ status: "done", last_error: "gone" }]);
      expect(jamAudioCopyJobMetrics()).toMatchObject({ skippedGone: 1, made: 0 });
      expect(copyObjects()).toEqual([]);
    });

    it("the purge sweep and the cascades take the copy with its track", async () => {
      const { track } = await channelSong(alice);
      await runOne();
      const row = await trackRow(track.id);
      expect(objects.has(row.audio_listen_key!)).toBe(true);
      expect(await jamKeysForServer(serverId)).toContain(row.audio_listen_key);
      expect(await jamKeysForUser(alice.id)).toContain(row.audio_listen_key);
      // Deleted a day ago: the sweep removes the recording, and the copy with it.
      await getPool().query(`UPDATE jam_tracks SET deleted_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [track.id]);
      await sweepJamMedia();
      expect(objects.has(row.audio_listen_key!)).toBe(false);
      expect(copyObjects()).toEqual([]);
      expect((await getPool().query(`SELECT media_purged_at FROM jam_tracks WHERE id = $1`, [track.id])).rows[0].media_purged_at).not.toBeNull();
    });

    it("the flag going off between the claim and the run drops the job and makes nothing", async () => {
      const { track } = await channelSong(alice);
      const [job] = await claimSpeechJobs(["jam_audio_copy"], 1);
      await copyFlag(false);
      await runJamAudioCopyJob(job!);
      expect(await jobs()).toEqual([]);
      expect(jamAudioCopyJobMetrics()).toMatchObject({ droppedFlagOff: 1, made: 0 });
      expect((await trackRow(track.id)).audio_listen_key).toBeNull();
      // On again: the backfill finds it and the copy is made, once.
      await copyFlag(true);
      expect(await enqueueMissingJamAudioCopies()).toBe(1);
      await runOne();
      expect(copyObjects()).toHaveLength(1);
    });

    it("two workers racing for one job: one claims it, one confirms, one object", async () => {
      await channelSong(alice);
      const [a, b] = await Promise.all([
        claimSpeechJobs(["jam_audio_copy"], 1, "worker-a"),
        claimSpeechJobs(["jam_audio_copy"], 1, "worker-b"),
      ]);
      expect(a.length + b.length).toBe(1);
      // Its lease is the job's own: another owner cannot settle it.
      const claimed = (a[0] ?? b[0])!;
      await runJamAudioCopyJob({ ...claimed, leased_by: "worker-c" });
      expect(jamAudioCopyJobMetrics()).toMatchObject({ lostLease: 1, made: 0 });
      expect(await jobs()).toMatchObject([{ status: "running", attempts: 1 }]);
      // The rightful owner then finishes it, and the copy exists exactly once.
      await runJamAudioCopyJob(claimed);
      expect(jamAudioCopyJobMetrics()).toMatchObject({ made: 1 });
      expect(copyObjects()).toHaveLength(1);
      expect(await jobs()).toMatchObject([{ status: "done" }]);
    });

    it("a dead worker's lease expires and the next claim makes the copy, on its second attempt", async () => {
      await channelSong(alice);
      const [first] = await claimSpeechJobs(["jam_audio_copy"], 1, "worker-dead");
      expect(first).toBeDefined();
      await getPool().query(`UPDATE speech_jobs SET lease_expires_at = NOW() - INTERVAL '1 second'`);
      await runOne();
      expect(await jobs()).toMatchObject([{ status: "done", attempts: 2 }]);
      expect(copyObjects()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------- backfill

  describe("the backfill", () => {
    async function oldTracks(count: number, publicFirst = false): Promise<string[]> {
      // Tracks recorded before the flag existed: no job, ever.
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        resetApiRateLimits();
        await resetSharedRateLimit("jam-song");
        await resetSharedRateLimit("jam-upload");
        const { track } = await channelSong(alice, `Antiga ${i}`);
        ids.push(track.id);
        // Staggered, so "newest first" has an order to follow.
        await getPool().query(`UPDATE jam_tracks SET created_at = NOW() - make_interval(mins => $2) WHERE id = $1`, [
          track.id,
          count - i,
        ]);
      }
      expect(await jobs()).toEqual([]);
      void publicFirst;
      return ids;
    }

    it("is rate limited, capped, newest first, idempotent and resumable", async () => {
      const ids = await oldTracks(14);
      await copyFlag(true);
      // 5 a pass by default, never more than ten waiting or running at once.
      expect(await enqueueMissingJamAudioCopies()).toBe(5);
      expect((await jobs()).map((job) => job.track_id)).toEqual(ids.slice(-5).reverse());
      expect(await enqueueMissingJamAudioCopies()).toBe(5);
      expect(await enqueueMissingJamAudioCopies()).toBe(0); // ten waiting: the cap
      expect(await jobs()).toHaveLength(BACKFILL_QUEUE_CAP);
      // A pass again with nothing finished adds nothing, and nothing is queued twice.
      expect(new Set((await jobs()).map((job) => job.track_id)).size).toBe(10);

      // Work two off: room appears, and only for the stems not yet queued.
      await runOne();
      await runOne();
      expect(copyObjects()).toHaveLength(2);
      expect(await enqueueMissingJamAudioCopies()).toBe(2);
      // The rest, to the end: every track has exactly one job and one copy.
      for (let i = 0; i < 20; i++) {
        const [job] = await claimSpeechJobs(["jam_audio_copy"], 1);
        if (!job) {
          if ((await enqueueMissingJamAudioCopies()) === 0) break;
          continue;
        }
        await runJamAudioCopyJob(job);
      }
      expect(await jobs()).toHaveLength(14);
      expect(copyObjects()).toHaveLength(14);
      expect((await jamAudioCopyMetrics()).waiting).toBe(0);
      // The backlog is over: a pass finds nothing and rests.
      expect(await enqueueMissingJamAudioCopies()).toBe(0);
    });

    it("the tracks of public songs go first, then the newest", async () => {
      const ids = await oldTracks(4);
      // The OLDEST track's song is public, so it jumps the queue.
      const song = (await getPool().query(`SELECT song_id FROM jam_tracks WHERE id = $1`, [ids[0]])).rows[0].song_id;
      expect((await call(alice, "PUT", `/api/jam-songs/${song}/public`, {})).status).toBe(200);
      await copyFlag(true);
      expect(await enqueueMissingJamAudioCopies(2)).toBe(2);
      expect((await jobs()).map((job) => job.track_id)).toEqual([ids[0], ids[3]]);
    });

    it("JAM_AUDIO_COPY_BACKFILL_PER_MINUTE sets the rate, and 0 pauses it while new tracks still queue", async () => {
      await oldTracks(6);
      await copyFlag(true);
      process.env.JAM_AUDIO_COPY_BACKFILL_PER_MINUTE = "0";
      expect(await enqueueMissingJamAudioCopies()).toBe(0);
      expect(await jobs()).toEqual([]);
      const fresh = await channelSong(alice, "Nova");
      expect((await jobs()).map((job) => job.track_id)).toEqual([fresh.track.id]);
      process.env.JAM_AUDIO_COPY_BACKFILL_PER_MINUTE = "2";
      expect(await enqueueMissingJamAudioCopies()).toBe(2);
      delete process.env.JAM_AUDIO_COPY_BACKFILL_PER_MINUTE;
    });

    it("does nothing at all with the flag off", async () => {
      await oldTracks(3);
      expect(await enqueueMissingJamAudioCopies()).toBe(0);
      expect(await jobs()).toEqual([]);
    });
  });

  // ------------------------------------------------- the whole path, real ffmpeg

  (ffmpegHere ? describe : describe.skip)("on real ffmpeg, through a worker tick", () => {
    it("a real FLAC stem becomes a real Ogg Opus copy by the tick, and the read offers it", async () => {
      await copyFlag(true);
      setJamAudioCopyConverterForTests(null);
      const dir = mkdtempSync(join(tmpdir(), "pqp-jam-audio-job-"));
      try {
        const raw = join(dir, "tone.flac");
        const made = spawnSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=3", "-ac", "1", "-c:a", "flac", raw,
        ]);
        expect(made.status).toBe(0);
        const flac = readFileSync(raw);
        const { song, track } = await (async () => {
          const created = await call<{ song: JamSongSummary }>(alice, "POST", `/api/channels/${jamId}/jam-songs`, { title: "Real" });
          const id = created.body.song.id;
          return { song: id, track: await addTrack(alice, id, { bytes: flac, extra: { durationMs: 3_000 } }) };
        })();
        await call(alice, "PUT", `/api/jam-songs/${song}/public`, {});
        expect(await runnableSpeechJobKinds()).toContain("jam_audio_copy");
        expect(await runSpeechJobsTick()).toBeGreaterThanOrEqual(1);
        await waitForJamAudioCopyJobForTests();
        expect(await jobs()).toMatchObject([{ track_id: track.id, status: "done", last_error: null }]);
        const row = await trackRow(track.id);
        const copy = objects.get(row.audio_listen_key!)!;
        expect(copy.body.subarray(0, 4).toString("latin1")).toBe("OggS");
        expect(copy.body.length).toBeLessThan(flac.length);
        expect((await publicDetail(song)).tracks[0]!.audioSources![0]).toMatchObject({ contentType: "audio/ogg", codec: "opus" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

