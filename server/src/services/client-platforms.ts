import type { IncomingHttpHeaders } from "node:http";
import type { Pool } from "pg";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import {
  applyDeclaredClient,
  parseClientAgent,
  type ClientFacts,
  type ClientPlatform,
} from "../lib/client-agent.js";

/**
 * Which app, on which OS, a person last connected from. For support only:
 * "I can't hear" and "my share has no sound" are very different bugs on
 * Chrome-on-Windows, the desktop shell and a phone, and until this the
 * answer was "ask them, then ask what a browser is".
 *
 * WHAT IS KEPT
 * One row per (account, platform): platform (web / desktop / ios / android),
 * OUR app version where the client says it, the OS family and the browser
 * family, first and last seen. No user agent string, no IP, no device model,
 * no browser version. Parsed in `lib/client-agent.ts` at the WebSocket
 * upgrade and the string is dropped there.
 *
 * WHAT IS MISSING, BY DESIGN OF THE CLIENTS TODAY
 * No app sends its version on the socket yet, so the version comes only from
 * what the server already sees: the desktop shell's `pqp/<version>` token in
 * Electron's user agent, and the iOS build number from URLSession's. The
 * Android app (OkHttp's default agent) and the web client (no build id on the
 * socket) have no app version. The `auth` frame accepts an optional
 * `client: { platform, version }` so an app can fill it in later with no
 * server release. See tools/admin-dashboard/README.md §"Which app a user is on".
 *
 * WHO CAN READ IT
 * Instance moderators and the operator dashboard's machine token, through
 * `GET /api/admin/users/:userId/client` and `GET /api/admin/user-client`.
 * Never a public profile, never a member, never another server's owner.
 *
 * NO WRITE PER CONNECTION
 * Same shape as `user-activity.ts`, for the same reason (a deploy reconnects
 * every socket at once; a per-connection UPDATE is the 2026-09-12 pool
 * storm). A note is a `Map.set`; a fact already written within the last hour
 * is not queued again, so `last_seen_at` is accurate to about an hour, and
 * each process flushes once a minute as one multi-row upsert.
 *
 * RETENTION
 * `sweepClientPlatforms` (daily, `jobs.ts`) deletes rows not seen for
 * `CLIENT_PLATFORM_RETENTION_DAYS`. The account's deletion cascades the rest.
 */

export const ADMIN_USER_CLIENT_PATH = "/api/admin/user-client";

export const CLIENT_PLATFORM_FLUSH_INTERVAL_MS = 60_000;
/** A fact already stored is re-sent no sooner than this, to move `last_seen_at`. */
export const CLIENT_PLATFORM_REFRESH_MS = 60 * 60_000;
export const CLIENT_PLATFORM_RETENTION_DAYS = 90;
const MAX_PENDING = 20_000;
const MAX_REMEMBERED = 100_000;
const MAX_ROWS_PER_STATEMENT = 2_000;

export interface ClientPlatformRecorderStats {
  noted: number;
  pending: number;
  flushes: number;
  flushFailures: number;
  dropped: number;
}

export interface ClientPlatformRecorder {
  note(userId: string, facts: ClientFacts): void;
  flush(): Promise<number>;
  stats(): ClientPlatformRecorderStats;
  start(): () => Promise<void>;
  resetForTests(): void;
}

interface Pending {
  userId: string;
  facts: ClientFacts;
  /** When this process observed it, so a late write cannot beat a later one. */
  seenAt: number;
}

function signature(facts: ClientFacts): string {
  return [facts.platform, facts.appVersion, facts.osFamily, facts.browserFamily].join("|");
}

