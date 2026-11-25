import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publicJamListResponseSchema, publicJamSongDetailSchema, publicJamSongSchema } from "@pqp/shared";

/**
 * The public song carries its `joinMode` (packages/shared/src/jam-public.ts):
 * the website cannot tell a song that takes a part from one that does not by
 * `needs`, which is empty for `open` and `closed` alike (user test round 1,
 * B2: people signed up to record on a closed song). Real Postgres, the public
 * routes asked with no Authorization header, the flag set the way production
 * sets it (a `feature_flags` row, pitfall 12). Standalone songs are seeded
 * with SQL: what is pinned is the serializer and the contract, not publishing.
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
delete process.env.JAM_PUBLIC_MEDIA_BASE_URL;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  resolveAuthUser: async () => null,
  resolveAuthSession: async () => null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { resetFeatureFlagsForTests, setGlobalFlag, startFeatureFlags } = await import("../lib/flags.js");

describeDb("public jams: joinMode on the public song", () => {
  let http: Server;
  let baseUrl = "";
  let starterId = "";
  const songs: Record<"open" | "wanted" | "wantedFilled" | "closed", string> = {
    open: "",
    wanted: "",
    wantedFilled: "",
    closed: "",
  };

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

  /** One standalone, published song with one public part by `starterId`. */
  async function seed(title: string, joinMode: string, wanted: string[], partInstrument: string): Promise<string> {
    const pool = getPool();
    const song = await pool.query<{ id: string }>(
      `INSERT INTO jam_songs (channel_id, server_id, author_id, title, join_mode, wanted_instruments)
       VALUES (NULL, NULL, $1, $2, $3, $4) RETURNING id`,
      [starterId, title, joinMode, wanted],
    );
    const songId = song.rows[0]!.id;
    await pool.query(`INSERT INTO jam_public_songs (song_id, published_by) VALUES ($1, $2)`, [songId, starterId]);
    const track = await pool.query<{ id: string }>(
      `INSERT INTO jam_tracks (song_id, author_id, instrument, audio_key, audio_content_type, audio_bytes, duration_ms, in_mix)
       VALUES ($1, $2, $3, $4, 'audio/wav', 1000, 5000, TRUE) RETURNING id`,
      [songId, starterId, partInstrument, `jam/public/${songId}/a.wav`],
    );
    await pool.query(
      `INSERT INTO jam_public_tracks (track_id, song_id, author_id, origin) VALUES ($1, $2, $3, 'published')`,
      [track.rows[0]!.id, songId, starterId],
    );
    await pool.query(
      `INSERT INTO jam_public_consents (song_id, user_id, choice) VALUES ($1, $2, 'yes')`,
      [songId, starterId],
    );
    return songId;
  }

  beforeEach(async () => {
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    await getPool().query(
      `TRUNCATE users, servers, channels, feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    const starter = await upsertUser({ clerkId: "clerk_jm_starter", displayName: "Starter", avatarUrl: null });
    starterId = starter.id;
    await startFeatureFlags();
    await setGlobalFlag("jam_public", true, { kind: "dashboard" });
    songs.open = await seed("Aberta", "open", [], "guitar");
    songs.wanted = await seed("Pede baixo", "wanted", ["bass"], "guitar");
    // asks for the instrument somebody already recorded: nothing missing, but `wanted` still takes it
    songs.wantedFilled = await seed("Baixo ja foi", "wanted", ["guitar"], "guitar");
    songs.closed = await seed("Fechada", "closed", [], "drums");
  });

  async function get(path: string): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(200);
    return response.json();
  }

  it("the list says what each song's joinMode is, and needs cannot tell open from closed", async () => {
    const list = publicJamListResponseSchema.parse(await get("/api/public/jams"));
    const byId = new Map(list.songs.map((song) => [song.id, song]));
    expect(byId.get(songs.open)?.joinMode).toBe("open");
    expect(byId.get(songs.wanted)?.joinMode).toBe("wanted");
    expect(byId.get(songs.wantedFilled)?.joinMode).toBe("wanted");
    expect(byId.get(songs.closed)?.joinMode).toBe("closed");
    // the reason the field exists: both read "asks for nobody"
    expect(byId.get(songs.open)?.needs).toEqual([]);
    expect(byId.get(songs.closed)?.needs).toEqual([]);
    expect(byId.get(songs.wanted)?.needs).toEqual(["bass"]);
    expect(byId.get(songs.wantedFilled)?.needs).toEqual([]);
  });

  it("the song detail carries it too, on the wire as a plain string", async () => {
    const raw = (await get(`/api/public/jams/${songs.closed}`)) as { song: Record<string, unknown> };
    expect(raw.song.joinMode).toBe("closed");
    const detail = publicJamSongDetailSchema.parse(raw);
    expect(detail.song.joinMode).toBe("closed");
    const open = (await get(`/api/public/jams/${songs.open}`)) as { song: Record<string, unknown> };
    expect(open.song.joinMode).toBe("open");
  });

  it("an older payload with no joinMode, or a newer server's unknown value, reads open", () => {
    const base = {
      id: songs.open,
      title: "x",
      artist: null,
      coverUrl: null,
      durationMs: 1,
      parts: [],
      needs: [],
      plays: 0,
      likes: 0,
      startedBy: { name: "a", handle: null, avatarUrl: null },
      origin: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(publicJamSongSchema.parse(base).joinMode).toBe("open");
    expect(publicJamSongSchema.parse({ ...base, joinMode: "invite-only" }).joinMode).toBe("open");
    expect(publicJamSongSchema.parse({ ...base, joinMode: "closed" }).joinMode).toBe("closed");
  });
});
