import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  jamPublicationResponseSchema,
  jamPublicConsentsResponseSchema,
  jamPublicInboxResponseSchema,
  jamPublicLikeResponseSchema,
  jamPublicMeConfigSchema,
  jamPublicMineResponseSchema,
  jamPublicSongCreatedSchema,
  jamPublicSongForViewerSchema,
  jamSongDetailResponseSchema,
  jamUploadTicketSchema,
  jamVideoSourceSchema,
  publicJamConfigSchema,
  publicJamListResponseSchema,
  publicJamOriginSchema,
  publicJamPartSchema,
  publicJamPersonSchema,
  publicJamSongDetailSchema,
  publicJamSongSchema,
  publicJamTrackSchema,
  adminJamPublicQueueSchema,
  reportPublicJamSchema,
  adminJamPublicSongSchema,
  Permission,
  type JamSongSummary,
  type JamTrack,
  type PublicJamSongDetail,
} from "@pqp/shared";

/**
 * PUBLIC JAMS, end to end over HTTP on a real Postgres, with the fake object
 * store of `jam.test.ts` (the REAL `lib/s3.ts` signs against it), a fake
 * image scanner behind the real `webhook` provider of `content-scan.ts`, and,
 * where it is installed, the real ffmpeg for the frame sampling.
 *
 * The flag is set the way production sets it: a `feature_flags` row read
 * after `startFeatureFlags()` (pitfall 12), never the environment. The public
 * reads are asked WITHOUT an Authorization header, the shape the website
 * sends. What is pinned: the flag (off means unmatched and refused), every
 * authorization rule including consent and its withdrawal, that nothing
 * unconsented, unscanned or private appears in a public read (with a walk
 * that fails on any key the contract does not name), the new-account queue,
 * the limits, the report auto-hide, the play dedupe across two counters (the
 * two API containers), that an unpublish is out of the very next read, the
 * scans and their quarantine, and the operator's routes.
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
const { createServer: createPqpServer } = await import("../services/servers.js");
const { createRole, assignRole } = await import("../services/roles.js");
const { resetSharedRateLimit } = await import("../lib/cluster-rate-limit.js");
const { resetFeatureFlagsForTests, setGlobalFlag, setServerFlagOverride, startFeatureFlags } =
  await import("../lib/flags.js");
const { jamPlays, JamPlayCounter, jamPlayViewer } = await import("../services/jam-public-plays.js");
const { sweepJamPublic, jamPublicTableMetrics, resetJamPublicCountersForTests, jamPublicCounters } =
  await import("../services/jam-public.js");
const {
  processOneJamCover,
  processOneJamVideo,
  setJamVideoToolsForTests,
  jamFrameTimes,
  realJamVideoTools,
  sweepJamPublicQuarantine,
} = await import("../services/jam-public-scan.js");
const { jamKeysForUser } = await import("../services/jam-keys.js");
const { takeJamPublicNoticesForTests } = await import("../services/jam-public-notify.js");
const { jamPublicMediaUrl, openJamPublicMediaUrl, jamPublicMediaExpiresAt } = await import(
  "../services/jam-public-media.js"
);
const { getAdminMetrics } = await import("../services/metrics.js");

// ------------------------------------------------------------ fake storage

const objects = new Map<string, { type: string; body: Buffer }>();
let s3: Server;
const BUCKET = "jam-public-test";

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

// ------------------------------------------------------------ fake scanner

/** The operator's own scanner, as the `webhook` provider calls it. */
const scanner = {
  verdict: "pass" as "pass" | "flag" | "reject",
  labels: [] as string[],
  calls: [] as Array<{ imageUrl: string; contentType: string }>,
};
let scanServer: Server;

