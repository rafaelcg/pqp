import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jamPublicSongCreatedSchema,
  jamUploadTicketSchema,
  publicJamSongDetailSchema,
  type JamTrack,
  type PublicJamSongDetail,
} from "@pqp/shared";

/**
 * THE STARTER'S ACCEPT, as a user test saw it fail to publish: the starter of
 * a public standalone song accepted an outside take (`PATCH /api/jam-tracks/:id
 * { inMix: true }`) and the public song page did not list it, because the
 * taker's account was young and the take was `review_state = 'pending'`.
 *
 * What is pinned, on a real Postgres and over HTTP, with the flag set the way
 * production sets it (a `feature_flags` row read after `startFeatureFlags()`,
 * pitfall 12) and the public read asked WITHOUT an Authorization header, the
 * website's shape:
 *
 * - `jam_public_new_account_review` OFF: a one hour old account's take is
 *   `review: none`, and the starter's accept is the whole step to public.
 * - ON: the same accept leaves the take held, and an operator's approval is
 *   what makes it public.
 * - OFF with `audio_only`: the part is listed and its video is not.
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
const { resetSharedRateLimit } = await import("../lib/cluster-rate-limit.js");
const { resetFeatureFlagsForTests, setGlobalFlag, startFeatureFlags } = await import("../lib/flags.js");
const { resetJamPublicCountersForTests } = await import("../services/jam-public.js");
const { takeJamPublicNoticesForTests } = await import("../services/jam-public-notify.js");

// ------------------------------------------------------------ fake storage

const objects = new Map<string, { type: string; body: Buffer }>();
let s3: Server;
const BUCKET = "jam-public-accept-test";

function startFakeS3(): Promise<string> {
  s3 = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = decodeURIComponent(url.pathname.replace(`/${BUCKET}/`, ""));
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(key, { type: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
        res.writeHead(200).end();
      });
      return;
    }
    const found = objects.get(key);
    if (req.method === "DELETE") {
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

// ------------------------------------------------------------------- harness

type Actor = { id: string; clerk_id: string };

let http: Server;
let baseUrl: string;
let starter: Actor; // an old account: starts the public standalone song
let taker: Actor; // outside, one hour old: records the take

const OPERATOR_TOKEN = "jam-public-accept-operator-token";

async function call<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(as ? { Authorization: "Bearer test" } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** A signed-out visitor: no Authorization header at all, the website's shape. */
const anon = <T = Record<string, unknown>>(method: string, path: string) => call<T>(null, method, path);

const operator = <T = Record<string, unknown>>(method: string, path: string, body?: unknown) =>
  call<T>(null, method, path, body, { Authorization: `Bearer ${OPERATOR_TOKEN}` });

