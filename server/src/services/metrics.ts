import { timingSafeEqual } from "node:crypto";
import { getPool } from "../db.js";
import { getVoiceActivitySnapshot } from "../ws/voice.js";
import { acquisitionReport, type AcquisitionReport } from "./acquisition.js";
import { callRatingSummary } from "./call-ratings.js";
import { connectionAdoption, type ConnectionAdoption } from "./connections.js";
import type { CallRatingSummary } from "@pqp/shared";

/**
 * The operator dashboard's one read: `GET /api/admin/metrics`.
 *
 * Aggregate counts and nothing else. No ids, no handles, no emails, no
 * per-person rows. The only names in the payload are the top five server
 * names of the last 24 hours, which is why the dashboard that renders this
 * sits behind its own authentication (see tools/admin-dashboard/README.md).
 *
 * Deliberately NOT on status.json, which carries no user counts of any kind
 * (see services/status.ts). This is a separate, authenticated endpoint.
 *
 * Two ways in, both resolved in api/index.ts:
 *  - an instance moderator with a Clerk session, same predicate as the
 *    acquisition report;
 *  - a machine caller (the Cloudflare Worker in front of the dashboard)
 *    presenting `Authorization: Bearer <ADMIN_METRICS_TOKEN>`, compared in
 *    constant time. With the variable unset that path does not exist.
 *
 * The payload is cached in memory for 30 seconds: the dashboard polls, and the
 * API is one machine in gru. Counts that lag by half a minute are still
 * counts; a scan of `messages` per page refresh is a self-inflicted incident.
 */

export const ADMIN_METRICS_PATH = "/api/admin/metrics";

/** Anything shorter is a guessable token, so it is treated as not set. */
export const ADMIN_METRICS_TOKEN_MIN_LENGTH = 16;

const CACHE_TTL_MS = 30_000;

/** Accounts that are not people are excluded from every count here. */
const EXCLUDED_ACCOUNTS = ["webhook", "character"] as const;

export interface AdminMetrics {
  generatedAt: string;
  /** Seconds the server will keep answering with this same payload. */
  cacheTtlSeconds: number;
  /** The deployed commit (`APP_VERSION`), null when the process was not stamped. */
  version: string | null;
  excludedAccounts: readonly string[];
  users: {
    total: number;
    last24h: number;
    /** 24 hourly buckets, oldest first; the last one is the current hour. */
    byHour: number[];
  };
  servers: { total: number; last24h: number };
  messages: {
    last24h: number;
    /** The 24 hours before those, for a like-for-like delta. */
    previous24h: number;
    lastHour: number;
    /** Webhook and character messages in the last 24h, reported, not counted. */
    automated24h: number;
    byHour: number[];
  };
  distinctSenders24h: number;
  activeTextChannels24h: number;
  channels: { text: number; voice: number; category: number; thread: number };
  voice: {
    activeRooms: number;
    participants: number;
    largestRoomNow: number;
    peakRoomSizeToday: number;
    /** ISO; the peak resets on deploy and at São Paulo midnight. */
    peakTrackedSince: string;
    backend: "mesh" | "livekit";
  };
  topServers24h: {
    name: string;
    tagline: string | null;
    channels: number;
    members: number;
    messages24h: number;
  }[];
  acquisition: AcquisitionReport;
  /** Prompted call quality, last 7 days. Counts only; see call-ratings.ts. */
  callRatings: CallRatingSummary;
  /**
   * Linked Steam / Battle.net / Twitch accounts; see connections.ts.
   *
   * `ofUsers` is the denominator for every share drawn from this block, and it
   * is `users.total` above, from the same snapshot: all human accounts that
   * exist, not accounts created in some window and not accounts that were
   * active. "12 of 400" here means twelve of everyone who ever signed up.
   */
  connections: ConnectionAdoption & { ofUsers: number };
}

// ------------------------------------------------------------------- token

function configuredToken(): string | null {
  const token = process.env.ADMIN_METRICS_TOKEN?.trim() ?? "";
  return token.length >= ADMIN_METRICS_TOKEN_MIN_LENGTH ? token : null;
}

