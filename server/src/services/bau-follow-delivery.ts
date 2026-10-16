import { randomUUID } from "node:crypto";
import {
  BAU_FOLLOW_MAX_DELIVERIES_PER_POST_PER_MINUTE,
  BAU_FOLLOW_PAUSE_AFTER_FAILURES,
  Permission,
  hasPermission,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { mapWithConcurrency } from "../lib/admission.js";
import { logEvent } from "../lib/log.js";
import { broadcastToChannel, announceServiceMessage } from "../ws/chat.js";
import { logAudit } from "./audit.js";
import { isBauFollowOn, mayManageFollow } from "./bau-follow.js";
import {
  buildInertBauPostSnapshot,
  followBody,
  snapshotHash,
  snapshotIsEmpty,
  type BauPostSnapshot,
  type PostForSnapshot,
} from "./bau-follow-snapshot.js";
import {
  getHydratedMessage,
  invalidateLatestMessages,
  mapMessage,
} from "./messages.js";
import { getBauPublicUrl } from "./community-home-public.js";
import { computeMemberPermissions } from "./permissions.js";

/**
 * Seguir, the delivery half: a free Baú post that goes live becomes a forward
 * card in every channel that follows its server.
 *
 * THE SEAM IS THE POST'S STATE, NOT A HOOK. A post goes live by four writes
 * (create as published, edit into published, "Publish now", a scheduled time
 * arriving, the last of them also from a feed read's catch-up). A hook on each
 * would miss one, so none of them hooks anything: `runBauFollowTick` reads what
 * is true (published, free, newer than the follow) and makes the deliveries
 * match, the way `community-home-push.ts` does for push. The publish and edit
 * routes only KICK the tick so a delivery does not wait for the timer.
 *
 * ONE TICK, FOUR PASSES, in this order:
 *   1. retract: a delivered card whose post is gone, back to a draft or
 *      members-only is deleted from the channel (members-only never goes out,
 *      and deleting a post deletes what it put elsewhere);
 *   2. sync: a delivered card whose post was edited gets the new snapshot;
 *   3. enqueue: every (post, follow) pair that qualifies and has no row yet
 *      gets one. The row IS the dedupe (primary key on the pair);
 *   4. deliver: claim due rows, post the cards.
 * 1 and 2 run whatever the flag says (removing and correcting are never the
 * dangerous direction); 3 and 4 only for sources the flag is on for.
 *
 * EXACTLY ONCE, ACROSS PROCESSES. A claim is one UPDATE that takes the row
 * (`delivering`, a `claim_id` and a lease); a second process re-checks the
 * status under the row lock and skips it. The message insert and the row's
 * move to `delivered` are ONE transaction guarded on the claim id, so a
 * process that dies before COMMIT leaves nothing and the lease expiring hands
 * the row to the next one, and a lease that expires under a slow process makes
 * its late COMMIT affect zero rows and roll back. A unique nonce on the message
 * (`bau-follow:<post>`, per channel and author) is the second wall.
 *
 * Nothing between BEGIN and COMMIT touches the network: the statements are all
 * database, and the fan-out happens after.
 */

/** A post older than this is never enqueued, nor delivered late (a flag off for a day, a worker down). */
export const BAU_FOLLOW_FRESH_MS = 6 * 60 * 60_000;
/** How long a claim holds a row before another process may take it. */
export const BAU_FOLLOW_LEASE_MS = 60_000;
/** Rows claimed per tick. The rest wait for the next. */
export const BAU_FOLLOW_CLAIM_BATCH = 50;
const SWEEP_BATCH = 100;
const ENQUEUE_BATCH = 500;
const CONCURRENCY = 4;
/** Posts looked at per claim. Each offers at most its remaining quota. */
const CLAIM_POSTS = 200;
/** After the Nth failed attempt, wait this long. */
export const BAU_FOLLOW_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000];
/** Attempts a delivery gets before it is given up on (`dead`). */
export const BAU_FOLLOW_MAX_ATTEMPTS = BAU_FOLLOW_BACKOFF_MS.length + 1;
const DEFER_FLAG_OFF_MS = 5 * 60_000;
const DEFER_PAUSED_MS = 60 * 60_000;
const PRUNE_AFTER_DAYS = 30;
/**
 * How far back the retract and edit passes look at delivered cards. Posts are
 * edited and deleted soon after they go out; looking only at the recent ledger
 * keeps each tick from revisiting years of history. A card older than this is
 * left as it was when the window passed.
 */
const RECONCILE_DAYS = 90;

export interface BauFollowTickResult {
  retracted: number;
  updated: number;
  enqueued: number;
  delivered: number;
  failed: number;
  paused: number;
}

function emptyResult(): BauFollowTickResult {
  return { retracted: 0, updated: 0, enqueued: 0, delivered: 0, failed: 0, paused: 0 };
}

// --------------------------------------------------------- the pseudo identity

const pseudoUserIds = new Map<string, string>();

/**
 * The webhook-style author a source's cards are posted as: a `users` row with
 * `is_webhook`, one per source server, never a member of anything. The message
 * itself carries the source's current name and icon (`webhook_username`,
 * `webhook_avatar_url`), so a rename shows up on the next card with no write
 * here. Nobody ever authenticates as this row (`clerk_id` is synthetic).
 */
export async function bauFollowAuthorFor(
  sourceServerId: string,
  name: string,
): Promise<string> {
  // On the pool, never inside a delivery's transaction: the id is cached for
  // every other delivery of this process, and an id whose row is not
  // committed yet is a foreign key violation waiting for the next one.
  const client = getPool();
  const known = pseudoUserIds.get(sourceServerId);
  if (known) {
    return known;
  }
  const clerkId = `bau-follow:${sourceServerId}`;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE clerk_id = $1`,
    [clerkId],
  );
  let id = existing.rows[0]?.id;
  if (!id) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name, is_webhook)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (clerk_id) DO UPDATE SET clerk_id = EXCLUDED.clerk_id
       RETURNING id`,
      [clerkId, name],
    );
    id = inserted.rows[0]!.id;
  }
  pseudoUserIds.set(sourceServerId, id);
  return id;
}

