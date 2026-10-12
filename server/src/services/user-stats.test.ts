import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MusicState, MusicTrack } from "@pqp/shared";

/**
 * Per-person counts for the Retrospectiva, against a real database, with the
 * registry ON, which is how production runs (pitfall 12: a flag production
 * sets is the flag the test sets).
 *
 * What each case guards:
 *  1. **One minute counts once.** Two samplers in the same minute (a worker
 *     rollout), a retried statement or a late older sample must not double a
 *     person's call time, and one sampler must not lose a minute to its own
 *     timer's phase. A failed write is retried, not lost.
 *  2. **Only real calls count.** A seat held for resume, a room of one, and a
 *     bot add nothing.
 *  3. **A blind worker writes nothing** instead of zeros.
 *  4. **A track counts where it was added**, never on a queue adopted from
 *     another machine, and never for a reorder or a skip.
 *  5. **Watched parties survive the viewer prune**, one row per party.
 */

// TEST_DATABASE_URL wins; see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const { createUserStatsRecorder, newlyQueuedTracks } = await import(
  "./user-stats.js"
);

function track(id: string, addedByUserId: string, autoplayed = false): MusicTrack {
  return {
    id,
    provider: "youtube",
    videoId: `v-${id}`,
    title: `Track ${id}`,
    sourceUrl: null,
    thumbnailUrl: null,
    durationMs: null,
    addedByUserId,
    addedByName: addedByUserId,
    ...(autoplayed ? { autoplayed: true } : {}),
  };
}

function music(current: MusicTrack | null, queue: MusicTrack[], history: MusicTrack[] = []): MusicState {
  return {
    current,
    queue,
    status: "playing",
    positionMs: 0,
    atMs: 0,
    rev: 1,
    actorId: "peer",
    openControls: false,
    repeat: "off",
    skipVotes: [],
    history,
  } as MusicState;
}

describe("newlyQueuedTracks", () => {
  it("counts tracks this person added, and nothing else", () => {
    const held = music(track("1", "me"), [track("2", "other")], [track("0", "me")]);
    // Reordered, one of mine added, one of somebody else's added, one autoplay.
    const next = music(track("1", "me"), [
      track("3", "me"),
      track("2", "other"),
      track("4", "other"),
      track("5", "me", true),
    ]);
    expect(newlyQueuedTracks(held, next, "me")).toEqual(["3"]);
  });

  it("counts nothing for a skip, a removal or a teardown", () => {
    const held = music(track("1", "me"), [track("2", "me")]);
    expect(newlyQueuedTracks(held, music(track("2", "me"), []), "me")).toHaveLength(0);
    expect(newlyQueuedTracks(held, music(track("1", "me"), []), "me")).toHaveLength(0);
    expect(newlyQueuedTracks(held, null, "me")).toHaveLength(0);
  });

  it("counts the first track of an empty room", () => {
    expect(newlyQueuedTracks(null, music(track("1", "me"), []), "me")).toHaveLength(1);
  });

  it("counts only the tracks the room kept, when given what it kept", () => {
    const held = music(track("1", "me"), []);
    const next = music(track("1", "me"), [track("2", "me"), track("3", "me")]);
    // A later write kept track 2 (and has already played it) but not 3.
    const kept = music(track("4", "other"), [], [track("1", "me"), track("2", "me")]);
    expect(newlyQueuedTracks(held, next, "me", kept)).toEqual(["2"]);
    // A winner that never saw this write holds none of it.
    expect(newlyQueuedTracks(held, next, "me", music(track("9", "other"), []))).toHaveLength(0);
    expect(newlyQueuedTracks(held, next, "me", null)).toHaveLength(0);
  });
});

