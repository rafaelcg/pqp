import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jamConfigSchema,
  jamFrameSchema,
  jamSongDetailResponseSchema,
  jamSongListResponseSchema,
  jamTrackSchema,
  jamUploadTicketSchema,
  jamVoteResponseSchema,
  JAM_MAX_TRACKS_PER_AUTHOR,
  JAM_MAX_TRACKS_PER_SONG,
  JAM_AUDIO_MAX_BYTES,
  JAM_COVER_MAX_BYTES,
  Permission,
  type JamFrame,
  type JamSongSummary,
  type JamTrack,
} from "@pqp/shared";

/**
 * Jam channels, end to end over HTTP on a real Postgres and a fake object
 * store that speaks just enough S3 (PUT, HEAD, GET, DELETE) for the REAL
 * `lib/s3.ts` to sign against and verify through: the presigned PUT the
 * route hands out is the one these tests upload to, and the claim's HEAD is a
 * real HEAD. The flag is set the way production sets it, as a row read after
 * `startFeatureFlags()` (pitfall 12), never through the environment.
 *
 * What is pinned here: the flag gate (off refuses every write that adds or
 * changes, never a read, and lets the four removals through), who may do
 * what, the `joinMode` rule on add-track (including after the song was closed
 * mid-upload), `in_mix` defaults, the track limits, the upload verification,
 * retries, votes, the timeline fields, the sweeps, the object keys read for
 * the cascades, and the frames each write announces. The cross-instance
 * delivery of those frames is `jam-two-process.test.ts`.
 */

// The repo-wide guard every DB suite uses (`TEST_DATABASE_URL ?? DATABASE_URL`;
// CI provides `DATABASE_URL`, and the per-worker setup in
// `test/setup/worker-database-env.ts` points both at a worker database), plus
// a localhost-only check on top because these suites TRUNCATE: a URL that
// points anywhere else makes them skip instead of truncating it.
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
delete process.env.READ_CACHE;

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
  frames: [] as unknown[],
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

// The real announce, with every frame kept for the assertions.
vi.mock("../ws/chat.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ws/chat.js")>();
  return {
    ...real,
    announceJam: (frame: unknown) => {
      stubs.frames.push(frame);
      real.announceJam(frame as never);
    },
  };
});

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createPqpServer, createChannel, deleteChannel, deleteServer } =
  await import("../services/servers.js");
const { createRole, assignRole, upsertChannelOverwrite } = await import("../services/roles.js");
const { issueTimeout } = await import("../services/sanctions.js");
const { resetSharedRateLimit } = await import("../lib/cluster-rate-limit.js");
const { resetFeatureFlagsForTests, setServerFlagOverride, startFeatureFlags } = await import(
  "../lib/flags.js"
);
const { sweepJamMedia, reducePeaks } = await import("../services/jam.js");
const { jamKeysForChannels, jamKeysForServer, jamKeysForUser } = await import(
  "../services/jam-keys.js"
);
const { postChannelMessage } = await import("../ws/chat.js");

// ------------------------------------------------------------ fake storage

interface StoredObject {
  type: string;
  body: Buffer;
}
const objects = new Map<string, StoredObject>();
const storage = { failDeletes: false, deleted: [] as string[] };
let s3: Server;
const BUCKET = "jam-test";

function startFakeS3(): Promise<string> {
  s3 = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = decodeURIComponent(url.pathname.replace(`/${BUCKET}/`, ""));
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(key, {
          type: String(req.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        });
        res.writeHead(200).end();
      });
      return;
    }
    const found = objects.get(key);
    if (req.method === "DELETE") {
      if (storage.failDeletes) {
        res.writeHead(500).end();
        return;
      }
      storage.deleted.push(key);
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
    s3.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(s3.address() as AddressInfo).port}`),
    ),
  );
}

// ------------------------------------------------------------------- harness

type Actor = { id: string; clerk_id: string };

let http: Server;
let baseUrl: string;
let alice: Actor; // owns the server: every permission
let bob: Actor;
let carol: Actor;
let dave: Actor; // member who may not post in the jam channel
let mod: Actor; // member holding MANAGE_MESSAGES
let eve: Actor; // not a member
let serverId: string;
let jamId: string;

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = Record<string, unknown>>(
  as: Actor,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: "Bearer test",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
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

async function join(user: Actor): Promise<void> {
  await getPool().query(
    `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
    [serverId, user.id],
  );
}

async function createSong(
  as: Actor,
  title = "Wonderwall",
  extra: Record<string, unknown> = {},
  channel = jamId,
) {
  return call<{ song: JamSongSummary; error?: string }>(
    as,
    "POST",
    `/api/channels/${channel}/jam-songs`,
    { title, ...extra },
  );
}

async function songId(
  as: Actor,
  title = "Wonderwall",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const reply = await createSong(as, title, extra);
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body.song.id;
}