/** Test seam: the cache outlives a truncated table. */
export function resetBauFollowAuthorCacheForTests(): void {
  pseudoUserIds.clear();
  lastPrune = 0;
}

// ------------------------------------------------------------------- the tick

let current: Promise<BauFollowTickResult> | null = null;
let rerun = false;
let lastPrune = 0;

/**
 * Run a tick. Never throws, never overlaps itself in a process: a call that
 * arrives while one is running asks for another pass straight after it (so a
 * publish that lands mid-tick is not left for the timer) and shares its answer.
 * Pass `serverId` to only look at one source server's follows (the publish
 * routes' kick); the periodic job passes nothing, and a re-run is always the
 * whole thing, which is a superset.
 */
export function runBauFollowTick(
  options: { serverId?: string } = {},
): Promise<BauFollowTickResult> {
  if (current) {
    rerun = true;
    return current;
  }
  const started = (async () => {
    const total = emptyResult();
    let scope = options;
    do {
      rerun = false;
      const one = await runOnce(scope);
      for (const key of Object.keys(total) as Array<keyof BauFollowTickResult>) {
        total[key] += one[key];
      }
      scope = {};
    } while (rerun);
    return total;
  })().finally(() => {
    current = null;
  });
  current = started;
  return started;
}

async function runOnce(options: { serverId?: string }): Promise<BauFollowTickResult> {
  const result = emptyResult();
  try {
    // Nothing followed and nothing ever delivered: one cheap read and out, so a
    // deployment that never opens this feature pays for it once per tick.
    const any = await getPool()
      .query<{ busy: boolean }>(
        `SELECT (EXISTS (SELECT 1 FROM bau_follows)
                 OR EXISTS (SELECT 1 FROM bau_follow_deliveries)) AS busy`,
      )
      .catch(() => null);
    if (any && !any.rows[0]?.busy) {
      return result;
    }
    await guarded("announce-retry", drainPendingAnnounces);
    await guarded("retract", async () => {
      result.retracted = await retractIneligible(options.serverId);
    });
    await guarded("sync", async () => {
      result.updated = await syncEditedPosts(options.serverId);
    });
    await guarded("enqueue", async () => {
      result.enqueued = await enqueueQualifying(options.serverId);
    });
    await guarded("deliver", async () => {
      const delivered = await deliverDue(options.serverId);
      result.delivered = delivered.delivered;
      result.failed = delivered.failed;
      result.paused = delivered.paused;
    });
    if (Date.now() - lastPrune > 60 * 60_000) {
      lastPrune = Date.now();
      await guarded("prune", pruneOld);
      await guarded("legacy-pings", async () => {
        await cleanLegacyPingCards();
      });
    }
  } catch (error) {
    console.error("[bau-follow] tick failed:", error);
  }
  return result;
}

/** The kick from a publish, edit or delete route. Fire and forget; never throws. */
export function kickBauFollow(serverId: string): void {
  void runBauFollowTick({ serverId }).catch((error: unknown) => {
    console.error("[bau-follow] kick failed:", error);
  });
}

async function guarded(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    // One pass failing must not starve the others, and nothing here may become
    // an unhandled rejection out of a timer (CLAUDE.md, pitfall 9).
    console.error(`[bau-follow] ${label} failed:`, error);
  }
}

// ---------------------------------------------------------------- 1. retract