/** Whether the machine-token path is available at all. */
export function isAdminMetricsTokenConfigured(): boolean {
  return configuredToken() !== null;
}

/**
 * Constant-time check of an `Authorization` header against the configured
 * token. False, never a throw, for a missing header, a non-Bearer scheme, an
 * unset token or a mismatch: the caller falls through to the regular Clerk
 * resolution, which is what a moderator's JWT needs anyway.
 */
export function isAdminMetricsTokenValid(authorization: string | undefined): boolean {
  const expected = configuredToken();
  if (!expected || !authorization) {
    return false;
  }
  const [scheme, ...rest] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer") {
    return false;
  }
  const presented = rest.join(" ").trim();
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison so the length check alone does not time differently.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ----------------------------------------------------------------- queries

function toHourly(rows: { hours_ago: number; n: string }[]): number[] {
  const buckets = new Array<number>(24).fill(0);
  for (const row of rows) {
    const index = 23 - Number(row.hours_ago);
    // A row outside the window can only come from clock skew (a created_at
    // slightly in the future); it is dropped rather than thrown on.
    if (index >= 0 && index < 24) {
      buckets[index] = Number(row.n);
    }
  }
  return buckets;
}

/**
 * `hours_ago` is computed in SQL against the database clock, so the buckets do
 * not depend on the app and the database agreeing on what time it is.
 */
function hoursAgo(column: string): string {
  return `(EXTRACT(EPOCH FROM date_trunc('hour', now()) - date_trunc('hour', ${column})) / 3600)::int`;
}