/** Step 1 and 2: a ticket, and the bytes PUT where it says. Returns the upload id. */
async function upload(
  as: Actor,
  song: string,
  kind: "audio" | "video" = "audio",
  options: { contentType?: string; stored?: string; bytes?: Buffer; put?: boolean } = {},
): Promise<string> {
  const contentType = options.contentType ?? (kind === "audio" ? "audio/webm" : "video/mp4");
  const bytes = options.bytes ?? Buffer.from(`${kind}-bytes-${Math.random()}`);
  const ticket = await call(as, "POST", `/api/jam-songs/${song}/uploads`, {
    kind,
    contentType,
    byteSize: bytes.length,
  });
  expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
  const parsed = jamUploadTicketSchema.parse(ticket.body);
  if (options.put !== false) {
    const put = await fetch(parsed.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": options.stored ?? contentType },
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
  }
  return parsed.uploadId;
}

/** The whole flow for one audio track (and a video when asked). */
async function addTrack(
  as: Actor,
  song: string,
  instrument = "guitar",
  extra: Record<string, unknown> = {},
  options: { video?: boolean } = {},
) {
  const audioUploadId = await upload(as, song, "audio");
  const videoUploadId = options.video ? await upload(as, song, "video") : undefined;
  return call<{ track: JamTrack; song: JamSongSummary; error?: string }>(
    as,
    "POST",
    `/api/jam-songs/${song}/tracks`,
    {
      instrument,
      audioUploadId,
      ...(videoUploadId ? { videoUploadId } : {}),
      durationMs: 30_000,
      ...extra,
    },
  );
}

async function trackId(
  as: Actor,
  song: string,
  instrument = "guitar",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const reply = await addTrack(as, song, instrument, extra);
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body.track.id;
}

const detail = async (as: Actor, song: string) => {
  const reply = await call(as, "GET", `/api/jam-songs/${song}`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return jamSongDetailResponseSchema.parse(reply.body);
};

const flag = (on: boolean | null) =>
  setServerFlagOverride("jam_channels", serverId, on, { kind: "dashboard" });

/** The frames announced since the last call, parsed against the contract. */
function takeFrames(): JamFrame[] {
  const frames = stubs.frames.splice(0).map((frame) => jamFrameSchema.parse(frame));
  return frames;
}

describeDb("jam channels", () => {
  beforeAll(async () => {
    const endpoint = await startFakeS3();
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_BUCKET = BUCKET;
    process.env.S3_ACCESS_KEY_ID = "jam-test";
    process.env.S3_SECRET_ACCESS_KEY = "jam-test-secret";
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
    for (const name of [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_FORCE_PATH_STYLE",
    ]) {
      delete process.env[name];
    }
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    await resetSharedRateLimit("jam-song");
    await resetSharedRateLimit("jam-upload");
    objects.clear();
    storage.failDeletes = false;
    storage.deleted.length = 0;
    stubs.frames.length = 0;
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members,
                channel_members, channel_reads, channel_overwrites, roles,
                member_roles, audit_log, member_timeouts, feature_flags,
                feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    const make = async (name: string) =>
      (await upsertUser({
        clerkId: `clerk_jam_${name}`,
        displayName: name,
        avatarUrl: null,
      })) as Actor;
    alice = await make("Alice");
    bob = await make("Bob");
    carol = await make("Carol");
    dave = await make("Dave");
    mod = await make("Mod");
    eve = await make("Eve");
    serverId = (await createPqpServer("Banda", alice.id)).server.id;
    for (const user of [bob, carol, dave, mod]) {
      await join(user);
    }
    const role = await createRole(serverId, {
      name: "Moderadores",
      permissions: Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.MANAGE_MESSAGES,
    });
    await assignRole(serverId, mod.id, role.id);
    await startFeatureFlags();
    await flag(true);
    const channel = await call<{ channel: { id: string } }>(
      alice,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "jam", type: "jam" },
    );
    expect(channel.status).toBe(201);
    jamId = channel.body.channel.id;
    // Dave sees the channel but may not post in it.
    await upsertChannelOverwrite(jamId, serverId, "member", dave.id, 0n, Permission.SEND_MESSAGES);
    stubs.frames.length = 0;
  });

  // ------------------------------------------------------------------ flag

  it("is off by default: the config says so, and creating a jam channel is 403", async () => {
    await flag(null);
    const config = await call(bob, "GET", `/api/jam/config?serverId=${serverId}`);
    expect(config.status).toBe(200);
    expect(jamConfigSchema.parse(config.body)).toEqual({ enabled: false, uploads: true });
    const created = await call(alice, "POST", `/api/servers/${serverId}/channels`, {
      name: "outra",
      type: "jam",
    });
    expect(created.status).toBe(403);
    expect(created.body.error).toBe("jam_channels_off");
    // Every other type is untouched.
    expect(
      (await call(alice, "POST", `/api/servers/${serverId}/channels`, { name: "t", type: "text" }))
        .status,
    ).toBe(201);
  });

  it("a per-server override turns it on for that server only, and the database accepts the type", async () => {
    const other = (await createPqpServer("Outra", alice.id)).server.id;
    expect((await call(bob, "GET", `/api/jam/config?serverId=${serverId}`)).body.enabled).toBe(
      true,
    );
    expect((await call(bob, "GET", `/api/jam/config?serverId=${other}`)).body.enabled).toBe(false);
    expect((await call(bob, "GET", "/api/jam/config")).body.enabled).toBe(false);
    expect((await call(bob, "GET", "/api/jam/config?serverId=nope")).body.enabled).toBe(false);
    const row = await getPool().query<{ type: string }>(`SELECT type FROM channels WHERE id = $1`, [
      jamId,
    ]);
    expect(row.rows[0]?.type).toBe("jam");
  });

  it("off refuses every write that adds or changes, never a read, and lets the removals through", async () => {
    const song = await songId(alice);
    const mine = await trackId(bob, song, "bass");
    const upl = await upload(bob, song, "audio");
    expect((await call(bob, "PUT", `/api/jam-tracks/${mine}/vote`)).status).toBe(200);
    stubs.frames.length = 0;

    await flag(false);
    const off = (r: Reply) => {
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.error).toBe("jam_channels_off");
    };
    off(await createSong(alice, "Nova"));
    off(await call(alice, "PATCH", `/api/jam-songs/${song}`, { title: "Renomeada" }));
    off(await call(bob, "POST", `/api/jam-songs/${song}/uploads`, {
      kind: "audio",
      contentType: "audio/webm",
      byteSize: 10,
    }));
    off(await call(bob, "POST", `/api/jam-songs/${song}/tracks`, {
      instrument: "bass",
      audioUploadId: upl,
      durationMs: 1000,
    }));
    off(await call(bob, "PATCH", `/api/jam-tracks/${mine}`, { gain: 1.5 }));
    off(await call(carol, "PUT", `/api/jam-tracks/${mine}/vote`));
    expect(takeFrames()).toEqual([]);

    // Reads are untouched, the media URL still works, the config says paused.
    const read = await detail(carol, song);
    expect(read.tracks).toHaveLength(1);
    expect(read.viewer.addableInstruments).toEqual([]);
    expect(
      jamSongListResponseSchema.parse((await call(carol, "GET", `/api/channels/${jamId}/jam-songs`)).body)
        .songs,
    ).toHaveLength(1);
    expect((await fetch(read.tracks[0]!.audioUrl)).status).toBe(200);
    expect((await call(carol, "GET", `/api/jam/config?serverId=${serverId}`)).body.enabled).toBe(
      false,
    );

    // The three removals still work: the vote, the track, the song.
    expect((await call(bob, "DELETE", `/api/jam-tracks/${mine}/vote`)).status).toBe(200);
    expect((await call(bob, "DELETE", `/api/jam-tracks/${mine}`)).status).toBe(204);
    expect((await call(alice, "DELETE", `/api/jam-songs/${song}`)).status).toBe(204);
  });

  // ----------------------------------------------------------------- songs

  it("creates a song: open by default, an original, normalised, announced", async () => {
    const reply = await createSong(bob, "  Wonder   wall ");
    expect(reply.status).toBe(201);
    expect(reply.body.song).toMatchObject({
      title: "Wonder wall",
      artist: null,
      joinMode: "open",
      wantedInstruments: [],
      authorId: bob.id,
      authorName: "Bob",
      trackCount: 0,
      instruments: [],
      contributorCount: 0,
      mixDurationMs: null,
      channelId: jamId,
      serverId,
    });
    expect(takeFrames()).toEqual([
      { type: "jam-song-created", channelId: jamId, song: reply.body.song },
    ]);
  });

  it("a nonce retry answers the same song with 200 and writes nothing", async () => {
    const first = await createSong(bob, "Mesma", { nonce: "n-1" });
    const second = await createSong(bob, "Mesma", { nonce: "n-1" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.song.id).toBe(first.body.song.id);
    expect((await getPool().query(`SELECT 1 FROM jam_songs`)).rowCount).toBe(1);
    expect(takeFrames()).toHaveLength(1);
  });

  it("a deleted song's nonce does not block a new song, and a constraint is never a 500", async () => {
    const first = await createSong(bob, "Apagada", { nonce: "reuse-1" });
    expect(first.status).toBe(201);
    expect((await call(bob, "DELETE", `/api/jam-songs/${first.body.song.id}`)).status).toBe(204);
    // The same nonce again (a client that reuses one, or a retry that arrives
    // after the delete): a NEW song, not an error and not the deleted one.
    const second = await createSong(bob, "Nova", { nonce: "reuse-1" });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.song.id).not.toBe(first.body.song.id);
    expect(second.body.song.title).toBe("Nova");
    // And while that one is live the nonce is a retry key again.
    const retry = await createSong(bob, "Nova", { nonce: "reuse-1" });
    expect(retry.status).toBe(200);
    expect(retry.body.song.id).toBe(second.body.song.id);
    // Two creates with one fresh nonce fired at once: one song, the other
    // answered with it, never a constraint error.
    const raced = await Promise.all(
      [1, 2, 3, 4].map(() => createSong(carol, "Corrida", { nonce: "race-1" })),
    );
    expect(raced.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(raced.map((r) => r.body.song.id)).size).toBe(1);
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it("who may create: members who can post; not a muted member, not a stranger, not a non-jam channel", async () => {
    expect((await createSong(dave)).status).toBe(403);
    expect((await createSong(eve)).status).toBe(404);
    const text = await createChannel(serverId, "geral-2", "text");
    expect((await createSong(bob, "x", {}, text.id)).status).toBe(404);
    expect((await call(bob, "GET", `/api/channels/${text.id}/jam-songs`)).status).toBe(404);
    expect((await createSong(bob, "")).status).toBe(400);
    expect((await createSong(bob, "x", { joinMode: "private" })).status).toBe(400);
    expect((await createSong(bob, "x", { joinMode: "wanted" })).status).toBe(400);
    // A timed-out member takes no part (the channel path is covered by the
    // gate in handleApi, the song path by the route).
    await issueTimeout({ serverId, userId: carol.id, issuedBy: alice.id, minutes: 5 });
    expect((await createSong(carol)).status).toBe(403);
    const song = await songId(alice);
    expect(
      (await call(carol, "PUT", `/api/jam-tracks/${await trackId(bob, song)}/vote`)).status,
    ).toBe(403);
    expect((await call(carol, "PATCH", `/api/jam-songs/${song}`, { title: "x" })).status).toBe(403);
  });

  it("a private channel's songs fail closed", async () => {
    const secret = await createChannel(serverId, "secreta", "jam", true);
    const reply = await createSong(alice, "Segredo", {}, secret.id);
    expect(reply.status).toBe(201);
    expect((await call(bob, "GET", `/api/channels/${secret.id}/jam-songs`)).status).toBe(404);
    expect((await call(bob, "GET", `/api/jam-songs/${reply.body.song.id}`)).status).toBe(404);
    expect((await call(bob, "POST", `/api/jam-songs/${reply.body.song.id}/tracks`, {})).status).toBe(
      404,
    );
  });

  it("wanted needs instruments; leaving wanted clears them; an artist can be cleared", async () => {
    const song = await songId(alice, "Cover", { artist: "Oasis", joinMode: "wanted", wantedInstruments: ["bass", "drums"] });
    let summary = (await detail(bob, song)).song;
    expect(summary).toMatchObject({ artist: "Oasis", joinMode: "wanted", wantedInstruments: ["bass", "drums"] });

    const empty = await call(alice, "PATCH", `/api/jam-songs/${song}`, { wantedInstruments: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.error).toBe("jam_wanted_needs_instruments");

    const closed = await call<{ song: JamSongSummary }>(alice, "PATCH", `/api/jam-songs/${song}`, {
      joinMode: "closed",
      artist: null,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.song).toMatchObject({ joinMode: "closed", wantedInstruments: [], artist: null });
    // Back to wanted with nothing left over is the same refusal.
    expect(
      (await call(alice, "PATCH", `/api/jam-songs/${song}`, { joinMode: "wanted" })).status,
    ).toBe(422);
    summary = (await detail(bob, song)).song;
    expect(summary.joinMode).toBe("closed");
    expect(
      takeFrames().filter((f) => f.type === "jam-song-updated"),
    ).toHaveLength(1);
  });

  it("edit and delete: the author or a moderator, nobody else", async () => {
    const song = await songId(bob);
    expect((await call(carol, "PATCH", `/api/jam-songs/${song}`, { title: "Minha" })).status).toBe(403);
    expect((await call(carol, "DELETE", `/api/jam-songs/${song}`)).status).toBe(403);
    expect((await call(eve, "PATCH", `/api/jam-songs/${song}`, { title: "x" })).status).toBe(404);
    expect((await call(bob, "PATCH", `/api/jam-songs/${song}`, { title: "Do Bob" })).status).toBe(200);
    expect((await call(mod, "PATCH", `/api/jam-songs/${song}`, { title: "Do mod" })).status).toBe(200);
    expect((await call(alice, "PATCH", `/api/jam-songs/${song}`, { title: "Da Alice" })).status).toBe(200);
    expect((await call(bob, "PATCH", `/api/jam-songs/${song}`, {})).status).toBe(400);
    stubs.frames.length = 0;
    expect((await call(mod, "DELETE", `/api/jam-songs/${song}`)).status).toBe(204);
    expect(takeFrames()).toEqual([{ type: "jam-song-deleted", channelId: jamId, songId: song }]);
    expect((await call(bob, "GET", `/api/jam-songs/${song}`)).status).toBe(404);
    // Gone for good, and a second delete is the same 404.
    expect((await call(mod, "DELETE", `/api/jam-songs/${song}`)).status).toBe(404);
  });

  // ------------------------------------------------------------------ list

  it("lists a page at a time, newest activity first, with a keyset cursor", async () => {
    const ids: string[] = [];
    for (const title of ["Um", "Dois", "Três", "Quatro", "Cinco"]) {
      ids.push(await songId(bob, title));
      await new Promise((done) => setTimeout(done, 5));
    }
    const first = jamSongListResponseSchema.parse(
      (await call(carol, "GET", `/api/channels/${jamId}/jam-songs?limit=2`)).body,
    );
    expect(first.songs.map((s) => s.title)).toEqual(["Cinco", "Quatro"]);
    expect(first.nextCursor).not.toBeNull();
    const second = jamSongListResponseSchema.parse(
      (
        await call(
          carol,
          "GET",
          `/api/channels/${jamId}/jam-songs?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).body,
    );
    expect(second.songs.map((s) => s.title)).toEqual(["Três", "Dois"]);
    const third = jamSongListResponseSchema.parse(
      (
        await call(
          carol,
          "GET",
          `/api/channels/${jamId}/jam-songs?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`,
        )
      ).body,
    );
    expect(third.songs.map((s) => s.title)).toEqual(["Um"]);
    expect(third.nextCursor).toBeNull();

    // A bump (a track added to the oldest) moves it to the top of `activity`,
    // and `created` does not care.
    await trackId(carol, ids[0]!, "bass");
    const bumped = jamSongListResponseSchema.parse(
      (await call(carol, "GET", `/api/channels/${jamId}/jam-songs?limit=1`)).body,
    );
    expect(bumped.songs[0]!.title).toBe("Um");
    const created = jamSongListResponseSchema.parse(
      (await call(carol, "GET", `/api/channels/${jamId}/jam-songs?limit=1&sort=created`)).body,
    );
    expect(created.songs[0]!.title).toBe("Cinco");
    // A cursor that is garbage is page one, never a 500.
    expect(
      (await call(carol, "GET", `/api/channels/${jamId}/jam-songs?cursor=lixo`)).status,
    ).toBe(200);
  });

  it("paging loses no song when several were written in the same millisecond", async () => {
    // Straight into the table, one statement: every row shares a timestamp
    // down to the microsecond except the id, the worst case for a keyset.
    await getPool().query(
      `INSERT INTO jam_songs (channel_id, server_id, author_id, title, created_at, updated_at)
       SELECT $1, $2, $3, 'S' || g, NOW(), NOW() + (g || ' microseconds')::interval
         FROM generate_series(1, 7) g`,
      [jamId, serverId, bob.id],
    );
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page += 1) {
      const reply = jamSongListResponseSchema.parse(
        (await call(carol, "GET", `/api/channels/${jamId}/jam-songs?limit=2${cursor}`)).body,
      );
      seen.push(...reply.songs.map((s) => s.title));
      if (!reply.nextCursor) {
        break;
      }
      cursor = `&cursor=${encodeURIComponent(reply.nextCursor)}`;
    }
    expect(seen).toEqual(["S7", "S6", "S5", "S4", "S3", "S2", "S1"]);
  });

  it("filters: title and artist without accents or case, who is wanted, mine; deleted songs never show", async () => {
    await songId(bob, "Águas de Março", { artist: "Elis Regina" });
    await songId(carol, "Another Brick", { artist: "Pink Floyd", joinMode: "wanted", wantedInstruments: ["bass"] });
    const gone = await songId(carol, "Apagada");
    await call(carol, "DELETE", `/api/jam-songs/${gone}`);
    const titles = async (query: string) =>
      jamSongListResponseSchema
        .parse((await call(alice, "GET", `/api/channels/${jamId}/jam-songs?${query}`)).body)
        .songs.map((s) => s.title)
        .sort();
    expect(await titles("")).toEqual(["Another Brick", "Águas de Março"]);
    expect(await titles("q=aguas")).toEqual(["Águas de Março"]);
    expect(await titles("q=ÁGUAS%20DE")).toEqual(["Águas de Março"]);
    expect(await titles("q=floyd")).toEqual(["Another Brick"]);
    expect(await titles("q=100%25")).toEqual([]);
    expect(await titles("wanting=bass")).toEqual(["Another Brick"]);
    expect(await titles("wanting=drums")).toEqual([]);
    expect(
      jamSongListResponseSchema
        .parse((await call(carol, "GET", `/api/channels/${jamId}/jam-songs?mine=true`)).body)
        .songs.map((s) => s.title),
    ).toEqual(["Another Brick"]);
    expect((await call(alice, "GET", `/api/channels/${jamId}/jam-songs?wanting=kazoo`)).status).toBe(
      400,
    );
  });

  // -------------------------------------------------------------- join mode

  it("open: anybody who can post adds any instrument; the detail says so", async () => {
    const song = await songId(alice);
    const reply = await addTrack(bob, song, "vocals");
    expect(reply.status).toBe(201);
    expect((await detail(carol, song)).viewer.addableInstruments).toEqual([
      "guitar",
      "bass",
      "drums",
      "vocals",
      "keys",
      "other",
    ]);
    // A member who may not post gets nothing, and no upload ticket.
    expect((await detail(dave, song)).viewer.addableInstruments).toEqual([]);
    const refused = await call(dave, "POST", `/api/jam-songs/${song}/uploads`, {
      kind: "audio",
      contentType: "audio/webm",
      byteSize: 10,
    });
    expect(refused.status).toBe(403);
  });

  it("wanted: only the wanted instruments from other people; the author adds anything", async () => {
    const song = await songId(alice, "Procura-se", { joinMode: "wanted", wantedInstruments: ["bass", "drums"] });
    expect((await detail(bob, song)).viewer.addableInstruments).toEqual(["bass", "drums"]);
    expect((await detail(alice, song)).viewer.addableInstruments).toHaveLength(6);

    const wrong = await addTrack(bob, song, "guitar");
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("jam_instrument_not_wanted");
    expect((await addTrack(bob, song, "bass")).status).toBe(201);
    // A moderator is bound by it too when adding their own.
    expect((await addTrack(mod, song, "keys")).status).toBe(403);
    expect((await addTrack(alice, song, "keys")).status).toBe(201);
  });

  it("closed: only the author adds, and nobody else gets a signed URL", async () => {
    const song = await songId(alice, "Só minha", { joinMode: "closed" });
    const ticket = await call(bob, "POST", `/api/jam-songs/${song}/uploads`, {
      kind: "audio",
      contentType: "audio/webm",
      byteSize: 10,
    });
    expect(ticket.status).toBe(403);
    expect(ticket.body.error).toBe("jam_song_closed");
    expect((await detail(bob, song)).viewer.addableInstruments).toEqual([]);
    expect((await detail(alice, song)).viewer.addableInstruments).toHaveLength(6);
    expect((await addTrack(alice, song, "guitar")).status).toBe(201);
    expect((await call(mod, "POST", `/api/jam-songs/${song}/uploads`, {
      kind: "audio",
      contentType: "audio/webm",
      byteSize: 10,
    })).status).toBe(403);
  });

  it("the rule is checked again at the claim: closed while the file was uploading", async () => {
    const song = await songId(alice);
    const audioUploadId = await upload(bob, song, "audio");
    expect((await call(alice, "PATCH", `/api/jam-songs/${song}`, { joinMode: "closed" })).status).toBe(
      200,
    );
    const claim = await call(bob, "POST", `/api/jam-songs/${song}/tracks`, {
      instrument: "bass",
      audioUploadId,
      durationMs: 5000,
    });
    expect(claim.status).toBe(403);
    expect(claim.body.error).toBe("jam_song_closed");
    expect((await getPool().query(`SELECT 1 FROM jam_tracks`)).rowCount).toBe(0);
    // And the upload is still unclaimed: nothing was spent.
    expect(
      (await getPool().query(`SELECT 1 FROM jam_uploads WHERE claimed_at IS NOT NULL`)).rowCount,
    ).toBe(0);
  });

  // ---------------------------------------------------------------- tracks

  it("adds a track end to end and says what it is, with working media URLs", async () => {
    const song = await songId(alice);
    const reply = await addTrack(
      bob,
      song,
      "guitar",
      { label: "Take 1, com pedal", offsetMs: -120.5, trimStartMs: 200, trimEndMs: 100, gain: 1.25, peaks: [0.1, 0.9, 0.4] },
      { video: true },
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const track = jamTrackSchema.parse(reply.body.track);
    expect(track).toMatchObject({
      songId: song,
      authorId: bob.id,
      authorName: "Bob",
      instrument: "guitar",
      label: "Take 1, com pedal",
      audioContentType: "audio/webm",
      videoContentType: "video/mp4",
      offsetMs: -120.5,
      trimStartMs: 200,
      trimEndMs: 100,
      durationMs: 30_000,
      gain: 1.25,
      peaks: [0.1, 0.9, 0.4],
      inMix: true,
      voteCount: 0,
    });
    expect(track.audioBytes).toBeGreaterThan(0);
    expect(track.videoBytes).toBeGreaterThan(0);
    expect(Date.parse(track.mediaExpiresAt)).toBeGreaterThan(Date.now());
    // The URLs the track carries serve the bytes that were uploaded.
    const audio = await fetch(track.audioUrl);
    expect(audio.status).toBe(200);
    expect(Buffer.from(await audio.arrayBuffer()).length).toBe(track.audioBytes);
    expect((await fetch(track.videoUrl!)).status).toBe(200);
    // The song's summary moved: one track, one contributor, a mix of the played length.
    expect(reply.body.song).toMatchObject({
      trackCount: 1,
      instruments: ["guitar"],
      contributorCount: 1,
      mixDurationMs: 30_000 - 200 - 100,
    });
    expect(takeFrames().map((f) => f.type)).toEqual(["jam-song-created", "jam-track-added"]);
    // Both uploads are claimed.
    expect(
      (await getPool().query(`SELECT 1 FROM jam_uploads WHERE claimed_at IS NOT NULL`)).rowCount,
    ).toBe(2);
  });

  it("in_mix: the first take of an instrument plays, later takes wait, and an emptied instrument starts over", async () => {
    const song = await songId(alice);
    const first = await trackId(bob, song, "guitar");
    const second = await trackId(carol, song, "guitar");
    const bass = await trackId(carol, song, "bass");
    const inMix = async () =>
      Object.fromEntries((await detail(alice, song)).tracks.map((t) => [t.id, t.inMix]));
    expect(await inMix()).toEqual({ [first]: true, [second]: false, [bass]: true });
    // Delete the playing take: another take of the instrument is still there,
    // so a new one is a later take (the song's author turns one on).
    expect((await call(bob, "DELETE", `/api/jam-tracks/${first}`)).status).toBe(204);
    const third = await trackId(bob, song, "guitar");
    expect(await inMix()).toEqual({ [second]: false, [bass]: true, [third]: false });
    // With no live take of the instrument left, the next one is the first again.
    expect((await call(bob, "DELETE", `/api/jam-tracks/${third}`)).status).toBe(204);
    expect((await call(carol, "DELETE", `/api/jam-tracks/${second}`)).status).toBe(204);
    const fourth = await trackId(bob, song, "guitar");
    expect(await inMix()).toEqual({ [bass]: true, [fourth]: true });
  });

  it("verifies the object: never uploaded, wrong stored type, another person's, another song's, used twice", async () => {
    const song = await songId(alice);
    const other = await songId(alice, "Outra");
    const claim = (as: Actor, audioUploadId: string, target = song) =>
      call(as, "POST", `/api/jam-songs/${target}/tracks`, {
        instrument: "bass",
        audioUploadId,
        durationMs: 5000,
      });

    const never = await upload(bob, song, "audio", { put: false });
    const missing = await claim(bob, never);
    expect(missing.status).toBe(422);
    expect(missing.body.error).toBe("jam_upload_not_verified");

    // Stored as something other than what was signed.
    const wrongType = await upload(bob, song, "audio", { stored: "audio/ogg" });
    expect((await claim(bob, wrongType)).status).toBe(422);

    const mine = await upload(bob, song, "audio");
    expect((await claim(carol, mine)).status).toBe(404);
    expect((await claim(bob, mine, other)).status).toBe(404);
    expect((await claim(bob, "11111111-1111-4111-8111-111111111111")).status).toBe(404);
    // A video upload is not an audio upload.
    const video = await upload(bob, song, "video");
    expect((await claim(bob, video)).status).toBe(404);
    expect((await claim(bob, mine)).status).toBe(201);
  });

  it("a retried claim returns the same track with 200 and adds nothing", async () => {
    const song = await songId(alice);
    const audioUploadId = await upload(bob, song, "audio");
    const body = { instrument: "drums", audioUploadId, durationMs: 9000 };
    const first = await call<{ track: JamTrack }>(bob, "POST", `/api/jam-songs/${song}/tracks`, body);
    const second = await call<{ track: JamTrack }>(bob, "POST", `/api/jam-songs/${song}/tracks`, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.track.id).toBe(first.body.track.id);
    expect((await getPool().query(`SELECT 1 FROM jam_tracks`)).rowCount).toBe(1);
    // A retry still answers after the song was closed meanwhile: the track
    // exists, so there is nothing left to refuse.
    await call(alice, "PATCH", `/api/jam-songs/${song}`, { joinMode: "closed" });
    const late = await call<{ track: JamTrack }>(bob, "POST", `/api/jam-songs/${song}/tracks`, body);
    expect(late.status).toBe(200);
    expect(late.body.track.id).toBe(first.body.track.id);
    await call(alice, "PATCH", `/api/jam-songs/${song}`, { joinMode: "open" });
    // Two concurrent retries land on one track too.
    const audio2 = await upload(bob, song, "audio");
    const racing = await Promise.all(
      [1, 2, 3].map(() =>
        call<{ track: JamTrack }>(bob, "POST", `/api/jam-songs/${song}/tracks`, {
          instrument: "keys",
          audioUploadId: audio2,
          durationMs: 4000,
        }),
      ),
    );
    expect(racing.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(racing.map((r) => r.body.track.id)).size).toBe(1);
    expect((await getPool().query(`SELECT 1 FROM jam_tracks`)).rowCount).toBe(2);
  });

  it("claims fired at once with one upload make exactly one track, and every one of them is answered with it", async () => {
    // The race this pins: a retry whose probe ("is there already a track for
    // this upload?") ran before the first claim committed, and whose upload
    // lookup ran after it, used to find the upload claimed and answer 404
    // `jam_upload_unknown` for a track that now exists. Many rounds of many
    // concurrent claims, because it is a window of a few milliseconds.
    for (let round = 0; round < 12; round += 1) {
      // The API's own per-person request limiter is not what is tested here.
      resetApiRateLimits();
      await resetSharedRateLimit("jam-upload");
      await resetSharedRateLimit("jam-song");
      const song = await songId(alice, `Rodada ${round}`);
      const audioUploadId = await upload(bob, song, "audio");
      const replies = await Promise.all(
        Array.from({ length: 8 }, () =>
          call<{ track: JamTrack; error?: string }>(bob, "POST", `/api/jam-songs/${song}/tracks`, {
            instrument: round % 2 === 0 ? "keys" : "other",
            audioUploadId,
            durationMs: 4000,
          }),
        ),
      );
      const summary = replies.map((r) => `${r.status}${r.body.error ? ` ${r.body.error}` : ""}`);
      expect(
        replies.every((r) => r.status === 200 || r.status === 201),
        `round ${round}: ${summary.join(", ")}`,
      ).toBe(true);
      expect(replies.filter((r) => r.status === 201), `round ${round}`).toHaveLength(1);
      expect(new Set(replies.map((r) => r.body.track.id)).size, `round ${round}`).toBe(1);
      const stored = await getPool().query(
        `SELECT 1 FROM jam_tracks WHERE audio_upload_id = $1`,
        [audioUploadId],
      );
      expect(stored.rowCount, `round ${round}`).toBe(1);
    }
  });

  it("a retry of the claim that took the person's last allowed track is answered with it, not a limit error", async () => {
    const song = await songId(alice);
    await getPool().query(
      `INSERT INTO jam_tracks (song_id, author_id, instrument, audio_key, audio_content_type, audio_bytes, duration_ms)
       SELECT $1, $2, 'other', 'k/' || g, 'audio/webm', 10, 1000 FROM generate_series(1, $3) g`,
      [song, bob.id, JAM_MAX_TRACKS_PER_AUTHOR - 1],
    );
    const audioUploadId = await upload(bob, song, "audio");
    const body = { instrument: "keys", audioUploadId, durationMs: 4000 };
    const replies = await Promise.all(
      Array.from({ length: 6 }, () =>
        call<{ track: JamTrack; error?: string }>(bob, "POST", `/api/jam-songs/${song}/tracks`, body),
      ),
    );
    const summary = replies.map((r) => `${r.status}${r.body.error ? ` ${r.body.error}` : ""}`).join(", ");
    expect(replies.every((r) => r.status === 200 || r.status === 201), summary).toBe(true);
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    // And the same retry, sequentially, long after: still the track.
    const late = await call<{ track: JamTrack }>(bob, "POST", `/api/jam-songs/${song}/tracks`, body);
    expect(late.status).toBe(200);
    // A genuinely new claim past the limit is still refused.
    const next = await addTrack(bob, song, "bass");
    expect(next.status).toBe(409);
  });

  it("mint: only the allowed types and sizes, with a jam limit rather than the attachment one", async () => {
    const song = await songId(alice);
    const mint = (extra: Record<string, unknown>) =>
      call(bob, "POST", `/api/jam-songs/${song}/uploads`, {
        kind: "audio",
        contentType: "audio/webm",
        byteSize: 1000,
        ...extra,
      });
    expect((await mint({ contentType: "audio/wav" })).status).toBe(400);
    expect((await mint({ contentType: "image/png" })).status).toBe(400);
    expect((await mint({ kind: "video" })).status).toBe(400);
    expect((await mint({ byteSize: 0 })).status).toBe(400);
    // 25 MB is over a message attachment's 10 MiB and fine for a stem.
    expect((await mint({ byteSize: 25 * 1024 * 1024 })).status).toBe(201);
    const huge = await mint({ byteSize: JAM_AUDIO_MAX_BYTES + 1 });
    expect(huge.status).toBe(413);
    expect(huge.body.error).toBe("jam_upload_too_large");
    expect(
      (await mint({ kind: "video", contentType: "video/webm", byteSize: 60 * 1024 * 1024 })).status,
    ).toBe(201);
    // The key is the server's: under the server and song, never the client's.
    const keys = await getPool().query<{ storage_key: string }>(`SELECT storage_key FROM jam_uploads`);
    for (const row of keys.rows) {
      expect(row.storage_key).toMatch(new RegExp(`^jam/${serverId}/${song}/[0-9a-f-]{36}\\.`));
    }
  });

  it("is off when storage is not configured", async () => {
    const song = await songId(alice);
    const kept = { ...process.env };
    delete process.env.S3_ENDPOINT;
    try {
      const config = await call(bob, "GET", `/api/jam/config?serverId=${serverId}`);
      expect(config.body).toEqual({ enabled: true, uploads: false });
      const ticket = await call(bob, "POST", `/api/jam-songs/${song}/uploads`, {
        kind: "audio",
        contentType: "audio/webm",
        byteSize: 10,
      });
      expect(ticket.status).toBe(503);
      expect(ticket.body.error).toBe("jam_storage_off");
    } finally {
      process.env.S3_ENDPOINT = kept.S3_ENDPOINT;
    }
  });

  it("rate limits tickets and songs per person across the cluster", async () => {
    const song = await songId(alice);
    const mint = () =>
      call(bob, "POST", `/api/jam-songs/${song}/uploads`, {
        kind: "audio",
        contentType: "audio/webm",
        byteSize: 10,
      });
    let status = 201;
    for (let i = 0; i < 40 && status === 201; i += 1) {
      status = (await mint()).status;
    }
    expect(status).toBe(429);
    for (let i = 0; i < 12 && status !== 429; i += 1) {
      status = (await createSong(carol, `S${i}`)).status;
    }
    expect(status).toBe(429);
  });

  it("limits: a song holds 32 tracks and one person 8 of them", async () => {
    const song = await songId(alice);
    const insert = (author: Actor, n: number) =>
      getPool().query(
        `INSERT INTO jam_tracks (song_id, author_id, instrument, audio_key, audio_content_type, audio_bytes, duration_ms)
         SELECT $1, $2, 'other', 'k/' || g, 'audio/webm', 10, 1000 FROM generate_series(1, $3) g`,
        [song, author.id, n],
      );
    await insert(bob, JAM_MAX_TRACKS_PER_AUTHOR);
    const mine = await addTrack(bob, song, "bass");
    expect(mine.status).toBe(409);
    expect(mine.body.error).toBe("jam_author_track_limit");
    expect((await detail(bob, song)).viewer.addableInstruments).toEqual([]);
    expect((await detail(carol, song)).viewer.addableInstruments).toHaveLength(6);
    await insert(carol, JAM_MAX_TRACKS_PER_SONG - JAM_MAX_TRACKS_PER_AUTHOR);
    const full = await addTrack(mod, song, "bass");
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("jam_song_full");
    expect((await detail(mod, song)).viewer.addableInstruments).toEqual([]);
  });

  it("the song preview: waveform, video flag, contributors and missing instruments, in the list, the detail and the frames", async () => {
    const song = await songId(alice, "Procura-se baixo", {
      joinMode: "wanted",
      wantedInstruments: ["bass", "drums"],
    });
    // Empty first.
    const empty = (await detail(carol, song)).song;
    expect(empty).toMatchObject({
      previewPeaks: [],
      hasVideo: false,
      contributors: [],
      missingInstruments: ["bass", "drums"],
    });

    // A quiet guitar (in the mix), a louder second guitar take (NOT in the
    // mix), then drums with a video: the preview takes the loudest IN-MIX stem.
    const quiet = Array.from({ length: 400 }, () => 0.1);
    const loud = Array.from({ length: 400 }, (_, i) => (i === 399 ? 1 : 0.5));
    const drums = Array.from({ length: 10 }, () => 0.3);
    await addTrack(alice, song, "guitar", { peaks: quiet });
    await addTrack(alice, song, "guitar", { peaks: loud }); // later take: not in the mix
    stubs.frames.length = 0;
    const withVideo = await addTrack(bob, song, "drums", { peaks: drums }, { video: true });
    expect(withVideo.status).toBe(201);

    const read = (await detail(carol, song)).song;
    expect(read.hasVideo).toBe(true);
    // Drums sum to 3.0, the in-mix guitar to 40: the guitar is the preview, 64 values.
    expect(read.previewPeaks).toHaveLength(64);
    expect(read.previewPeaks.every((v) => v === 0.1)).toBe(true);
    expect(read.contributors.map((c) => c.name)).toEqual(["Alice", "Bob"]);
    expect(read.contributorCount).toBe(2);
    // Bass is still missing, drums is covered.
    expect(read.missingInstruments).toEqual(["bass"]);

    // The same fields in the list, the frame and the add answer: one query.
    const listed = jamSongListResponseSchema.parse(
      (await call(carol, "GET", `/api/channels/${jamId}/jam-songs`)).body,
    ).songs.find((s) => s.id === song)!;
    expect(listed).toEqual(read);
    expect(withVideo.body.song).toEqual(read);
    const added = takeFrames().find((f) => f.type === "jam-track-added")!;
    expect((added as Extract<JamFrame, { type: "jam-track-added" }>).song).toEqual(read);

    // Turning the loud take on and the quiet one off changes the preview, and a
    // non-wanted song never lists missing instruments.
    const tracks = (await detail(alice, song)).tracks.filter((t) => t.instrument === "guitar");
    await call(alice, "PATCH", `/api/jam-tracks/${tracks[0]!.id}`, { inMix: false });
    await call(alice, "PATCH", `/api/jam-tracks/${tracks[1]!.id}`, { inMix: true });
    const swapped = (await detail(carol, song)).song;
    expect(swapped.previewPeaks[63]).toBe(1);
    expect(swapped.previewPeaks[0]).toBe(0.5);
    await call(alice, "PATCH", `/api/jam-songs/${song}`, { joinMode: "open" });
    expect((await detail(carol, song)).song.missingInstruments).toEqual([]);
  });

  it("the preview names at most four contributors, nicknames first, and a removed track drops its person", async () => {
    const song = await songId(alice);
    const people = [alice, bob, carol, mod, dave];
    // Dave may not post, so his track goes in directly.
    for (const person of [alice, bob, carol, mod]) {
      await trackId(person, song, "other");
      await new Promise((done) => setTimeout(done, 5));
    }
    await getPool().query(
      `INSERT INTO jam_tracks (song_id, author_id, instrument, audio_key, audio_content_type, audio_bytes, duration_ms)
       VALUES ($1, $2, 'other', 'k/dave', 'audio/webm', 10, 1000)`,
      [song, dave.id],
    );
    await getPool().query(`UPDATE server_members SET nickname = 'Robertão' WHERE user_id = $1`, [bob.id]);
    const summary = (await detail(carol, song)).song;
    expect(people).toHaveLength(5);
    expect(summary.contributorCount).toBe(5);
    expect(summary.contributors).toHaveLength(4);
    expect(summary.contributors.map((c) => c.name)).toEqual(["Alice", "Robertão", "Carol", "Mod"]);
    const own = (await detail(alice, song)).tracks.find((t) => t.authorId === alice.id)!;
    await call(alice, "DELETE", `/api/jam-tracks/${own.id}`);
    expect((await detail(carol, song)).song.contributors.map((c) => c.name)).toEqual([
      "Robertão",
      "Carol",
      "Mod",
      "Dave",
    ]);
  });

  it("reducePeaks keeps the loudest value of each bucket and never exceeds 64", () => {
    expect(reducePeaks([0.1, 0.2])).toEqual([0.1, 0.2]);
    const spike = Array.from({ length: 400 }, (_, i) => (i === 123 ? 0.9 : 0.05));
    const reduced = reducePeaks(spike);
    expect(reduced).toHaveLength(64);
    expect(Math.max(...reduced)).toBe(0.9);
    expect(reducePeaks([2, -1, Number.NaN])).toEqual([1, 0, 0]);
  });

  it("trims and the mix length: the played slice, offsets either side of zero", async () => {
    const song = await songId(alice);
    expect(
      (await addTrack(bob, song, "bass", { trimStartMs: 20_000, trimEndMs: 10_000 })).status,
    ).toBe(400);
    await trackId(bob, song, "guitar", { offsetMs: 0, durationMs: 30_000 });
    await trackId(carol, song, "bass", { offsetMs: -2_000, durationMs: 10_000 });
    const summary = (await detail(alice, song)).song;
    // Starts at -2 s (the bass), ends at 30 s (the guitar).
    expect(summary.mixDurationMs).toBe(32_000);
    expect(summary.instruments).toEqual(["guitar", "bass"]);
    expect(summary.contributorCount).toBe(2);
  });

  it("the mix length is earliest heard sample to latest, for takes shaped like the web recorder's uploads", async () => {
    // Three takes as the web uploads them (`offsetMs` is the song time of the file's first sample, a trim hides
    // audio without moving it): a count-in take, a camera take trimmed in the editor, a count-in take at 44.1 kHz.
    // Heard slices: guitar 0..60 s, bass 0.5..59 s, keys 0..60 s, so the mix is 60 s. The old arithmetic (the
    // earliest OFFSET to the latest end minus BOTH trims) said 62.05 s - 2.05 s of count-in nobody hears.
    const song = await songId(alice);
    await trackId(alice, song, "guitar", {
      offsetMs: -2023,
      trimStartMs: 2023,
      trimEndMs: 0,
      durationMs: 62_023,
    });
    await trackId(bob, song, "bass", {
      offsetMs: -137,
      trimStartMs: 637,
      trimEndMs: 1000,
      durationMs: 60_137,
    });
    const keys = await addTrack(carol, song, "keys", {
      offsetMs: -2050,
      trimStartMs: 2050,
      trimEndMs: 0,
      durationMs: 62_050,
    });
    expect(keys.status, JSON.stringify(keys.body)).toBe(201);
    expect(keys.body.song.mixDurationMs).toBe(60_000);
    expect((await detail(alice, song)).song.mixDurationMs).toBe(60_000);
    // It is computed on read (nothing stores it), so a later take moves it with nothing to recompute: drums
    // heard 0.1 s to 70.1 s make the mix 70.1 s.
    await trackId(mod, song, "drums", { offsetMs: 100, durationMs: 70_000 });
    expect((await detail(alice, song)).song.mixDurationMs).toBe(70_100);
  });

  // ------------------------------------------------------------ track edits

  it("the track's author owns label, offset, trims and gain; nobody else, not even the song's author", async () => {
    const song = await songId(alice);
    const track = await trackId(bob, song, "guitar", { durationMs: 20_000 });
    stubs.frames.length = 0;
    const edited = await call<{ track: JamTrack; song: JamSongSummary }>(
      bob,
      "PATCH",
      `/api/jam-tracks/${track}`,
      { label: "Take 2", offsetMs: 150.25, trimStartMs: 500, trimEndMs: 250, gain: 0.5 },
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.track).toMatchObject({
      label: "Take 2",
      offsetMs: 150.25,
      trimStartMs: 500,
      trimEndMs: 250,
      gain: 0.5,
      inMix: true,
    });
    expect(edited.body.song.mixDurationMs).toBe(20_000 - 750);
    expect(takeFrames().map((f) => f.type)).toEqual(["jam-track-updated"]);

    for (const as of [alice, mod, carol]) {
      const refused = await call(as, "PATCH", `/api/jam-tracks/${track}`, { gain: 1 });
      expect(refused.status, `${as.id}`).toBe(403);
    }
    expect((await call(eve, "PATCH", `/api/jam-tracks/${track}`, { gain: 1 })).status).toBe(404);
    // Bounds: gain 0..2, a trim that leaves nothing is 422 against the stored
    // length, `label: null` clears.
    expect((await call(bob, "PATCH", `/api/jam-tracks/${track}`, { gain: 2.01 })).status).toBe(400);
    expect((await call(bob, "PATCH", `/api/jam-tracks/${track}`, { gain: 2 })).status).toBe(200);
    const trim = await call(bob, "PATCH", `/api/jam-tracks/${track}`, { trimEndMs: 19_500 });
    expect(trim.status).toBe(422);
    expect(trim.body.error).toBe("jam_trim_invalid");
    const cleared = await call<{ track: JamTrack }>(bob, "PATCH", `/api/jam-tracks/${track}`, {
      label: null,
    });
    expect(cleared.body.track.label).toBeNull();
    expect((await call(bob, "PATCH", `/api/jam-tracks/${track}`, {})).status).toBe(400);
    // A gain comes back as it was sent, not as a single-precision neighbour.
    expect(
      (await call<{ track: JamTrack }>(bob, "PATCH", `/api/jam-tracks/${track}`, { gain: 1.1 })).body
        .track.gain,
    ).toBe(1.1);
    // The instrument is not editable.
    expect(
      (await call<{ track: JamTrack }>(bob, "PATCH", `/api/jam-tracks/${track}`, { instrument: "bass", gain: 1 }))
        .body.track.instrument,
    ).toBe("guitar");
  });

  it("in_mix is the song author's or a moderator's, never the track author's", async () => {
    const song = await songId(alice);
    const first = await trackId(bob, song, "guitar");
    const take2 = await trackId(bob, song, "guitar");
    const set = (as: Actor, id: string, inMix: boolean) =>
      call<{ track: JamTrack; song: JamSongSummary }>(as, "PATCH", `/api/jam-tracks/${id}`, { inMix });
    expect((await set(bob, take2, true)).status).toBe(403);
    expect((await set(carol, take2, true)).status).toBe(403);
    // Swap the takes: the song's author and then a moderator.
    expect((await set(alice, first, false)).body.track.inMix).toBe(false);
    expect((await set(mod, take2, true)).body.track.inMix).toBe(true);
    // Mixed fields need both rights: the song's author does not own Bob's gain.
    expect(
      (await call(alice, "PATCH", `/api/jam-tracks/${take2}`, { inMix: false, gain: 1 })).status,
    ).toBe(403);
    // A song author can mix their own take AND nudge it.
    const own = await trackId(alice, song, "bass");
    expect(
      (await call(alice, "PATCH", `/api/jam-tracks/${own}`, { inMix: false, gain: 1.1 })).status,
    ).toBe(200);
    const summary = (await detail(alice, song)).song;
    expect(summary.trackCount).toBe(3);
  });

  it("delete a track: its author, the song's author or a moderator; its objects wait for the sweep", async () => {
    const song = await songId(alice);
    const track = await trackId(bob, song, "bass");
    const keysBefore = [...objects.keys()];
    expect(keysBefore).toHaveLength(1);
    expect((await call(carol, "DELETE", `/api/jam-tracks/${track}`)).status).toBe(403);
    expect((await call(eve, "DELETE", `/api/jam-tracks/${track}`)).status).toBe(404);
    stubs.frames.length = 0;
    expect((await call(bob, "DELETE", `/api/jam-tracks/${track}`)).status).toBe(204);
    const frames = takeFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "jam-track-deleted", trackId: track, channelId: jamId });
    expect((frames[0] as Extract<JamFrame, { type: "jam-track-deleted" }>).song.trackCount).toBe(0);
    expect((await call(bob, "DELETE", `/api/jam-tracks/${track}`)).status).toBe(404);
    expect((await detail(alice, song)).tracks).toEqual([]);
    // Soft: the object is still there until the sweep a day later.
    expect([...objects.keys()]).toEqual(keysBefore);

    const second = await trackId(carol, song, "keys");
    expect((await call(alice, "DELETE", `/api/jam-tracks/${second}`)).status).toBe(204);
    const third = await trackId(carol, song, "keys");
    expect((await call(mod, "DELETE", `/api/jam-tracks/${third}`)).status).toBe(204);
  });

  it("deleting a song takes its tracks with it", async () => {
    const song = await songId(alice);
    const track = await trackId(bob, song);
    expect((await call(alice, "DELETE", `/api/jam-songs/${song}`)).status).toBe(204);
    expect((await call(bob, "GET", `/api/jam-songs/${song}`)).status).toBe(404);
    expect((await call(bob, "PUT", `/api/jam-tracks/${track}/vote`)).status).toBe(404);
    const live = await getPool().query(`SELECT 1 FROM jam_tracks WHERE deleted_at IS NULL`);
    expect(live.rowCount).toBe(0);
  });

  // ----------------------------------------------------------------- votes

  it("votes: one per person per track, idempotent both ways, counted, framed only when it moved", async () => {
    const song = await songId(alice);
    const track = await trackId(bob, song);
    stubs.frames.length = 0;
    const vote = async (as: Actor, method: "PUT" | "DELETE") =>
      jamVoteResponseSchema.parse((await call(as, method, `/api/jam-tracks/${track}/vote`)).body);
    expect(await vote(carol, "PUT")).toMatchObject({ voteCount: 1, voted: true, trackId: track, songId: song });
    expect(await vote(carol, "PUT")).toMatchObject({ voteCount: 1, voted: true });
    expect(await vote(alice, "PUT")).toMatchObject({ voteCount: 2 });
    expect(await vote(bob, "PUT")).toMatchObject({ voteCount: 3 });
    expect(takeFrames().map((f) => (f.type === "jam-track-votes" ? f.voteCount : f.type))).toEqual([1, 2, 3]);

    const read = await detail(carol, song);
    expect(read.tracks[0]!.voteCount).toBe(3);
    expect(read.viewer.votedTrackIds).toEqual([track]);
    expect((await detail(mod, song)).viewer.votedTrackIds).toEqual([]);

    expect(await vote(carol, "DELETE")).toMatchObject({ voteCount: 2, voted: false });
    expect(await vote(carol, "DELETE")).toMatchObject({ voteCount: 2, voted: false });
    expect(takeFrames().map((f) => (f.type === "jam-track-votes" ? f.voteCount : f.type))).toEqual([2]);
    expect((await call(eve, "PUT", `/api/jam-tracks/${track}/vote`)).status).toBe(404);
    // No voter is named anywhere a viewer can read.
    const frame = JSON.stringify(read);
    expect(frame).not.toContain(carol.id);
  });

  // ------------------------------------------------------------- the detail

  it("the detail names the viewer: author, moderator, what they may add", async () => {
    const song = await songId(bob, "Do Bob", { joinMode: "wanted", wantedInstruments: ["keys"] });
    expect((await detail(bob, song)).viewer).toMatchObject({ isAuthor: true, canModerate: false });
    expect((await detail(mod, song)).viewer).toMatchObject({ isAuthor: false, canModerate: true });
    expect((await detail(alice, song)).viewer.canModerate).toBe(true);
    expect((await detail(carol, song)).viewer).toMatchObject({
      isAuthor: false,
      canModerate: false,
      addableInstruments: ["keys"],
    });
    expect((await call(eve, "GET", `/api/jam-songs/${song}`)).status).toBe(404);
    expect((await call(eve, "GET", `/api/channels/${jamId}/jam-songs`)).status).toBe(404);
    // A server nickname is the name the song shows.
    await getPool().query(`UPDATE server_members SET nickname = 'Robertão' WHERE user_id = $1`, [bob.id]);
    expect((await detail(carol, song)).song.authorName).toBe("Robertão");
  });

  it("a jam channel takes no messages", async () => {
    const result = await postChannelMessage({
      author: bob as never,
      channelId: jamId,
      body: "oi?",
    });
    expect(result).toMatchObject({ ok: false, reason: "no-access" });
    expect((await getPool().query(`SELECT 1 FROM messages WHERE channel_id = $1`, [jamId])).rowCount).toBe(0);
  });

  // ---------------------------------------------------------------- sweeps

  it("the sweep deletes an upload nobody claimed after an hour, and nothing that was claimed", async () => {
    const song = await songId(alice);
    const claimed = await addTrack(bob, song, "bass");
    expect(claimed.status).toBe(201);
    const orphan = await upload(bob, song, "audio");
    const fresh = await upload(bob, song, "audio");
    await getPool().query(
      `UPDATE jam_uploads SET created_at = NOW() - INTERVAL '2 hours' WHERE id = $1 OR claimed_at IS NOT NULL`,
      [orphan],
    );
    const orphanKey = (
      await getPool().query<{ storage_key: string }>(`SELECT storage_key FROM jam_uploads WHERE id = $1`, [orphan])
    ).rows[0]!.storage_key;
    const objectsBefore = objects.size;

    // A bucket outage keeps the row for the next pass, never leaks the key.
    storage.failDeletes = true;
    expect(await sweepJamMedia()).toBe(0);
    expect((await getPool().query(`SELECT 1 FROM jam_uploads WHERE id = $1`, [orphan])).rowCount).toBe(1);

    storage.failDeletes = false;
    expect(await sweepJamMedia()).toBe(1);
    expect(storage.deleted).toEqual([orphanKey]);
    expect(objects.size).toBe(objectsBefore - 1);
    expect((await getPool().query(`SELECT 1 FROM jam_uploads WHERE id = $1`, [orphan])).rowCount).toBe(0);
    // The fresh one and the claimed one stay.
    expect((await getPool().query(`SELECT 1 FROM jam_uploads WHERE id = $1`, [fresh])).rowCount).toBe(1);
    expect((await detail(alice, song)).tracks).toHaveLength(1);
    expect(await sweepJamMedia()).toBe(0);
  });

  it("an upload the sweep has picked up can no longer be claimed, even if its object delete failed", async () => {
    const song = await songId(alice);
    const upl = await upload(bob, song, "audio");
    await getPool().query(`UPDATE jam_uploads SET created_at = NOW() - INTERVAL '2 hours'`);
    storage.failDeletes = true;
    expect(await sweepJamMedia()).toBe(0);
    // The object is still in the bucket and the row is still there, marked.
    expect(objects.size).toBe(1);
    const claim = await call(bob, "POST", `/api/jam-songs/${song}/tracks`, {
      instrument: "bass",
      audioUploadId: upl,
      durationMs: 5000,
    });
    expect(claim.status).toBe(404);
    expect(claim.body.error).toBe("jam_upload_unknown");
    // The next pass finishes the job.
    storage.failDeletes = false;
    expect(await sweepJamMedia()).toBe(1);
    expect(objects.size).toBe(0);
  });

  it("a missing song, track or channel all answer the same 404", async () => {
    const secret = await createChannel(serverId, "secreta", "jam", true);
    const hidden = (await createSong(alice, "Escondida", {}, secret.id)).body.song.id;
    const missing = "11111111-1111-4111-8111-111111111111";
    const bodies = await Promise.all([
      call(bob, "GET", `/api/jam-songs/${hidden}`),
      call(bob, "GET", `/api/jam-songs/${missing}`),
      call(bob, "GET", `/api/channels/${secret.id}/jam-songs`),
      call(bob, "GET", `/api/channels/${missing}/jam-songs`),
      call(bob, "PUT", `/api/jam-tracks/${missing}/vote`),
    ]);
    expect(new Set(bodies.map((r) => r.status))).toEqual(new Set([404]));
    expect(new Set(bodies.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it("the sweep deletes a deleted track's objects a day later, then marks it", async () => {
    const song = await songId(alice);
    const reply = await addTrack(bob, song, "bass", {}, { video: true });
    const track = reply.body.track.id;
    await call(bob, "DELETE", `/api/jam-tracks/${track}`);
    expect(await sweepJamMedia()).toBe(0);
    await getPool().query(`UPDATE jam_tracks SET deleted_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [track]);
    const before = objects.size;
    expect(before).toBe(2);
    expect(await sweepJamMedia()).toBe(1);
    expect(objects.size).toBe(0);
    const row = await getPool().query<{ media_purged_at: Date | null }>(
      `SELECT media_purged_at FROM jam_tracks WHERE id = $1`,
      [track],
    );
    expect(row.rows[0]!.media_purged_at).not.toBeNull();
    expect(await sweepJamMedia()).toBe(0);
  });

  // -------------------------------------------------------- the three cascades

  it("names every object before a channel, a server or an account is deleted, and deletes them", async () => {
    const song = await songId(alice);
    await addTrack(bob, song, "bass", {}, { video: true });
    await addTrack(carol, song, "keys");
    const never = await upload(bob, song, "audio", { put: false });
    expect(never).toBeTruthy();
    const all = (await getPool().query<{ k: string }>(
      `SELECT storage_key AS k FROM jam_uploads`,
    )).rows.map((r) => r.k).sort();
    expect(all).toHaveLength(4);

    expect((await jamKeysForChannels([jamId])).sort()).toEqual(all);
    expect((await jamKeysForServer(serverId)).sort()).toEqual(all);
    // Bob's: his two claimed objects and the upload that was never claimed.
    expect(await jamKeysForUser(bob.id)).toHaveLength(3);
    expect(await jamKeysForUser(carol.id)).toHaveLength(1);
    expect(await jamKeysForUser(eve.id)).toEqual([]);

    // The channel delete reads the keys inside its transaction and deletes the
    // objects after it commits.
    expect(await deleteChannel(jamId)).toBe(true);
    const deadline = Date.now() + 5000;
    while (storage.deleted.length < all.length && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20));
    }
    expect([...storage.deleted].sort()).toEqual(all);
    expect(objects.size).toBe(0);
    expect((await getPool().query(`SELECT 1 FROM jam_songs`)).rowCount).toBe(0);
  });

  it("a server delete deletes its jam objects too", async () => {
    const song = await songId(alice);
    await addTrack(bob, song, "bass");
    const keys = (await jamKeysForServer(serverId)).sort();
    expect(keys).toHaveLength(1);
    await deleteServer(serverId);
    const deadline = Date.now() + 5000;
    while (storage.deleted.length < keys.length && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20));
    }
    expect([...storage.deleted].sort()).toEqual(keys);
  });

  it("an account's recordings go with it; the song and everybody else's tracks stay", async () => {
    const song = await songId(bob, "Do Bob");
    await trackId(bob, song, "bass");
    await trackId(carol, song, "keys");
    await getPool().query(`DELETE FROM users WHERE id = $1`, [bob.id]);
    const left = await detail(carol, song);
    expect(left.song.authorId).toBeNull();
    expect(left.song.authorName).toBeNull();
    expect(left.tracks.map((t) => t.instrument)).toEqual(["keys"]);
  });

  // ----------------------------------------------------------------- covers

  /** The first bytes of a real PNG header (signature, IHDR), enough for the sniff. */
  const pngBytes = (extra = 8) => {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(512, 16);
    header.writeUInt32BE(512, 20);
    return Buffer.concat([header, Buffer.alloc(extra, 7)]);
  };
  /** A minimal JPEG header with a start-of-frame, 1024 x 1024. */
  const jpegBytes = () =>
    Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x04, 0x00,
      0x04, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
    ]);

  async function coverUpload(
    as: Actor,
    song: string,
    options: { contentType?: string; bytes?: Buffer; stored?: string } = {},
  ): Promise<string> {
    const contentType = options.contentType ?? "image/png";
    const bytes = options.bytes ?? pngBytes();
    const ticket = await call(as, "POST", `/api/jam-songs/${song}/uploads`, {
      kind: "cover",
      contentType,
      byteSize: bytes.length,
    });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const parsed = jamUploadTicketSchema.parse(ticket.body);
    const put = await fetch(parsed.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": options.stored ?? contentType },
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    return parsed.uploadId;
  }

  const setCover = (as: Actor, song: string, uploadId: string) =>
    call<{ song: JamSongSummary; error?: string }>(as, "PUT", `/api/jam-songs/${song}/cover`, {
      uploadId,
    });
  const removeCover = (as: Actor, song: string) =>
    call<{ song: JamSongSummary; error?: string }>(as, "DELETE", `/api/jam-songs/${song}/cover`);

  async function settled(check: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!(await check()) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(await check()).toBe(true);
  }

  const keyOf = async (uploadId: string) =>
    (
      await getPool().query<{ storage_key: string }>(
        `SELECT storage_key FROM jam_uploads WHERE id = $1`,
        [uploadId],
      )
    ).rows[0]!.storage_key;

  it("a song has no cover until one is set, and every read says so with null", async () => {
    const song = await songId(alice);
    expect((await detail(bob, song)).song.coverUrl).toBeNull();
    const list = await call(bob, "GET", `/api/channels/${jamId}/jam-songs`);
    expect(jamSongListResponseSchema.parse(list.body).songs[0]!.coverUrl).toBeNull();
  });

  it("sets a cover end to end: the picture is on the list, the detail and the frame, and the bytes are fetchable", async () => {
    const song = await songId(bob, "Com capa");
    takeFrames();
    const id = await coverUpload(bob, song);
    const set = await setCover(bob, song, id);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const url = set.body.song.coverUrl;
    expect(url).toBeTruthy();
    expect((await fetch(url!)).status).toBe(200);

    const frames = takeFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "jam-song-updated", channelId: jamId });
    expect((frames[0] as { song: JamSongSummary }).song.coverUrl).toBeTruthy();

    // Everybody who can see the channel reads it, in the list and in the detail.
    const list = await call(carol, "GET", `/api/channels/${jamId}/jam-songs`);
    expect(jamSongListResponseSchema.parse(list.body).songs[0]!.coverUrl).toBeTruthy();
    expect((await detail(carol, song)).song.coverUrl).toBeTruthy();

    // The same picture signs to the same object: its path is its identity.
    const again = (await detail(alice, song)).song.coverUrl!;
    expect(new URL(again).pathname).toBe(new URL(url!).pathname);
  });

  it("who may set a cover: the author or a moderator, not another member, not somebody who cannot see the channel", async () => {
    const song = await songId(bob);
    // Not the author: no ticket either, so a stranger's picture costs the bucket nothing.
    const denied = await call(carol, "POST", `/api/jam-songs/${song}/uploads`, {
      kind: "cover",
      contentType: "image/png",
      byteSize: 100,
    });
    expect(denied.status).toBe(403);
    // A moderator may, with their own upload.
    const modUpload = await coverUpload(mod, song);
    expect((await setCover(mod, song, modUpload)).status).toBe(200);
    // The song's author's upload cannot be claimed by somebody else.
    const bobUpload = await coverUpload(bob, song);
    const stolen = await setCover(mod, song, bobUpload);
    expect(stolen.status).toBe(404);
    expect(stolen.body.error).toBe("jam_upload_unknown");
    // A member who is not the author cannot claim even a valid upload id.
    expect((await setCover(carol, song, bobUpload)).status).toBe(403);
    // A stranger does not even learn the song is there.
    expect((await setCover(eve, song, bobUpload)).status).toBe(404);
    expect((await removeCover(carol, song)).status).toBe(403);
    expect((await removeCover(eve, song)).status).toBe(404);
  });

  it("a cover upload is not a back door: it cannot be claimed as a track, in a closed song or any other", async () => {
    const song = await songId(bob, "Fechada", { joinMode: "closed" });
    const id = await coverUpload(bob, song);
    const track = await call(bob, "POST", `/api/jam-songs/${song}/tracks`, {
      instrument: "guitar",
      audioUploadId: id,
      durationMs: 30_000,
    });
    expect(track.status).toBe(404);
  });

  it("verifies the object: wrong type, not an image, over the limit, never uploaded", async () => {
    const song = await songId(bob);
    // Types: only the three pictures, and the size is bounded at the ticket.
    for (const contentType of ["image/gif", "image/svg+xml", "audio/webm", "text/html"]) {
      const refused = await call(bob, "POST", `/api/jam-songs/${song}/uploads`, {
        kind: "cover",
        contentType,
        byteSize: 100,
      });
      expect(refused.status, contentType).toBe(400);
    }
    const huge = await call(bob, "POST", `/api/jam-songs/${song}/uploads`, {
      kind: "cover",
      contentType: "image/png",
      byteSize: JAM_COVER_MAX_BYTES + 1,
    });
    expect(huge.status).toBe(413);
    expect(huge.body.error).toBe("jam_upload_too_large");

    // Bytes that are not the picture they were signed as: HTML in a PNG's clothes.
    const fake = await coverUpload(bob, song, {
      bytes: Buffer.from("<script>alert(1)</script>".repeat(4)),
    });
    const notImage = await setCover(bob, song, fake);
    expect(notImage.status).toBe(422);
    expect(notImage.body.error).toBe("jam_upload_not_verified");
    // A JPEG stored under a PNG ticket is the wrong format too.
    const mismatch = await coverUpload(bob, song, { contentType: "image/png", bytes: jpegBytes() });
    expect((await setCover(bob, song, mismatch)).status).toBe(422);
    // The object stored with another content type than the signed one.
    const stored = await coverUpload(bob, song, { contentType: "image/png", stored: "image/jpeg" });
    expect((await setCover(bob, song, stored)).status).toBe(422);
    // Never uploaded.
    const ticket = await call(bob, "POST", `/api/jam-songs/${song}/uploads`, {
      kind: "cover",
      contentType: "image/png",
      byteSize: 50,
    });
    const missing = await setCover(bob, song, ticket.body.uploadId as string);
    expect(missing.status).toBe(422);
    // Nothing above set a cover.
    expect((await detail(bob, song)).song.coverUrl).toBeNull();

    // A real JPEG is accepted; a retry of the claim is the same answer, announced again (a frame is idempotent).
    const good = await coverUpload(bob, song, { contentType: "image/jpeg", bytes: jpegBytes() });
    expect((await setCover(bob, song, good)).status).toBe(200);
    takeFrames();
    const retried = await setCover(bob, song, good);
    expect(retried.status).toBe(200);
    expect(retried.body.song.coverUrl).toBeTruthy();
    expect(takeFrames()).toMatchObject([{ type: "jam-song-updated" }]);
  });

  it("replacing a cover deletes the old object and its ledger row; removing deletes the last one", async () => {
    const song = await songId(bob);
    const first = await coverUpload(bob, song);
    await setCover(bob, song, first);
    const firstKey = await keyOf(first);
    expect(objects.has(firstKey)).toBe(true);

    const second = await coverUpload(bob, song, { contentType: "image/jpeg", bytes: jpegBytes() });
    const replaced = await setCover(bob, song, second);
    expect(replaced.status).toBe(200);
    expect(new URL(replaced.body.song.coverUrl!).pathname).toContain(".jpg");
    await settled(() => !objects.has(firstKey));
    await settled(
      async () =>
        (await getPool().query(`SELECT 1 FROM jam_uploads WHERE id = $1`, [first])).rowCount === 0,
    );
    expect(
      (await getPool().query(`SELECT 1 FROM jam_song_covers WHERE song_id = $1`, [song])).rowCount,
    ).toBe(1);

    takeFrames();
    const removed = await removeCover(bob, song);
    expect(removed.status).toBe(200);
    expect(removed.body.song.coverUrl).toBeNull();
    expect(takeFrames()).toMatchObject([{ type: "jam-song-updated" }]);
    await settled(() => objects.size === 0);
    expect((await getPool().query(`SELECT 1 FROM jam_song_covers`)).rowCount).toBe(0);
    // Nothing left to remove: 200, and the same frame again (a retry whose first answer was lost still tells the room).
    expect((await removeCover(bob, song)).status).toBe(200);
    expect(takeFrames()).toMatchObject([{ type: "jam-song-updated" }]);
  });

  it("off refuses a ticket and a set for a cover, never a read, and lets the removal through", async () => {
    const song = await songId(bob);
    const id = await coverUpload(bob, song);
    await setCover(bob, song, id);
    const spare = await coverUpload(bob, song, { bytes: pngBytes(16) });
    await flag(false);
    const ticket = await call(bob, "POST", `/api/jam-songs/${song}/uploads`, {
      kind: "cover",
      contentType: "image/png",
      byteSize: 100,
    });
    expect(ticket.status).toBe(403);
    expect(ticket.body.error).toBe("jam_channels_off");
    expect((await setCover(bob, song, spare)).status).toBe(403);
    expect((await detail(carol, song)).song.coverUrl).toBeTruthy();
    // A picture somebody should not see stays removable while the feature is paused.
    expect((await removeCover(mod, song)).status).toBe(200);
    expect((await detail(carol, song)).song.coverUrl).toBeNull();
  });

  it("a timed-out member cannot change the cover", async () => {
    const song = await songId(bob);
    const id = await coverUpload(bob, song);
    await issueTimeout({ serverId, userId: bob.id, issuedBy: alice.id, minutes: 5 });
    expect((await setCover(bob, song, id)).status).toBe(403);
    expect((await removeCover(bob, song)).status).toBe(403);
  });

  it("the sweep collects a cover the song stopped showing, and a deleted song's cover a day later, never a live one", async () => {
    const song = await songId(bob);
    const live = await coverUpload(bob, song);
    await setCover(bob, song, live);
    const liveKey = await keyOf(live);

    // A claimed cover upload no song names (a failed immediate delete) is collected after the hour.
    const stray = await coverUpload(bob, song, { bytes: pngBytes(20) });
    await getPool().query(
      `UPDATE jam_uploads SET claimed_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [stray],
    );
    const strayKey = await keyOf(stray);
    expect(await sweepJamMedia()).toBe(1);
    expect(objects.has(strayKey)).toBe(false);
    expect(objects.has(liveKey)).toBe(true);
    expect((await getPool().query(`SELECT 1 FROM jam_uploads WHERE id = $1`, [stray])).rowCount).toBe(0);

    // A deleted song's cover stays for the day, then goes with its rows.
    expect((await call(bob, "DELETE", `/api/jam-songs/${song}`)).status).toBe(204);
    expect(await sweepJamMedia()).toBe(0);
    expect(objects.has(liveKey)).toBe(true);
    await getPool().query(
      `UPDATE jam_songs SET deleted_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [song],
    );
    expect(await sweepJamMedia()).toBe(1);
    expect(objects.has(liveKey)).toBe(false);
    expect((await getPool().query(`SELECT 1 FROM jam_song_covers`)).rowCount).toBe(0);
  });

  it("a failed delete of the old cover is left for the sweep, not lost", async () => {
    const song = await songId(bob);
    const first = await coverUpload(bob, song);
    await setCover(bob, song, first);
    storage.failDeletes = true;
    const second = await coverUpload(bob, song, { bytes: pngBytes(30) });
    expect((await setCover(bob, song, second)).status).toBe(200);
    await new Promise((done) => setTimeout(done, 150));
    // The row is still there for the sweep: claimed, and no song points at it.
    expect(
      (await getPool().query(`SELECT 1 FROM jam_uploads WHERE id = $1`, [first])).rowCount,
    ).toBe(1);
    await getPool().query(
      `UPDATE jam_uploads SET claimed_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [first],
    );
    storage.failDeletes = false;
    expect(await sweepJamMedia()).toBe(1);
    expect(
      (await getPool().query(`SELECT 1 FROM jam_uploads WHERE id = $1`, [first])).rowCount,
    ).toBe(0);
  });

  it("an account that set a cover on somebody else's song takes the picture with it; the cascades name the cover's key", async () => {
    const song = await songId(alice, "Da Alice");
    const id = await coverUpload(mod, song);
    await setCover(mod, song, id);
    const keys = await jamKeysForUser(mod.id);
    expect(keys).toHaveLength(1);
    expect(await jamKeysForChannels([jamId])).toEqual(expect.arrayContaining(keys));
    await getPool().query(`DELETE FROM users WHERE id = $1`, [mod.id]);
    expect((await detail(alice, song)).song.coverUrl).toBeNull();
    expect((await getPool().query(`SELECT 1 FROM jam_song_covers`)).rowCount).toBe(0);
  });

  it("a blip of the database after the commit does not lose the announcement: the summary read is tried again", async () => {
    const song = await songId(bob);
    const id = await coverUpload(bob, song);
    takeFrames();
    const pool = getPool();
    const real = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    let failed = 0;
    const spy = vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      // The summary select, once: the first read after the claim committed.
      if (failed === 0 && text.includes("LEFT JOIN jam_song_covers") && text.includes("WHERE s.id = $1")) {
        failed += 1;
        return Promise.reject(new Error("connection terminated"));
      }
      return real(...args);
    }) as never);
    try {
      const set = await setCover(bob, song, id);
      expect(set.status).toBe(200);
      expect(failed).toBe(1);
      expect(set.body.song.coverUrl).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    expect(takeFrames()).toMatchObject([{ type: "jam-song-updated" }]);
  });

  it("a database that stays unreadable for the whole retry window still tells the room once it can read again", async () => {
    const song = await songId(bob);
    const id = await coverUpload(bob, song);
    takeFrames();
    const pool = getPool();
    const real = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    let failed = 0;
    const spy = vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      // The summary select: three reads in a row (the call and both its retries).
      if (failed < 3 && text.includes("LEFT JOIN jam_song_covers") && text.includes("WHERE s.id = $1")) {
        failed += 1;
        return Promise.reject(new Error("connection terminated"));
      }
      return real(...args);
    }) as never);
    try {
      // The caller is told it failed, though the claim committed...
      const set = await setCover(bob, song, id);
      expect(set.status).toBe(500);
      expect(failed).toBe(3);
      // ...and the room hears of it by itself once a read works again.
      await settled(() => stubs.frames.length > 0);
    } finally {
      spy.mockRestore();
    }
    const frames = takeFrames();
    expect(frames).toMatchObject([{ type: "jam-song-updated" }]);
    expect((frames[0] as { song: JamSongSummary }).song.coverUrl).toBeTruthy();
  });

  it("an edit of the title keeps the cover and is announced once, with both", async () => {
    const song = await songId(bob, "Antes");
    await setCover(bob, song, await coverUpload(bob, song));
    takeFrames();
    const renamed = await call<{ song: JamSongSummary }>(bob, "PATCH", `/api/jam-songs/${song}`, {
      title: "Depois",
      artist: "Os Cometas",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.song).toMatchObject({ title: "Depois", artist: "Os Cometas" });
    expect(renamed.body.song.coverUrl).toBeTruthy();
    const frames = takeFrames();
    expect(frames).toHaveLength(1);
    expect((frames[0] as { song: JamSongSummary }).song.title).toBe("Depois");
  });
});