async function retractIneligible(serverId?: string): Promise<number> {
  const pool = getPool();
  const scope = serverId ? "AND d.source_server_id = $2" : "";
  const params: unknown[] = [SWEEP_BATCH];
  if (serverId) {
    params.push(serverId);
  }
  const candidates = await pool.query<{
    post_id: string;
    follow_id: string;
    message_id: string;
    channel_id: string;
  }>(
    `SELECT d.post_id, d.follow_id, d.message_id, m.channel_id
       FROM bau_follow_deliveries d
       JOIN messages m ON m.id = d.message_id
       LEFT JOIN community_home_posts p ON p.id = d.post_id
      WHERE d.status = 'delivered' AND d.message_id IS NOT NULL
        AND d.delivered_at > NOW() - INTERVAL '${RECONCILE_DAYS} days'
        AND (p.id IS NULL OR p.status <> 'published' OR p.visibility <> 'free')
        ${scope}
      LIMIT $1`,
    params,
  );
  const results = await mapWithConcurrency(candidates.rows, CONCURRENCY, async (row) => {
    // The message and the row's move to `retracted` are ONE transaction: a
    // process that stops between them must not leave a `delivered` row whose
    // message is gone (nothing would ever revive it). `deleteMessage`'s other
    // work (attachment sweep) has nothing to do here: a card has no files.
    const client = await pool.connect();
    let deleted = false;
    try {
      await client.query("BEGIN");
      const gone = await client.query(`DELETE FROM messages WHERE id = $1`, [
        row.message_id,
      ]);
      deleted = (gone.rowCount ?? 0) > 0;
      await client.query(
        `UPDATE bau_follow_deliveries
            SET status = 'retracted', message_id = NULL
          WHERE post_id = $1 AND follow_id = $2 AND status = 'delivered'`,
        [row.post_id, row.follow_id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[bau-follow] retract failed:", error);
      return false;
    } finally {
      client.release();
    }
    if (deleted) {
      invalidateLatestMessages(row.channel_id);
      broadcastToChannel(row.channel_id, {
        type: "message-delete",
        channelId: row.channel_id,
        messageId: row.message_id,
      });
    }
    return deleted;
  });
  const retracted = results.filter(Boolean).length;
  // Rows that never delivered, for a post that is gone or no longer qualifies.
  await pool.query(
    `UPDATE bau_follow_deliveries d
        SET status = 'retracted', claim_id = NULL, claimed_until = NULL
      WHERE d.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM community_home_posts p
           WHERE p.id = d.post_id AND p.status = 'published' AND p.visibility = 'free'
        )
        ${serverId ? "AND d.source_server_id = $1" : ""}`,
    serverId ? [serverId] : [],
  );
  if (retracted > 0) {
    logEvent("bau.follow.retracted", { count: retracted });
  }
  return retracted;
}

// ------------------------------------------------------------------- 2. sync

interface SyncRow extends PostForSnapshot {
  follow_id: string;
  message_id: string;
  channel_id: string;
  snapshot_hash: string | null;
  /** `updated_at::text`: microsecond exact, written back with a cast (a JS Date has milliseconds). */
  post_updated_at: string;
  source_id: string;
  source_name: string;
  source_icon_url: string | null;
}

/** Pages of stale cards one tick works through (SWEEP_BATCH rows each). */
const SYNC_PAGES_PER_TICK = 10;

/**
 * Cards whose post changed since they were last synced, ALL of them: a keyset
 * walk over (post, follow), a bounded number of pages per tick, so an edit of a
 * post with hundreds of followers reaches every card instead of re-reading the
 * same first page. A row leaves the set once it is synced (its stored version
 * is the post's own `updated_at`, to the microsecond), so the next tick starts
 * from what is still stale.
 */
async function syncEditedPosts(serverId?: string): Promise<number> {
  const pool = getPool();
  let cursor: { post: string; follow: string } | null = null;
  let updated = 0;
  for (let page = 0; page < SYNC_PAGES_PER_TICK; page += 1) {
    const params: unknown[] = [SWEEP_BATCH];
    let scope = "";
    if (serverId) {
      params.push(serverId);
      scope += ` AND d.source_server_id = $${params.length}`;
    }
    if (cursor) {
      params.push(cursor.post, cursor.follow);
      scope += ` AND (d.post_id, d.follow_id) > ($${params.length - 1}::uuid, $${params.length}::uuid)`;
    }
    const rows = await pool.query<SyncRow>(
      `SELECT d.follow_id, d.message_id, m.channel_id, d.snapshot_hash,
              p.updated_at::text AS post_updated_at,
              p.id, p.server_id, p.title, p.body, p.teaser, p.media_kind,
              p.media_youtube_url, p.published_at, p.created_at,
              s.id AS source_id, s.name AS source_name, s.icon_url AS source_icon_url
         FROM bau_follow_deliveries d
         JOIN messages m ON m.id = d.message_id
         JOIN community_home_posts p ON p.id = d.post_id
         JOIN servers s ON s.id = d.source_server_id
         JOIN bau_follows f ON f.id = d.follow_id
        WHERE d.status = 'delivered' AND d.message_id IS NOT NULL
          AND d.delivered_at > NOW() - INTERVAL '${RECONCILE_DAYS} days'
          AND p.status = 'published' AND p.visibility = 'free'
          AND (d.post_updated_at IS NULL OR p.updated_at > d.post_updated_at)
          ${scope}
        ORDER BY d.post_id, d.follow_id
        LIMIT $1`,
      params,
    );
    if (rows.rows.length === 0) {
      break;
    }
    const done = await mapWithConcurrency(rows.rows, CONCURRENCY, async (row) => {
      try {
        return await syncOne(row);
      } catch (error) {
        console.error("[bau-follow] sync failed:", error);
        return false;
      }
    });
    updated += done.filter(Boolean).length;
    const last = rows.rows[rows.rows.length - 1]!;
    cursor = { post: last.id, follow: last.follow_id };
    if (rows.rows.length < SWEEP_BATCH) {
      break;
    }
  }
  if (updated > 0) {
    logEvent("bau.follow.updated", { count: updated });
  }
  return updated;
}

/**
 * Cards delivered while a delivery could still ping carry the role's name alone
 * on their first line (`@Role`, then the fallback) and a `message_mentions` row
 * per member. Nothing pings now, so those lines and rows go.
 *
 * NOT PART OF THE EVERY-TICK SWEEP: reading message bodies there would charge
 * every tick for a population that only shrinks. It runs on the first tick of a
 * process and then hourly (beside the prune), over the same window as the sync,
 * a batch at a time. Hourly, not once, because during a rolling deploy a replica
 * still on the old code can deliver one more ping card after this one has swept.
 * A card whose post is edited meanwhile is also fixed by `syncOne`.
 */
async function cleanLegacyPingCards(): Promise<number> {
  const pool = getPool();
  let cleaned = 0;
  for (let batch = 0; batch < 10; batch += 1) {
    const rows = await pool.query<{ id: string; channel_id: string }>(
      `WITH legacy AS (
         SELECT m.id FROM messages m
           JOIN bau_follow_deliveries d ON d.message_id = m.id
          WHERE d.status = 'delivered' AND m.forward IS NOT NULL
            AND d.delivered_at > NOW() - INTERVAL '${RECONCILE_DAYS} days'
            AND m.body LIKE '@%' AND position(chr(10) in m.body) > 0
          LIMIT ${SWEEP_BATCH}
       ), fixed AS (
         UPDATE messages m
            SET body = substr(m.body, position(chr(10) in m.body) + 1), edited_at = NOW()
           FROM legacy WHERE m.id = legacy.id
         RETURNING m.id, m.channel_id
       ), unmentioned AS (
         DELETE FROM message_mentions WHERE message_id IN (SELECT id FROM fixed)
       )
       SELECT id, channel_id FROM fixed`,
    );
    // The rows are already fixed in the database (one statement, mentions
    // included); see `announceCardUpdate` for the announcement.
    await mapWithConcurrency(rows.rows, CONCURRENCY, async (row) => {
      invalidateLatestMessages(row.channel_id);
      await announceCardUpdate(row.id, row.channel_id);
    });
    cleaned += rows.rows.length;
    if (rows.rows.length < SWEEP_BATCH) {
      break;
    }
  }
  if (cleaned > 0) {
    logEvent("bau.follow.legacyPingsCleaned", { count: cleaned });
  }
  return cleaned;
}

async function syncOne(row: SyncRow): Promise<boolean> {
  const pool = getPool();
  const snapshot = await buildInertBauPostSnapshot(
    row,
    { id: row.source_id, name: row.source_name, icon_url: row.source_icon_url },
    { publicUrl: await getBauPublicUrl(row.server_id, row.id) },
  );
  const hash = snapshotHash(snapshot);
  // The sweep never reads a body: only a card whose post was edited (this row is
  // in the stale set) but whose snapshot did not change asks whether it still
  // carries a legacy `@Role` line, because that card would otherwise keep it.
  if (hash === row.snapshot_hash && !(await isLegacyPingCard(row.message_id))) {
    await pool.query(
      `UPDATE bau_follow_deliveries SET post_updated_at = $3::timestamptz
        WHERE post_id = $1 AND follow_id = $2`,
      [row.id, row.follow_id, row.post_updated_at],
    );
    return false;
  }
  const body = followBody(snapshot);
  // Nothing pings from a Seguir card, so it holds no mention rows: any that a
  // legacy card still has go with its rewrite. BEFORE the body changes: the body
  // is what marks a card as legacy, so a failure here leaves it marked and the
  // next pass retries both. One primary-key delete per EDITED card.
  await pool.query(`DELETE FROM message_mentions WHERE message_id = $1`, [row.message_id]);
  const changed = await pool.query(
    `UPDATE messages
        SET body = $2, forward = $3::jsonb, edited_at = NOW(),
            webhook_username = $4, webhook_avatar_url = $5
      WHERE id = $1
        AND EXISTS (
          SELECT 1 FROM community_home_posts p
           WHERE p.id = $6 AND p.status = 'published' AND p.visibility = 'free'
        )`,
    [
      row.message_id,
      body,
      JSON.stringify(snapshot),
      snapshot.sourceServerName,
      snapshot.sourceServerIconUrl ?? null,
      row.id,
    ],
  );
  await pool.query(
    `UPDATE bau_follow_deliveries
        SET snapshot_hash = $3, post_updated_at = $4::timestamptz
      WHERE post_id = $1 AND follow_id = $2`,
    [row.id, row.follow_id, hash, row.post_updated_at],
  );
  if ((changed.rowCount ?? 0) === 0) {
    return false;
  }
  invalidateLatestMessages(row.channel_id);
  await announceCardUpdate(row.message_id, row.channel_id);
  return true;
}

/** Whether a delivered card still opens with the `@Role` line a pinging delivery wrote. */
async function isLegacyPingCard(messageId: string): Promise<boolean> {
  const found = await getPool().query(
    `SELECT 1 FROM messages WHERE id = $1 AND body LIKE '@%'`,
    [messageId],
  );
  return (found.rowCount ?? 0) > 0;
}

/**
 * Tell the channel a card changed. The change is already committed, so this is
 * a courtesy to people with the channel open (a client that misses it reads the
 * card as it is on open), but a hydrating read can fail transiently, so it gets
 * three tries a moment apart before it is logged and let go.
 */
async function announceCardUpdate(messageId: string, channelId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const message = await getHydratedMessage(messageId);
      if (message) {
        broadcastToChannel(channelId, { type: "message-update", message: mapMessage(message) });
      }
      pendingAnnounces.delete(messageId);
      return;
    } catch (error) {
      if (attempt === 3) {
        console.error("[bau-follow] card update announce failed:", error);
        // Remembered, and tried again at the top of every tick until it lands
        // or its hour is up (see `drainPendingAnnounces`).
        if (pendingAnnounces.size < PENDING_ANNOUNCE_MAX) {
          pendingAnnounces.set(messageId, { channelId, since: pendingAnnounces.get(messageId)?.since ?? Date.now() });
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

/** Card updates whose announcement failed, by message id: retried each tick, dropped after an hour. */
const pendingAnnounces = new Map<string, { channelId: string; since: number }>();
const PENDING_ANNOUNCE_MAX = 1000;
const PENDING_ANNOUNCE_TTL_MS = 60 * 60_000;

async function drainPendingAnnounces(): Promise<void> {
  const now = Date.now();
  for (const [messageId, entry] of [...pendingAnnounces]) {
    if (now - entry.since > PENDING_ANNOUNCE_TTL_MS) {
      pendingAnnounces.delete(messageId);
      continue;
    }
    await announceCardUpdate(messageId, entry.channelId);
  }
}

// ---------------------------------------------------------------- 3. enqueue

async function followSourcesWithFlagOn(serverId?: string): Promise<string[]> {
  const sources = await getPool().query<{ source_server_id: string }>(
    `SELECT DISTINCT source_server_id FROM bau_follows
      WHERE paused_at IS NULL ${serverId ? "AND source_server_id = $1" : ""}`,
    serverId ? [serverId] : [],
  );
  return sources.rows
    .map((row) => row.source_server_id)
    .filter((id) => isBauFollowOn(id));
}

async function enqueueQualifying(serverId?: string): Promise<number> {
  const sources = await followSourcesWithFlagOn(serverId);
  if (sources.length === 0) {
    return 0;
  }
  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO bau_follow_deliveries (post_id, follow_id, source_server_id)
     SELECT p.id, f.id, p.server_id
       FROM bau_follows f
       JOIN servers s ON s.id = f.source_server_id
         AND s.community_home_enabled = TRUE AND s.bau_follow_allowed = TRUE
       JOIN community_home_posts p ON p.server_id = f.source_server_id
      WHERE f.source_server_id = ANY($1::uuid[])
        AND f.paused_at IS NULL
        AND p.status = 'published' AND p.visibility = 'free'
        AND p.published_at IS NOT NULL
        AND p.published_at > f.since_at
        AND p.published_at > NOW() - ($2::int * INTERVAL '1 millisecond')
        AND NOT EXISTS (
          SELECT 1 FROM bau_follow_deliveries d
           WHERE d.post_id = p.id AND d.follow_id = f.id
        )
      LIMIT ${ENQUEUE_BATCH}
     ON CONFLICT DO NOTHING`,
    [sources, BAU_FOLLOW_FRESH_MS],
  );
  // A card that was retracted (the post went back to a draft or members-only)
  // and now qualifies again is delivered again: its message is gone, so this is
  // not a duplicate.
  const revived = await pool.query(
    `UPDATE bau_follow_deliveries d
        SET status = 'pending', attempts = 0, next_attempt_at = NOW(),
            claim_id = NULL, claimed_until = NULL, last_error = NULL
       FROM bau_follows f, community_home_posts p
      WHERE d.status = 'retracted' AND d.message_id IS NULL
        AND f.id = d.follow_id AND p.id = d.post_id
        AND f.source_server_id = ANY($1::uuid[])
        AND f.paused_at IS NULL
        AND p.status = 'published' AND p.visibility = 'free'
        AND p.published_at > f.since_at
        AND p.published_at > NOW() - ($2::int * INTERVAL '1 millisecond')`,
    [sources, BAU_FOLLOW_FRESH_MS],
  );
  return (inserted.rowCount ?? 0) + (revived.rowCount ?? 0);
}

// ---------------------------------------------------------------- 4. deliver

interface Claimed {
  post_id: string;
  follow_id: string;
  source_server_id: string;
  attempts: number;
  claim_id: string;
}

async function claimDue(serverId?: string): Promise<Claimed[]> {
  const claimId = randomUUID();
  const due = (alias: string) =>
    `((${alias}.status = 'pending' AND ${alias}.next_attempt_at <= NOW())
      OR (${alias}.status = 'delivering' AND ${alias}.claimed_until < NOW()))
      ${serverId ? `AND ${alias}.source_server_id = $4` : ""}`;
  const result = await getPool().query<Claimed>(
    `WITH RECURSIVE recent AS (
       -- The quota counts what went out in the last minute AND what is being
       -- delivered right now (a live claim), so two workers claiming at once
       -- cannot each spend the whole quota.
       SELECT post_id, COUNT(*)::int AS n
         FROM bau_follow_deliveries
        WHERE delivered_at > NOW() - INTERVAL '1 minute'
           OR (status = 'delivering' AND claimed_until > NOW())
        GROUP BY post_id
     ),
     -- Posts already at their quota this minute. Dropped from the window below,
     -- NOT inside the scan: the scan is one index probe per post however many
     -- due rows a post has, and a probe that filtered rows would walk all of a
     -- saturated post's due rows to find the next post.
     spent AS (
       SELECT post_id FROM recent WHERE n >= $3
     ),
     -- The posts that have something due, one index probe each (a skip scan
     -- over the partial index on due rows), never a scan of the whole queue.
     posts(post_id) AS (
       (SELECT d.post_id FROM bau_follow_deliveries d
         WHERE ${due("d")} ORDER BY d.post_id LIMIT 1)
       UNION ALL
       SELECT (SELECT d.post_id FROM bau_follow_deliveries d
                WHERE d.post_id > p.post_id AND ${due("d")}
                ORDER BY d.post_id LIMIT 1)
         FROM posts p WHERE p.post_id IS NOT NULL
     ),
     -- Each post offers at most the quota it has LEFT this minute. A post that
     -- is at its quota offers nothing, so its leftovers can never crowd a
     -- later post out of the window.
     candidates AS (
       SELECT x.post_id, x.follow_id, x.next_attempt_at
         FROM (SELECT post_id FROM posts
                WHERE post_id IS NOT NULL AND post_id NOT IN (SELECT post_id FROM spent)
                LIMIT ${CLAIM_POSTS}) p
         LEFT JOIN recent r ON r.post_id = p.post_id
         CROSS JOIN LATERAL (
           SELECT d.post_id, d.follow_id, d.next_attempt_at
             FROM bau_follow_deliveries d
            WHERE d.post_id = p.post_id AND ${due("d")}
            ORDER BY d.next_attempt_at, d.follow_id
            LIMIT GREATEST(0, $3 - COALESCE(r.n, 0))
         ) x
     ),
     picked AS (
       SELECT post_id, follow_id FROM candidates ORDER BY next_attempt_at LIMIT $2
     )
     UPDATE bau_follow_deliveries d
        SET status = 'delivering', claim_id = $1,
            claimed_until = NOW() + (${BAU_FOLLOW_LEASE_MS}::int * INTERVAL '1 millisecond'),
            attempts = d.attempts + 1
       FROM picked
      WHERE d.post_id = picked.post_id AND d.follow_id = picked.follow_id
        AND ${due("d")}
      RETURNING d.post_id, d.follow_id, d.source_server_id, d.attempts, d.claim_id`,
    serverId
      ? [claimId, BAU_FOLLOW_CLAIM_BATCH, BAU_FOLLOW_MAX_DELIVERIES_PER_POST_PER_MINUTE, serverId]
      : [claimId, BAU_FOLLOW_CLAIM_BATCH, BAU_FOLLOW_MAX_DELIVERIES_PER_POST_PER_MINUTE],
  );
  return result.rows;
}

async function deliverDue(
  serverId?: string,
): Promise<{ delivered: number; failed: number; paused: number }> {
  const claimed = await claimDue(serverId);
  const totals = { delivered: 0, failed: 0, paused: 0 };
  for (let i = 0; i < claimed.length; i += CONCURRENCY) {
    const chunk = claimed.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(chunk.map((row) => deliverOne(row)));
    for (const outcome of outcomes) {
      if (outcome === "delivered") {
        totals.delivered += 1;
      } else if (outcome === "failed") {
        totals.failed += 1;
      } else if (outcome === "paused") {
        totals.paused += 1;
        totals.failed += 1;
      }
    }
  }
  if (totals.delivered > 0 || totals.failed > 0) {
    logEvent("bau.follow.tick", totals);
  }
  return totals;
}

type Outcome = "delivered" | "skipped" | "failed" | "paused";

interface DeliveryContext {
  created_by: string | null;
  paused_at: Date | null;
  after_since: boolean | null;
  target_channel_id: string;
  target_server_id: string;
  channel_type: string;
  channel_kind: string;
  source_id: string;
  source_name: string;
  source_icon_url: string | null;
  home_enabled: boolean | null;
  follow_allowed: boolean;
  source_public: boolean;
  slowmode_seconds: number;
  blocked: boolean;
  post_id: string | null;
  post_server_id: string | null;
  title: string | null;
  body: string | null;
  teaser: string | null;
  visibility: string | null;
  status: string | null;
  media_kind: PostForSnapshot["media_kind"];
  media_youtube_url: string | null;
  published_at: Date | null;
  post_created_at: Date | null;
  post_updated_at: string | null;
}

async function loadContext(claimed: Claimed): Promise<DeliveryContext | null> {
  const result = await getPool().query<DeliveryContext>(
    `SELECT f.created_by, f.paused_at, (p.published_at > f.since_at) AS after_since, f.target_channel_id,
            f.target_server_id, tc.type AS channel_type, tc.kind AS channel_kind,
            s.id AS source_id, s.name AS source_name, s.icon_url AS source_icon_url,
            s.community_home_enabled AS home_enabled,
            s.bau_follow_allowed AS follow_allowed,
            (s.is_community AND NOT s.is_community_suspended AND s.community_slug IS NOT NULL) AS source_public,
            tc.slowmode_seconds,
            EXISTS (
              SELECT 1 FROM bau_follow_blocks b
               WHERE b.source_server_id = f.source_server_id
                 AND b.blocked_server_id = f.target_server_id
            ) AS blocked,
            p.id AS post_id, p.server_id AS post_server_id, p.title, p.body,
            p.teaser, p.visibility, p.status, p.media_kind, p.media_youtube_url,
            p.published_at, p.created_at AS post_created_at,
            p.updated_at::text AS post_updated_at
       FROM bau_follows f
       JOIN servers s ON s.id = f.source_server_id
       JOIN channels tc ON tc.id = f.target_channel_id
       LEFT JOIN community_home_posts p ON p.id = $2
      WHERE f.id = $1`,
    [claimed.follow_id, claimed.post_id],
  );
  return result.rows[0] ?? null;
}

async function settle(
  claimed: Claimed,
  patch: {
    status: "pending" | "retracted" | "dead";
    delayMs?: number;
    refundAttempt?: boolean;
    error?: string | null;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE bau_follow_deliveries
        SET status = $4,
            next_attempt_at = NOW() + ($5::int * INTERVAL '1 millisecond'),
            attempts = GREATEST(0, attempts - $6::int),
            claim_id = NULL, claimed_until = NULL, last_error = $7
      WHERE post_id = $1 AND follow_id = $2 AND claim_id = $3`,
    [
      claimed.post_id,
      claimed.follow_id,
      claimed.claim_id,
      patch.status,
      patch.delayMs ?? 0,
      patch.refundAttempt ? 1 : 0,
      patch.error ?? null,
    ],
  );
}

function retryPatch(claimed: Claimed, error: string) {
  if (claimed.attempts >= BAU_FOLLOW_MAX_ATTEMPTS) {
    return { status: "dead" as const, error };
  }
  const delay =
    BAU_FOLLOW_BACKOFF_MS[Math.min(claimed.attempts, BAU_FOLLOW_BACKOFF_MS.length) - 1] ??
    BAU_FOLLOW_BACKOFF_MS[BAU_FOLLOW_BACKOFF_MS.length - 1]!;
  return { status: "pending" as const, delayMs: delay, error };
}

async function deliverOne(claimed: Claimed): Promise<Outcome> {
  try {
    const ctx = await loadContext(claimed);
    if (!ctx) {
      // The follow went away between the claim and now; its rows went with it.
      return "skipped";
    }
    const eligible =
      ctx.post_id !== null &&
      ctx.post_server_id === claimed.source_server_id &&
      ctx.status === "published" &&
      ctx.visibility === "free" &&
      // Published after this follow began (or last resumed): a row that
      // outlived a resume must not carry what came before it.
      // (compared in SQL: a JavaScript Date only has milliseconds)
      ctx.after_since === true &&
      !ctx.blocked;
    if (!eligible) {
      await settle(claimed, { status: "retracted" });
      return "skipped";
    }
    if (
      ctx.published_at === null ||
      Date.now() - ctx.published_at.getTime() > BAU_FOLLOW_FRESH_MS
    ) {
      await settle(claimed, { status: "dead", error: "stale" });
      return "skipped";
    }
    if (
      !isBauFollowOn(claimed.source_server_id) ||
      ctx.home_enabled !== true ||
      !ctx.follow_allowed
    ) {
      // Switched off at the source: nothing is lost, it waits, and the attempt
      // is not counted against it.
      await settle(claimed, {
        status: "pending",
        delayMs: DEFER_FLAG_OFF_MS,
        refundAttempt: true,
      });
      return "skipped";
    }
    if (ctx.paused_at) {
      await settle(claimed, {
        status: "pending",
        delayMs: DEFER_PAUSED_MS,
        refundAttempt: true,
      });
      return "skipped";
    }

    // The authority the follow was made under, asked again every time.
    const permissions =
      ctx.created_by && ctx.channel_kind === "server" && ctx.channel_type === "text"
        ? await computeMemberPermissions(
            ctx.target_server_id,
            ctx.created_by,
            ctx.target_channel_id,
          )
        : 0n;
    if (!mayManageFollow(permissions)) {
      const paused = await recordPermissionFailure(claimed, ctx, "permissions");
      await settle(claimed, retryPatch(claimed, "permissions"));
      return paused ? "paused" : "failed";
    }

    // The source side of the authority: a private source is followed only by
    // its own staff, so a creator who lost MANAGE_SERVER there has lost the
    // right (a public community is open to any member by intent).
    let sourceOk = true;
    if (!ctx.source_public) {
      sourceOk =
        ctx.created_by !== null &&
        hasPermission(
          await computeMemberPermissions(claimed.source_server_id, ctx.created_by),
          Permission.MANAGE_SERVER,
        );
    }
    // The destination's own ban of the source identity is honoured: the card is
    // not posted, and it counts toward the auto-pause like a lost permission.
    const authorId = await bauFollowAuthorFor(ctx.source_id, ctx.source_name);
    const banned = await getPool().query(
      `SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2`,
      [ctx.target_server_id, authorId],
    );
    if (!sourceOk || (banned.rowCount ?? 0) > 0) {
      const banPause = sourceOk;
      const paused = await recordPermissionFailure(claimed, ctx, banPause ? "banned" : "permissions");
      await settle(claimed, retryPatch(claimed, banPause ? "banned" : "source authority"));
      return paused ? "paused" : "failed";
    }
    const post: PostForSnapshot = {
      id: ctx.post_id!,
      server_id: ctx.post_server_id!,
      title: ctx.title,
      body: ctx.body ?? "",
      teaser: ctx.teaser,
      media_kind: ctx.media_kind,
      media_youtube_url: ctx.media_youtube_url,
      published_at: ctx.published_at,
      created_at: ctx.post_created_at ?? ctx.published_at,
    };
    const snapshot = await buildInertBauPostSnapshot(
      post,
      { id: ctx.source_id, name: ctx.source_name, icon_url: ctx.source_icon_url },
      { publicUrl: await getBauPublicUrl(post.server_id, post.id) },
    );
    if (snapshotIsEmpty(snapshot)) {
      await settle(claimed, { status: "dead", error: "empty" });
      return "skipped";
    }
    const committed = await commitDelivery(claimed, ctx, snapshot);
    if (committed === "ineligible") {
      await settle(claimed, { status: "retracted" });
      return "skipped";
    }
    if (committed && "slowMs" in committed) {
      await settle(claimed, {
        status: "pending",
        delayMs: committed.slowMs + 500,
        refundAttempt: true,
      });
      return "skipped";
    }
    if (!committed) {
      return "skipped";
    }
    // COMMITTED means delivered. The announcement is a courtesy to people who
    // have the channel open: a failure here (a hydrating read, the fan-out) is
    // logged and never turned into a failed delivery, because the card exists
    // and the row is settled; a client that missed the frame reads it on open.
    invalidateLatestMessages(ctx.target_channel_id);
    if (committed.fresh) {
      try {
        const message = await getHydratedMessage(committed.messageId);
        if (message) {
          await announceServiceMessage(mapMessage(message));
        }
      } catch (error) {
        console.error("[bau-follow] announce failed after commit:", error);
      }
    }
    return "delivered";
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.error(
      `[bau-follow] delivery failed post=${claimed.post_id} follow=${claimed.follow_id}:`,
      text,
    );
    await settle(claimed, retryPatch(claimed, text.slice(0, 500))).catch(() => {});
    return "failed";
  }
}

/**
 * The one transaction: the card and the row's move to
 * `delivered`, guarded on the claim. Returns null when the claim is no longer
 * ours (a lease that expired under a slow process), with nothing written.
 */
async function commitDelivery(
  claimed: Claimed,
  ctx: DeliveryContext,
  snapshot: BauPostSnapshot,
): Promise<
  | { messageId: string; fresh: boolean }
  | { slowMs: number }
  | "ineligible"
  | null
> {
  const authorId = await bauFollowAuthorFor(ctx.source_id, ctx.source_name);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const guard = await client.query(
      `SELECT 1 FROM bau_follow_deliveries
        WHERE post_id = $1 AND follow_id = $2 AND claim_id = $3 AND status = 'delivering'
        FOR UPDATE`,
      [claimed.post_id, claimed.follow_id, claimed.claim_id],
    );
    if (guard.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    // Slow mode is the channel's own pace: one card per interval, the rest wait.
    // Decided HERE, under a lock on the channel, so two deliveries into the same
    // channel at once cannot both read "the interval has passed" and both post;
    // the second waits for the first's commit and then sees its card. Only a
    // channel that has slow mode pays for the lookup (an index read, newest
    // first).
    if (ctx.slowmode_seconds > 0) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `bau-follow-slow:${ctx.target_channel_id}`,
      ]);
      const last = await client.query<{ created_at: Date }>(
        `SELECT created_at FROM messages
          WHERE channel_id = $1 AND author_id = $2
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.target_channel_id, authorId],
      );
      const lastAt = last.rows[0]?.created_at;
      const waitMs = lastAt ? lastAt.getTime() + ctx.slowmode_seconds * 1000 - Date.now() : 0;
      if (waitMs > 0) {
        await client.query("ROLLBACK");
        return { slowMs: waitMs };
      }
    }
    // The post, locked for the length of this transaction and checked AGAIN:
    // the context was read a moment ago, and a post made members-only or
    // unpublished since then must not be announced from that stale read. An
    // edit that wants to change it now waits for this commit, and the retract
    // pass then takes the card back.
    const still = await client.query(
      `SELECT 1 FROM community_home_posts
        WHERE id = $1 AND status = 'published' AND visibility = 'free'
        FOR SHARE`,
      [claimed.post_id],
    );
    if (still.rows.length === 0) {
      await client.query("ROLLBACK");
      return "ineligible";
    }
    const nonce = `bau-follow:${claimed.post_id}`;
    const body = followBody(snapshot);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO messages
         (channel_id, author_id, body, webhook_username, webhook_avatar_url, nonce, forward)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (channel_id, author_id, nonce) WHERE nonce IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        ctx.target_channel_id,
        authorId,
        body,
        snapshot.sourceServerName,
        snapshot.sourceServerIconUrl ?? null,
        nonce,
        JSON.stringify(snapshot),
      ],
    );
    let messageId = inserted.rows[0]?.id ?? null;
    const fresh = messageId !== null;
    if (!messageId) {
      // The wall behind the table: a card for this post is already in this
      // channel. Adopt it instead of posting a second.
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM messages
          WHERE channel_id = $1 AND author_id = $2 AND nonce = $3`,
        [ctx.target_channel_id, authorId, nonce],
      );
      messageId = existing.rows[0]?.id ?? null;
      if (!messageId) {
        throw new Error("delivery nonce conflict without a message");
      }
    }
    const done = await client.query(
      `UPDATE bau_follow_deliveries
          SET status = 'delivered', message_id = $4, delivered_at = NOW(),
              snapshot_hash = $5, post_updated_at = $6::timestamptz,
              claim_id = NULL, claimed_until = NULL, last_error = NULL
        WHERE post_id = $1 AND follow_id = $2 AND claim_id = $3`,
      [
        claimed.post_id,
        claimed.follow_id,
        claimed.claim_id,
        messageId,
        snapshotHash(snapshot),
        ctx.post_updated_at,
      ],
    );
    if ((done.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE bau_follows SET permission_failures = 0
        WHERE id = $1 AND permission_failures > 0`,
      [claimed.follow_id],
    );
    await client.query("COMMIT");
    return { messageId, fresh };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------- auto-pause

/** Count a permission failure; at the limit, pause the follow and tell the destination's staff. Returns whether it paused. */
async function recordPermissionFailure(
  claimed: Claimed,
  ctx: DeliveryContext,
  reason: "permissions" | "banned",
): Promise<boolean> {
  const followId = claimed.follow_id;
  const pool = getPool();
  // Only while this delivery's claim is still ours: a worker that lost its lease
  // (a slow check) must not move the shared counter, or pause the follow, on a
  // verdict a newer worker has already overtaken.
  const counted = await pool.query<{ permission_failures: number }>(
    `UPDATE bau_follows SET permission_failures = permission_failures + 1
      WHERE id = $1 AND paused_at IS NULL
        AND EXISTS (
          SELECT 1 FROM bau_follow_deliveries d
           WHERE d.post_id = $2 AND d.follow_id = $1 AND d.claim_id = $3
             AND d.status = 'delivering' AND d.claimed_until > NOW()
        )
      RETURNING permission_failures`,
    [followId, claimed.post_id, claimed.claim_id],
  );
  const failures = counted.rows[0]?.permission_failures ?? 0;
  if (failures < BAU_FOLLOW_PAUSE_AFTER_FAILURES) {
    return false;
  }
  const paused = await pool.query(
    `UPDATE bau_follows
        SET paused_at = NOW(), paused_reason = $2
      WHERE id = $1 AND paused_at IS NULL`,
    [followId, reason],
  );
  if ((paused.rowCount ?? 0) === 0) {
    return false;
  }
  logEvent("bau.follow.paused", {
    followId,
    sourceServerId: ctx.source_id,
    targetServerId: ctx.target_server_id,
  });
  await guarded("pause-notice", async () => {
    await logAudit({
      serverId: ctx.target_server_id,
      actorId: null,
      action: "bau_follow.pause",
      targetType: "bau_follow",
      targetId: followId,
      reason,
      changes: [
        { key: "source", old: null, new: ctx.source_name },
        { key: "channelId", old: null, new: ctx.target_channel_id },
      ],
    });
    await postPauseNotice(ctx, reason);
  });
  return true;
}

/**
 * A plain message in the destination channel, from the source's identity, so
 * the people who look after the channel hear about it where they already are.
 * Server-written copy in Portuguese, like the AutoMod alert is: the audit log
 * and the channel's Seguir section say the same in the viewer's language.
 */
async function postPauseNotice(
  ctx: DeliveryContext,
  reason: "permissions" | "banned",
): Promise<void> {
  const authorId = await bauFollowAuthorFor(ctx.source_id, ctx.source_name);
  const client = await getPool().connect();
  let messageId: string;
  try {
    const body =
      reason === "banned"
        ? `Seguir pausado: este servidor baniu o Baú de ${ctx.source_name}, então os posts pararam de chegar neste canal. ` +
          "Quem gerencia o servidor pode desbanir e retomar nas configurações do canal, em Seguir, ou deixar de seguir."
        : `Seguir pausado: os posts do Baú de ${ctx.source_name} pararam de chegar neste canal ` +
          "porque quem configurou perdeu a permissão de gerenciar o canal. " +
          "Quem gerencia o canal pode retomar nas configurações do canal, em Seguir.";
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body, webhook_username, webhook_avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [ctx.target_channel_id, authorId, body, ctx.source_name, ctx.source_icon_url],
    );
    messageId = inserted.rows[0]!.id;
  } finally {
    client.release();
  }
  invalidateLatestMessages(ctx.target_channel_id);
  const message = await getHydratedMessage(messageId);
  if (message) {
    await announceServiceMessage(mapMessage(message));
  }
}

// ------------------------------------------------------------------- prune

async function pruneOld(): Promise<void> {
  await getPool().query(
    `DELETE FROM bau_follow_deliveries
      WHERE status IN ('retracted', 'dead')
        AND created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [PRUNE_AFTER_DAYS],
  );
}
