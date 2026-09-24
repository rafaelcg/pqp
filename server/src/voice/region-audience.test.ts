import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The server-majority signal on a real Postgres: recording an account's last
 * seen country (throttled, country only, dark without regions) and folding a
 * server's recently active members into a per-country tally.
 *
 * TEST_DATABASE_URL wins, and the suite skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  COUNTRY_WRITE_INTERVAL_MS,
  SERVER_COUNTRIES_TTL_MS,
  recordUserCountry,
  resetRegionAudience,
  serverMemberCountries,
} = await import("./region-audience.js");

const SAVED = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_REGIONS",
] as const;
const saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));

async function makeUser(
  flags: { bot?: boolean; character?: boolean } = {},
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO users (clerk_id, display_name, is_bot, is_character)
     VALUES ($1, 'Region Tester', $2, $3) RETURNING id`,
    [`clerk_region_${randomUUID()}`, flags.bot ?? false, flags.character ?? false],
  );
  return result.rows[0]!.id;
}

async function makeServer(ownerId: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO servers (name, owner_id) VALUES ('region test', $1) RETURNING id`,
    [ownerId],
  );
  return result.rows[0]!.id;
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
    [serverId, userId],
  );
}

async function seen(userId: string, country: string, daysAgo = 0): Promise<void> {
  await getPool().query(
    `UPDATE users SET last_country = $2,
            last_country_at = NOW() - make_interval(days => $3)
      WHERE id = $1`,
    [userId, country, daysAgo],
  );
}

async function row(
  userId: string,
): Promise<{ last_country: string | null; last_country_at: Date | null }> {
  const result = await getPool().query<{
    last_country: string | null;
    last_country_at: Date | null;
  }>(`SELECT last_country, last_country_at FROM users WHERE id = $1`, [userId]);
  return result.rows[0]!;
}

describeDb("region audience (real Postgres)", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
    for (const name of SAVED) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  beforeEach(() => {
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    process.env.LIVEKIT_REGIONS = "mia:wss://sfu-mia.example.test";
    resetRegionAudience();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("recordUserCountry", () => {
    it("stores the two-letter country and a timestamp, nothing else", async () => {
      const user = await makeUser();
      expect(await recordUserCountry(user, "BR")).toBe(true);
      const stored = await row(user);
      expect(stored.last_country).toBe("BR");
      expect(stored.last_country_at).toBeInstanceOf(Date);
    });

    it("writes nothing without LIVEKIT_REGIONS, which is every self-host", async () => {
      delete process.env.LIVEKIT_REGIONS;
      const user = await makeUser();
      expect(await recordUserCountry(user, "BR")).toBe(false);
      expect(await row(user)).toEqual({ last_country: null, last_country_at: null });
    });

    it("writes nothing for a socket without a country", async () => {
      const user = await makeUser();
      expect(await recordUserCountry(user, null)).toBe(false);
      expect((await row(user)).last_country).toBeNull();
    });

    it("the same country inside the interval issues no query at all", async () => {
      const user = await makeUser();
      const now = Date.now();
      await recordUserCountry(user, "BR", now);
      const query = vi.spyOn(getPool(), "query");
      expect(await recordUserCountry(user, "BR", now + 60_000)).toBe(false);
      expect(query).not.toHaveBeenCalled();
    });

    it("a new country is written at once, throttle or not", async () => {
      const user = await makeUser();
      const now = Date.now();
      await recordUserCountry(user, "BR", now);
      expect(await recordUserCountry(user, "GB", now + 60_000)).toBe(true);
      expect((await row(user)).last_country).toBe("GB");
    });

    it("the database skips a fresh identical row (the other replica, or after a restart)", async () => {
      const user = await makeUser();
      await recordUserCountry(user, "BR");
      const first = (await row(user)).last_country_at;
      // A new process: none of the in-process memory.
      resetRegionAudience();
      expect(await recordUserCountry(user, "BR")).toBe(false);
      expect((await row(user)).last_country_at).toEqual(first);
    });

    it("refreshes a stale row after the interval", async () => {
      const user = await makeUser();
      await getPool().query(
        `UPDATE users SET last_country = 'BR',
                last_country_at = NOW() - make_interval(secs => $2)
          WHERE id = $1`,
        [user, COUNTRY_WRITE_INTERVAL_MS / 1000 + 60],
      );
      expect(await recordUserCountry(user, "BR")).toBe(true);
      const at = (await row(user)).last_country_at!;
      expect(Date.now() - at.getTime()).toBeLessThan(60_000);
    });
  });

  describe("serverMemberCountries", () => {
    it("counts this server's recently active people by country", async () => {
      const owner = await makeUser();
      const server = await makeServer(owner);
      const other = await makeServer(owner);
      await addMember(server, owner);
      await seen(owner, "BR");
      for (const country of ["BR", "BR", "GB", "US"]) {
        const user = await makeUser();
        await addMember(server, user);
        await seen(user, country, 2);
      }
      // Not counted: seen too long ago, never seen, a bot, a character, and
      // somebody who belongs to a different server.
      const stale = await makeUser();
      await addMember(server, stale);
      await seen(stale, "GB", 45);
      await addMember(server, await makeUser());
      const bot = await makeUser({ bot: true });
      await addMember(server, bot);
      await seen(bot, "US");
      const character = await makeUser({ character: true });
      await addMember(server, character);
      await seen(character, "US");
      const outsider = await makeUser();
      await addMember(other, outsider);
      await seen(outsider, "GB");

      expect(await serverMemberCountries(server)).toEqual(
        new Map([
          ["BR", 3],
          ["GB", 1],
          ["US", 1],
        ]),
      );
    });

    it("caches per server, then reads again after the TTL", async () => {
      const owner = await makeUser();
      const server = await makeServer(owner);
      await addMember(server, owner);
      await seen(owner, "BR");
      const now = Date.now();
      expect(await serverMemberCountries(server, now)).toEqual(new Map([["BR", 1]]));

      const newcomer = await makeUser();
      await addMember(server, newcomer);
      await seen(newcomer, "GB");
      expect(await serverMemberCountries(server, now + 60_000)).toEqual(
        new Map([["BR", 1]]),
      );
      expect(
        await serverMemberCountries(server, now + SERVER_COUNTRIES_TTL_MS + 1),
      ).toEqual(
        new Map([
          ["BR", 1],
          ["GB", 1],
        ]),
      );
    });

    it("recording feeds the tally end to end", async () => {
      const owner = await makeUser();
      const server = await makeServer(owner);
      await addMember(server, owner);
      await recordUserCountry(owner, "GB");
      expect(await serverMemberCountries(server)).toEqual(new Map([["GB", 1]]));
    });
  });
});
