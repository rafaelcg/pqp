import { timingSafeEqual } from "node:crypto";
import { getPool } from "../db.js";
import { runtimeSnapshot, type RuntimeMetrics } from "../lib/runtime.js";
import { getVoiceActivitySnapshot } from "../ws/voice.js";
import { acquisitionReport, type AcquisitionReport } from "./acquisition.js";
import { callRatingSummary } from "./call-ratings.js";
import { isCommunitiesEnabled } from "./communities.js";
import { connectionAdoption, type ConnectionAdoption } from "./connections.js";
import type { CallRatingSummary } from "@pqp/shared";

/**
 * The operator dashboard's one read: `GET /api/admin/metrics`.
 *
 * Aggregate counts, and never an id, a handle or an email.
 *
 * It is not *only* counts, and the exceptions are worth stating because they
 * are the reason the dashboard has a password on it:
 *  - server, community and channel **names**, in the "most active" tables;
 *  - free text people wrote about the product: call-rating notes and the last
 *    few feedback entries, both truncated, neither attributed to anybody.
 * There is still no row here that identifies a person. See
 * tools/admin-dashboard/README.md.
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
 * The counts are cached in memory for 30 seconds: the dashboard polls, and the
 * API is one machine in gru. Counts that lag by half a minute are still
 * counts; a scan of `messages` per page refresh is a self-inflicted incident.
 * The `runtime` block is the exception and is sampled per request — it costs
 * nothing and a stale one would be actively misleading. See `getAdminMetrics`.
 */

export const ADMIN_METRICS_PATH = "/api/admin/metrics";

/** Anything shorter is a guessable token, so it is treated as not set. */
export const ADMIN_METRICS_TOKEN_MIN_LENGTH = 16;

const CACHE_TTL_MS = 30_000;

/** Accounts that are not people are excluded from every count here. */
const EXCLUDED_ACCOUNTS = ["webhook", "character"] as const;

export interface AdminMetrics {
  generatedAt: string;
  /**
   * Seconds the server will keep answering with these same *counts*.
   *
   * Not the whole payload: `runtime` is sampled per request and ignores this.
   */
  cacheTtlSeconds: number;
  /** The deployed commit (`APP_VERSION`), null when the process was not stamped. */
  version: string | null;
  excludedAccounts: readonly string[];
  /**
   * Live process pressure: open WebSockets and the connection pool.
   *
   * THE ONE BLOCK IN THIS PAYLOAD THAT IS NOT CACHED, and the one that costs
   * nothing — see `getAdminMetrics` for why those two facts are the same
   * decision. Everything in it is a property read (`wss.clients.size`, the
   * pool's own counters); there is no query behind it. See lib/runtime.ts.
   */
  runtime: RuntimeMetrics;
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
    /**
     * The rooms that have somebody in them right now, largest first.
     *
     * A DM call has no server channel behind it, so `channel` is null there
     * and the dashboard labels it a conversation rather than inventing a name.
     */
    rooms: {
      channel: string | null;
      server: string | null;
      participants: number;
      sharingScreen: number;
    }[];
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

  // ------------------------------------------------------------ tab detail
  // Everything below backs one tab each on the operator dashboard. It is
  // computed in the same 30-second snapshot as the headline numbers above,
  // rather than behind its own endpoint, because at this instance's size the
  // extra queries cost less than a second round trip would and the tabs can
  // then switch with no network at all.

  /** Backs the "canais" tab. */
  channelDetail: {
    /** Server text channels with the private allowlist on. */
    privateText: number;
    /** Channels with no server behind them: direct and group conversations. */
    conversations: { dm: number; group: number };
    serversWithChannels: number;
    maxChannelsInServer: number;
    /** Server text channels that have never received a message. */
    emptyText: number;
    topText24h: {
      channel: string;
      server: string;
      messages24h: number;
      senders24h: number;
    }[];
  };

  /** Backs the "usuários" tab. Adoption and activity, never a person. */
  userDetail: {
    /** Distinct human senders over 7 days (the 24h figure is above). */
    active7d: number;
    withHandle: number;
    withAvatar: number;
    withBanner: number;
    ageChecked: number;
    /** Accounts inside the art. 18 deletion grace window. */
    deletionPending: number;
    /** Oldest first, São Paulo days, up to 14 of them. */
    signupsByDay: { day: string; n: number }[];
    /**
     * The closest thing to retention this schema can answer honestly.
     *
     * `eligible` is every account older than 24 hours; `active` is how many of
     * those sent a message in the last 7 days. It is not a cohort curve and it
     * should not be read as one: somebody who reads without posting counts as
     * inactive here, because messages are the only per-user activity this
     * database records.
     */
    returning7d: { eligible: number; active: number };
  };

