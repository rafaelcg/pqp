import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SttOptions, SttProvider, Translator } from "../speech/types.js";

/**
 * Baú video subtitles, on a real Postgres. Storage is an in-memory stand-in
 * that can hand a video to the worker as a file; the speech provider and the
 * translator are fakes (no network, no key); ffmpeg is replaced by a fake that
 * writes N seconds of silence, except in the one test that runs the real
 * thing when this machine has it. What is pinned:
 *
 *   * OFF MEANS OFF, set the way production sets it (rows after
 *     `startFeatureFlags`, never the environment): no job, no provider call,
 *     and stored subtitles are hidden too.
 *   * The pipeline: publish -> job -> windows -> one source track with the
 *     detected language -> translations of the WORDS only, every timing kept
 *     -> the feed says which tracks exist -> the route serves WebVTT.
 *   * The same lock as the video: a members-only post a viewer cannot open has
 *     no subtitles for them.
 *   * The flag is asked again before the provider; the budget is reserved and
 *     refused; a replaced video forgets its subtitles; the sweep is the
 *     backfill.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;
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

const storage = vi.hoisted(() => ({
  objects: new Map<string, { bytes: Buffer; contentType: string; file?: string }>(),
  downloads: [] as string[],
}));

vi.mock("../lib/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/s3.js")>()),
  isStorageConfigured: () => true,
  presignPut: (key: string) => `http://storage.test/${key}?put`,
  presignGet: (key: string) => `http://storage.test/${key}?get`,
  headObject: async (key: string) => {
    const object = storage.objects.get(key);
    return object ? { contentLength: object.bytes.length, contentType: object.contentType } : null;
  },
  getObjectPrefix: async (key: string, length: number) =>
    storage.objects.get(key)?.bytes.subarray(0, length) ?? null,
  deleteObject: async (key: string) => {
    storage.objects.delete(key);
  },
  downloadObjectToFile: async (key: string, path: string) => {
    storage.downloads.push(key);
    const object = storage.objects.get(key);
    if (!object) return null;
    if (object.file) await copyFile(object.file, path);
    else await writeFile(path, object.bytes);
    return { bytes: object.bytes.length };
  },
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer } = await import("./servers.js");
const flags = await import("../lib/flags.js");
const tr = await import("./community-home-translation.js");
const captions = await import("./community-home-captions.js");
const worker = await import("./community-home-captions-worker.js");
const { claimSpeechJobs } = await import("./speech-jobs.js");
const { runSpeechJobsTick, waitForCaptionsJobForTests } = await import("./speech-worker.js");
const { setSttProviderForTests } = await import("../speech/select.js");
const { isFfmpegAvailable } = await import("../speech/transcode.js");

const ffmpeg = await isFfmpegAvailable();

let httpServer: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : {}) as T };
}

interface PostBody {
  id: string;
  locked: boolean;
  media: { kind: string } | null;
  captions: { sourceLang: string; langs: string[]; durationMs: number | null } | null;
}

interface Track {
  lang: string;
  source: boolean;
  auto: boolean;
  vtt: string;
}

/** A provider that says "frase <n>" a second into every window it is sent, in Portuguese. */
function fakeProvider() {
  const calls: SttOptions[] = [];
  const provider: SttProvider = {
    id: "fake/whisper",
    async transcribe(_audio, opts) {
      calls.push({ ...opts, signal: undefined });
      const n = calls.length - 1;
      return {
        text: `frase ${n}`,
        segments: [{ start: 1, end: 4, text: `frase ${n}`, noSpeechProb: 0.01 }],
        language: "pt",
        durationMs: opts.durationMs ?? 0,
      };
    },
  };
  return { provider, calls };
}

function fakeTranslator() {
  const calls: Array<{ texts: string[]; from: string; to: string }> = [];
  const translator: Translator = {
    id: "fake/translator",
    async translate(texts, from, to) {
      calls.push({ texts: [...texts], from, to });
      return { texts: texts.map((t) => `[${to}] ${t}`), costUsd: 0.0001 };
    },
  };
  return { translator, calls };
}