async function upload(as: Actor, song: string, kind: "audio" | "video"): Promise<string> {
  const contentType = kind === "audio" ? "audio/flac" : "video/mp4";
  const bytes = Buffer.from(`${kind}-${Math.random()}`);
  const ticket = await call(as, "POST", `/api/jam-songs/${song}/uploads`, {
    kind,
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

async function addTrack(
  as: Actor,
  song: string,
  instrument: string,
  extra: Record<string, unknown> = {},
  options: { video?: boolean } = {},
) {
  const audioUploadId = await upload(as, song, "audio");
  const videoUploadId = options.video ? await upload(as, song, "video") : undefined;
  return call<{ track: JamTrack; error?: string }>(as, "POST", `/api/jam-songs/${song}/tracks`, {
    instrument,
    audioUploadId,
    ...(videoUploadId ? { videoUploadId } : {}),
    durationMs: 30_000,
    peaks: [0.1, 0.5, 0.9],
    ...extra,
  });
}

async function publicSong(song: string): Promise<PublicJamSongDetail | null> {
  const reply = await anon<PublicJamSongDetail>("GET", `/api/public/jams/${song}`);
  if (reply.status === 404) {
    return null;
  }
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return publicJamSongDetailSchema.parse(reply.body);
}

const reviewFlag = (on: boolean | null) =>
  setGlobalFlag("jam_public_new_account_review", on, { kind: "dashboard" });

const reviewStateOf = async (trackId: string) =>
  (
    await getPool().query<{ review_state: string }>(
      `SELECT review_state FROM jam_public_tracks WHERE track_id = $1`,
      [trackId],
    )
  ).rows[0]?.review_state;

/**
 * A public standalone song by the (old) starter, with the starter's own first
 * take in, so the song itself is live and listed.
 */
async function startSong(): Promise<string> {
  const created = await call(starter, "POST", "/api/jam-public/songs", {
    title: "Aberta",
    joinMode: "wanted",
    wantedInstruments: ["bass", "drums"],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const song = jamPublicSongCreatedSchema.parse(created.body).song.id;
  const first = await addTrack(starter, song, "guitar", { publicConsent: "yes" });
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(await publicSong(song)).not.toBeNull();
  return song;
}

describeDb("a starter's accept on a public standalone song", () => {
  beforeAll(async () => {
    const endpoint = await startFakeS3();
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_BUCKET = BUCKET;
    process.env.S3_ACCESS_KEY_ID = "jam-public-accept-test";
    process.env.S3_SECRET_ACCESS_KEY = "jam-public-accept-test-secret";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.ADMIN_METRICS_TOKEN = OPERATOR_TOKEN;
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
    for (const name of [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_FORCE_PATH_STYLE",
      "ADMIN_METRICS_TOKEN",
      "JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS",
    ]) {
      delete process.env[name];
    }
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    resetJamPublicCountersForTests();
    takeJamPublicNoticesForTests();
    // The hold is 72 hours; the taker below is 1 hour old, the starter 30 days.
    process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "72";
    for (const name of [
      "JAM_PUBLIC_SONGS_PER_DAY",
      "JAM_PUBLIC_TAKES_PER_DAY",
      "JAM_PUBLIC_REPORTS_TO_HIDE",
    ]) {
      delete process.env[name];
    }
    await resetSharedRateLimit("jam-song");
    await resetSharedRateLimit("jam-upload");
    objects.clear();
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members, server_bans,
                channel_members, channel_reads, channel_overwrites, roles,
                member_roles, audit_log, member_timeouts, feature_flags,
                feature_flag_overrides, feature_flag_audit, reports,
                jam_public_audit, jam_public_quarantine
       RESTART IDENTITY CASCADE`,
    );
    const make = async (name: string) =>
      (await upsertUser({ clerkId: `clerk_jpa_${name}`, displayName: name, avatarUrl: null })) as Actor;
    starter = await make("Starter");
    taker = await make("Taker");
    await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [starter.id]);
    await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [taker.id]);
    await startFeatureFlags();
    await setGlobalFlag("jam_public", true, { kind: "dashboard" });
  });

  it("flag off: the take is not public until the starter accepts, then the very next public read lists it", async () => {
    await reviewFlag(false);
    const song = await startSong();

    const take = await addTrack(taker, song, "bass", { publicConsent: "yes" });
    expect(take.status, JSON.stringify(take.body)).toBe(201);
    const id = take.body.track.id;
    expect(take.body.track.inMix).toBe(false);
    // A young account's take is not held with the flag off.
    expect(await reviewStateOf(id)).toBe("none");

    // Recorded but not accepted: not in the public version.
    expect((await publicSong(song))!.tracks.map((one) => one.id)).not.toContain(id);

    const accepted = await call(starter, "PATCH", `/api/jam-tracks/${id}`, { inMix: true });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const after = (await publicSong(song))!.tracks;
    expect(after.map((one) => one.id)).toContain(id);
    expect(after.map((one) => one.instrument)).toEqual(["guitar", "bass"]);
    // And the accept left nothing behind for an operator.
    const queue = await operator<{ tracks: unknown[] }>("GET", "/api/admin/jam-public/queue");
    expect(queue.body.tracks).toEqual([]);
  });

  it("flag on: the accept leaves the take held, and an operator's approval makes it public", async () => {
    await reviewFlag(true);
    const song = await startSong();

    const take = await addTrack(taker, song, "bass", { publicConsent: "yes" });
    expect(take.status, JSON.stringify(take.body)).toBe(201);
    const id = take.body.track.id;
    expect(await reviewStateOf(id)).toBe("pending");
    expect((await publicSong(song))!.tracks.map((one) => one.id)).not.toContain(id);

    const accepted = await call(starter, "PATCH", `/api/jam-tracks/${id}`, { inMix: true });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    // Accepted into the mix and still held.
    expect((await publicSong(song))!.tracks.map((one) => one.id)).not.toContain(id);
    expect(await reviewStateOf(id)).toBe("pending");

    const approved = await operator("PUT", "/api/admin/jam-public/review", { kind: "track", id, decision: "approve" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await reviewStateOf(id)).toBe("approved");
    expect((await publicSong(song))!.tracks.map((one) => one.id)).toContain(id);
  });

  it("flag off, audio_only: the accepted part is listed and its video is not", async () => {
    await reviewFlag(false);
    const song = await startSong();

    const take = await addTrack(taker, song, "drums", { publicConsent: "audio_only" }, { video: true });
    expect(take.status, JSON.stringify(take.body)).toBe(201);
    const id = take.body.track.id;
    expect((await publicSong(song))!.tracks.map((one) => one.id)).not.toContain(id);

    expect((await call(starter, "PATCH", `/api/jam-tracks/${id}`, { inMix: true })).status).toBe(200);

    const listed = (await publicSong(song))!.tracks.find((one) => one.id === id);
    expect(listed).toBeDefined();
    expect(listed!.audioUrl).toContain(`/${BUCKET}/`);
    expect(listed!.videoUrl).toBeNull();
    expect(listed!.videoContentType).toBeNull();
    expect(listed!.videoSources).toEqual([]);
  });
});
