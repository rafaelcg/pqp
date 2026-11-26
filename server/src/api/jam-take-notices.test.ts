import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jamPublicSongCreatedSchema,
  jamTakeNoticesResponseSchema,
  jamUploadTicketSchema,
  publicJamSongDetailSchema,
  type JamTrack,
  type PublicJamSongDetail,
} from "@pqp/shared";

/**
 * TELLING THE STARTER (launch test N1). A stranger sends a part to a public song
 * and its starter must be told, in the app's own mechanism: a durable item they
 * read at boot (`GET /api/jam-public/notices`), a live frame, a push.
 *
 * On a real Postgres and over HTTP, with the flag set the way production sets it
 * (a `feature_flags` row read after `startFeatureFlags()`, pitfall 12):
 *
 * - a take makes ONE item for the starter, a burst raises its count and adds the
 *   instrument, the recorder is told nothing, a block silences it, flag off
 *   writes nothing;
 * - the item empties when the takes are answered, and an accept or a refusal
 *   tells the SENDER (accepted / refused, a frame of its own type);
 * - a take still waiting does NOT fill what the song asks for: the song stays
 *   under "needs" in the public list and the `needs` filter until the take is in
 *   the mix.
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
const { takeJamPublicNoticesForTests, takeJamTakeDecisionsForTests } = await import("../services/jam-public-notify.js");
const { jamTakeNoticeCounters } = await import("../services/jam-take-notices.js");

// ------------------------------------------------------------ fake storage

const objects = new Map<string, { type: string; body: Buffer }>();
let s3: Server;
const BUCKET = "jam-take-notices-test";

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
let taker: Actor; // records the take
let other: Actor; // a third account

const OPERATOR_TOKEN = "jam-take-notices-operator-token";

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


async function notices(as: Actor) {
  const reply = await call(as, "GET", "/api/jam-public/notices");
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return jamTakeNoticesResponseSchema.parse(reply.body).notices;
}

const noticesFlag = (on: boolean | null) =>
  setGlobalFlag("jam_take_notices", on, { kind: "dashboard" });

async function neededOnList(song: string, instrument?: string): Promise<boolean> {
  const query = instrument ? `?needs=${instrument}` : "";
  const reply = await anon<{ songs: Array<{ id: string; needs: string[] }> }>("GET", `/api/public/jams${query}`);
  expect(reply.status).toBe(200);
  return reply.body.songs.some((one) => one.id === song);
}

describeDb("telling the starter about takes", () => {
  beforeAll(async () => {
    const endpoint = await startFakeS3();
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_BUCKET = BUCKET;
    process.env.S3_ACCESS_KEY_ID = "jam-take-notices-test";
    process.env.S3_SECRET_ACCESS_KEY = "jam-take-notices-test-secret";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.ADMIN_METRICS_TOKEN = OPERATOR_TOKEN;
    await initDb();
    http = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (http?.listening) {
      await new Promise<void>((done) => http.close(() => done()));
    }
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
    takeJamTakeDecisionsForTests();
    process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "72";
    for (const name of ["JAM_PUBLIC_SONGS_PER_DAY", "JAM_PUBLIC_TAKES_PER_DAY", "JAM_PUBLIC_REPORTS_TO_HIDE"]) {
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
      (await upsertUser({ clerkId: `clerk_jtn_${name}`, displayName: name, avatarUrl: null })) as Actor;
    starter = await make("Starter");
    taker = await make("Taker");
    other = await make("Other");
    await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '30 days' WHERE id = ANY($1::uuid[])`, [
      [starter.id, taker.id, other.id],
    ]);
    await startFeatureFlags();
    await setGlobalFlag("jam_public", true, { kind: "dashboard" });
    await reviewFlag(false);
  });

  it("one take: the starter has an item naming the song and the instrument, a frame says so, the recorder hears nothing", async () => {
    const song = await startSong();
    const take = await addTrack(taker, song, "bass", { publicConsent: "yes" });
    expect(take.status, JSON.stringify(take.body)).toBe(201);

    const items = await notices(starter);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "take", songId: song, title: "Aberta", instruments: ["bass"], count: 1 });
    // The live nudge carries the instrument, to the starter only.
    const frames = takeJamPublicNoticesForTests().filter((one) => one.notice.kind === "take");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ userId: starter.id, notice: { songId: song, instrument: "bass", admitted: false } });
    // Not told: the person who recorded it, and anybody else.
    expect(await notices(taker)).toEqual([]);
    expect(await notices(other)).toEqual([]);
    expect(jamTakeNoticeCounters()).toMatchObject({ created: 1, merged: 0, pushClaimed: 1 });
  });

  it("a burst on one song is ONE item with a count and every instrument, and it empties when they are answered", async () => {
    const song = await startSong();
    const bass = await addTrack(taker, song, "bass", { publicConsent: "yes" });
    const drums = await addTrack(other, song, "drums", { publicConsent: "yes" });
    const bass2 = await addTrack(other, song, "bass", { publicConsent: "yes" });
    expect([bass.status, drums.status, bass2.status]).toEqual([201, 201, 201]);

    let items = await notices(starter);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ count: 3 });
    expect(items[0]!.instruments).toEqual(["bass", "drums"]);
    // One push claim for the whole burst; the other two were held back.
    expect(jamTakeNoticeCounters()).toMatchObject({ created: 1, merged: 2, pushClaimed: 1, pushHeldBack: 2 });

    // Answering one lowers the count (read live); answering all empties the item.
    expect((await call(starter, "PATCH", `/api/jam-tracks/${bass.body.track.id}`, { inMix: true })).status).toBe(200);
    items = await notices(starter);
    expect(items[0]).toMatchObject({ count: 2 });
    expect((await call(starter, "DELETE", `/api/jam-tracks/${drums.body.track.id}`)).status).toBe(204);
    expect((await call(starter, "DELETE", `/api/jam-tracks/${bass2.body.track.id}`)).status).toBe(204);
    expect(await notices(starter)).toEqual([]);
  });

  it("a pending take does not fill what the song asks for; an accepted one does", async () => {
    const song = await startSong();
    expect(await neededOnList(song)).toBe(true);
    expect((await publicSong(song))!.song.needs).toEqual(["bass", "drums"]);

    const take = await addTrack(taker, song, "bass", { publicConsent: "yes" });
    expect(take.status).toBe(201);
    // The summary every client reads (`missingInstruments`, and `instruments` for the ones that
    // work the need out themselves) agrees: the waiting take is not in the band.
    const summary = (take.body as unknown as { song: { missingInstruments: string[]; instruments: string[] } }).song;
    expect(summary.missingInstruments).toEqual(["bass", "drums"]);
    expect(summary.instruments).toEqual(["guitar"]);
    // Waiting for the starter: still wanted, on the list and in the filter.
    expect((await publicSong(song))!.song.needs).toEqual(["bass", "drums"]);
    expect(await neededOnList(song, "bass")).toBe(true);
    // The owner's own summary agrees (the app's "Falta alguém" reads this).
    const mine = await call<{ song: { needs: string[] } }>(starter, "GET", `/api/jam-public/songs/${song}`);
    expect(mine.status).toBe(200);
    expect(mine.body.song.needs).toEqual(["bass", "drums"]);

    expect((await call(starter, "PATCH", `/api/jam-tracks/${take.body.track.id}`, { inMix: true })).status).toBe(200);
    expect((await publicSong(song))!.song.needs).toEqual(["drums"]);
    expect(await neededOnList(song, "bass")).toBe(false);
    expect(await neededOnList(song, "drums")).toBe(true);
  });

  it("accepting tells the sender: an item, a frame of its own type; refusing says so too", async () => {
    const song = await startSong();
    const first = await addTrack(taker, song, "bass", { publicConsent: "yes" });
    const second = await addTrack(taker, song, "drums", { publicConsent: "yes" });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await notices(taker)).toEqual([]);

    expect((await call(starter, "PATCH", `/api/jam-tracks/${first.body.track.id}`, { inMix: true })).status).toBe(200);
    await vi.waitFor(async () => expect((await notices(taker)).map((one) => one.kind)).toEqual(["accepted"]));
    expect((await notices(taker))[0]).toMatchObject({ songId: song, instruments: ["bass"], count: 1 });
    expect(takeJamTakeDecisionsForTests()).toEqual([
      { userId: taker.id, frame: { type: "jam-take-decision", decision: "accepted", songId: song, title: "Aberta", instrument: "bass" } },
    ]);

    expect((await call(starter, "DELETE", `/api/jam-tracks/${second.body.track.id}`)).status).toBe(204);
    await vi.waitFor(async () => expect((await notices(taker)).map((one) => one.kind).sort()).toEqual(["accepted", "refused"]));
    expect(takeJamTakeDecisionsForTests().map((one) => one.frame.decision)).toEqual(["refused"]);

    // The starter's own mix changes and deletes tell nobody.
    const own = await addTrack(starter, song, "vocals", { publicConsent: "yes" });
    expect((await call(starter, "DELETE", `/api/jam-tracks/${own.body.track.id}`)).status).toBe(204);
    expect(await notices(starter)).toEqual([]);

    // Tapping spends the item, and only the owner's.
    const item = (await notices(taker))[0]!;
    expect((await call(other, "POST", "/api/jam-public/notices/ack", { id: item.id })).status).toBe(200);
    expect(await notices(taker)).toHaveLength(2);
    expect((await call(taker, "POST", "/api/jam-public/notices/ack", { id: item.id })).status).toBe(200);
    expect(await notices(taker)).toHaveLength(1);
  });

  it("a starter who blocked the recorder is not told (the take still waits in the inbox)", async () => {
    const song = await startSong();
    await getPool().query(`INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2)`, [starter.id, taker.id]);
    const take = await addTrack(taker, song, "bass", { publicConsent: "yes" });
    expect(take.status).toBe(201);
    expect(await notices(starter)).toEqual([]);
    expect(jamTakeNoticeCounters()).toMatchObject({ created: 0, skippedBlocked: 1, pushClaimed: 0 });
    const inbox = await call<{ takes: unknown[] }>(starter, "GET", "/api/jam-public/inbox");
    expect(inbox.body.takes).toHaveLength(1);
  });

  it("flag off: nothing is written, nothing is read, no decision is sent; the old frame still goes", async () => {
    await noticesFlag(false);
    const song = await startSong();
    const take = await addTrack(taker, song, "bass", { publicConsent: "yes" });
    expect(take.status).toBe(201);
    expect(await notices(starter)).toEqual([]);
    expect((await getPool().query(`SELECT 1 FROM jam_take_notices`)).rowCount).toBe(0);
    // The nudge that existed before this feature is untouched by the switch.
    expect(takeJamPublicNoticesForTests().filter((one) => one.notice.kind === "take")).toHaveLength(1);
    expect((await call(starter, "PATCH", `/api/jam-tracks/${take.body.track.id}`, { inMix: true })).status).toBe(200);
    expect(takeJamTakeDecisionsForTests()).toEqual([]);
    expect(await notices(taker)).toEqual([]);
    // The needs rule is a bug fix, not part of the switch.
    expect((await publicSong(song))!.song.needs).toEqual(["drums"]);
  });
});