  /** Backs the "comunidades" tab. */
  communities: {
    /**
     * `COMMUNITIES_ENABLED`. With it off every count below is zero because the
     * feature is off, not because nobody used it, and the dashboard says so
     * rather than drawing an empty state that looks like a result.
     */
    enabled: boolean;
    total: number;
    listed: number;
    suspended: number;
    withSlug: number;
    byCategory: { category: string; n: number }[];
    list: {
      name: string;
      slug: string | null;
      category: string;
      members: number;
      channels: number;
      messages24h: number;
      suspended: boolean;
    }[];
  };

  /**
   * Product surfaces that are not users / messages / voice.
   *
   * Friends, attachments, invites and push sit in the same snapshot as the
   * rest so the dashboard can draw them without a second read. Counts only.
   */
  product: {
    friendships: number;
    pendingFriendRequests: number;
    attachments: { total: number; last24h: number };
    invites: { created24h: number; uses: number };
    push: { web: number; apns: number };
  };

  /** Backs the "moderação" tab. */
  moderation: {
    reports: { open: number; actioned: number; dismissed: number; last24h: number };
    feedback: { open: number; confirmed: number; closed: number; last24h: number };
    bans: number;
    /** Timeouts that have not expired yet. */
    activeTimeouts: number;
    /** Newest first. Body truncated server side; no author, ever. */
    recentFeedback: { kind: string; status: string; createdAt: string; body: string }[];
  };
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

/**
 * Everything the 30-second cache holds — which is everything except `runtime`.
 *
 * Expressed as a type rather than as a convention on purpose: it makes it
 * impossible to accidentally compute the live block inside the cached one.
 */
type CachedMetrics = Omit<AdminMetrics, "runtime">;

async function computeAdminMetrics(): Promise<CachedMetrics> {
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

  // One snapshot, used both to look up room names below and to build the
  // payload further down. Calling it twice would let a room open between the
  // two calls and render with no name at all.
  const voice = getVoiceActivitySnapshot();

  // The tab detail, in a second round of parallel queries. It is separate from
  // the block above only for readability; both rounds are inside the same
  // 30-second cache entry, so a dashboard switching tabs never touches the API.
  const [
    channelShape,
    channelsPerServer,
    emptyTextChannels,
    topTextChannels,
    userAdoption,
    active7d,
    signupsByDay,
    returning7d,
    communityTotals,
    communityCategories,
    communityList,
    reportCounts,
    feedbackCounts,
    banCounts,
    recentFeedback,
    voiceRoomNames,
    productCounts,
  ] = await Promise.all([
    pool.query<{ private_text: string; dm: string; grp: string }>(
      `SELECT COUNT(*) FILTER (
                WHERE kind = 'server' AND type = 'text' AND is_private
              )::text AS private_text,
              COUNT(*) FILTER (WHERE kind = 'dm')::text AS dm,
              COUNT(*) FILTER (WHERE kind = 'group')::text AS grp
         FROM channels`,
    ),
    pool.query<{ servers_with_channels: string; max_channels: string }>(
      `SELECT COUNT(*)::text AS servers_with_channels,
              COALESCE(MAX(n), 0)::text AS max_channels
         FROM (
           SELECT server_id, COUNT(*) AS n
             FROM channels
            WHERE kind = 'server'
            GROUP BY server_id
         ) t`,
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM channels c
        WHERE c.kind = 'server' AND c.type = 'text'
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id)`,
    ),
    pool.query<{ channel: string; server: string; messages_24h: string; senders_24h: string }>(
      `SELECT c.name AS channel,
              s.name AS server,
              COUNT(*)::text AS messages_24h,
              COUNT(DISTINCT m.author_id)::text AS senders_24h
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         JOIN servers s ON s.id = c.server_id
         JOIN users u ON u.id = m.author_id
        WHERE m.created_at >= now() - interval '24 hours'
          AND c.kind = 'server' AND c.type = 'text'
          AND NOT u.is_webhook AND NOT u.is_character
        GROUP BY c.id, c.name, s.name
        ORDER BY COUNT(*) DESC, c.name
        LIMIT 8`,
    ),
    pool.query<{
      with_handle: string;
      with_avatar: string;
      with_banner: string;
      age_checked: string;
      deletion_pending: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE handle IS NOT NULL)::text AS with_handle,
              COUNT(*) FILTER (
                WHERE avatar_url IS NOT NULL OR avatar_key IS NOT NULL
              )::text AS with_avatar,
              COUNT(*) FILTER (
                WHERE banner_url IS NOT NULL OR banner_key IS NOT NULL
              )::text AS with_banner,
              COUNT(*) FILTER (WHERE age_checked_at IS NOT NULL)::text AS age_checked,
              COUNT(*) FILTER (WHERE deletion_started_at IS NOT NULL)::text AS deletion_pending
         FROM users
        WHERE NOT is_webhook AND NOT is_character`,
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(DISTINCT m.author_id)::text AS n
         FROM messages m
         JOIN users u ON u.id = m.author_id
        WHERE m.created_at >= now() - interval '7 days'
          AND NOT u.is_webhook AND NOT u.is_character`,
    ),
    pool.query<{ day: string; n: string }>(
      `SELECT to_char(
                date_trunc('day', created_at AT TIME ZONE 'America/Sao_Paulo'),
                'YYYY-MM-DD'
              ) AS day,
              COUNT(*)::text AS n
         FROM users
        WHERE created_at >= now() - interval '14 days'
          AND NOT is_webhook AND NOT is_character
        GROUP BY 1
        ORDER BY 1`,
    ),
    pool.query<{ eligible: string; active: string }>(
      `SELECT COUNT(*)::text AS eligible,
              COUNT(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM messages m
                   WHERE m.author_id = u.id
                     AND m.created_at >= now() - interval '7 days'
                )
              )::text AS active
         FROM users u
        WHERE NOT u.is_webhook AND NOT u.is_character
          AND u.created_at < now() - interval '24 hours'`,
    ),
    pool.query<{ total: string; listed: string; suspended: string; with_slug: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE NOT is_community_suspended)::text AS listed,
              COUNT(*) FILTER (WHERE is_community_suspended)::text AS suspended,
              COUNT(*) FILTER (WHERE community_slug IS NOT NULL)::text AS with_slug
         FROM servers
        WHERE is_community`,
    ),
    pool.query<{ category: string; n: string }>(
      `SELECT community_category AS category, COUNT(*)::text AS n
         FROM servers
        WHERE is_community
        GROUP BY 1
        ORDER BY COUNT(*) DESC, 1`,
    ),
    pool.query<{
      name: string;
      slug: string | null;
      category: string;
      members: string;
      channels: string;
      messages_24h: string;
      suspended: boolean;
    }>(
      `SELECT s.name,
              s.community_slug AS slug,
              s.community_category AS category,
              s.is_community_suspended AS suspended,
              s.member_count::text AS members,
              (SELECT COUNT(*) FROM channels c
                WHERE c.server_id = s.id AND c.kind = 'server')::text AS channels,
              (SELECT COUNT(*)
                 FROM messages m
                 JOIN channels c2 ON c2.id = m.channel_id
                 JOIN users u2 ON u2.id = m.author_id
                WHERE c2.server_id = s.id
                  AND m.created_at >= now() - interval '24 hours'
                  AND NOT u2.is_webhook AND NOT u2.is_character)::text AS messages_24h
         FROM servers s
        WHERE s.is_community
        ORDER BY s.member_count DESC, s.name
        LIMIT 20`,
    ),
    pool.query<{ open: string; actioned: string; dismissed: string; last24h: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::text AS open,
              COUNT(*) FILTER (WHERE status = 'actioned')::text AS actioned,
              COUNT(*) FILTER (WHERE status = 'dismissed')::text AS dismissed,
              COUNT(*) FILTER (
                WHERE created_at >= now() - interval '24 hours'
              )::text AS last24h
         FROM reports`,
    ),
    pool.query<{ open: string; confirmed: string; closed: string; last24h: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::text AS open,
              COUNT(*) FILTER (WHERE status = 'confirmed')::text AS confirmed,
              COUNT(*) FILTER (WHERE status = 'closed')::text AS closed,
              COUNT(*) FILTER (
                WHERE created_at >= now() - interval '24 hours'
              )::text AS last24h
         FROM feedback`,
    ),
    pool.query<{ bans: string; timeouts: string }>(
      `SELECT (SELECT COUNT(*) FROM server_bans)::text AS bans,
              (SELECT COUNT(*) FROM member_timeouts
                WHERE expires_at > now())::text AS timeouts`,
    ),
    pool.query<{ kind: string; status: string; created_at: Date; body: string }>(
      `SELECT kind, status, created_at, left(body, 160) AS body
         FROM feedback
        ORDER BY id DESC
        LIMIT 8`,
    ),
    // Names for the rooms that have somebody in them right now. The snapshot
    // holds channel ids only; an empty list skips the query entirely rather
    // than sending `IN ()` to Postgres.
    (async () => {
      const ids = voice.rooms.map((room) => room.voiceChannelId);
      if (ids.length === 0) {
        return { rows: [] as { id: string; channel: string; server: string | null }[] };
      }
      return pool.query<{ id: string; channel: string; server: string | null }>(
        `SELECT c.id::text AS id, c.name AS channel, s.name AS server
           FROM channels c
           LEFT JOIN servers s ON s.id = c.server_id
          WHERE c.id = ANY($1::uuid[])`,
        [ids],
      );
    })(),
    pool.query<{
      friendships: string;
      friend_pending: string;
      attachments: string;
      attachments_24h: string;
      invites_24h: string;
      invite_uses: string;
      push_web: string;
      push_apns: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM friendships WHERE status = 'accepted')::text AS friendships,
         (SELECT COUNT(*) FROM friendships WHERE status = 'pending')::text AS friend_pending,
         (SELECT COUNT(*) FROM message_attachments)::text AS attachments,
         (SELECT COUNT(*) FROM message_attachments
           WHERE created_at >= now() - interval '24 hours')::text AS attachments_24h,
         (SELECT COUNT(*) FROM server_invites
           WHERE created_at >= now() - interval '24 hours')::text AS invites_24h,
         (SELECT COALESCE(SUM(uses), 0) FROM server_invites)::text AS invite_uses,
         (SELECT COUNT(*) FROM push_subscriptions WHERE platform = 'web')::text AS push_web,
         (SELECT COUNT(*) FROM push_subscriptions WHERE platform = 'apns')::text AS push_apns`,
    ),
  ]);

  const channelCounts = { text: 0, voice: 0, category: 0, thread: 0 };
  for (const row of channels.rows) {
    if (row.type in channelCounts) {
      channelCounts[row.type as keyof typeof channelCounts] = Number(row.n);
    }
  }

  const m = messages.rows[0];
  const roomNames = new Map(
    voiceRoomNames.rows.map((row) => [row.id, { channel: row.channel, server: row.server }]),
  );

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
      rooms: voice.rooms.map((room) => {
        const named = roomNames.get(room.voiceChannelId);
        return {
          channel: named?.channel ?? null,
          server: named?.server ?? null,
          participants: room.participants,
          sharingScreen: room.sharingScreen,
        };
      }),
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

    channelDetail: {
      privateText: Number(channelShape.rows[0]?.private_text ?? 0),
      conversations: {
        dm: Number(channelShape.rows[0]?.dm ?? 0),
        group: Number(channelShape.rows[0]?.grp ?? 0),
      },
      serversWithChannels: Number(channelsPerServer.rows[0]?.servers_with_channels ?? 0),
      maxChannelsInServer: Number(channelsPerServer.rows[0]?.max_channels ?? 0),
      emptyText: Number(emptyTextChannels.rows[0]?.n ?? 0),
      topText24h: topTextChannels.rows.map((row) => ({
        channel: row.channel,
        server: row.server,
        messages24h: Number(row.messages_24h),
        senders24h: Number(row.senders_24h),
      })),
    },

    userDetail: {
      active7d: Number(active7d.rows[0]?.n ?? 0),
      withHandle: Number(userAdoption.rows[0]?.with_handle ?? 0),
      withAvatar: Number(userAdoption.rows[0]?.with_avatar ?? 0),
      withBanner: Number(userAdoption.rows[0]?.with_banner ?? 0),
      ageChecked: Number(userAdoption.rows[0]?.age_checked ?? 0),
      deletionPending: Number(userAdoption.rows[0]?.deletion_pending ?? 0),
      signupsByDay: signupsByDay.rows.map((row) => ({ day: row.day, n: Number(row.n) })),
      returning7d: {
        eligible: Number(returning7d.rows[0]?.eligible ?? 0),
        active: Number(returning7d.rows[0]?.active ?? 0),
      },
    },

    communities: {
      enabled: isCommunitiesEnabled(),
      total: Number(communityTotals.rows[0]?.total ?? 0),
      listed: Number(communityTotals.rows[0]?.listed ?? 0),
      suspended: Number(communityTotals.rows[0]?.suspended ?? 0),
      withSlug: Number(communityTotals.rows[0]?.with_slug ?? 0),
      byCategory: communityCategories.rows.map((row) => ({
        category: row.category,
        n: Number(row.n),
      })),
      list: communityList.rows.map((row) => ({
        name: row.name,
        slug: row.slug,
        category: row.category,
        members: Number(row.members),
        channels: Number(row.channels),
        messages24h: Number(row.messages_24h),
        suspended: row.suspended,
      })),
    },

    product: {
      friendships: Number(productCounts.rows[0]?.friendships ?? 0),
      pendingFriendRequests: Number(productCounts.rows[0]?.friend_pending ?? 0),
      attachments: {
        total: Number(productCounts.rows[0]?.attachments ?? 0),
        last24h: Number(productCounts.rows[0]?.attachments_24h ?? 0),
      },
      invites: {
        created24h: Number(productCounts.rows[0]?.invites_24h ?? 0),
        uses: Number(productCounts.rows[0]?.invite_uses ?? 0),
      },
      push: {
        web: Number(productCounts.rows[0]?.push_web ?? 0),
        apns: Number(productCounts.rows[0]?.push_apns ?? 0),
      },
    },

    moderation: {
      reports: {
        open: Number(reportCounts.rows[0]?.open ?? 0),
        actioned: Number(reportCounts.rows[0]?.actioned ?? 0),
        dismissed: Number(reportCounts.rows[0]?.dismissed ?? 0),
        last24h: Number(reportCounts.rows[0]?.last24h ?? 0),
      },
      feedback: {
        open: Number(feedbackCounts.rows[0]?.open ?? 0),
        confirmed: Number(feedbackCounts.rows[0]?.confirmed ?? 0),
        closed: Number(feedbackCounts.rows[0]?.closed ?? 0),
        last24h: Number(feedbackCounts.rows[0]?.last24h ?? 0),
      },
      bans: Number(banCounts.rows[0]?.bans ?? 0),
      activeTimeouts: Number(banCounts.rows[0]?.timeouts ?? 0),
      recentFeedback: recentFeedback.rows.map((row) => ({
        kind: row.kind,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        body: row.body,
      })),
    },
  };
}

// ------------------------------------------------------------------- cache

let cached: { at: number; payload: CachedMetrics } | null = null;
let inFlight: Promise<CachedMetrics> | null = null;

/**
 * The cached counts when they are younger than the TTL, otherwise a fresh set.
 * Concurrent callers during a refresh share the same computation rather than
 * each running the queries.
 */
async function getCachedMetrics(): Promise<CachedMetrics> {
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

/**
 * The payload: ~32 queries' worth of counts from the 30-second cache, plus a
 * `runtime` block taken **now**, on every single request.
 *
 * WHY THE SPLIT. The cache exists because the counts are expensive — a scan of
 * `messages` per dashboard refresh is a self-inflicted incident, and a signup
 * total that lags by half a minute is still a signup total. Neither half of
 * that reasoning applies to `runtime`. It costs nothing, so caching it saves
 * nothing; and a *stale* saturation reading is worse than no reading at all,
 * because the entire value of `waitingCount` is that it moves during the ten
 * seconds a stampede is actually happening. A dashboard that showed a queue of
 * zero because the queue formed and drained inside the cache window would be
 * confidently wrong at the exact moment it was being consulted.
 *
 * The high-water marks in the block cover the other half of the same problem:
 * a 30-second poll misses a spike even when the reading is live. See
 * lib/runtime.ts.
 *
 * The spread never mutates the cached object, so the cache cannot pick up a
 * `runtime` block and start serving a stale one.
 */
export async function getAdminMetrics(): Promise<AdminMetrics> {
  const payload = await getCachedMetrics();
  return { ...payload, runtime: runtimeSnapshot() };
}

/** Test hook: forget the cached payload. */
export function resetAdminMetricsCache(): void {
  cached = null;
}