describeDb("Baú video subtitles", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let serverId: string;
  let stt: ReturnType<typeof fakeProvider>;
  let translate: ReturnType<typeof fakeTranslator>;
  /** Seconds of sound the fake ffmpeg "finds" in the next video. */
  let audioSeconds: number;

  beforeAll(async () => {
    await initDb();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    setSttProviderForTests(undefined);
    worker.setCaptionsAudioExtractorForTests(null);
    tr.setCommunityHomeTranslatorForTests(null);
    flags.resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    storage.objects.clear();
    storage.downloads.length = 0;
    resetApiRateLimits();
    flags.resetFeatureFlagsForTests();
    tr.resetCommunityHomeTranslationForTests();
    captions.resetCommunityHomeCaptionsForTests();
    delete process.env.VOICE_STT_DAILY_SECONDS;
    stt = fakeProvider();
    setSttProviderForTests(stt.provider);
    translate = fakeTranslator();
    tr.setCommunityHomeTranslatorForTests(translate.translator);
    audioSeconds = 65;
    worker.setCaptionsAudioExtractorForTests(async (_video, pcm) => {
      await writeFile(pcm, Buffer.alloc(audioSeconds * 32_000));
      return { durationMs: audioSeconds * 1000 };
    });
    await getPool().query(
      `TRUNCATE users, servers, speech_jobs, speech_usage_daily, community_home_translation_usage,
                feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({ clerkId: "clerk_owner", displayName: "owner", avatarUrl: null });
    member = await upsertUser({ clerkId: "clerk_member", displayName: "member", avatarUrl: null });
    serverId = (await createChatServer("QG", owner.id)).server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    await flags.startFeatureFlags();
    await flags.setGlobalFlag("community_home", true, { kind: "dashboard" });
    await flags.setGlobalFlag("community_home_vip", true, { kind: "dashboard" });
  });

  afterEach(() => {
    delete process.env.VOICE_STT_DAILY_SECONDS;
  });

  const captionsOn = (enabled: boolean | null = true) =>
    flags.setServerFlagOverride("community_home_video_captions", serverId, enabled, { kind: "dashboard" });
  const translationOn = (enabled: boolean | null = true) =>
    flags.setServerFlagOverride("community_home_translation", serverId, enabled, { kind: "dashboard" });

  /** Mint, "upload" and claim a video, then publish it the way the composer does. */
  async function publishVideo(extra: Record<string, unknown> = {}, bytes = Buffer.from("not really an mp4")) {
    const minted = await call<{ uploadId: string; key: string }>(owner, "POST", `/api/servers/${serverId}/home/media`, {
      contentType: "video/mp4",
      byteSize: bytes.length,
      filename: "lancamento.mp4",
    });
    expect(minted.status).toBe(201);
    storage.objects.set(minted.body.key, { bytes, contentType: "video/mp4" });
    const claimed = await call(owner, "POST", `/api/servers/${serverId}/home/media/claim`, {
      uploadId: minted.body.uploadId,
    });
    expect(claimed.status).toBe(200);
    const res = await call<{ post: PostBody }>(owner, "POST", `/api/servers/${serverId}/home/posts`, {
      status: "published",
      title: "Lançamento",
      body: "",
      mediaUploadId: minted.body.uploadId,
      ...extra,
    });
    expect(res.status).toBe(201);
    return { post: res.body.post, key: minted.body.key };
  }

  async function jobs(postId: string) {
    const { rows } = await getPool().query<{ status: string; last_error: string | null; attempts: number }>(
      `SELECT status, last_error, attempts FROM speech_jobs WHERE kind = 'community_home_captions' AND post_id = $1`,
      [postId],
    );
    return rows;
  }

  async function tracks(postId: string) {
    const { rows } = await getPool().query<{ lang: string; is_source: boolean; cues: Array<{ start: number; end: number; text: string }> }>(
      `SELECT lang, is_source, cues FROM community_home_post_captions WHERE post_id = $1 ORDER BY is_source DESC, lang`,
      [postId],
    );
    return rows;
  }

  /** What the worker would do on its next tick, without needing ffmpeg on this machine. */
  async function runCaptionJob() {
    const [job] = await claimSpeechJobs(["community_home_captions"], 1);
    expect(job, "a captions job is due").toBeTruthy();
    await worker.runCommunityHomeCaptionsJob(job!);
    await captions.waitForCaptionTranslationsForTests();
  }

  async function feedPost(as: typeof owner, lang?: string) {
    const res = await call<{ posts: PostBody[] }>(as, "GET", `/api/servers/${serverId}/home/posts${lang ? `?lang=${lang}` : ""}`);
    expect(res.status).toBe(200);
    return res.body.posts[0]!;
  }

  async function captionTracks(as: typeof owner, postId: string, lang?: string) {
    return call<{ tracks: Track[] }>(
      as,
      "GET",
      `/api/servers/${serverId}/home/posts/${postId}/captions${lang ? `?lang=${lang}` : ""}`,
    );
  }

  // ------------------------------------------------------------- off means off

  it("flag off: a video publish queues nothing, the sweep queues nothing, the route answers no tracks", async () => {
    const { post } = await publishVideo();
    await captions.scheduleCommunityHomeCaptions(post.id, serverId);
    await captions.sweepCommunityHomeCaptions();
    expect(await jobs(post.id)).toEqual([]);
    expect(stt.calls).toHaveLength(0);
    expect((await feedPost(member, "en")).captions).toBeNull();
    const res = await captionTracks(member, post.id, "en");
    expect(res.status).toBe(200);
    expect(res.body.tracks).toEqual([]);
  });

  // -------------------------------------------------------------- the pipeline

  it("publish -> one source track in the language heard -> translations with the same timings -> WebVTT", async () => {
    await captionsOn();
    await translationOn();
    const { post, key } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));

    await runCaptionJob();
    expect(storage.downloads).toEqual([key]);

    // 65 s in 30 s windows with 1 s of overlap: three calls, the language held
    // after the first window that had words.
    expect(stt.calls.map((c) => [c.format, c.durationMs, c.language])).toEqual([
      ["wav", 30_000, undefined],
      ["wav", 30_000, "pt"],
      ["wav", 7_000, "pt"],
    ]);
    // Charged for every second sent, overlaps included.
    const usage = await getPool().query<{ seconds: number; calls: number }>(`SELECT seconds, calls FROM speech_usage_daily`);
    expect(usage.rows[0]).toEqual({ seconds: 67, calls: 1 });
    expect(await jobs(post.id)).toEqual([{ status: "done", last_error: null, attempts: 1 }]);

    const stored = await tracks(post.id);
    expect(stored.map((t) => [t.lang, t.is_source])).toEqual([
      ["pt", true],
      ["en", false],
      ["es", false],
    ]);
    const source = stored[0]!.cues;
    expect(source.map((c) => c.text)).toEqual(["frase 0", "frase 1", "frase 2"]);
    for (const translated of stored.slice(1)) {
      // The words change, the timings do not.
      expect(translated.cues.map((c) => [c.start, c.end])).toEqual(source.map((c) => [c.start, c.end]));
    }
    expect(stored[1]!.cues[0]!.text).toBe("[en] frase 0");
    // Only cue text went to the translator, never a timestamp.
    const captionCalls = translate.calls.filter((c) => c.texts.includes("frase 0"));
    expect(captionCalls.map((c) => [c.from, c.to])).toEqual([
      ["pt", "en"],
      ["pt", "es"],
    ]);

    expect((await feedPost(member, "en")).captions).toEqual({ sourceLang: "pt", langs: ["pt", "en"], durationMs: 65_000 });
    expect((await feedPost(member, "pt")).captions).toEqual({ sourceLang: "pt", langs: ["pt"], durationMs: 65_000 });

    const en = await captionTracks(member, post.id, "en");
    expect(en.status).toBe(200);
    expect(en.body.tracks.map((t) => [t.lang, t.source, t.auto])).toEqual([
      ["pt", true, true],
      ["en", false, true],
    ]);
    expect(en.body.tracks[1]!.vtt).toContain("WEBVTT");
    expect(en.body.tracks[1]!.vtt).toContain("00:00:01.000 --> 00:00:04.000\n[en] frase 0");
    expect(en.body.tracks[0]!.vtt).toContain("00:00:30.000 --> 00:00:33.000\nfrase 1");
    const pt = await captionTracks(member, post.id, "pt");
    expect(pt.body.tracks.map((t) => t.lang)).toEqual(["pt"]);
  });

  it("translations off: the source track only, and the translator is never asked", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    expect((await tracks(post.id)).map((t) => t.lang)).toEqual(["pt"]);
    expect(translate.calls.filter((c) => c.texts.includes("frase 0"))).toEqual([]);
    const en = await captionTracks(member, post.id, "en");
    expect(en.body.tracks.map((t) => t.lang)).toEqual(["pt"]);
    expect((await feedPost(member, "en")).captions).toEqual({ sourceLang: "pt", langs: ["pt"], durationMs: 65_000 });
  });

  it("a members-only video the viewer cannot open has no subtitles for them", async () => {
    await captionsOn();
    await translationOn();
    const { post } = await publishVideo({ visibility: "members", teaser: "Só pra VIP" });
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    expect((await tracks(post.id)).length).toBe(3);

    const seen = await feedPost(member, "en");
    expect(seen.locked).toBe(true);
    expect(seen.captions).toBeNull();
    const res = await captionTracks(member, post.id, "en");
    expect(res.body.tracks).toEqual([]);
    // Staff can play it, so staff get them.
    expect((await captionTracks(owner, post.id, "en")).body.tracks.length).toBe(2);
  });

  it("turning the flag off hides stored subtitles at once", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    expect((await captionTracks(member, post.id)).body.tracks).toHaveLength(1);
    await captionsOn(false);
    expect((await captionTracks(member, post.id)).body.tracks).toEqual([]);
    expect((await feedPost(member)).captions).toBeNull();
  });

  // ---------------------------------------------------------- the guard rails

  it("the flag is asked again before the provider: off mid-queue drops the job with no call", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await captionsOn(false);
    const [job] = await claimSpeechJobs(["community_home_captions"], 1);
    await worker.runCommunityHomeCaptionsJob(job!);
    expect(stt.calls).toHaveLength(0);
    expect(storage.downloads).toEqual([]);
    // Deleted rather than settled, so the sweep queues it again when the flag returns.
    expect(await jobs(post.id)).toEqual([]);
    await captionsOn(true);
    await captions.sweepCommunityHomeCaptions();
    expect(await jobs(post.id)).toEqual([{ status: "queued", last_error: null, attempts: 0 }]);
  });

  it("a video longer than the day's budget is refused before any call, and offered again later", async () => {
    await captionsOn();
    // Room for a minute, so the cheap check before the download passes; the
    // video needs 67 s, so the reservation itself is refused.
    process.env.VOICE_STT_DAILY_SECONDS = "61";
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    expect(stt.calls).toHaveLength(0);
    expect(await jobs(post.id)).toEqual([{ status: "done", last_error: "over-budget", attempts: 1 }]);
    const refused = await getPool().query<{ refused: number }>(`SELECT refused FROM speech_usage_daily`);
    expect(refused.rows[0]!.refused).toBe(1);

    // Not again within the hour...
    await captions.sweepCommunityHomeCaptions();
    expect((await jobs(post.id))[0]!.status).toBe("done");
    // ...but after it.
    await getPool().query(`UPDATE speech_jobs SET finished_at = NOW() - interval '2 hours'`);
    await captions.sweepCommunityHomeCaptions();
    expect(await jobs(post.id)).toEqual([{ status: "queued", last_error: null, attempts: 0 }]);
  });

  it("less than a minute of budget left: not even a download", async () => {
    await captionsOn();
    process.env.VOICE_STT_DAILY_SECONDS = "30";
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    expect(storage.downloads).toEqual([]);
    expect(stt.calls).toHaveLength(0);
    expect(await jobs(post.id)).toEqual([{ status: "done", last_error: "over-budget", attempts: 1 }]);
  });

  it("no provider configured: no download, settled as unavailable", async () => {
    await captionsOn();
    setSttProviderForTests(null);
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    expect(storage.downloads).toEqual([]);
    expect(await jobs(post.id)).toEqual([{ status: "done", last_error: "no-provider", attempts: 1 }]);
  });

  it("silence: no track, settled as no speech", async () => {
    await captionsOn();
    stt.provider.transcribe = async (_audio, opts) => ({
      text: "",
      segments: [{ start: 0, end: 30, text: "Legendas pela comunidade Amara.org", noSpeechProb: 0.2 }],
      language: "pt",
      durationMs: opts.durationMs ?? 0,
    });
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    expect(await tracks(post.id)).toEqual([]);
    expect(await jobs(post.id)).toEqual([{ status: "done", last_error: "no-speech", attempts: 1 }]);
    expect((await feedPost(member)).captions).toBeNull();
  });

  it("replacing the video forgets its subtitles and its job", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    expect(await tracks(post.id)).toHaveLength(1);
    const edited = await call(owner, "PATCH", `/api/servers/${serverId}/home/posts/${post.id}`, {
      clearMedia: true,
      body: "Agora sem vídeo",
    });
    expect(edited.status).toBe(200);
    expect(await tracks(post.id)).toEqual([]);
    expect(await jobs(post.id)).toEqual([]);
  });

  it("the sweep is the backfill: videos published before the flag get a job, newest first, once", async () => {
    const first = await publishVideo();
    const second = await publishVideo();
    expect(await jobs(first.post.id)).toEqual([]);
    await captionsOn();
    const swept = await captions.sweepCommunityHomeCaptions();
    expect(swept.enqueued).toBe(2);
    expect(await jobs(first.post.id)).toHaveLength(1);
    expect(await jobs(second.post.id)).toHaveLength(1);
    expect((await captions.sweepCommunityHomeCaptions()).enqueued).toBe(0);
  });

  it("the sweep translates a source track that is missing its translations", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    expect((await tracks(post.id)).map((t) => t.lang)).toEqual(["pt"]);
    await translationOn();
    const swept = await captions.sweepCommunityHomeCaptions();
    expect(swept.translated).toBe(2);
    expect((await tracks(post.id)).map((t) => t.lang)).toEqual(["pt", "en", "es"]);
  });

  it("a playlist dressed as an MP4 never reaches ffmpeg, so it cannot make the worker fetch a URL", async () => {
    worker.setCaptionsAudioExtractorForTests(null);
    let hits = 0;
    const bait = createServer((_req, res) => {
      hits += 1;
      res.end("x");
    });
    await new Promise<void>((resolve) => bait.listen(0, "127.0.0.1", resolve));
    try {
      const port = (bait.address() as AddressInfo).port;
      const playlist = Buffer.from(
        `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${port}/internal\n#EXT-X-ENDLIST\n`,
      );
      await captionsOn();
      const { post } = await publishVideo({}, playlist);
      await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
      await runCaptionJob();
      expect(hits).toBe(0);
      expect(stt.calls).toHaveLength(0);
      expect(await jobs(post.id)).toEqual([{ status: "done", last_error: "unsupported-container", attempts: 1 }]);
    } finally {
      await new Promise<void>((resolve) => bait.close(() => resolve()));
    }
  });

  it("a translation whose claim was taken over mid-way writes nothing and frees nothing of the new holder's", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    await translationOn();
    // The provider is slow; while it works, another process takes the claim.
    translate.translator.translate = async (texts, _from, to) => {
      await getPool().query(
        `UPDATE community_home_caption_translation_jobs SET claimed_by = 'someone-else' WHERE post_id = $1`,
        [post.id],
      );
      return { texts: texts.map((t) => `[${to}] ${t}`) };
    };
    expect(await captions.translateCommunityHomeCaptions(post.id, "en")).toBe("skipped:claimed");
    expect((await tracks(post.id)).map((t) => t.lang)).toEqual(["pt"]);
    const claim = await getPool().query<{ claimed_by: string }>(
      `SELECT claimed_by FROM community_home_caption_translation_jobs WHERE post_id = $1 AND lang = 'en'`,
      [post.id],
    );
    expect(claim.rows[0]?.claimed_by).toBe("someone-else");
  });

  it("a video replaced mid-job: not one more window goes to the provider", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    const real = stt.provider.transcribe;
    stt.provider.transcribe = async (audio, opts) => {
      // What the edit does in its transaction when the video changes.
      await getPool().query(`DELETE FROM speech_jobs WHERE post_id = $1`, [post.id]);
      return real(audio, opts);
    };
    await runCaptionJob();
    expect(stt.calls).toHaveLength(1);
    expect(await tracks(post.id)).toEqual([]);
  });

  it("a post unpublished mid-job: the rest is not sent and the job settles as gone", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    const real = stt.provider.transcribe;
    stt.provider.transcribe = async (audio, opts) => {
      await getPool().query(`UPDATE community_home_posts SET status = 'draft' WHERE id = $1`, [post.id]);
      return real(audio, opts);
    };
    await runCaptionJob();
    expect(stt.calls).toHaveLength(1);
    expect(await jobs(post.id)).toEqual([{ status: "done", last_error: "gone", attempts: 1 }]);
  });

  it("a database error before the work starts puts the job back with backoff", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    const pool = getPool();
    const realQuery = pool.query.bind(pool);
    let failed = false;
    const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (!failed && typeof text === "string" && text.includes("FROM community_home_posts WHERE id = $1")) {
        failed = true;
        return Promise.reject(new Error("connection reset"));
      }
      return (realQuery as (...a: unknown[]) => unknown)(text, ...rest);
    }) as never);
    try {
      await runCaptionJob();
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(true);
    expect((await jobs(post.id))[0]!.status).toBe("queued");
  });

  it("the brand reaches the model as a placeholder and comes back as the author's words", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    const cues = [
      { start: 0, end: 2, text: "que é o QG do pqp" },
      { start: 3, end: 5, text: "entre em pqp.gg, fale com @rafa" },
    ];
    await getPool().query(
      `UPDATE community_home_post_captions SET cues = $2::jsonb, source_hash = 'brand' WHERE post_id = $1 AND is_source`,
      [post.id, JSON.stringify(cues)],
    );
    await translationOn();
    const sent: string[] = [];
    translate.translator.translate = async (texts, _from, to) => {
      sent.push(...texts);
      // A model that "helpfully" translates whatever pqp it is shown.
      return { texts: texts.map((t) => `[${to}] ${t.replace(/pqp/gi, "WTF")}`) };
    };
    expect(await captions.translateCommunityHomeCaptions(post.id, "en")).toBe("done");
    expect(sent.join(" ")).not.toMatch(/pqp/i);
    const en = (await tracks(post.id)).find((t) => t.lang === "en")!;
    expect(en.cues.map((c) => c.text)).toEqual([
      "[en] que é o QG do pqp",
      "[en] entre em pqp.gg, fale com @rafa",
    ]);
  });

  it("translation turned off between two batches: the second is never sent", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    const cues = Array.from({ length: 70 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.5, text: `fala ${i}` }));
    await getPool().query(
      `UPDATE community_home_post_captions SET cues = $2::jsonb, source_hash = 'seventy' WHERE post_id = $1 AND is_source`,
      [post.id, JSON.stringify(cues)],
    );
    await translationOn();
    let batches = 0;
    translate.translator.translate = async (texts, _from, to) => {
      batches += 1;
      await translationOn(false);
      return { texts: texts.map((t) => `[${to}] ${t}`) };
    };
    expect(await captions.translateCommunityHomeCaptions(post.id, "en")).toBe("skipped:flag_off");
    expect(batches).toBe(1);
    expect((await tracks(post.id)).map((t) => t.lang)).toEqual(["pt"]);
    const usage = await getPool().query<{ chars: string }>(`SELECT chars::text FROM community_home_translation_usage`);
    expect(Number(usage.rows[0]!.chars)).toBe(cues.slice(0, 60).reduce((n, c) => n + c.text.length, 0));
  });

  it("a reader's request does not retry a translation that is in backoff", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    await translationOn();
    const source = await getPool().query<{ source_hash: string }>(
      `SELECT source_hash FROM community_home_post_captions WHERE post_id = $1 AND is_source`,
      [post.id],
    );
    await getPool().query(
      `INSERT INTO community_home_caption_translation_jobs (post_id, lang, source_hash, attempts, retry_at)
       VALUES ($1, 'en', $2, 1, NOW() + interval '10 minutes')`,
      [post.id, source.rows[0]!.source_hash],
    );
    const res = await captionTracks(member, post.id, "en");
    expect(res.body.tracks.map((t) => t.lang)).toEqual(["pt"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await captions.waitForCaptionTranslationsForTests();
    expect(translate.calls.filter((c) => c.texts.includes("frase 0"))).toEqual([]);
  });

  it("a claim lost half way keeps only the batches sent and gives the rest of the budget back", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    // Seventy cues: two batches of up to sixty.
    const cues = Array.from({ length: 70 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.5, text: `fala ${i}` }));
    await getPool().query(
      `UPDATE community_home_post_captions SET cues = $2::jsonb, source_hash = 'seventy' WHERE post_id = $1 AND is_source`,
      [post.id, JSON.stringify(cues)],
    );
    await translationOn();
    let batches = 0;
    translate.translator.translate = async (texts, _from, to) => {
      batches += 1;
      await getPool().query(
        `UPDATE community_home_caption_translation_jobs SET claimed_by = 'someone-else' WHERE post_id = $1`,
        [post.id],
      );
      return { texts: texts.map((t) => `[${to}] ${t}`) };
    };
    expect(await captions.translateCommunityHomeCaptions(post.id, "en")).toBe("skipped:claimed");
    expect(batches).toBe(1);
    const firstBatch = cues.slice(0, 60).reduce((n, c) => n + c.text.length, 0);
    const usage = await getPool().query<{ chars: string }>(`SELECT chars::text FROM community_home_translation_usage`);
    expect(Number(usage.rows[0]!.chars)).toBe(firstBatch);
  });

  it("a database error renewing the claim before any batch is not a spent attempt", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    await translationOn();
    const pool = getPool();
    const realQuery = pool.query.bind(pool);
    const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (typeof text === "string" && text.includes("SET claimed_at = NOW()")) {
        return Promise.reject(new Error("connection reset"));
      }
      return (realQuery as (...a: unknown[]) => unknown)(text, ...rest);
    }) as never);
    try {
      expect(await captions.translateCommunityHomeCaptions(post.id, "en")).toBe("failed");
    } finally {
      spy.mockRestore();
    }
    const claim = await getPool().query<{ claimed_by: string | null; attempts: number }>(
      `SELECT claimed_by, attempts FROM community_home_caption_translation_jobs WHERE post_id = $1 AND lang = 'en'`,
      [post.id],
    );
    expect(claim.rows[0]).toEqual({ claimed_by: null, attempts: 0 });
    const usage = await getPool().query<{ chars: string }>(`SELECT chars::text FROM community_home_translation_usage`);
    expect(Number(usage.rows[0]?.chars ?? 0)).toBe(0);
    expect(await captions.translateCommunityHomeCaptions(post.id, "en")).toBe("done");
  });

  it("a database error before the provider frees the claim without spending an attempt", async () => {
    await captionsOn();
    const { post } = await publishVideo();
    await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));
    await runCaptionJob();
    await translationOn();
    const spy = vi.spyOn(tr, "reserveTranslationBudget").mockRejectedValueOnce(new Error("connection reset"));
    try {
      expect(await captions.translateCommunityHomeCaptions(post.id, "en")).toBe("failed");
    } finally {
      spy.mockRestore();
    }
    const claim = await getPool().query<{ claimed_by: string | null; attempts: number }>(
      `SELECT claimed_by, attempts FROM community_home_caption_translation_jobs WHERE post_id = $1 AND lang = 'en'`,
      [post.id],
    );
    expect(claim.rows[0]).toEqual({ claimed_by: null, attempts: 0 });
    expect(translate.calls.filter((c) => c.texts.includes("frase 0"))).toEqual([]);
    // And the next try goes through.
    expect(await captions.translateCommunityHomeCaptions(post.id, "en")).toBe("done");
  });

  it.skipIf(!ffmpeg)("the worker tick runs it end to end through the real ffmpeg", async () => {
    worker.setCaptionsAudioExtractorForTests(null);
    const dir = await mkdtemp(join(tmpdir(), "pqp-captions-test-"));
    try {
      const video = join(dir, "clip.mp4");
      const made = spawnSync("ffmpeg", [
        "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=160x90:d=3",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video,
      ]);
      expect(made.status, made.stderr?.toString()).toBe(0);
      await captionsOn();
      const bytes = await readFile(video);
      const { post, key } = await publishVideo({}, bytes);
      storage.objects.set(key, { bytes, contentType: "video/mp4", file: video });
      await vi.waitFor(async () => expect(await jobs(post.id)).toHaveLength(1));

      expect(await runSpeechJobsTick()).toBeGreaterThanOrEqual(1);
      await waitForCaptionsJobForTests();
      // Three seconds of sound: one window, sent as a WAV of that length.
      expect(stt.calls.map((c) => [c.format, Math.round((c.durationMs ?? 0) / 100)])).toEqual([["wav", 30]]);
      expect((await tracks(post.id)).map((t) => t.lang)).toEqual(["pt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
