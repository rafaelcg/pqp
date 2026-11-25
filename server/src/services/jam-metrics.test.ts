import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbUser } from "../db.js";

/**
 * `jam` on `GET /api/admin/metrics`, on a real Postgres.
 *
 * Rows are written with SQL at the ages each case needs, because the thing
 * under test is what the queries make of the tables. The cast is small enough
 * to hold in the head, and each person exists to pin one rule:
 *
 *   alice  a take 20 days ago, 2 days ago (video) and 1 hour ago: a recorder, not a first
 *   bob    a take 10 days ago and 3 days ago: the returner
 *   carol  one take 2 days ago and nothing before: the first-taker
 *   dave   a DELETED take 12 days ago, a live one 20 hours ago: a deleted take
 *          still means "has tried it", so not a first-taker, and not a returner
 *          (the old take is not live)
 *   erin   one take 25 days ago: in the 30-day count only
 *
 * One case reads the whole admin payload, so the block is proved to be wired,
 * not only computed.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.CLUSTER_BUS;

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer: createPqpServer } = await import("./servers.js");
const { jamMetrics } = await import("./jam-metrics.js");
const { getAdminMetrics, resetAdminMetricsCache } = await import("./metrics.js");

describeDb("jam metrics", () => {
  let alice: DbUser;
  let bob: DbUser;
  let carol: DbUser;
  let dave: DbUser;
  let erin: DbUser;
  let serverA: string;
  let serverB: string;
  let jamA1: string;
  let jamA2: string;
  let jamB: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    resetAdminMetricsCache();
    await getPool().query(`TRUNCATE users, servers, channels RESTART IDENTITY CASCADE`);
    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    [alice, bob, carol, dave, erin] = await Promise.all(
      ["alice", "bob", "carol", "dave", "erin"].map(make),
    );
    serverA = (await createPqpServer("Sala A", alice.id)).server.id;
    serverB = (await createPqpServer("Sala B", bob.id)).server.id;
    // A third server with no jam channel: it must not count.
    await createPqpServer("Sala C", carol.id);
    jamA1 = await jamChannel(serverA, "jam-1");
    jamA2 = await jamChannel(serverA, "jam-2");
    jamB = await jamChannel(serverB, "jam");
  });

  async function jamChannel(serverId: string, name: string): Promise<string> {
    const row = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type) VALUES ($1, $2, 'jam') RETURNING id`,
      [serverId, name],
    );
    return row.rows[0]!.id;
  }

  async function song(
    channelId: string | null,
    serverId: string | null,
    ago: string,
    deleted = false,
  ): Promise<string> {
    const row = await getPool().query<{ id: string }>(
      `INSERT INTO jam_songs (channel_id, server_id, author_id, title, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, 'musica', now() - $4::interval, now() - $4::interval,
               CASE WHEN $5::boolean THEN now() ELSE NULL END)
       RETURNING id`,
      [channelId, serverId, alice.id, ago, deleted],
    );
    return row.rows[0]!.id;
  }

  async function take(
    songId: string,
    author: DbUser,
    ago: string,
    opts: { video?: boolean; deleted?: boolean; inMix?: boolean } = {},
  ): Promise<string> {
    const row = await getPool().query<{ id: string }>(
      `INSERT INTO jam_tracks (song_id, author_id, instrument, audio_key, audio_content_type,
                               audio_bytes, video_key, duration_ms, in_mix, created_at, deleted_at)
       VALUES ($1, $2, 'guitar', 'jam/x/' || gen_random_uuid(), 'audio/webm', 1000,
               CASE WHEN $4::boolean THEN 'jam/x/v-' || gen_random_uuid() ELSE NULL END,
               1000, $6::boolean, now() - $3::interval,
               CASE WHEN $5::boolean THEN now() ELSE NULL END)
       RETURNING id`,
      [songId, author.id, ago, opts.video === true, opts.deleted === true, opts.inMix === true],
    );
    return row.rows[0]!.id;
  }

  async function publish(songId: string, ago: string, unpublished = false): Promise<void> {
    await getPool().query(
      `INSERT INTO jam_public_songs (song_id, published_at, first_published_at, review_state, unpublished_at)
       VALUES ($1, now() - $2::interval, now() - $2::interval, 'approved',
               CASE WHEN $3::boolean THEN now() ELSE NULL END)`,
      [songId, ago, unpublished],
    );
  }

  async function publicTake(
    trackId: string,
    songId: string,
    author: DbUser,
    ago: string,
    opts: { outside: boolean; removed?: boolean },
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO jam_public_tracks (track_id, song_id, author_id, origin, outside, created_at, removed_at)
       VALUES ($1, $2, $3, 'recorded', $4::boolean, now() - $5::interval,
               CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
      [trackId, songId, author.id, opts.outside, ago, opts.removed === true],
    );
  }

  async function vote(trackId: string, user: DbUser, ago: string): Promise<void> {
    await getPool().query(
      `INSERT INTO jam_track_votes (track_id, user_id, created_at) VALUES ($1, $2, now() - $3::interval)`,
      [trackId, user.id, ago],
    );
  }

  async function seedWeek(): Promise<void> {
    const s1 = await song(jamA1, serverA, "2 hours");
    const s2 = await song(jamA2, serverA, "3 days");
    const s3 = await song(jamB, serverB, "20 days");
    const s4 = await song(jamB, serverB, "1 hour", true); // deleted: nowhere
    const s5 = await song(null, null, "5 hours"); // a standalone public jam

    await take(s3, alice, "20 days");
    const a2 = await take(s2, alice, "2 days", { video: true });
    const a3 = await take(s1, alice, "1 hour");
    await take(s3, bob, "10 days", { video: true });
    const b2 = await take(s2, bob, "3 days");
    const c1 = await take(s2, carol, "2 days", { inMix: true });
    const d1 = await take(s3, dave, "12 days", { deleted: true });
    const d2 = await take(s2, dave, "20 hours");
    const e1 = await take(s3, erin, "25 days");

    await publish(s1, "2 days"); // first published this week: counts
    await publish(s5, "3 days"); // a standalone song: counts
    await publish(s2, "10 days"); // older than a week: no
    await publish(s3, "1 day", true); // taken down: no
    await publish(s4, "1 day"); // the song is deleted: no

    await publicTake(c1, s2, carol, "2 days", { outside: true }); // admitted: it is in the mix
    await publicTake(b2, s2, bob, "3 days", { outside: true }); // received, still out of the mix
    await publicTake(d2, s2, dave, "20 hours", { outside: true, removed: true }); // an operator removed it
    await publicTake(a2, s2, alice, "2 days", { outside: false }); // the starter's own: not outside
    await publicTake(e1, s3, erin, "25 days", { outside: true }); // outside the window

    await vote(a3, carol, "1 day");
    await vote(a3, bob, "2 days");
    await vote(a2, dave, "8 days"); // outside the window
    await vote(d1, alice, "1 day"); // on a deleted take
  }

  it("reads zero everywhere when there is no jam", async () => {
    await getPool().query(`DELETE FROM channels WHERE type = 'jam'`);
    expect(await jamMetrics()).toEqual({
      jamChannels: 0,
      serversWithJam: 0,
      songs: { created24h: 0, created7d: 0, live: 0 },
      takes: { posted24h: 0, posted7d: 0, live: 0, withVideo7d: 0 },
      recorders: { distinct7d: 0, distinct30d: 0 },
      firstTakers7d: 0,
      returningRecorders7d: 0,
      public: { firstPublished7d: 0, outsideTakes7d: 0, outsideTakesAdmitted7d: 0 },
      votes7d: 0,
    });
  });

  it("counts every number over the seeded windows", async () => {
    await seedWeek();
    expect(await jamMetrics()).toEqual({
      jamChannels: 3,
      serversWithJam: 2,
      // s1 and s5 today, s2 this week, s3 old, s4 deleted.
      songs: { created24h: 2, created7d: 3, live: 4 },
      takes: {
        posted24h: 2, // a3, d2
        posted7d: 5, // a2, a3, b2, c1, d2
        live: 8, // everything but dave's deleted take
        withVideo7d: 1, // a2 (bob's old take has a video, but 10 days ago)
      },
      recorders: { distinct7d: 4, distinct30d: 5 },
      firstTakers7d: 1, // carol; dave's deleted take means he had tried it
      returningRecorders7d: 1, // bob
      public: { firstPublished7d: 2, outsideTakes7d: 2, outsideTakesAdmitted7d: 1 },
      votes7d: 2,
    });
  });

  it("moves a person from first-taker to returning when an older live take shows up", async () => {
    await seedWeek();
    // Carol also has a live take 9 days ago: no longer her first, and the week
    // before is covered, so she returns.
    const s = await song(jamA1, serverA, "9 days");
    await take(s, carol, "9 days");
    const m = await jamMetrics();
    expect(m.firstTakers7d).toBe(0);
    expect(m.returningRecorders7d).toBe(2);
    expect(m.recorders.distinct7d).toBe(4);
  });

  it("does not count a person whose only take this week is deleted", async () => {
    const s = await song(jamA1, serverA, "1 day");
    await take(s, carol, "1 day", { deleted: true });
    const m = await jamMetrics();
    expect(m.recorders).toEqual({ distinct7d: 0, distinct30d: 0 });
    expect(m.firstTakers7d).toBe(0);
    expect(m.takes.live).toBe(0);
  });

  it("is on the admin payload", async () => {
    await seedWeek();
    const payload = await getAdminMetrics();
    expect(payload.jam).toEqual(await jamMetrics());
    expect(payload.jam?.recorders.distinct7d).toBe(4);
  });
});
