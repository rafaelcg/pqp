import { getPool } from "../db.js";
import { sfuRegions } from "./regions.js";

/**
 * WHERE A SERVER'S PEOPLE ARE, for `decideSfuRegion` (`voice/regions.ts`).
 *
 * WHY. A room's SFU region used to follow its first joiner's country, so one
 * visitor from London first into a big Brazilian server's channel put the
 * whole call on the London box and every Brazilian paid the extra ocean both
 * ways. The region should follow the server's people instead, and this file
 * is the two halves of knowing where they are:
 *
 * - RECORDING. Each account's last seen country (`users.last_country`, the
 *   two-letter `CF-IPCountry` the WebSocket upgrade already carried, never an
 *   IP, never a city) and when (`users.last_country_at`). Written at WS auth,
 *   at most once per account per `COUNTRY_WRITE_INTERVAL_MS` unless the
 *   country changed, and only in multi-region mode: a deployment without
 *   `LIVEKIT_REGIONS` never writes it, same as every other region column.
 *
 * - READING. Per server, how many members seen in the last
 *   `ACTIVE_WINDOW_DAYS` days were last seen in each country. Cached per
 *   server for `SERVER_COUNTRIES_TTL_MS`: a server's centre of gravity moves
 *   over weeks, and the read runs only when a room opens.
 */

/** A known account's country is refreshed at most this often, unless it changed. */
export const COUNTRY_WRITE_INTERVAL_MS = 6 * 60 * 60_000;

/** Members count only if seen within this many days. */
export const ACTIVE_WINDOW_DAYS = 30;

/** How long one server's tally is reused before it is read again. */
export const SERVER_COUNTRIES_TTL_MS = 3 * 60 * 60_000;

/** Bounds on the two in-process maps, so neither grows with the user base forever. */
const MAX_REMEMBERED_WRITES = 100_000;
const MAX_CACHED_SERVERS = 10_000;

/** Last country this process wrote per account, and when. */
const lastWrites = new Map<string, { country: string; at: number }>();

/**
 * Record where an account was just seen. Fire and forget from the caller's
 * point of view: it never throws, and a failed write only means the next
 * connection tries again.
 *
 * Two throttles. In process: the same country for the same account inside
 * the interval issues no query at all. In the database: the UPDATE's WHERE
 * skips the write when the row already says so and is fresh, which covers
 * the other replica and a restart that emptied the map.
 *
 * ORDERED BY OBSERVATION. `last_country_at` is the moment this process saw
 * the connection, not the moment the statement ran, and a write only lands
 * over an older observation. Two connections from two countries at once (a
 * phone and a VPN'd laptop) cannot leave the older one stored because its
 * statement happened to run second.
 */
export async function recordUserCountry(
  userId: string,
  country: string | null,
  now: number = Date.now(),
): Promise<boolean> {
  if (!country || !sfuRegions()) {
    return false;
  }
  const previous = lastWrites.get(userId);
  if (
    previous &&
    previous.country === country &&
    now - previous.at < COUNTRY_WRITE_INTERVAL_MS
  ) {
    return false;
  }
  // Re-inserted so the Map's order is least recently written first, and
  // only the oldest entry goes at the bound: clearing the whole map would
  // send every remembered account back to the database at once.
  lastWrites.delete(userId);
  evictOldest(lastWrites, MAX_REMEMBERED_WRITES);
  lastWrites.set(userId, { country, at: now });
  try {
    const result = await getPool().query(
      `UPDATE users
          SET last_country = $2, last_country_at = $4
        WHERE id = $1
          AND (last_country_at IS NULL OR last_country_at < $4)
          AND (last_country IS DISTINCT FROM $2
               OR last_country_at IS NULL
               OR last_country_at < $4 - make_interval(secs => $3))`,
      [userId, country, COUNTRY_WRITE_INTERVAL_MS / 1000, new Date(now)],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    // Forget the attempt so the next connection retries it (unless a newer
    // one already replaced it).
    if (lastWrites.get(userId)?.at === now) {
      lastWrites.delete(userId);
    }
    console.error("[voice] recording the account's country failed:", error);
    return false;
  }
}

interface CachedTally {
  at: number;
  countries: Promise<Map<string, number>>;
}

const serverTallies = new Map<string, CachedTally>();

/**
 * Recently active members of a server per country. Bots and character
 * accounts do not count: they are not people on a microphone. Rejects on a
 * failed read (and forgets it, so the next room retries); the caller treats
 * that as "no data", which is the first-joiner rule.
 */
export function serverMemberCountries(
  serverId: string,
  now: number = Date.now(),
): Promise<Map<string, number>> {
  const cached = serverTallies.get(serverId);
  if (cached && now - cached.at < SERVER_COUNTRIES_TTL_MS) {
    // Touched: moved to the back, so eviction takes the coldest server.
    serverTallies.delete(serverId);
    serverTallies.set(serverId, cached);
    return cached.countries;
  }
  serverTallies.delete(serverId);
  evictOldest(serverTallies, MAX_CACHED_SERVERS);
  const countries = readServerMemberCountries(serverId);
  serverTallies.set(serverId, { at: now, countries });
  countries.catch(() => {
    if (serverTallies.get(serverId)?.countries === countries) {
      serverTallies.delete(serverId);
    }
  });
  return countries;
}

async function readServerMemberCountries(
  serverId: string,
): Promise<Map<string, number>> {
  const result = await getPool().query<{ country: string; members: number }>(
    `SELECT u.last_country AS country, COUNT(*)::int AS members
       FROM server_members sm
       JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = $1
        AND u.last_country IS NOT NULL
        AND u.last_country_at > NOW() - make_interval(days => $2)
        AND NOT u.is_bot
        AND NOT u.is_character
      GROUP BY u.last_country`,
    [serverId, ACTIVE_WINDOW_DAYS],
  );
  return new Map(result.rows.map((row) => [row.country, row.members]));
}

/**
 * Drop the oldest entries until there is room for one more. A Map iterates
 * in insertion order and both callers re-insert on use, so this is LRU.
 */
function evictOldest(map: Map<string, unknown>, max: number): void {
  while (map.size >= max) {
    const oldest = map.keys().next();
    if (oldest.done) {
      return;
    }
    map.delete(oldest.value);
  }
}

/** Test hook. */
export function resetRegionAudience(): void {
  lastWrites.clear();
  serverTallies.clear();
}