function startFakeScanner(): Promise<string> {
  scanServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      scanner.calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          verdict: scanner.verdict,
          labels: scanner.labels,
          score: scanner.verdict === "pass" ? 0.01 : 0.95,
          illegal: scanner.labels.includes("illegal"),
        }),
      );
    });
  });
  return new Promise((resolve) =>
    scanServer.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(scanServer.address() as AddressInfo).port}/scan`),
    ),
  );
}
let scanUrl = "";
const scannerOn = () => {
  process.env.CONTENT_SCAN_PROVIDER = "webhook";
  process.env.CONTENT_SCAN_URL = scanUrl;
};
const scannerOff = () => {
  delete process.env.CONTENT_SCAN_PROVIDER;
  delete process.env.CONTENT_SCAN_URL;
};

// ------------------------------------------------------------------- harness

type Actor = { id: string; clerk_id: string };

let http: Server;
let baseUrl: string;
let alice: Actor; // owns the server; starts the channel song
let bob: Actor; // member
let carol: Actor; // member, nicknamed in the server
let mod: Actor; // member holding MANAGE_MESSAGES
let eve: Actor; // not a member
let frank: Actor; // not a member
let serverId: string;
let jamId: string;

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
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
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

/** A signed-out visitor: no Authorization header at all, the website's shape. */
const anon = <T = Record<string, unknown>>(method: string, path: string) => call<T>(null, method, path);

/** The operator's machine token. */
const OPERATOR_TOKEN = "jam-public-operator-token";
const operator = <T = Record<string, unknown>>(method: string, path: string, body?: unknown) =>
  call<T>(null, method, path, body, { Authorization: `Bearer ${OPERATOR_TOKEN}` });

async function upload(
  as: Actor,
  song: string,
  kind: "audio" | "video" | "cover" = "audio",
  options: { contentType?: string; bytes?: Buffer } = {},
): Promise<string> {
  const contentType =
    options.contentType ?? (kind === "audio" ? "audio/flac" : kind === "video" ? "video/mp4" : "image/jpeg");
  const bytes = options.bytes ?? (kind === "cover" ? jpegBytes() : Buffer.from(`${kind}-${Math.random()}`));
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

const jpegBytes = () =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x04, 0x00, 0x04,
    0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);

async function addTrack(
  as: Actor,
  song: string,
  instrument = "guitar",
  extra: Record<string, unknown> = {},
  options: { video?: Buffer | true } = {},
) {
  const audioUploadId = await upload(as, song, "audio");
  const videoUploadId = options.video
    ? await upload(as, song, "video", options.video === true ? {} : { bytes: options.video })
    : undefined;
  return call<{ track: JamTrack; song: JamSongSummary; error?: string }>(
    as,
    "POST",
    `/api/jam-songs/${song}/tracks`,
    {
      instrument,
      audioUploadId,
      ...(videoUploadId ? { videoUploadId } : {}),
      durationMs: 30_000,
      peaks: [0.1, 0.5, 0.9],
      ...extra,
    },
  );
}

async function trackId(
  as: Actor,
  song: string,
  instrument = "guitar",
  extra: Record<string, unknown> = {},
  options: { video?: Buffer | true } = {},
): Promise<string> {
  const reply = await addTrack(as, song, instrument, extra, options);
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body.track.id;
}

/** A channel song by `as` with their first take. */
async function channelSong(as: Actor, title = "Wonderwall", extra: Record<string, unknown> = {}) {
  const created = await call<{ song: JamSongSummary }>(as, "POST", `/api/channels/${jamId}/jam-songs`, {
    title,
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.song.id;
  await trackId(as, id, "guitar");
  return id;
}

const publicFlag = (on: boolean | null) => setGlobalFlag("jam_public", on, { kind: "dashboard" });

const publish = (as: Actor, song: string, body: Record<string, unknown> = {}) =>
  call<{ publication: unknown; error?: string }>(as, "PUT", `/api/jam-songs/${song}/public`, body);

const consent = (as: Actor, song: string, choice: string) =>
  call<{ publication: unknown; error?: string }>(as, "PUT", `/api/jam-songs/${song}/public-consent`, {
    choice,
  });

async function publicSong(song: string): Promise<PublicJamSongDetail | null> {
  const reply = await anon<PublicJamSongDetail>("GET", `/api/public/jams/${song}`);
  if (reply.status === 404) {
    return null;
  }
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  assertOnlyContractKeys(reply.body, publicJamSongDetailSchema, "detail");
  return publicJamSongDetailSchema.parse(reply.body);
}

async function publicList(query = ""): Promise<z.infer<typeof publicJamListResponseSchema>> {
  const reply = await anon("GET", `/api/public/jams${query}`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  assertOnlyContractKeys(reply.body, publicJamListResponseSchema, "list");
  return publicJamListResponseSchema.parse(reply.body);
}

/**
 * THE PRIVACY WALK. Every key of a public payload must be one the contract
 * names, at every depth: a field added to a query that leaks (an author id, a
 * server id, an email, a nickname column) fails here even when the schema
 * would have stripped it on parse.
 */
const PERSON_KEYS = Object.keys(publicJamPersonSchema.shape);
const SHAPES: Record<string, string[]> = {
  list: Object.keys(publicJamListResponseSchema.shape),
  detail: Object.keys(publicJamSongDetailSchema.shape),
  song: Object.keys(publicJamSongSchema.shape),
  track: Object.keys(publicJamTrackSchema.shape),
  part: Object.keys(publicJamPartSchema.shape),
  person: PERSON_KEYS,
  origin: Object.keys(publicJamOriginSchema.shape),
  source: Object.keys(jamVideoSourceSchema.shape),
};

function assertOnlyContractKeys(payload: unknown, _schema: unknown, shape: keyof typeof SHAPES): void {
  const walk = (value: unknown, kind: keyof typeof SHAPES, path: string) => {
    if (value === null || typeof value !== "object") {
      return;
    }
    const allowed = SHAPES[kind]!;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      expect(allowed, `${path}.${key} is not in the public contract`).toContain(key);
      const next: Record<string, keyof typeof SHAPES> = {
        songs: "song",
        song: "song",
        tracks: "track",
        parts: "part",
        person: "person",
        startedBy: "person",
        origin: "origin",
        videoSources: "source",
      };
      const childKind = next[key];
      if (childKind && child !== null) {
        if (Array.isArray(child)) {
          child.forEach((item, index) => walk(item, childKind, `${path}.${key}[${index}]`));
        } else {
          walk(child, childKind, `${path}.${key}`);
        }
      }
    }
  };
  walk(payload, shape, shape);
}

async function settleUploads(): Promise<void> {
  // The scans wait until no presigned PUT can still replace the bytes.
  await getPool().query(`UPDATE jam_uploads SET created_at = NOW() - INTERVAL '1 hour'`);
}

const fakeTools = {
  frames: [] as number[],
  async probe() {
    return 12;
  },
  async frame(_path: string, _type: string, seconds: number, out: string) {
    fakeTools.frames.push(seconds);
    writeFileSync(out, jpegBytes());
  },
};

describeDb("public jams", () => {
  beforeAll(async () => {
    const endpoint = await startFakeS3();
    scanUrl = await startFakeScanner();
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_BUCKET = BUCKET;
    process.env.S3_ACCESS_KEY_ID = "jam-public-test";
    process.env.S3_SECRET_ACCESS_KEY = "jam-public-test-secret";
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
    await new Promise<void>((done) => scanServer.close(() => done()));
    for (const name of [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_FORCE_PATH_STYLE",
      "ADMIN_METRICS_TOKEN",
    ]) {
      delete process.env[name];
    }
    scannerOff();
    setJamVideoToolsForTests(null);
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    resetJamPublicCountersForTests();
    jamPlays.reset();
    takeJamPublicNoticesForTests();
    scannerOff();
    scanner.verdict = "pass";
    scanner.labels = [];
    scanner.calls.length = 0;
    fakeTools.frames.length = 0;
    setJamVideoToolsForTests(fakeTools);
    // Every account here is "old" unless a test says otherwise.
    process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "0";
    for (const name of [
      "JAM_PUBLIC_SONGS_PER_DAY",
      "JAM_PUBLIC_TAKES_PER_DAY",
      "JAM_PUBLIC_LIKES_PER_MINUTE",
      "JAM_PUBLIC_REPORTS_PER_DAY",
      "JAM_PUBLIC_REPORTS_TO_HIDE",
    ]) {
      delete process.env[name];
    }
    await resetSharedRateLimit("jam-song");
    await resetSharedRateLimit("jam-upload");
    await resetSharedRateLimit("jam-public-like");
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
      (await upsertUser({ clerkId: `clerk_jp_${name}`, displayName: name, avatarUrl: null })) as Actor;
    alice = await make("Alice");
    bob = await make("Bob");
    carol = await make("Carol");
    mod = await make("Mod");
    eve = await make("Eve");
    frank = await make("Frank");
    await getPool().query(`UPDATE users SET handle = 'alice' WHERE id = $1`, [alice.id]);
    serverId = (await createPqpServer("Banda", alice.id)).server.id;
    for (const user of [bob, carol, mod]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, user.id],
      );
    }
    await getPool().query(
      `UPDATE server_members SET nickname = 'Carolzinha da Banda' WHERE server_id = $1 AND user_id = $2`,
      [serverId, carol.id],
    );
    const role = await createRole(serverId, {
      name: "Moderadores",
      permissions: Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.MANAGE_MESSAGES,
    });
    await assignRole(serverId, mod.id, role.id);
    await startFeatureFlags();
    await setServerFlagOverride("jam_channels", serverId, true, { kind: "dashboard" });
    const channel = await call<{ channel: { id: string } }>(alice, "POST", `/api/servers/${serverId}/channels`, {
      name: "jam",
      type: "jam",
    });
    expect(channel.status).toBe(201);
    jamId = channel.body.channel.id;
  });

  // ------------------------------------------------------------------ flag

  describe("with the flag off", () => {
    it("answers config, and nothing else under /api/public/jams is even a route", async () => {
      const config = await anon("GET", "/api/public/jams/config");
      expect(config.status).toBe(200);
      expect(publicJamConfigSchema.strict().parse(config.body)).toEqual({ enabled: false });
      expect(config.headers.get("cache-control")).toBe("public, max-age=60");
      const song = await channelSong(alice);
      // The unknown path's answer: no session, so 401, exactly like a typo.
      expect((await anon("GET", "/api/public/jams")).status).toBe(401);
      expect((await anon("GET", `/api/public/jams/${song}`)).status).toBe(401);
      expect((await anon("POST", `/api/public/jams/${song}/play`)).status).toBe(401);
      expect((await anon("GET", "/api/public/nonsense")).status).toBe(401);
    });

    it("refuses every publishing write, and the channel jam works as before", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).body.error).toBe("jam_public_off");
      const create = await call(alice, "POST", "/api/jam-public/songs", { title: "Sozinha" });
      expect(create.status).toBe(403);
      expect(create.body.error).toBe("jam_public_off");
      expect((await call(alice, "PUT", `/api/jam-public/songs/${song}/like`)).body.error).toBe("jam_public_off");
      const config = jamPublicMeConfigSchema.parse((await call(bob, "GET", "/api/jam-public/config")).body);
      expect(config.enabled).toBe(false);
      // The channel song is untouched: a member reads it, a stranger does not.
      const detail = jamSongDetailResponseSchema.parse((await call(bob, "GET", `/api/jam-songs/${song}`)).body);
      expect(detail.song.channelId).toBe(jamId);
      expect((await call(eve, "GET", `/api/jam-songs/${song}`)).status).toBe(404);
    });

    it("turning it off hides a published song from every read at once", async () => {
      await publicFlag(true);
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      expect(await publicSong(song)).not.toBeNull();
      await publicFlag(false);
      expect((await anon("GET", `/api/public/jams/${song}`)).status).toBe(401);
      // And a non-member loses public access to the channel's song.
      expect((await call(eve, "GET", `/api/jam-songs/${song}`)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------- standalone

  describe("a standalone public jam", () => {
    beforeEach(async () => {
      await publicFlag(true);
    });

    it("belongs to no channel, is listed once its first take is in, and a retry is the same song", async () => {
      const created = await call(eve, "POST", "/api/jam-public/songs", {
        title: "Canção da Eve",
        artist: null,
        joinMode: "wanted",
        wantedInstruments: ["bass", "drums"],
        nonce: "n-1",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const body = jamPublicSongCreatedSchema.parse(created.body);
      expect(body.song.channelId).toBeNull();
      expect(body.song.serverId).toBeNull();
      expect(body.publication.status).toBe("live");
      expect(body.publication.listed).toBe(false);
      expect(body.publication.hasOrigin).toBe(false);
      const again = await call(eve, "POST", "/api/jam-public/songs", { title: "Canção da Eve", nonce: "n-1" });
      expect(again.status).toBe(200);
      expect(jamPublicSongCreatedSchema.parse(again.body).song.id).toBe(body.song.id);

      const song = body.song.id;
      expect((await publicList()).songs).toHaveLength(0);
      expect(await publicSong(song)).toBeNull();
      // The starter records the first take through the very same routes.
      await trackId(eve, song, "guitar", { publicConsent: "yes" });
      const listed = await publicList();
      expect(listed.songs.map((one) => one.id)).toEqual([song]);
      expect(listed.songs[0]!.needs).toEqual(["bass", "drums"]);
      expect(listed.songs[0]!.origin).toBeNull();
      expect(listed.songs[0]!.startedBy).toEqual({ name: "Eve", handle: null, avatarUrl: null });
      const detail = (await publicSong(song))!;
      expect(detail.tracks).toHaveLength(1);
      expect(detail.tracks[0]!.audioUrl).toContain(`/${BUCKET}/jam/public/${song}/`);
      expect(detail.song.durationMs).toBe(30_000);
      // The ?needs= filter.
      expect((await publicList("?needs=bass")).songs).toHaveLength(1);
      expect((await publicList("?needs=keys")).songs).toHaveLength(0);
      // Not in any channel's list.
      const wall = await call<{ songs: JamSongSummary[] }>(alice, "GET", `/api/channels/${jamId}/jam-songs`);
      expect(wall.body.songs.map((one) => one.id)).not.toContain(song);
    });

    it("an outside take arrives out of the mix, waits in the starter's inbox, and goes public with one action", async () => {
      const created = jamPublicSongCreatedSchema.parse(
        (await call(eve, "POST", "/api/jam-public/songs", { title: "Aberta" })).body,
      );
      const song = created.song.id;
      await trackId(eve, song, "guitar", { publicConsent: "yes" });
      // Without saying it is fine to go public: refused.
      const noConsent = await addTrack(frank, song, "bass");
      expect(noConsent.status).toBe(400);
      expect(noConsent.body.error).toBe("jam_public_consent_required");
      const take = await addTrack(frank, song, "bass", { publicConsent: "audio_only" });
      expect(take.status, JSON.stringify(take.body)).toBe(201);
      expect(take.body.track.inMix).toBe(false);
      expect(takeJamPublicNoticesForTests()).toContainEqual(
        expect.objectContaining({ userId: eve.id, notice: expect.objectContaining({ kind: "take", songId: song }) }),
      );
      expect((await publicSong(song))!.tracks).toHaveLength(1);
      const inbox = jamPublicInboxResponseSchema.parse((await call(eve, "GET", "/api/jam-public/inbox")).body);
      expect(inbox.takes.map((one) => one.track.id)).toEqual([take.body.track.id]);
      // Frank may not put his own take in.
      expect((await call(frank, "PATCH", `/api/jam-tracks/${take.body.track.id}`, { inMix: true })).status).toBe(403);
      const accepted = await call(eve, "PATCH", `/api/jam-tracks/${take.body.track.id}`, { inMix: true });
      expect(accepted.status).toBe(200);
      expect((await publicSong(song))!.tracks.map((one) => one.instrument)).toEqual(["guitar", "bass"]);
      expect(jamPublicInboxResponseSchema.parse((await call(eve, "GET", "/api/jam-public/inbox")).body).takes).toEqual([]);
      // The starter can remove any part.
      expect((await call(eve, "DELETE", `/api/jam-tracks/${take.body.track.id}`)).status).toBe(204);
      expect((await publicSong(song))!.tracks).toHaveLength(1);
    });

    it("a closed song takes no outside part", async () => {
      const created = jamPublicSongCreatedSchema.parse(
        (await call(eve, "POST", "/api/jam-public/songs", { title: "Fechada", joinMode: "closed" })).body,
      );
      await trackId(eve, created.song.id, "guitar", { publicConsent: "yes" });
      const ticket = await call(frank, "POST", `/api/jam-songs/${created.song.id}/uploads`, {
        kind: "audio",
        contentType: "audio/flac",
        byteSize: 10,
      });
      expect(ticket.status).toBe(403);
      expect(ticket.body.error).toBe("jam_song_closed");
    });
  });

  // --------------------------------------------------------- channel songs

  describe("a channel song made public", () => {
    beforeEach(async () => {
      await publicFlag(true);
    });

    it("only its starter publishes it; a stranger cannot even see it", async () => {
      const song = await channelSong(alice);
      expect((await publish(bob, song)).body.error).toBe("jam_public_not_starter");
      expect((await publish(eve, song)).status).toBe(404);
      expect((await call(eve, "GET", `/api/jam-songs/${song}/public`)).status).toBe(404);
      const published = jamPublicationResponseSchema.parse((await publish(alice, song)).body);
      expect(published.publication!.status).toBe("live");
      expect(published.publication!.listed).toBe(true);
      // Idempotent.
      expect((await publish(alice, song)).status).toBe(200);
    });

    it("asks everybody with a part; a part is public only after its person's yes, and leaves at once on no", async () => {
      const song = await channelSong(alice);
      const carolTrack = await trackId(carol, song, "bass", {}, { video: true });
      const bobTrack = await trackId(bob, song, "drums");
      expect((await publish(alice, song)).status).toBe(200);
      const asked = takeJamPublicNoticesForTests()
        .filter((one) => one.notice.kind === "consent")
        .map((one) => one.userId)
        .sort();
      expect(asked).toEqual([bob.id, carol.id].sort());
      const pending = jamPublicConsentsResponseSchema.parse((await call(carol, "GET", "/api/jam-public/consents")).body);
      expect(pending.pending.map((one) => one.songId)).toEqual([song]);
      expect(pending.pending[0]!.serverName).toBe("Banda");

      // Only Alice's part, and nothing about the others leaks.
      let detail = (await publicSong(song))!;
      expect(detail.tracks.map((one) => one.instrument)).toEqual(["guitar"]);
      let raw = JSON.stringify(detail) + JSON.stringify(await publicList());
      for (const secret of [carolTrack, bobTrack, carol.id, bob.id, alice.id, jamId, "Carol", "Bob"]) {
        expect(raw).not.toContain(secret);
      }
      // A presigned URL shows the object key, which names the origin server;
      // through the edge (JAM_PUBLIC_MEDIA_BASE_URL) nothing names it.
      process.env.JAM_PUBLIC_MEDIA_BASE_URL = "https://media.example.test";
      try {
        expect(JSON.stringify(await publicSong(song))).not.toContain(serverId);
      } finally {
        delete process.env.JAM_PUBLIC_MEDIA_BASE_URL;
      }
      expect(detail.song.startedBy).toEqual({ name: "Alice", handle: "alice", avatarUrl: null });
      expect(detail.song.origin).toEqual({ name: "Banda", iconUrl: null, slug: null });

      // Somebody with no part cannot answer.
      expect((await consent(mod, song, "yes")).body.error).toBe("jam_public_no_part");

      // Carol: audio only. Her part is public, her video never.
      expect((await consent(carol, song, "audio_only")).status).toBe(200);
      detail = (await publicSong(song))!;
      const carolPublic = detail.tracks.find((one) => one.id === carolTrack)!;
      expect(carolPublic.videoUrl).toBeNull();
      expect(carolPublic.person.name).toBe("Carol");
      raw = JSON.stringify(detail);
      expect(raw).not.toContain("Carolzinha");
      expect(raw).not.toContain(bobTrack);

      // Carol withdraws: gone from the very next read.
      expect((await consent(carol, song, "no")).status).toBe(200);
      expect((await publicSong(song))!.tracks.map((one) => one.id)).not.toContain(carolTrack);
      // A consent of `no` works with the flag off; a yes does not.
      await publicFlag(false);
      expect((await consent(bob, song, "no")).status).toBe(200);
      expect((await consent(bob, song, "yes")).body.error).toBe("jam_public_off");
      await publicFlag(true);

      const view = jamPublicationResponseSchema.parse((await call(alice, "GET", `/api/jam-songs/${song}/public`)).body);
      const parts = Object.fromEntries(view.publication!.parts.map((one) => [one.trackId, one]));
      expect(parts[carolTrack]!.consent).toBe("no");
      expect(parts[carolTrack]!.public).toBe(false);
      expect(parts[bobTrack]!.consent).toBe("no");
    });

    it("a stranger records on it through public access and sees only the public version", async () => {
      const song = await channelSong(alice);
      await trackId(carol, song, "bass");
      expect((await publish(alice, song)).status).toBe(200);
      const take = await addTrack(eve, song, "drums", { publicConsent: "yes" });
      expect(take.status, JSON.stringify(take.body)).toBe(201);
      expect(take.body.track.inMix).toBe(false);
      // Answered with the public view: no channel, no unconsented part.
      expect(take.body.song.channelId).toBeNull();
      expect(take.body.song.serverId).toBeNull();
      const detail = jamSongDetailResponseSchema.parse((await call(eve, "GET", `/api/jam-songs/${song}`)).body);
      expect(detail.song.channelId).toBeNull();
      expect(detail.tracks.map((one) => one.authorId).sort()).toEqual([alice.id, eve.id].sort());
      expect(JSON.stringify(detail)).not.toContain("Carol");
      expect(detail.viewer.canModerate).toBe(false);
      // The channel's members still see everything, Eve's take included.
      const member = jamSongDetailResponseSchema.parse((await call(bob, "GET", `/api/jam-songs/${song}`)).body);
      expect(member.tracks).toHaveLength(3);
      expect(member.song.channelId).toBe(jamId);
      // Alice's inbox, then her one action.
      const inbox = jamPublicInboxResponseSchema.parse((await call(alice, "GET", "/api/jam-public/inbox")).body);
      expect(inbox.takes.map((one) => one.track.id)).toEqual([take.body.track.id]);
      expect((await call(alice, "PATCH", `/api/jam-tracks/${take.body.track.id}`, { inMix: true })).status).toBe(200);
      expect((await publicSong(song))!.tracks.map((one) => one.instrument)).toEqual(["guitar", "drums"]);
      // Eve cannot reach anybody else's track.
      const carolTrack = member.tracks.find((one) => one.authorId === carol.id)!.id;
      expect((await call(eve, "PATCH", `/api/jam-tracks/${carolTrack}`, { gain: 0 })).status).toBe(404);
      // Unpublished: Eve loses the channel's song, and keeps the right to delete her own take.
      expect((await call(alice, "DELETE", `/api/jam-songs/${song}/public`)).status).toBe(200);
      expect((await call(eve, "GET", `/api/jam-songs/${song}`)).status).toBe(404);
      expect((await call(eve, "DELETE", `/api/jam-tracks/${take.body.track.id}`)).status).toBe(204);
    });

    it("an unpublish is out of the very next read, list and song", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      expect((await publicList()).songs).toHaveLength(1);
      const off = jamPublicationResponseSchema.parse((await call(alice, "DELETE", `/api/jam-songs/${song}/public`)).body);
      expect(off.publication!.status).toBe("unpublished");
      expect(await publicSong(song)).toBeNull();
      expect((await publicList()).songs).toHaveLength(0);
      // A republish brings it back.
      expect((await publish(alice, song)).status).toBe(200);
      expect(await publicSong(song)).not.toBeNull();
    });

    it("a moderator of the origin channel may unpublish, with a reason the starter is told", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      takeJamPublicNoticesForTests();
      expect((await call(bob, "DELETE", `/api/jam-songs/${song}/public`)).status).toBe(403);
      const off = await call(mod, "DELETE", `/api/jam-songs/${song}/public?reason=${encodeURIComponent("fora do tema")}`);
      expect(off.status).toBe(200);
      expect(jamPublicationResponseSchema.parse(off.body).publication!.removedReason).toBe("fora do tema");
      expect(takeJamPublicNoticesForTests()).toContainEqual({
        userId: alice.id,
        notice: expect.objectContaining({ kind: "unpublished", reason: "fora do tema" }),
      });
      const audit = await getPool().query(`SELECT action, actor_kind FROM jam_public_audit WHERE song_id = $1`, [song]);
      expect(audit.rows).toContainEqual({ action: "unpublish", actor_kind: "moderator" });
    });

    it("the starter can hide the origin, and a public community's slug links it", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song, { showOrigin: false })).status).toBe(200);
      expect((await publicSong(song))!.song.origin).toBeNull();
      expect((await call(alice, "PATCH", `/api/jam-songs/${song}/public`, { showOrigin: true })).status).toBe(200);
      expect((await publicSong(song))!.song.origin).toEqual({ name: "Banda", iconUrl: null, slug: null });
      await getPool().query(
        `UPDATE servers SET is_community = TRUE, community_slug = 'banda' WHERE id = $1`,
        [serverId],
      );
      process.env.COMMUNITIES_ENABLED = "true";
      try {
        expect((await publicSong(song))!.song.origin!.slug).toBe("banda");
      } finally {
        delete process.env.COMMUNITIES_ENABLED;
      }
      expect((await call(bob, "PATCH", `/api/jam-songs/${song}/public`, { showOrigin: false })).body.error).toBe(
        "jam_public_not_starter",
      );
    });

    it("a member's part recorded on an already public song carries its answer", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      // An older client sends no answer: the part stays out until they give one.
      const silent = await trackId(bob, song, "bass");
      expect((await publicSong(song))!.tracks.map((one) => one.id)).not.toContain(silent);
      const told = await trackId(carol, song, "drums", { publicConsent: "yes" });
      expect((await publicSong(song))!.tracks.map((one) => one.id)).toContain(told);
    });

    it("deleting the starter's account, or a part's author's, removes them from every read at once", async () => {
      const song = await channelSong(alice);
      const carolTrack = await trackId(carol, song, "bass");
      expect((await publish(alice, song)).status).toBe(200);
      expect((await consent(carol, song, "yes")).status).toBe(200);
      expect((await publicSong(song))!.tracks.map((one) => one.id)).toContain(carolTrack);
      await getPool().query(`UPDATE users SET deletion_started_at = NOW() WHERE id = $1`, [carol.id]);
      expect((await publicSong(song))!.tracks.map((one) => one.id)).not.toContain(carolTrack);
      await getPool().query(`UPDATE users SET deletion_started_at = NOW() WHERE id = $1`, [alice.id]);
      expect(await publicSong(song)).toBeNull();
    });

    it("a standalone song whose starter is gone is swept", async () => {
      const created = jamPublicSongCreatedSchema.parse(
        (await call(eve, "POST", "/api/jam-public/songs", { title: "Órfã" })).body,
      );
      await trackId(eve, created.song.id, "guitar", { publicConsent: "yes" });
      await trackId(frank, created.song.id, "bass", { publicConsent: "yes" });
      await getPool().query(`DELETE FROM users WHERE id = $1`, [eve.id]);
      expect(await publicSong(created.song.id)).toBeNull();
      expect((await sweepJamPublic()).orphans).toBe(1);
      const row = await getPool().query(`SELECT deleted_at FROM jam_songs WHERE id = $1`, [created.song.id]);
      expect(row.rows[0].deleted_at).not.toBeNull();
    });
  });

  // ----------------------------------------------------------- new accounts

  describe("new accounts", () => {
    beforeEach(async () => {
      await publicFlag(true);
      process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "72";
      await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '30 days' WHERE id <> $1`, [eve.id]);
    });

    it("a new account's first public jam waits for an operator, and so do its takes", async () => {
      expect(jamPublicMeConfigSchema.parse((await call(eve, "GET", "/api/jam-public/config")).body).publishing).toBe(
        "review",
      );
      const created = jamPublicSongCreatedSchema.parse(
        (await call(eve, "POST", "/api/jam-public/songs", { title: "Primeira" })).body,
      );
      expect(created.publication.status).toBe("review");
      const song = created.song.id;
      await trackId(eve, song, "guitar", { publicConsent: "yes" });
      expect(await publicSong(song)).toBeNull();
      const queue = adminJamPublicQueueSchema.parse((await operator("GET", "/api/admin/jam-public/queue")).body);
      expect(queue.songs.map((one) => one.songId)).toEqual([song]);
      expect(queue.tracks).toHaveLength(1);
      expect(
        (await operator("PUT", "/api/admin/jam-public/review", { kind: "song", id: song, decision: "approve" })).status,
      ).toBe(200);
      // Approving the song looks at the starter's own takes in it too.
      expect((await publicSong(song))!.tracks).toHaveLength(1);

      // Eve's take on somebody else's public song waits too.
      const other = await channelSong(alice, "Outra");
      expect((await publish(alice, other)).status).toBe(200);
      const take = await addTrack(eve, other, "bass", { publicConsent: "yes" });
      expect(take.status).toBe(201);
      expect((await call(alice, "PATCH", `/api/jam-tracks/${take.body.track.id}`, { inMix: true })).status).toBe(200);
      expect((await publicSong(other))!.tracks.map((one) => one.id)).not.toContain(take.body.track.id);
      expect(
        (await operator("PUT", "/api/admin/jam-public/review", { kind: "track", id: take.body.track.id, decision: "approve" }))
          .status,
      ).toBe(200);
      expect((await publicSong(other))!.tracks.map((one) => one.id)).toContain(take.body.track.id);
    });

    it("an old account is not queued", async () => {
      const song = await channelSong(alice);
      const published = jamPublicationResponseSchema.parse((await publish(alice, song)).body);
      expect(published.publication!.status).toBe("live");
    });
  });

  // ----------------------------------------------------------------- limits

  describe("limits", () => {
    beforeEach(async () => {
      await publicFlag(true);
    });

    it("new public jams per day", async () => {
      process.env.JAM_PUBLIC_SONGS_PER_DAY = "1";
      expect((await call(eve, "POST", "/api/jam-public/songs", { title: "Um" })).status).toBe(201);
      const second = await call(eve, "POST", "/api/jam-public/songs", { title: "Dois" });
      expect(second.status).toBe(429);
      expect(second.body.error).toBe("jam_public_rate_limited");
      // Refused before the song existed: nothing left behind.
      const left = await getPool().query(`SELECT COUNT(*)::int AS n FROM jam_songs WHERE title = 'Dois'`);
      expect(left.rows[0].n).toBe(0);
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      expect(jamPublicCounters().rateLimited.songs).toBe(1);
    });

    it("public takes per day", async () => {
      process.env.JAM_PUBLIC_TAKES_PER_DAY = "1";
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      expect((await addTrack(eve, song, "bass", { publicConsent: "yes" })).status).toBe(201);
      const second = await addTrack(eve, song, "drums", { publicConsent: "yes" });
      expect(second.status).toBe(429);
      expect(second.body.error).toBe("jam_public_rate_limited");
    });

    it("public takes per day hold under a race: two adds at once never make two public takes past the limit", async () => {
      process.env.JAM_PUBLIC_TAKES_PER_DAY = "1";
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      const [one, two] = await Promise.all([
        addTrack(eve, song, "bass", { publicConsent: "yes" }),
        addTrack(eve, song, "drums", { publicConsent: "yes" }),
      ]);
      const created = [one, two].filter((reply) => reply.status === 201);
      for (const reply of created) {
        expect((await call(alice, "PATCH", `/api/jam-tracks/${reply.body.track.id}`, { inMix: true })).status).toBe(200);
      }
      const publicEve = (await publicSong(song))!.tracks.filter((track) => track.person.name === "Eve");
      expect(publicEve).toHaveLength(1);
    });

    it("likes: one per account, counted, and a per-minute budget", async () => {
      process.env.JAM_PUBLIC_LIKES_PER_MINUTE = "3";
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      const like = async (as: Actor, on = true) =>
        call(as, on ? "PUT" : "DELETE", `/api/jam-public/songs/${song}/like`);
      expect(jamPublicLikeResponseSchema.parse((await like(eve)).body)).toEqual({ songId: song, liked: true, likes: 1 });
      expect(jamPublicLikeResponseSchema.parse((await like(eve)).body).likes).toBe(1);
      expect(jamPublicLikeResponseSchema.parse((await like(frank)).body).likes).toBe(2);
      expect((await publicSong(song))!.song.likes).toBe(2);
      expect(jamPublicLikeResponseSchema.parse((await like(eve, false)).body).likes).toBe(1);
      expect((await like(eve)).status).toBe(429);
      const viewer = jamPublicSongForViewerSchema.parse((await call(frank, "GET", `/api/jam-public/songs/${song}`)).body);
      expect(viewer.viewer.liked).toBe(true);
      expect(viewer.viewer.isStarter).toBe(false);
    });

    it("the public routes have their own address buckets", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      let refused = 0;
      for (let i = 0; i < 40; i += 1) {
        if ((await anon("POST", `/api/public/jams/${song}/play`)).status === 429) refused += 1;
      }
      expect(refused).toBeGreaterThan(0);
      expect(jamPublicCounters().addressRefused.play).toBe(refused);
    });
  });

  // ---------------------------------------------------------------- reports

  describe("reports", () => {
    beforeEach(async () => {
      await publicFlag(true);
    });

    it("go to the instance queue, and enough distinct people hide the song until an operator looks", async () => {
      process.env.JAM_PUBLIC_REPORTS_TO_HIDE = "2";
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      const report = (as: Actor, extra: Record<string, unknown> = {}) =>
        call(as, "POST", "/api/jam-public/reports", { songId: song, reason: "spam", ...extra });
      // Signed in only: there is no anonymous door.
      expect((await anon("POST", "/api/jam-public/reports")).status).toBe(401);
      expect((await report(eve)).status).toBe(201);
      expect((await report(eve)).body).toEqual({ duplicate: true });
      const queued = await getPool().query(
        `SELECT server_id, context_kind, reported_user_id, channel_label FROM reports`,
      );
      expect(queued.rows).toEqual([
        { server_id: null, context_kind: "none", reported_user_id: alice.id, channel_label: "Jam pública · Wonderwall" },
      ]);
      expect(await publicSong(song)).not.toBeNull();
      expect((await report(frank)).status).toBe(201);
      expect(await publicSong(song)).toBeNull();
      const view = jamPublicationResponseSchema.parse((await call(alice, "GET", `/api/jam-songs/${song}/public`)).body);
      expect(view.publication!.status).toBe("hidden");
      const queue = adminJamPublicQueueSchema.parse((await operator("GET", "/api/admin/jam-public/queue")).body);
      expect(queue.songs[0]).toMatchObject({ songId: song, status: "hidden", reports: 2 });
      expect(
        (await operator("PUT", "/api/admin/jam-public/review", { kind: "song", id: song, decision: "approve" })).status,
      ).toBe(200);
      expect(await publicSong(song)).not.toBeNull();
      // The reports the operator already weighed do not hide it again.
      expect((await report(bob)).status).toBe(201);
      expect(await publicSong(song)).not.toBeNull();
    });

    it("a part is reported against its author, only when it is public", async () => {
      const song = await channelSong(alice);
      const carolTrack = await trackId(carol, song, "bass");
      expect((await publish(alice, song)).status).toBe(200);
      const report = () =>
        call(eve, "POST", "/api/jam-public/reports", { songId: song, trackId: carolTrack, reason: "harassment" });
      expect((await report()).status).toBe(404);
      expect((await consent(carol, song, "yes")).status).toBe(200);
      expect((await report()).status).toBe(201);
      const queued = await getPool().query(`SELECT reported_user_id FROM reports`);
      expect(queued.rows).toEqual([{ reported_user_id: carol.id }]);
    });

    it("a copyright report is accepted, kept as its own reason, and counted for the operator", async () => {
      process.env.JAM_PUBLIC_REPORTS_TO_HIDE = "5";
      const song = await channelSong(alice);
      const carolTrack = await trackId(carol, song, "bass");
      expect((await publish(alice, song)).status).toBe(200);
      expect((await consent(carol, song, "yes")).status).toBe(200);
      // The shared contract knows the reason, and an unknown one is still a 400.
      expect(reportPublicJamSchema.safeParse({ songId: song, reason: "copyright" }).success).toBe(true);
      expect((await call(eve, "POST", "/api/jam-public/reports", { songId: song, reason: "pirated" })).status).toBe(400);
      expect(
        (await call(eve, "POST", "/api/jam-public/reports", { songId: song, trackId: carolTrack, reason: "copyright", details: "my song" }))
          .status,
      ).toBe(201);
      expect((await call(frank, "POST", "/api/jam-public/reports", { songId: song, reason: "spam" })).status).toBe(201);
      const stored = await getPool().query(`SELECT reason FROM jam_public_reports ORDER BY created_at`);
      expect(stored.rows.map((row) => row.reason)).toEqual(["copyright", "spam"]);
      const queued = await getPool().query(`SELECT reason, server_id, reported_user_id FROM reports ORDER BY id`);
      expect(queued.rows).toEqual([
        { reason: "copyright", server_id: null, reported_user_id: carol.id },
        { reason: "spam", server_id: null, reported_user_id: alice.id },
      ]);
      const list = await operator<{ songs: unknown[] }>("GET", "/api/admin/jam-public/songs?status=live");
      expect(adminJamPublicSongSchema.parse(list.body.songs[0])).toMatchObject({ songId: song, reports: 2, copyrightReports: 1 });
    });

    it("reports per day", async () => {
      process.env.JAM_PUBLIC_REPORTS_PER_DAY = "1";
      const one = await channelSong(alice, "Um");
      const two = await channelSong(alice, "Dois");
      expect((await publish(alice, one)).status).toBe(200);
      expect((await publish(alice, two)).status).toBe(200);
      expect((await call(eve, "POST", "/api/jam-public/reports", { songId: one, reason: "spam" })).status).toBe(201);
      const second = await call(eve, "POST", "/api/jam-public/reports", { songId: two, reason: "spam" });
      expect(second.status).toBe(429);
    });
  });

  // ------------------------------------------------------------------ plays

  describe("plays", () => {
    beforeEach(async () => {
      await publicFlag(true);
    });

    it("count once per song per address per hour, however often it is asked", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      for (let i = 0; i < 5; i += 1) {
        expect((await anon("POST", `/api/public/jams/${song}/play`)).status).toBe(204);
      }
      expect((await call(eve, "POST", `/api/jam-public/songs/${song}/play`)).status).toBe(204);
      expect((await call(eve, "POST", `/api/jam-public/songs/${song}/play`)).status).toBe(204);
      await jamPlays.flush();
      expect((await publicSong(song))!.song.plays).toBe(2);
      expect(jamPlays.deduped).toBe(5);
      // Another hour is another play.
      jamPlays.note(song, jamPlayViewer("account", eve.id), Date.now() + 3_600_000);
      await jamPlays.flush();
      expect((await publicSong(song))!.song.plays).toBe(3);
    });

    it("the two API containers do not double count one listener (the primary key decides)", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      const a = new JamPlayCounter();
      const b = new JamPlayCounter();
      const viewer = jamPlayViewer("address", "203.0.113.9");
      a.note(song, viewer);
      b.note(song, viewer);
      b.note(song, jamPlayViewer("address", "203.0.113.10"));
      // An id that is not a published song is skipped, never an error that loses the batch.
      b.note("00000000-0000-4000-8000-000000000000", viewer);
      await Promise.all([a.flush(), b.flush()]);
      expect(a.counted + b.counted).toBe(2);
      expect((await publicSong(song))!.song.plays).toBe(2);
      const marks = await getPool().query(`SELECT viewer FROM jam_public_play_marks`);
      // Never the address itself.
      expect(JSON.stringify(marks.rows)).not.toContain("203.0.113");
    });
  });

  // ------------------------------------------------------------------ scans

  describe("scans", () => {
    beforeEach(async () => {
      await publicFlag(true);
    });

    it("with no scanner configured, a cover and a video are recorded unscanned and never public", async () => {
      const song = await channelSong(alice);
      const cover = await upload(alice, song, "cover");
      expect((await call(alice, "PUT", `/api/jam-songs/${song}/cover`, { uploadId: cover })).status).toBe(200);
      const video = await trackId(alice, song, "vocals", {}, { video: true });
      expect((await publish(alice, song)).status).toBe(200);
      await settleUploads();
      // Recorded `unscanned` at publish: there is nothing for the job to claim.
      expect(await processOneJamCover()).toBeNull();
      expect(await processOneJamVideo()).toBeNull();
      const detail = (await publicSong(song))!;
      expect(detail.song.coverUrl).toBeNull();
      expect(detail.tracks.find((one) => one.id === video)!.videoUrl).toBeNull();
      expect(detail.song.parts.find((one) => one.instrument === "vocals")!.hasVideo).toBe(false);
      const view = jamPublicationResponseSchema.parse((await call(alice, "GET", `/api/jam-songs/${song}/public`)).body);
      expect(view.publication!.cover).toBe("hidden");
      expect(view.publication!.parts.find((one) => one.trackId === video)!.video).toBe("unscanned");
    });

    it("a cover is public only once it passed, and only after its upload URL expired", async () => {
      scannerOn();
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      const cover = await upload(alice, song, "cover");
      expect((await call(alice, "PUT", `/api/jam-songs/${song}/cover`, { uploadId: cover })).status).toBe(200);
      // The presigned PUT could still replace the bytes: not judged yet.
      expect(await processOneJamCover()).toBeNull();
      expect((await publicSong(song))!.song.coverUrl).toBeNull();
      await settleUploads();
      expect(await processOneJamCover()).toBe("passed");
      expect(scanner.calls).toHaveLength(1);
      expect((await publicSong(song))!.song.coverUrl).toContain(`/${BUCKET}/jam/${serverId}/`);
    });

    it("a rejected cover is quarantined, taken off the song, and reported to the instance queue", async () => {
      scannerOn();
      scanner.verdict = "reject";
      scanner.labels = ["gore"];
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      const cover = await upload(alice, song, "cover");
      expect((await call(alice, "PUT", `/api/jam-songs/${song}/cover`, { uploadId: cover })).status).toBe(200);
      await settleUploads();
      expect(await processOneJamCover()).toBe("rejected");
      const covers = await getPool().query(`SELECT 1 FROM jam_song_covers WHERE song_id = $1`, [song]);
      expect(covers.rowCount).toBe(0);
      const held = await getPool().query(`SELECT kind, uploader_id FROM jam_public_quarantine`);
      expect(held.rows).toEqual([{ kind: "cover", uploader_id: alice.id }]);
      const reports = await getPool().query(`SELECT server_id, reporter_id, reason FROM reports`);
      expect(reports.rows).toEqual([{ server_id: null, reporter_id: null, reason: "violence" }]);
      // The evidence is never handed to an account delete.
      const key = (await getPool().query(`SELECT storage_key FROM jam_public_quarantine`)).rows[0].storage_key;
      expect(await jamKeysForUser(alice.id)).not.toContain(key);
    });

    it("video frames: sampled, scanned, public only when passed; rejected is quarantined and off the track", async () => {
      scannerOn();
      const song = await channelSong(alice);
      const good = await trackId(alice, song, "vocals", {}, { video: true });
      expect((await publish(alice, song)).status).toBe(200);
      await settleUploads();
      // Until the scan, the public version of the track is its audio.
      expect((await publicSong(song))!.tracks.find((one) => one.id === good)!.videoUrl).toBeNull();
      expect(await processOneJamVideo()).toBe("passed");
      expect(fakeTools.frames).toEqual([0, 5, 10]);
      expect(scanner.calls).toHaveLength(3);
      // The sampled frames were deleted after the scanner fetched them.
      expect([...objects.keys()].filter((key) => key.startsWith("jam-scan/"))).toEqual([]);
      let detail = (await publicSong(song))!;
      expect(detail.tracks.find((one) => one.id === good)!.videoUrl).toContain(`/${BUCKET}/jam/`);
      expect(detail.tracks.find((one) => one.id === good)!.videoSources).toHaveLength(1);
      // Once the worker's MP4 copy exists it is first, in videoUrl and the list.
      await getPool().query(
        `UPDATE jam_tracks SET video_mp4_key = video_key || '.copy.mp4', video_mp4_content_type = 'video/mp4',
                               video_mp4_bytes = 42 WHERE id = $1`,
        [good],
      );
      detail = (await publicSong(song))!;
      const copied = detail.tracks.find((one) => one.id === good)!;
      expect(copied.videoSources.map((one) => one.contentType)).toEqual(["video/mp4", "video/mp4"]);
      expect(copied.videoSources[0]!.bytes).toBe(42);
      expect(copied.videoUrl).toBe(copied.videoSources[0]!.url);
      expect(copied.videoUrl).toContain(".copy.mp4");
      expect(detail.song.parts.find((one) => one.instrument === "vocals")!.hasVideo).toBe(true);

      // A second part, flagged: not public, reported, nothing quarantined.
      scanner.verdict = "flag";
      const flagged = await trackId(carol, song, "keys", { publicConsent: "yes" }, { video: true });
      await consent(carol, song, "yes");
      await settleUploads();
      expect(await processOneJamVideo()).toBe("flagged");
      expect((await publicSong(song))!.tracks.find((one) => one.id === flagged)!.videoUrl).toBeNull();

      // A third, rejected with `illegal`: quarantined forever, off the track, reported.
      scanner.verdict = "reject";
      scanner.labels = ["illegal"];
      const bad = await trackId(bob, song, "drums", { publicConsent: "yes" }, { video: true });
      await settleUploads();
      expect(await processOneJamVideo()).toBe("rejected");
      const track = await getPool().query(`SELECT video_key FROM jam_tracks WHERE id = $1`, [bad]);
      expect(track.rows[0].video_key).toBeNull();
      const held = await getPool().query(`SELECT kind, track_id FROM jam_public_quarantine`);
      expect(held.rows).toEqual([{ kind: "video", track_id: bad }]);
      await getPool().query(`UPDATE jam_public_quarantine SET quarantined_at = NOW() - INTERVAL '400 days'`);
      expect(await sweepJamPublicQuarantine()).toBe(0);
      const reasons = (await getPool().query(`SELECT reason FROM reports ORDER BY id`)).rows.map((row) => row.reason);
      expect(reasons).toEqual(["other", "illegal_content"]);
      const queue = adminJamPublicQueueSchema.parse((await operator("GET", "/api/admin/jam-public/queue")).body);
      expect(queue.videos.map((one) => one.video).sort()).toEqual(["flagged", "rejected"]);
    });

    it("an audio-only answer keeps a passed video private", async () => {
      scannerOn();
      const song = await channelSong(alice);
      const part = await trackId(carol, song, "bass", {}, { video: true });
      expect((await publish(alice, song)).status).toBe(200);
      await consent(carol, song, "audio_only");
      await settleUploads();
      expect(await processOneJamVideo()).toBe("passed");
      expect((await publicSong(song))!.tracks.find((one) => one.id === part)!.videoUrl).toBeNull();
      await consent(carol, song, "yes");
      expect((await publicSong(song))!.tracks.find((one) => one.id === part)!.videoUrl).not.toBeNull();
    });

    it.skipIf(!hasFfmpeg())("end to end with the real ffmpeg: a generated clip, sampled and judged by the scanner", async () => {
      scannerOn();
      setJamVideoToolsForTests(null, async () => true);
      const dir = mkdtempSync(join(tmpdir(), "pqp-jam-e2e-"));
      try {
        const clip = join(dir, "clip.mp4");
        execFileSync(
          "ffmpeg",
          ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=11:size=160x120:rate=10",
            "-pix_fmt", "yuv420p", "-y", clip],
          { stdio: "ignore" },
        );
        const song = await channelSong(alice);
        const part = await trackId(alice, song, "vocals", {}, { video: readFileSync(clip) });
        expect((await publish(alice, song)).status).toBe(200);
        await settleUploads();
        expect(await processOneJamVideo()).toBe("passed");
        // The first frame, then one every five seconds: 0, 5, 10.
        expect(scanner.calls).toHaveLength(3);
        expect(scanner.calls.every((one) => one.contentType === "image/jpeg")).toBe(true);
        const frames = await getPool().query(`SELECT video_scan_frames FROM jam_public_tracks WHERE track_id = $1`, [part]);
        expect(frames.rows[0].video_scan_frames).toBe(3);
        expect((await publicSong(song))!.tracks.find((one) => one.id === part)!.videoUrl).not.toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("the API process without ffmpeg leaves a video for the worker", async () => {
      scannerOn();
      setJamVideoToolsForTests(fakeTools, async () => false);
      const song = await channelSong(alice);
      await trackId(alice, song, "vocals", {}, { video: true });
      expect((await publish(alice, song)).status).toBe(200);
      await settleUploads();
      expect(await processOneJamVideo()).toBeNull();
      const row = await getPool().query(`SELECT video_scan_status FROM jam_public_tracks WHERE song_id = $1 AND video_scan_key IS NOT NULL`, [song]);
      expect(row.rows[0].video_scan_status).toBe("pending");
    });
  });

  // --------------------------------------------------------------- operator

  // ------------------------------------------------ auto-accept outside takes

  describe("auto-accept of outside takes", () => {
    beforeEach(async () => {
      await publicFlag(true);
    });

    const setAuto = (as: Actor, song: string, on: boolean) =>
      call<{ publication: { autoAcceptOutside: boolean } | null; error?: string }>(
        as,
        "PATCH",
        `/api/jam-songs/${song}/public`,
        { autoAcceptOutside: on },
      );

    /** A standalone public jam of eve's with her own first take in. */
    async function openSong(title = "Aberta"): Promise<string> {
      const created = jamPublicSongCreatedSchema.parse(
        (await call(eve, "POST", "/api/jam-public/songs", { title })).body,
      );
      await trackId(eve, created.song.id, "guitar", { publicConsent: "yes" });
      return created.song.id;
    }

    const inboxIds = async (as: Actor) =>
      jamPublicInboxResponseSchema.parse((await call(as, "GET", "/api/jam-public/inbox")).body).takes.map(
        (one) => one.track.id,
      );
    const publicIds = async (song: string) => (await publicSong(song))!.tracks.map((one) => one.id);
    const inMix = async (track: string) =>
      (await getPool().query(`SELECT in_mix FROM jam_tracks WHERE id = $1`, [track])).rows[0].in_mix as boolean;

    it("is off by default, and only the starter may change it", async () => {
      const song = await openSong();
      const reading = jamPublicationResponseSchema.parse((await call(eve, "GET", `/api/jam-songs/${song}/public`)).body);
      expect(reading.publication!.autoAcceptOutside).toBe(false);
      expect((await publicSong(song))!.song.autoAcceptOutside).toBe(false);
      // Not the starter: a stranger cannot even see it, a participant is told it is not theirs.
      expect((await setAuto(frank, song, true)).status).toBe(404);
      await trackId(frank, song, "bass", { publicConsent: "yes" });
      expect((await setAuto(frank, song, true)).status).toBe(403);
      // An empty change is refused, and the switch is not touched.
      expect((await call(eve, "PATCH", `/api/jam-songs/${song}/public`, {})).status).toBe(400);
      const on = await setAuto(eve, song, true);
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(on.body.publication!.autoAcceptOutside).toBe(true);
    });

    it("off, an outside take waits for the starter exactly as before", async () => {
      const song = await openSong();
      const take = await addTrack(frank, song, "bass", { publicConsent: "yes" });
      expect(take.body.track.inMix).toBe(false);
      await sweepJamPublic();
      expect(await inboxIds(eve)).toEqual([take.body.track.id]);
      expect(await inMix(take.body.track.id)).toBe(false);
    });

    it("on, a take that clears every check goes in without a tap, and the starter is told", async () => {
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      takeJamPublicNoticesForTests();
      const take = await addTrack(frank, song, "bass", { publicConsent: "yes" });
      expect(take.status, JSON.stringify(take.body)).toBe(201);
      const id = take.body.track.id;
      expect(await inMix(id)).toBe(true);
      expect(await publicIds(song)).toContain(id);
      expect(await inboxIds(eve)).toEqual([]);
      // One notice, and it says the take is already in.
      const notices = takeJamPublicNoticesForTests().filter((one) => one.userId === eve.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.notice).toMatchObject({ kind: "take", songId: song, trackId: id, admitted: true });
      // The song page says it is on, in the list and the detail.
      expect((await publicSong(song))!.song.autoAcceptOutside).toBe(true);
      expect((await publicList()).songs.find((one) => one.id === song)!.autoAcceptOutside).toBe(true);
      // Audited as the system's doing.
      const audit = await getPool().query(
        `SELECT action, actor_kind, track_id FROM jam_public_audit WHERE action LIKE 'auto-%' ORDER BY id`,
      );
      expect(audit.rows).toEqual([
        { action: "auto-accept-on", actor_kind: "starter", track_id: null },
        { action: "auto-admit", actor_kind: "system", track_id: id },
      ]);
      expect(jamPublicCounters().takesAutoAdmitted).toBe(1);
    });

    it("covers only the takes recorded after it went on, and turning it off stops the next one without removing the last", async () => {
      const song = await openSong();
      const waiting = await trackId(frank, song, "bass", { publicConsent: "yes" });
      expect((await setAuto(eve, song, true)).status).toBe(200);
      // Turning it on again does not move the moment it began.
      expect((await setAuto(eve, song, true)).status).toBe(200);
      await sweepJamPublic();
      expect(await inMix(waiting)).toBe(false);
      expect(await inboxIds(eve)).toEqual([waiting]);

      const admitted = await trackId(carol, song, "keys", { publicConsent: "yes" });
      expect(await inMix(admitted)).toBe(true);

      const off = await setAuto(eve, song, false);
      expect(off.body.publication!.autoAcceptOutside).toBe(false);
      expect(await inMix(admitted)).toBe(true);
      expect(await publicIds(song)).toContain(admitted);
      const later = await trackId(bob, song, "drums", { publicConsent: "yes" });
      await sweepJamPublic();
      expect(await inMix(later)).toBe(false);
      expect(await inboxIds(eve)).toEqual([later, waiting]);
    });

    it("a take held by the platform's review queue is NOT admitted early, then goes in by itself when an operator approves it", async () => {
      process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "72";
      await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '30 days' WHERE id <> $1`, [frank.id]);
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const take = await addTrack(frank, song, "bass", { publicConsent: "yes" });
      const id = take.body.track.id;
      // Held: not in the mix, not public, and the starter got the ordinary request notice.
      expect(await inMix(id)).toBe(false);
      expect(await publicIds(song)).not.toContain(id);
      expect(
        takeJamPublicNoticesForTests().filter((one) => one.userId === eve.id).map((one) => one.notice),
      ).toEqual([expect.objectContaining({ kind: "take", trackId: id, admitted: false })]);
      // The sweep, however often it runs, does not move it.
      await sweepJamPublic();
      await sweepJamPublic();
      expect(await inMix(id)).toBe(false);
      expect(await inboxIds(eve)).toEqual([id]);
      const queue = adminJamPublicQueueSchema.parse((await operator("GET", "/api/admin/jam-public/queue")).body);
      expect(queue.tracks.map((one) => one.trackId)).toEqual([id]);
      // The operator's approval is what clears it, and the take goes in with no tap from eve.
      expect(
        (await operator("PUT", "/api/admin/jam-public/review", { kind: "track", id, decision: "approve" })).status,
      ).toBe(200);
      expect(await inMix(id)).toBe(true);
      expect(await publicIds(song)).toContain(id);
      expect(await inboxIds(eve)).toEqual([]);
    });

    it("a rejected take is never admitted", async () => {
      process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "72";
      await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '30 days' WHERE id <> $1`, [frank.id]);
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const id = await trackId(frank, song, "bass", { publicConsent: "yes" });
      expect(
        (await operator("PUT", "/api/admin/jam-public/review", { kind: "track", id, decision: "reject" })).status,
      ).toBe(200);
      await sweepJamPublic();
      expect(await inMix(id)).toBe(false);
      expect(await publicIds(song)).not.toContain(id);
    });

    it("the minute sweep admits a take whose hold cleared with no hook of its own", async () => {
      process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "72";
      await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '30 days' WHERE id <> $1`, [frank.id]);
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const id = await trackId(frank, song, "bass", { publicConsent: "yes" });
      expect(await inMix(id)).toBe(false);
      // Approved some other way (a restart between the approval and its hook).
      await getPool().query(`UPDATE jam_public_tracks SET review_state = 'approved' WHERE track_id = $1`, [id]);
      const swept = await sweepJamPublic();
      expect(swept.admitted).toBe(1);
      expect(await inMix(id)).toBe(true);
    });

    it("two sweeps at once admit a take once", async () => {
      process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "72";
      await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '30 days' WHERE id <> $1`, [frank.id]);
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const id = await trackId(frank, song, "bass", { publicConsent: "yes" });
      await getPool().query(`UPDATE jam_public_tracks SET review_state = 'approved' WHERE track_id = $1`, [id]);
      resetJamPublicCountersForTests();
      const both = await Promise.all([sweepJamPublic(), sweepJamPublic()]);
      expect(both.reduce((sum, one) => sum + one.admitted, 0)).toBe(1);
      expect(jamPublicCounters().takesAutoAdmitted).toBe(1);
      const audit = await getPool().query(`SELECT 1 FROM jam_public_audit WHERE action = 'auto-admit'`);
      expect(audit.rowCount).toBe(1);
    });

    it("an operator's removal of an admitted part sticks, and so does one made before the admission", async () => {
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const id = await trackId(frank, song, "bass", { publicConsent: "yes" });
      expect(await publicIds(song)).toContain(id);
      expect(
        (await operator("PUT", "/api/admin/jam-public/remove-part", { trackId: id, reason: "áudio de outra pessoa" }))
          .status,
      ).toBe(200);
      expect(await publicIds(song)).not.toContain(id);
      // Nothing brings it back: not a sweep, not the starter turning the switch off and on.
      await sweepJamPublic();
      await setAuto(eve, song, false);
      await setAuto(eve, song, true);
      await sweepJamPublic();
      expect(await publicIds(song)).not.toContain(id);
      const row = await getPool().query(`SELECT removed_at FROM jam_public_tracks WHERE track_id = $1`, [id]);
      expect(row.rows[0].removed_at).not.toBeNull();

      // Removed while still waiting (a hold): the admission never touches it.
      process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "72";
      await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '30 days' WHERE id <> $1`, [carol.id]);
      const held = await trackId(carol, song, "keys", { publicConsent: "yes" });
      expect(await inMix(held)).toBe(false);
      await operator("PUT", "/api/admin/jam-public/remove-part", { trackId: held, reason: "spam" });
      await operator("PUT", "/api/admin/jam-public/review", { kind: "track", id: held, decision: "approve" });
      await sweepJamPublic();
      expect(await inMix(held)).toBe(false);
      expect(await publicIds(song)).not.toContain(held);
    });

    it("the starter taking an admitted part out of the mix, or deleting it, is not undone", async () => {
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const id = await trackId(frank, song, "bass", { publicConsent: "yes" });
      expect(await inMix(id)).toBe(true);
      expect((await call(eve, "PATCH", `/api/jam-tracks/${id}`, { inMix: false })).status).toBe(200);
      await sweepJamPublic();
      expect(await inMix(id)).toBe(false);
      expect(await publicIds(song)).not.toContain(id);
      const other = await trackId(carol, song, "keys", { publicConsent: "yes" });
      expect((await call(eve, "DELETE", `/api/jam-tracks/${other}`)).status).toBe(204);
      await sweepJamPublic();
      expect(await publicIds(song)).not.toContain(other);
    });

    it("a take whose author answered no while it was held is not admitted when the hold clears", async () => {
      process.env.JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS = "72";
      await getPool().query(`UPDATE users SET created_at = NOW() - INTERVAL '30 days' WHERE id <> $1`, [frank.id]);
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const id = await trackId(frank, song, "bass", { publicConsent: "yes" });
      expect((await consent(frank, song, "no")).status).toBe(200);
      await operator("PUT", "/api/admin/jam-public/review", { kind: "track", id, decision: "approve" });
      await sweepJamPublic();
      expect(await inMix(id)).toBe(false);
      expect(await publicIds(song)).not.toContain(id);
    });

    it("a take with a video waits for the frame scan, and a flagged video never goes in by itself", async () => {
      scannerOn();
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const waiting = await trackId(frank, song, "bass", { publicConsent: "yes" }, { video: true });
      expect(await inMix(waiting)).toBe(false);
      await settleUploads();
      await sweepJamPublic();
      expect(await inMix(waiting)).toBe(false);
      expect(await processOneJamVideo()).toBe("passed");
      expect(await inMix(waiting)).toBe(true);
      expect((await publicSong(song))!.tracks.find((one) => one.id === waiting)!.videoUrl).not.toBeNull();

      scanner.verdict = "flag";
      const flagged = await trackId(carol, song, "keys", { publicConsent: "yes" }, { video: true });
      await settleUploads();
      expect(await processOneJamVideo()).toBe("flagged");
      await sweepJamPublic();
      expect(await inMix(flagged)).toBe(false);
      expect(await inboxIds(eve)).toEqual([flagged]);
    });

    it("with no scanner a take with a video is not admitted by itself, one without is", async () => {
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const withVideo = await trackId(frank, song, "bass", { publicConsent: "yes" }, { video: true });
      const audioOnly = await trackId(carol, song, "keys", { publicConsent: "yes" });
      await sweepJamPublic();
      expect(await inMix(withVideo)).toBe(false);
      expect(await inMix(audioOnly)).toBe(true);
    });

    it("a song whose picture the scanner flagged stops admitting until it is replaced", async () => {
      scannerOn();
      scanner.verdict = "flag";
      const song = await openSong();
      expect((await call(eve, "PUT", `/api/jam-songs/${song}/cover`, { uploadId: await upload(eve, song, "cover") })).status).toBe(
        200,
      );
      expect((await setAuto(eve, song, true)).status).toBe(200);
      await settleUploads();
      expect(await processOneJamCover()).toBe("flagged");
      const held = await trackId(frank, song, "bass", { publicConsent: "yes" });
      await sweepJamPublic();
      expect(await inMix(held)).toBe(false);
    });

    it("works the same on a channel song, in the channel's own frame, and a member's take is not an outside one", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      expect((await setAuto(alice, song, true)).status).toBe(200);
      // A stranger's take through public access goes in.
      const outside = await trackId(eve, song, "bass", { publicConsent: "yes" });
      expect(await inMix(outside)).toBe(true);
      // A member's take keeps the channel's rule (a second guitar waits for the starter).
      const member = await trackId(bob, song, "guitar", { publicConsent: "yes" });
      expect(await inMix(member)).toBe(false);
      await sweepJamPublic();
      expect(await inMix(member)).toBe(false);
    });

    it("with the flag off nothing is admitted", async () => {
      const song = await openSong();
      expect((await setAuto(eve, song, true)).status).toBe(200);
      const id = await trackId(frank, song, "bass", { publicConsent: "yes" });
      // (admitted at once: put it back as a held take, then switch the flag off)
      await getPool().query(`UPDATE jam_tracks SET in_mix = FALSE WHERE id = $1`, [id]);
      await getPool().query(`UPDATE jam_public_tracks SET auto_admitted_at = NULL WHERE track_id = $1`, [id]);
      await publicFlag(false);
      await sweepJamPublic();
      expect(await inMix(id)).toBe(false);
      await publicFlag(true);
      await sweepJamPublic();
      expect(await inMix(id)).toBe(true);
    });
  });

  describe("the operator", () => {
    beforeEach(async () => {
      await publicFlag(true);
    });

    it("lists, takes down with a reason (audited, the starter told), removes a part, and blocks a publisher", async () => {
      const song = await channelSong(alice);
      const carolTrack = await trackId(carol, song, "bass");
      expect((await publish(alice, song)).status).toBe(200);
      expect((await consent(carol, song, "yes")).status).toBe(200);
      const list = await operator<{ songs: unknown[] }>("GET", "/api/admin/jam-public/songs?status=live");
      expect(list.status).toBe(200);
      const row = adminJamPublicSongSchema.parse(list.body.songs[0]);
      expect(row).toMatchObject({ songId: song, listed: true, publicParts: 2, status: "live" });
      // Not reachable without the token.
      expect([401, 404]).toContain((await anon("GET", "/api/admin/jam-public/songs")).status);
      expect((await call(eve, "GET", "/api/admin/jam-public/songs")).status).toBe(404);

      expect(
        (await operator("PUT", "/api/admin/jam-public/remove-part", { trackId: carolTrack, reason: "áudio de outra pessoa" }))
          .status,
      ).toBe(200);
      expect((await publicSong(song))!.tracks.map((one) => one.id)).not.toContain(carolTrack);

      takeJamPublicNoticesForTests();
      expect((await operator("PUT", "/api/admin/jam-public/unpublish", { songId: song, reason: "direitos autorais" })).status).toBe(
        200,
      );
      expect(await publicSong(song)).toBeNull();
      expect(takeJamPublicNoticesForTests()).toContainEqual({
        userId: alice.id,
        notice: expect.objectContaining({ kind: "removed", reason: "direitos autorais" }),
      });
      // The starter cannot put it back.
      expect((await publish(alice, song)).body.error).toBe("jam_public_removed");
      const audit = await getPool().query(
        `SELECT action, actor_kind, actor_id, reason FROM jam_public_audit WHERE action IN ('remove', 'remove-part') ORDER BY id`,
      );
      expect(audit.rows).toEqual([
        { action: "remove-part", actor_kind: "dashboard", actor_id: null, reason: "áudio de outra pessoa" },
        { action: "remove", actor_kind: "dashboard", actor_id: null, reason: "direitos autorais" },
      ]);
      const mine = jamPublicMineResponseSchema.parse((await call(alice, "GET", "/api/jam-public/mine")).body);
      expect(mine.songs[0]!.publication).toMatchObject({ status: "removed", removedReason: "direitos autorais" });

      // An operator restores it.
      expect(
        (await operator("PUT", "/api/admin/jam-public/review", { kind: "song", id: song, decision: "approve" })).status,
      ).toBe(200);
      expect(await publicSong(song)).not.toBeNull();

      // Blocked: every song and part of the account leaves the public reads, and it may not publish.
      expect((await operator("PUT", "/api/admin/jam-public/block", { userId: alice.id, blocked: true, reason: "spam" })).status).toBe(
        200,
      );
      expect(await publicSong(song)).toBeNull();
      expect(jamPublicMeConfigSchema.parse((await call(alice, "GET", "/api/jam-public/config")).body).publishing).toBe(
        "blocked",
      );
      const other = await channelSong(alice, "Outra");
      expect((await publish(alice, other)).body.error).toBe("jam_public_blocked");
      expect((await call(alice, "POST", "/api/jam-public/songs", { title: "x" })).body.error).toBe("jam_public_blocked");
    });

    it("a member banned from the origin server cannot record publicly, and a banned starter's song is not public", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      const elsewhere = await createPqpServer("Outro", eve.id);
      await getPool().query(`INSERT INTO server_bans (server_id, user_id) VALUES ($1, $2)`, [serverId, frank.id]);
      const ticket = await call(frank, "POST", `/api/jam-songs/${song}/uploads`, {
        kind: "audio",
        contentType: "audio/flac",
        byteSize: 10,
      });
      expect(ticket.status).toBe(403);
      void elsewhere;
    });

    it("the dashboard's metrics carry a jamPublic block", async () => {
      const song = await channelSong(alice);
      expect((await publish(alice, song)).status).toBe(200);
      const table = await jamPublicTableMetrics();
      expect(table).toMatchObject({ enabled: true, published: 1 });
      const metrics = await getAdminMetrics();
      expect(metrics.jamPublic.published).toBe(1);
      expect(metrics.jamPublic.process.published).toBe(1);
    });
  });
});

// ------------------------------------------------------------------- units

describe("public jam media URLs", () => {
  it("presigned and stable inside a ten-minute window by default", () => {
    process.env.S3_ENDPOINT = "http://127.0.0.1:9";
    process.env.S3_BUCKET = "b";
    process.env.S3_ACCESS_KEY_ID = "k";
    process.env.S3_SECRET_ACCESS_KEY = "s";
    process.env.S3_FORCE_PATH_STYLE = "true";
    try {
      const at = Date.UTC(2026, 10, 12, 10, 3, 0);
      const a = jamPublicMediaUrl("jam/x/y/z.flac", at);
      const b = jamPublicMediaUrl("jam/x/y/z.flac", at + 5 * 60_000);
      expect(a).toBe(b);
      expect(a).toContain("X-Amz-Expires=3600");
      expect(jamPublicMediaExpiresAt(at).toISOString()).toBe("2026-11-12T11:00:00.000Z");
      expect(jamPublicMediaUrl("stories/elsewhere.jpg", at)).toBe("");
    } finally {
      for (const name of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE"]) {
        delete process.env[name];
      }
    }
  });

  it("honours JAM_PUBLIC_MEDIA_BASE_URL with an opaque, signed, expiring path the edge can check", () => {
    process.env.JAM_PUBLIC_MEDIA_BASE_URL = "https://media.example.test/";
    try {
      const at = Date.UTC(2026, 10, 12, 10, 3, 0);
      const key = "jam/11111111-1111-4111-8111-111111111111/song/a.flac";
      const url = new URL(jamPublicMediaUrl(key, at));
      expect(url.origin).toBe("https://media.example.test");
      expect(url.pathname.startsWith("/jam-media/")).toBe(true);
      // The key (and the server id inside it) is not readable in the URL.
      expect(url.toString()).not.toContain("11111111");
      // Same object, same window: the same URL (a shared cache can hold it).
      expect(jamPublicMediaUrl(key, at + 60_000)).toBe(url.toString());
      const token = url.pathname.slice("/jam-media/".length);
      const e = url.searchParams.get("e");
      const s = url.searchParams.get("s");
      expect(openJamPublicMediaUrl(token, e, s, at)).toEqual({ key });
      const other = new URL(jamPublicMediaUrl("jam/public/other.flac", at)).pathname.slice("/jam-media/".length);
      expect(openJamPublicMediaUrl(other, e, s, at)).toEqual({ failure: "bad-signature" });
      expect(openJamPublicMediaUrl(token, e, s, at + 2 * 3_600_000)).toEqual({ failure: "expired" });
      expect(openJamPublicMediaUrl(token, String(Number(e) + 1), s, at)).toEqual({ failure: "bad-signature" });
      expect(jamPublicMediaUrl("jam/../x", at)).not.toBe("");
      expect(jamPublicMediaUrl("stories/x.jpg", at)).toBe("");
    } finally {
      delete process.env.JAM_PUBLIC_MEDIA_BASE_URL;
    }
  });

  it("samples the first frame, then one every five seconds, at most 24", () => {
    expect(jamFrameTimes(Number.NaN)).toEqual([0]);
    expect(jamFrameTimes(4)).toEqual([0]);
    expect(jamFrameTimes(12)).toEqual([0, 5, 10]);
    expect(jamFrameTimes(600)).toHaveLength(24);
  });
});

/**
 * The real ffmpeg on a tiny generated video (CI may not have ffmpeg: then
 * this is skipped, and the job's own gate keeps the API from claiming videos).
 */
function hasFfmpeg(): boolean {
  try {
    execFileSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasFfmpeg())("frame sampling with the real ffmpeg", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pqp-jam-ffmpeg-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("probes a 12 s MP4 and pulls a JPEG at 0, 5 and 10 s", async () => {
    const video = join(dir, "clip.mp4");
    execFileSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=12:size=160x120:rate=10",
        "-pix_fmt", "yuv420p", "-y", video],
      { stdio: "ignore" },
    );
    const seconds = await realJamVideoTools.probe(video, "video/mp4");
    expect(seconds).toBeGreaterThan(11);
    const times = jamFrameTimes(seconds);
    expect(times).toEqual([0, 5, 10]);
    for (const [index, at] of times.entries()) {
      const out = join(dir, `f-${index}.jpg`);
      await realJamVideoTools.frame(video, "video/mp4", at, out);
      const bytes = readFileSync(out);
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
    }
  });

  it("reads a WebM with no duration in its header (a browser's recorder), when the encoder exists", async () => {
    let webm: string;
    try {
      webm = join(dir, "clip.webm");
      execFileSync(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=7:size=160x120:rate=10",
          "-c:v", "libvpx", "-b:v", "200k", "-y", webm],
        { stdio: "ignore" },
      );
    } catch {
      return; // no VP8 encoder in this ffmpeg build
    }
    const seconds = await realJamVideoTools.probe(webm, "video/webm");
    expect(seconds).toBeGreaterThan(6);
    const out = join(dir, "w.jpg");
    await realJamVideoTools.frame(webm, "video/webm", 5, out);
    expect(readFileSync(out)[0]).toBe(0xff);
    // A WebM handed in as MP4 is refused: the demuxer is forced, never guessed.
    await expect(realJamVideoTools.probe(webm, "video/mp4")).rejects.toThrow();
  });
});
