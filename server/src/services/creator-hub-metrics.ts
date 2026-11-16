import { getPool } from "../db.js";
import { bauPaymentsMetrics, type BauPaymentsMetrics } from "./bau-payments/metrics.js";

/**
 * The creator hub on `GET /api/admin/metrics` (`creatorHub`): the first-party
 * numbers the Baú VIP creator-hub pilot is judged by. No third-party tracker,
 * and nothing here names a person: counts only.
 *
 * Two halves, the shape `stories` already uses:
 *
 *   - `process`: counters this process increments, since it started. The two
 *     the funnel needs and no table holds, a locked card shown to a fan
 *     (`ctaViews`) and a tap on a creator's support link (`supportClicks`),
 *     are recorded with `recordCreatorHubEvent`. They read 0 until a caller
 *     exists; there is deliberately no HTTP endpoint in this file. Per
 *     process like the push counters: with two API instances read each.
 *   - `db`: deployment-wide counts from tables that already exist, cached for
 *     30 s so the dashboard's polling costs one read per half minute. Null
 *     when the read failed, so "could not ask" is never mistaken for zero.
 */

const stats = {
  /** A fan saw the locked card of a members-only post (the "Apoiar" prompt). */
  ctaViews: 0,
  /** A fan tapped the creator's support link. */
  supportClicks: 0,
};

/**
 * What a caller records. The kind is the counter's name with the number
 * dropped: `recordCreatorHubEvent("ctaView")` bumps `ctaViews`.
 */
export type CreatorHubEventKind = "ctaView" | "supportClick";

const COUNTER_OF: Record<CreatorHubEventKind, keyof typeof stats> = {
  ctaView: "ctaViews",
  supportClick: "supportClicks",
};

export function recordCreatorHubEvent(kind: CreatorHubEventKind): void {
  const counter = COUNTER_OF[kind];
  if (counter) {
    stats[counter] += 1;
  }
}

export interface CreatorHubMetrics {
  /** Since this process started. */
  process: { ctaViews: number; supportClicks: number };
  /**
   * Baú+ payments (fans paying for VIP inside pqp): this process's counters
   * and deployment-wide counts. See `services/bau-payments/metrics.ts`.
   */
  payments: BauPaymentsMetrics;
  /** Deployment wide, from the database. Null when the read failed. */
  db: {
    /** Servers whose owner turned the Baú on, and how many of them have posted. */
    servers: {
      bauOn: number;
      withPosts: number;
      withMembersOnlyPosts: number;
      withVipHolders: number;
    };
    posts: {
      /** Every post, drafts and scheduled included. */
      total: number;
      published: number;
      membersOnly: number;
      /** Members-only share of published posts, 0..1; null with no published post. */
      membersOnlyShare: number | null;
      published7d: number;
    };
    vip: {
      /** Distinct (server, person) pairs holding the VIP cargo. */
      holders: number;
      /** The servers with the most holders. */
      topServers: { serverId: string; name: string; holders: number }[];
    };
    follows: {
      total: number;
      active: number;
      paused: number;
      /** Distinct source servers (creators) that have a follow pointing at them. */
      creators: number;
      deliveries: {
        pending: number;
        delivered: number;
        retracted: number;
        dead: number;
        delivered7d: number;
      };
    };
    /**
     * People who joined a server whose Baú is on, in the last 7 days:
     * through a door that names itself (`bySource`, `join_source`; an owner
     * or an unattributed row is not a join) and through a tagged link
     * (`withRef`, `join_ref`, the creator's `?ref=`).
     */
    joins7d: {
      total: number;
      withRef: number;
      bySource: Record<string, number>;
    };
  } | null;
}

export function resetCreatorHubStatsForTests(): void {
  stats.ctaViews = 0;
  stats.supportClicks = 0;
  cached = null;
}

let cached: { at: number; value: CreatorHubMetrics["db"] } | null = null;

const n = (value: string | null | undefined): number => Number(value ?? 0);