export function createClientPlatformRecorder(
  options: {
    now?: () => number;
    pool?: () => Pick<Pool, "query">;
    flushIntervalMs?: number;
    maxPending?: number;
  } = {},
): ClientPlatformRecorder {
  const now = options.now ?? Date.now;
  const pool = options.pool ?? getPool;
  const flushIntervalMs = options.flushIntervalMs ?? CLIENT_PLATFORM_FLUSH_INTERVAL_MS;
  const maxPending = options.maxPending ?? MAX_PENDING;

  /** Noted and not yet stored, keyed `userId|platform`. */
  let pending = new Map<string, Pending>();
  /**
   * The last fact this process noted for each key, and whether it has landed.
   * Suppression is judged against THIS and not against what was last stored:
   * a Firefox note still queued or in flight must not make a later Chrome
   * note look like "already stored" (it would leave Firefox as the latest
   * sighting). Oldest first.
   */
  const known = new Map<string, { sig: string; at: number; landed: boolean }>();
  let flushing: Promise<number> | null = null;
  let noted = 0;
  let flushes = 0;
  let flushFailures = 0;
  let dropped = 0;

  function note(userId: string, facts: ClientFacts): void {
    // A script or a bot with no recognisable agent says nothing worth a row.
    if (facts.platform === "unknown") {
      return;
    }
    const key = `${userId}|${facts.platform}`;
    const sig = signature(facts);
    const at = now();
    const previous = known.get(key);
    if (
      previous &&
      previous.sig === sig &&
      // Same as what is queued or in flight (it will land), or landed lately.
      (!previous.landed || at - previous.at < CLIENT_PLATFORM_REFRESH_MS)
    ) {
      return;
    }
    if (!pending.has(key) && pending.size >= maxPending) {
      dropped += 1;
      return;
    }
    noted += 1;
    // The newest fact for this key wins within a batch.
    pending.set(key, { userId, facts, seenAt: at });
    // Re-inserted so the Map's order is least recently noted first, and
    // bounded by dropping the oldest: a forgotten key is only ever written
    // once more than it had to be.
    known.delete(key);
    known.set(key, { sig, at, landed: false });
    if (known.size > MAX_REMEMBERED) {
      const oldest = known.keys().next().value;
      if (oldest !== undefined) {
        known.delete(oldest);
      }
    }
  }

  function flush(): Promise<number> {
    if (flushing) {
      return flushing;
    }
    if (pending.size === 0) {
      return Promise.resolve(0);
    }
    flushing = flushBatch().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function flushBatch(): Promise<number> {
    const batch = pending;
    pending = new Map();
    let written = 0;
    try {
      const entries = [...batch.entries()];
      for (let i = 0; i < entries.length; i += MAX_ROWS_PER_STATEMENT) {
        const slice = entries.slice(i, i + MAX_ROWS_PER_STATEMENT);
        // Joined to `users` so an account deleted between the note and the
        // flush drops out instead of failing the statement on the foreign
        // key, and so bots, webhooks and the house cast never get a row.
        // `(user_id, platform)` is unique within a batch (the Map key), which
        // `ON CONFLICT DO UPDATE` requires.
        const result = await pool().query(
          `INSERT INTO user_client_platforms
             (user_id, platform, app_version, os_family, browser_family, last_seen_at)
           SELECT v.user_id, v.platform, v.app_version, v.os_family, v.browser_family,
                  v.seen_at
             FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[],
                         $6::timestamptz[])
                  AS v(user_id, platform, app_version, os_family, browser_family, seen_at)
             JOIN users u ON u.id = v.user_id
            WHERE NOT u.is_webhook AND NOT u.is_character AND NOT u.is_bot
           ON CONFLICT (user_id, platform) DO UPDATE
             SET app_version    = EXCLUDED.app_version,
                 os_family      = EXCLUDED.os_family,
                 browser_family = EXCLUDED.browser_family,
                 last_seen_at   = EXCLUDED.last_seen_at
             -- Two API processes flush on their own clocks: the observation
             -- that happened LAST wins, not the flush that ran last.
             WHERE user_client_platforms.last_seen_at <= EXCLUDED.last_seen_at`,
          [
            slice.map(([, e]) => e.userId),
            slice.map(([, e]) => e.facts.platform),
            slice.map(([, e]) => e.facts.appVersion),
            slice.map(([, e]) => e.facts.osFamily),
            slice.map(([, e]) => e.facts.browserFamily),
            slice.map(([, e]) => new Date(e.seenAt)),
          ],
        );
        written += result.rowCount ?? 0;
        for (const [key, entry] of slice) {
          batch.delete(key);
          // Landed, unless something newer was noted for the key meanwhile
          // (then `known` already names that one, still queued).
          const current = known.get(key);
          if (current && current.sig === signature(entry.facts)) {
            current.landed = true;
            current.at = now();
          }
        }
      }
      flushes += 1;
      return written;
    } catch (error) {
      flushFailures += 1;
      // Put back what did not land, unless something newer was noted meanwhile.
      for (const [key, entry] of batch) {
        if (pending.has(key)) {
          continue;
        }
        if (pending.size >= maxPending) {
          dropped += 1;
          continue;
        }
        pending.set(key, entry);
      }
      logEvent("clientPlatforms.flushFailed", {
        pending: pending.size,
        error: error instanceof Error ? error.message : String(error),
      });
      return written;
    }
  }

  function start(): () => Promise<void> {
    const timer = setInterval(() => {
      void flush().catch(() => undefined);
    }, flushIntervalMs);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await flush().catch(() => undefined);
      await flush().catch(() => undefined);
    };
  }

  return {
    note,
    flush,
    stats: () => ({ noted, pending: pending.size, flushes, flushFailures, dropped }),
    start,
    resetForTests() {
      pending = new Map();
      known.clear();
      flushing = null;
      noted = 0;
      flushes = 0;
      flushFailures = 0;
      dropped = 0;
    },
  };
}