describeDb("user stats", () => {
  const savedRegistry = process.env.VOICE_REGISTRY;

  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    await getPool().query(`TRUNCATE voice_rooms CASCADE`);
    await getPool().query(`TRUNCATE hls_session_viewers`);
    await getPool().query(`TRUNCATE user_watch_parties`);
  });

  afterEach(() => {
    if (savedRegistry === undefined) {
      delete process.env.VOICE_REGISTRY;
    } else {
      process.env.VOICE_REGISTRY = savedRegistry;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function person(name: string): Promise<string> {
    const user = await upsertUser({ clerkId: name, displayName: name, avatarUrl: null });
    return user.id;
  }

  async function seat(
    channelId: string,
    userId: string,
    options: { sharing?: boolean; orphaned?: boolean } = {},
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO voice_rooms (channel_id, transport) VALUES ($1, 'mesh')
       ON CONFLICT DO NOTHING`,
      [channelId],
    );
    await getPool().query(
      `INSERT INTO voice_peers
         (peer_id, channel_id, user_id, instance_id, display_name, sharing_screen, orphaned_at)
       VALUES ($1, $2, $3, $4, 'x', $5, $6)`,
      [
        randomUUID(),
        channelId,
        userId,
        randomUUID(),
        options.sharing ?? false,
        options.orphaned ? new Date() : null,
      ],
    );
  }

  async function stats(): Promise<
    Record<string, { voice: number; share: number; music: number }>
  > {
    const result = await getPool().query<{
      user_id: string;
      voice_seconds: number;
      share_seconds: number;
      music_queued: number;
    }>(`SELECT user_id, voice_seconds, share_seconds, music_queued FROM user_daily_stats`);
    return Object.fromEntries(
      result.rows.map((row) => [
        row.user_id,
        { voice: row.voice_seconds, share: row.share_seconds, music: row.music_queued },
      ]),
    );
  }

  const recorder = () => createUserStatsRecorder({ enabled: () => true });

  it("adds a minute once, however many samplers see it", async () => {
    const ana = await person("ana");
    const bia = await person("bia");
    const room = randomUUID();
    await seat(room, ana, { sharing: true });
    await seat(room, bia);

    const first = recorder();
    const second = recorder();
    const at = new Date("2026-10-10T23:00:10Z");
    await first.sample(at);
    await second.sample(new Date("2026-10-10T23:00:40Z"));
    await first.sample(at);

    expect(await stats()).toEqual({
      [ana]: { voice: 60, share: 60, music: 0 },
      [bia]: { voice: 60, share: 0, music: 0 },
    });

    await first.sample(new Date("2026-10-10T23:01:05Z"));
    expect((await stats())[ana]).toEqual({ voice: 120, share: 120, music: 0 });
  });

  it("counts every tick of one sampler, and never moves the stored time back", async () => {
    const ana = await person("ana");
    const bia = await person("bia");
    const room = randomUUID();
    await seat(room, ana);
    await seat(room, bia);

    // A timer whose phase sits on the minute boundary: two ticks inside one
    // clock minute are still two minutes of call.
    const timer = recorder();
    await timer.sample(new Date("2026-10-10T23:00:00.100Z"));
    await timer.sample(new Date("2026-10-10T23:00:59.900Z"));
    expect((await stats())[ana]?.voice).toBe(120);

    // A late sample, older than the stored one, adds nothing...
    await recorder().sample(new Date("2026-10-10T23:00:30Z"));
    // ...and does not move the stored time back: had it gone back to :30,
    // this second sampler's tick 20 s after the stored one would count.
    await recorder().sample(new Date("2026-10-10T23:01:20Z"));
    expect((await stats())[ana]?.voice).toBe(120);

    await timer.sample(new Date("2026-10-10T23:01:59.950Z"));
    expect((await stats())[ana]?.voice).toBe(180);
  });

  it("retries a failed write before the next tick, oldest first", async () => {
    const ana = await person("ana");
    const bia = await person("bia");
    const room = randomUUID();
    await seat(room, ana, { sharing: true });
    await seat(room, bia);
    let fail = true;
    const r = createUserStatsRecorder({
      enabled: () => true,
      pool: () =>
        ({
          query: async (text: string, values?: unknown[]) => {
            if (fail) {
              throw new Error("breaker open");
            }
            return getPool().query(text, values);
          },
        }) as unknown as ReturnType<typeof getPool>,
    });

    // Seven failed minutes: the five newest are kept.
    for (let minute = 0; minute < 7; minute += 1) {
      await r.sample(new Date(Date.parse("2026-10-10T23:00:00Z") + minute * 60_000));
    }
    expect(await stats()).toEqual({});
    expect(r.metrics()).toMatchObject({ samplesPending: 5, samplesDropped: 2 });

    // The database is back: the five kept minutes land, then this one.
    fail = false;
    await r.sample(new Date("2026-10-10T23:07:00Z"));
    expect(await stats()).toEqual({
      [ana]: { voice: 360, share: 360, music: 0 },
      [bia]: { voice: 360, share: 0, music: 0 },
    });
    expect(r.metrics()).toMatchObject({ samplesPending: 0, samplesRetried: 5 });
  });

  it("counts nothing for a held seat, a room of one, a bot or a second tab", async () => {
    const ana = await person("ana");
    const bia = await person("bia");
    const bot = await person("bot");
    await getPool().query(`UPDATE users SET is_bot = TRUE WHERE id = $1`, [bot]);

    // Ana is alone once Bia's seat is only held for resume.
    const room = randomUUID();
    await seat(room, ana);
    await seat(room, bia, { orphaned: true });
    // A bot is not company: Bia with only a bot is alone too.
    const withBot = randomUUID();
    await seat(withBot, bia);
    await seat(withBot, bot);
    // Two tabs of one person are one person.
    const tabs = randomUUID();
    await seat(tabs, ana);
    await seat(tabs, ana, { sharing: true });

    await recorder().sample(new Date("2026-10-10T23:00:00Z"));
    expect(await stats()).toEqual({});

    // Somebody real joins Bia: now it is a call, counted once for her.
    await seat(withBot, ana);
    await recorder().sample(new Date("2026-10-10T23:01:00Z"));
    expect(await stats()).toEqual({
      [ana]: { voice: 60, share: 0, music: 0 },
      [bia]: { voice: 60, share: 0, music: 0 },
    });
  });

  it("writes nothing in a blind worker, and says so", async () => {
    const ana = await person("ana");
    const bia = await person("bia");
    const room = randomUUID();
    await seat(room, ana);
    await seat(room, bia);
    process.env.VOICE_REGISTRY = "off";
    const savedRole = process.env.WORKER_MODE;
    process.env.WORKER_MODE = "worker";
    try {
      const blind = recorder();
      const result = await blind.sample(new Date("2026-10-10T23:00:00Z"));
      expect(result.source).toBe("unavailable");
      expect(blind.metrics().blindTicks).toBe(1);
      expect(await stats()).toEqual({});
    } finally {
      if (savedRole === undefined) {
        delete process.env.WORKER_MODE;
      } else {
        process.env.WORKER_MODE = savedRole;
      }
    }
  });

  it("writes nothing while the flag is off", async () => {
    const ana = await person("ana");
    const bia = await person("bia");
    const room = randomUUID();
    await seat(room, ana);
    await seat(room, bia);
    const off = createUserStatsRecorder({ enabled: () => false });
    expect((await off.sample()).source).toBe("off");
    off.noteMusicQueued(ana, 3);
    expect(await off.flushMusic()).toBe(0);
    expect(await stats()).toEqual({});
  });

  it("drops noted tracks when the flag goes off before the flush", async () => {
    const ana = await person("ana");
    let on = true;
    const r = createUserStatsRecorder({ enabled: () => on });
    r.noteMusicQueued(ana, 2);
    on = false;
    expect(await r.flushMusic()).toBe(0);
    expect(await stats()).toEqual({});
    expect(r.metrics()).toMatchObject({ musicPending: 0, musicDropped: 2 });
  });

  it("lets a track dropped by an off flush count when reported again", async () => {
    const ana = await person("ana");
    let on = true;
    const r = createUserStatsRecorder({
      enabled: () => on,
      now: () => Date.parse("2026-10-10T12:00:00Z"),
    });
    r.noteTracksQueued(ana, ["t1"]);
    on = false;
    expect(await r.flushMusic()).toBe(0);
    on = true;
    r.noteTracksQueued(ana, ["t1"]);
    r.noteTracksQueued(ana, ["t1"]);
    await r.flushMusic();
    expect(await stats()).toEqual({ [ana]: { voice: 0, share: 0, music: 1 } });
  });

  it("counts one add once, however many writes report it", async () => {
    const ana = await person("ana");
    const r = createUserStatsRecorder({
      enabled: () => true,
      now: () => Date.parse("2026-10-10T23:30:00Z"),
    });
    r.noteTracksQueued(ana, ["t1", "t2"]);
    // Two writes that both lost to a winner holding t2 report it again.
    r.noteTracksQueued(ana, ["t2"]);
    r.noteTracksQueued(ana, ["t2", "t3"]);
    expect(r.metrics().musicNoted).toBe(3);
    await r.flushMusic();
    expect(await stats()).toEqual({ [ana]: { voice: 0, share: 0, music: 3 } });
  });

  it("keeps a counted track recognised for the whole window, then forgets it", async () => {
    const ana = await person("ana");
    let at = Date.parse("2026-10-10T12:00:00Z");
    const r = createUserStatsRecorder({ enabled: () => true, now: () => at });
    r.noteTracksQueued(ana, ["t1"]);
    // A busy instance adds many other tracks meanwhile; t1 is still known.
    for (let i = 0; i < 25_000; i += 1) {
      r.noteTracksQueued(ana, [`filler-${i}`]);
    }
    at += 60 * 60_000;
    r.noteTracksQueued(ana, ["t1"]);
    expect(r.metrics().musicNoted).toBe(25_001);
    // Past the window a re-send is a new add.
    at += 7 * 60 * 60_000;
    r.noteTracksQueued(ana, ["t1"]);
    expect(r.metrics().musicNoted).toBe(25_002);
  });

  it("credits a track only once the buffer accepted its count", async () => {
    const ana = await person("ana");
    const bia = await person("bia");
    const r = createUserStatsRecorder({
      enabled: () => true,
      now: () => Date.parse("2026-10-10T12:00:00Z"),
      maxPendingMusic: 1,
    });
    r.noteTracksQueued(ana, ["a1"]);
    // The buffer is full for a new person: refused, not credited.
    r.noteTracksQueued(bia, ["b1"]);
    expect(r.metrics()).toMatchObject({ musicNoted: 1, musicDropped: 1 });
    await r.flushMusic();
    // The same report again now lands, because the first one never counted.
    r.noteTracksQueued(bia, ["b1"]);
    r.noteTracksQueued(bia, ["b1"]);
    await r.flushMusic();
    expect(await stats()).toEqual({
      [ana]: { voice: 0, share: 0, music: 1 },
      [bia]: { voice: 0, share: 0, music: 1 },
    });
  });

  it("flushes queued tracks per person per day, beside the call time", async () => {
    const ana = await person("ana");
    const r = createUserStatsRecorder({
      enabled: () => true,
      now: () => Date.parse("2026-10-10T23:30:00Z"),
    });
    r.noteMusicQueued(ana, 2);
    r.noteMusicQueued(ana, 1);
    r.noteMusicQueued(ana, 0);
    await r.flushMusic();
    r.noteMusicQueued(ana, 4);
    await r.flushMusic();
    expect(await stats()).toEqual({ [ana]: { voice: 0, share: 0, music: 7 } });
    const day = await getPool().query(`SELECT day::text FROM user_daily_stats`);
    // 23:30 UTC is 20:30 in São Paulo, same day.
    expect(day.rows[0].day).toBe("2026-10-10");
  });

  it("keeps queued tracks through a failed flush", async () => {
    const ana = await person("ana");
    let fail = true;
    const r = createUserStatsRecorder({
      enabled: () => true,
      pool: () =>
        ({
          query: async (text: string, values?: unknown[]) => {
            if (fail) {
              throw new Error("breaker open");
            }
            return getPool().query(text, values);
          },
        }) as unknown as ReturnType<typeof getPool>,
    });
    r.noteMusicQueued(ana, 2);
    await r.flushMusic();
    expect(r.metrics().musicFlushFailures).toBe(1);
    expect(r.metrics().musicPending).toBe(2);
    fail = false;
    await r.flushMusic();
    expect(await stats()).toEqual({ [ana]: { voice: 0, share: 0, music: 2 } });
  });

  it("copies watched parties before the viewer prune, one row per party", async () => {
    const ana = await person("ana");
    const { channels } = await createServer("Cinema", ana);
    const channelId = channels[0].id;
    const startedAt = Date.parse("2026-10-10T22:00:00Z");
    await getPool().query(
      `INSERT INTO hls_session_viewers
         (channel_id, started_at_ms, user_id, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, now() - interval '30 minutes', now())`,
      [channelId, startedAt, ana],
    );
    const r = recorder();
    expect(await r.copyWatchParties()).toBe(1);
    expect(await r.copyWatchParties()).toBe(0);

    // A party last seen hours ago, still inside the viewer table's 24h
    // retention: a worker that was down that long still copies it.
    await getPool().query(
      `INSERT INTO hls_session_viewers
         (channel_id, started_at_ms, user_id, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, now() - interval '6 hours', now() - interval '5 hours')`,
      [channelId, startedAt - 86_400_000, ana],
    );
    expect(await r.copyWatchParties()).toBe(1);

    // The viewer table prunes; the copy stays.
    await getPool().query(`TRUNCATE hls_session_viewers`);
    const kept = await getPool().query(`SELECT user_id FROM user_watch_parties`);
    expect(kept.rows).toEqual([{ user_id: ana }, { user_id: ana }]);
  });

  it("goes with the account", async () => {
    const ana = await person("ana");
    const bia = await person("bia");
    const room = randomUUID();
    await seat(room, ana);
    await seat(room, bia);
    await recorder().sample(new Date("2026-10-10T23:00:00Z"));
    await getPool().query(`DELETE FROM users WHERE id = $1`, [ana]);
    expect(Object.keys(await stats())).toEqual([bia]);
  });
});