async function readDb(): Promise<NonNullable<CreatorHubMetrics["db"]>> {
  const pool = getPool();
  const [overview, follows, deliveries, joins] = await Promise.all([
    pool.query<Record<string, string | null>>(
      `WITH post_servers AS (
         -- One pass over the posts: per server, then summed below.
         SELECT server_id,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'published') AS published,
                COUNT(*) FILTER (WHERE status = 'published'
                                   AND visibility = 'members') AS members,
                COUNT(*) FILTER (WHERE status = 'published'
                                   AND published_at > now() - interval '7 days') AS recent,
                BOOL_OR(visibility = 'members') AS has_members
           FROM community_home_posts
          GROUP BY server_id
       ),
       vip AS (
         -- One pass over the VIP grants: per server, then summed below.
         SELECT mr.server_id, COUNT(*) AS holders
           FROM member_roles mr
           JOIN roles r ON r.id = mr.role_id AND r.system_key = 'vip'
          GROUP BY mr.server_id
       )
       SELECT
         (SELECT COUNT(*) FROM servers WHERE community_home_enabled)::text AS bau_on,
         (SELECT COUNT(*) FROM post_servers)::text AS with_posts,
         (SELECT COUNT(*) FROM post_servers WHERE has_members)::text AS with_members_posts,
         (SELECT COALESCE(SUM(total), 0) FROM post_servers)::text AS posts_total,
         (SELECT COALESCE(SUM(published), 0) FROM post_servers)::text AS posts_published,
         (SELECT COALESCE(SUM(members), 0) FROM post_servers)::text AS posts_members,
         (SELECT COALESCE(SUM(recent), 0) FROM post_servers)::text AS posts_7d,
         (SELECT COALESCE(SUM(holders), 0) FROM vip)::text AS vip_holders,
         (SELECT COUNT(*) FROM vip)::text AS vip_servers,
         (SELECT COALESCE(json_agg(t ORDER BY t.holders DESC, t.name), '[]'::json)
            FROM (SELECT s.id AS "serverId", s.name, v.holders::int AS holders
                    FROM vip v JOIN servers s ON s.id = v.server_id
                   ORDER BY v.holders DESC, s.name
                   LIMIT 5) t)::text AS top_vip`,
    ),
    pool.query<Record<string, string | null>>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE paused_at IS NULL)::text AS active,
              COUNT(*) FILTER (WHERE paused_at IS NOT NULL)::text AS paused,
              COUNT(DISTINCT source_server_id)::text AS creators
         FROM bau_follows`,
    ),
    pool.query<{ status: string; n: string; recent: string }>(
      `SELECT status, COUNT(*)::text AS n,
              COUNT(*) FILTER (
                WHERE status = 'delivered'
                  AND delivered_at > now() - interval '7 days')::text AS recent
         FROM bau_follow_deliveries
        GROUP BY status`,
    ),
    pool.query<{ source: string; n: string; tagged: string }>(
      `SELECT sm.join_source AS source, COUNT(*)::text AS n,
              COUNT(*) FILTER (WHERE sm.join_ref IS NOT NULL)::text AS tagged
         FROM server_members sm
         JOIN servers s ON s.id = sm.server_id AND s.community_home_enabled
        WHERE sm.joined_at > now() - interval '7 days'
          AND sm.join_source IS NOT NULL
        GROUP BY sm.join_source`,
    ),
  ]);

  const o = overview.rows[0] ?? {};
  const published = n(o.posts_published);
  const byStatus = new Map(deliveries.rows.map((row) => [row.status, row]));
  const delivered = (status: string) => n(byStatus.get(status)?.n);
  const f = follows.rows[0] ?? {};
  const bySource: Record<string, number> = {};
  let joinsTotal = 0;
  let joinsTagged = 0;
  for (const row of joins.rows) {
    bySource[row.source] = n(row.n);
    joinsTotal += n(row.n);
    joinsTagged += n(row.tagged);
  }

  return {
    servers: {
      bauOn: n(o.bau_on),
      withPosts: n(o.with_posts),
      withMembersOnlyPosts: n(o.with_members_posts),
      withVipHolders: n(o.vip_servers),
    },
    posts: {
      total: n(o.posts_total),
      published,
      membersOnly: n(o.posts_members),
      membersOnlyShare: published > 0 ? n(o.posts_members) / published : null,
      published7d: n(o.posts_7d),
    },
    vip: {
      holders: n(o.vip_holders),
      topServers: JSON.parse(o.top_vip ?? "[]") as {
        serverId: string;
        name: string;
        holders: number;
      }[],
    },
    follows: {
      total: n(f.total),
      active: n(f.active),
      paused: n(f.paused),
      creators: n(f.creators),
      deliveries: {
        pending: delivered("pending") + delivered("delivering"),
        delivered: delivered("delivered"),
        retracted: delivered("retracted"),
        dead: delivered("dead"),
        delivered7d: n(byStatus.get("delivered")?.recent),
      },
    },
    joins7d: { total: joinsTotal, withRef: joinsTagged, bySource },
  };
}

export async function creatorHubMetrics(): Promise<CreatorHubMetrics> {
  let db: CreatorHubMetrics["db"] = null;
  if (cached && Date.now() - cached.at < 30_000) {
    db = cached.value;
  } else {
    try {
      db = await readDb();
      cached = { at: Date.now(), value: db };
    } catch (error) {
      // The metrics page must not fail because this block could not be read.
      console.error(
        "[creator-hub] metrics read failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { process: { ...stats }, payments: await bauPaymentsMetrics(), db };
}