export const clientPlatforms = createClientPlatformRecorder();

// ---------------------------------------------------------------------------
// The socket's own facts, parsed once at the upgrade.

/**
 * What each live socket's upgrade said about its client. A WeakMap so a
 * closed socket takes its entry with it, and the raw user agent is parsed
 * the moment it arrives and never held: only families go in.
 */
const socketClients = new WeakMap<object, ClientFacts>();

export function noteSocketClient(socket: object, headers: IncomingHttpHeaders): void {
  const raw = headers["user-agent"];
  socketClients.set(socket, parseClientAgent(Array.isArray(raw) ? raw[0] : raw));
}

/** The socket's client, with whatever its `auth` frame declared on top. */
export function socketClient(socket: object, declared?: unknown): ClientFacts {
  const parsed = socketClients.get(socket) ?? parseClientAgent(null);
  return applyDeclaredClient(parsed, declared);
}

// ---------------------------------------------------------------------------
// Retention.

/** Rows for a client not seen in `CLIENT_PLATFORM_RETENTION_DAYS`. */
export async function sweepClientPlatforms(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM user_client_platforms
      WHERE last_seen_at < NOW() - make_interval(days => $1)`,
    [CLIENT_PLATFORM_RETENTION_DAYS],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// The read.

export interface UserClientRow {
  platform: ClientPlatform;
  /** Our app's version, when known. See the header for which apps say it. */
  appVersion: string | null;
  osFamily: string | null;
  browserFamily: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface UserClientReport {
  userId: string;
  /** The most recently seen client, or null when nothing has been recorded. */
  latest: UserClientRow | null;
  /** Every platform seen inside the retention window, newest first. */
  clients: UserClientRow[];
  /** Days a row is kept after its last sighting. */
  retentionDays: number;
  /** What the recorder cannot know today, so a blank is not misread. */
  notRecorded: string[];
}

const NOT_RECORDED = [
  "web build id",
  "android app version",
  "ios marketing version (the build number is recorded when present)",
  "browser and OS versions",
];

interface Row {
  platform: ClientPlatform;
  app_version: string | null;
  os_family: string | null;
  browser_family: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

export type UserClientTarget = { userId: string } | { handle: string } | { tag: string };

/**
 * An account id from whatever the operator has: the id, a public handle, or
 * `name#1234`. Null when nobody matches. Humans only: a webhook or a
 * character has no client.
 */
export async function resolveUserClientTarget(
  target: UserClientTarget,
): Promise<string | null> {
  if ("userId" in target) {
    const result = await getPool().query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [target.userId],
    );
    return result.rows[0]?.id ?? null;
  }
  if ("handle" in target) {
    const result = await getPool().query<{ id: string }>(
      `SELECT id FROM users WHERE handle = lower($1) AND NOT is_webhook`,
      [target.handle.trim().replace(/^@/, "")],
    );
    return result.rows[0]?.id ?? null;
  }
  const match = /^([^#\s]{1,64})#(\d{4})$/.exec(target.tag.trim().replace(/^@/, ""));
  if (!match) {
    return null;
  }
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM users
      WHERE lower(username) = lower($1) AND discriminator = $2 AND NOT is_webhook`,
    [match[1], match[2]],
  );
  return result.rows[0]?.id ?? null;
}

export async function userClientReport(userId: string): Promise<UserClientReport> {
  const result = await getPool().query<Row>(
    `SELECT platform, app_version, os_family, browser_family, first_seen_at, last_seen_at
       FROM user_client_platforms
      WHERE user_id = $1
        AND last_seen_at >= NOW() - make_interval(days => $2)
      ORDER BY last_seen_at DESC`,
    [userId, CLIENT_PLATFORM_RETENTION_DAYS],
  );
  const clients: UserClientRow[] = result.rows.map((row) => ({
    platform: row.platform,
    appVersion: row.app_version,
    osFamily: row.os_family,
    browserFamily: row.browser_family,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  }));
  return {
    userId,
    latest: clients[0] ?? null,
    clients,
    retentionDays: CLIENT_PLATFORM_RETENTION_DAYS,
    notRecorded: NOT_RECORDED,
  };
}