async function computeAdminMetrics(): Promise<AdminMetrics> {
  const pool = getPool();
  const [
    users,
    usersByHour,
    servers,
    channels,
    messages,
    messagesByHour,
    topServers,
    acquisition,
    callRatings,
    connections,
  ] = await Promise.all([
    pool.query<{ total: string; last24h: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::text AS last24h
         FROM users
        WHERE NOT is_webhook AND NOT is_character`,
    ),
    pool.query<{ hours_ago: number; n: string }>(
      `SELECT ${hoursAgo("created_at")} AS hours_ago, COUNT(*)::text AS n
         FROM users
        WHERE created_at >= date_trunc('hour', now()) - interval '23 hours'
          AND NOT is_webhook AND NOT is_character
        GROUP BY 1`,
    ),
    pool.query<{ total: string; last24h: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::text AS last24h
         FROM servers`,
    ),
    pool.query<{ type: string; n: string }>(
      `SELECT type, COUNT(*)::text AS n
         FROM channels
        WHERE kind = 'server'
        GROUP BY type`,
    ),
    pool.query<{
      last24h: string;
      previous24h: string;
      last_hour: string;
      automated24h: string;
      senders: string;
      active_text_channels: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE f.human AND f.recent)::text AS last24h,
              COUNT(*) FILTER (WHERE f.human AND NOT f.recent)::text AS previous24h,
              COUNT(*) FILTER (WHERE f.human AND m.created_at >= now() - interval '1 hour')::text AS last_hour,
              COUNT(*) FILTER (WHERE NOT f.human AND f.recent)::text AS automated24h,
              COUNT(DISTINCT m.author_id) FILTER (WHERE f.human AND f.recent)::text AS senders,
              COUNT(DISTINCT m.channel_id) FILTER (
                WHERE f.human AND f.recent AND c.kind = 'server' AND c.type = 'text'
              )::text AS active_text_channels
         FROM messages m
         JOIN users u ON u.id = m.author_id
         JOIN channels c ON c.id = m.channel_id
         CROSS JOIN LATERAL (
           SELECT NOT (u.is_webhook OR u.is_character) AS human,
                  m.created_at >= now() - interval '24 hours' AS recent
         ) f
        WHERE m.created_at >= now() - interval '48 hours'`,
    ),
    pool.query<{ hours_ago: number; n: string }>(
      `SELECT ${hoursAgo("m.created_at")} AS hours_ago,
              COUNT(*)::text AS n
         FROM messages m
         JOIN users u ON u.id = m.author_id
        WHERE m.created_at >= date_trunc('hour', now()) - interval '23 hours'
          AND NOT u.is_webhook AND NOT u.is_character
        GROUP BY 1`,
    ),
    pool.query<{
      name: string;
      tagline: string | null;
      channels: string;
      members: string;
      messages_24h: string;
    }>(
      `WITH active AS (
         SELECT c.server_id, COUNT(*) AS messages_24h
           FROM messages m
           JOIN channels c ON c.id = m.channel_id
           JOIN users u ON u.id = m.author_id
          WHERE m.created_at >= now() - interval '24 hours'
            AND c.server_id IS NOT NULL
            AND NOT u.is_webhook AND NOT u.is_character
          GROUP BY c.server_id
          ORDER BY COUNT(*) DESC
          LIMIT 5
       )
       SELECT s.name,
              s.community_tagline AS tagline,
              (SELECT COUNT(*) FROM channels c
                WHERE c.server_id = s.id AND c.type IN ('text', 'voice'))::text AS channels,
              (SELECT COUNT(*) FROM server_members sm
                WHERE sm.server_id = s.id)::text AS members,
              a.messages_24h::text AS messages_24h
         FROM active a
         JOIN servers s ON s.id = a.server_id
        ORDER BY a.messages_24h DESC, s.name`,
    ),
    acquisitionReport(7),
    callRatingSummary(7),
    connectionAdoption(),
  ]);

  const channelCounts = { text: 0, voice: 0, category: 0, thread: 0 };
  for (const row of channels.rows) {
    if (row.type in channelCounts) {
      channelCounts[row.type as keyof typeof channelCounts] = Number(row.n);
    }
  }

  const m = messages.rows[0];
  const voice = getVoiceActivitySnapshot();

  return {
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
    version: process.env.APP_VERSION?.trim() || null,
    excludedAccounts: EXCLUDED_ACCOUNTS,
    users: {
      total: Number(users.rows[0]?.total ?? 0),
      last24h: Number(users.rows[0]?.last24h ?? 0),
      byHour: toHourly(usersByHour.rows),
    },
    servers: {
      total: Number(servers.rows[0]?.total ?? 0),
      last24h: Number(servers.rows[0]?.last24h ?? 0),
    },
    messages: {
      last24h: Number(m?.last24h ?? 0),
      previous24h: Number(m?.previous24h ?? 0),
      lastHour: Number(m?.last_hour ?? 0),
      automated24h: Number(m?.automated24h ?? 0),
      byHour: toHourly(messagesByHour.rows),
    },
    distinctSenders24h: Number(m?.senders ?? 0),
    activeTextChannels24h: Number(m?.active_text_channels ?? 0),
    channels: channelCounts,
    voice: {
      activeRooms: voice.activeRooms,
      participants: voice.participants,
      largestRoomNow: voice.largestRoomNow,
      peakRoomSizeToday: voice.peakRoomSizeToday,
      peakTrackedSince: voice.peakTrackedSince,
      backend: voice.backend,
    },
    topServers24h: topServers.rows.map((row) => ({
      name: row.name,
      tagline: row.tagline,
      channels: Number(row.channels),
      members: Number(row.members),
      messages24h: Number(row.messages_24h),
    })),
    acquisition,
    callRatings,
    // The denominator travels with the numerators rather than leaving the
    // dashboard to pick one: it is the users total in this same payload.
    connections: { ...connections, ofUsers: Number(users.rows[0]?.total ?? 0) },
  };
}

// ------------------------------------------------------------------- cache

let cached: { at: number; payload: AdminMetrics } | null = null;
let inFlight: Promise<AdminMetrics> | null = null;

/**
 * The cached payload when it is younger than the TTL, otherwise a fresh one.
 * Concurrent callers during a refresh share the same computation rather than
 * each running the queries.
 */
export async function getAdminMetrics(): Promise<AdminMetrics> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.payload;
  }
  if (!inFlight) {
    inFlight = computeAdminMetrics()
      .then((payload) => {
        cached = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Test hook: forget the cached payload. */
export function resetAdminMetricsCache(): void {
  cached = null;
}
