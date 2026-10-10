import { hasPermission, Permission } from "@pqp/shared";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import {
  isCommunityHomeEnabled,
  isCommunityHomeVipEnabled,
} from "./community-home.js";
import { computeMemberPermissionsBulk } from "./permissions.js";
import { isAnyPushEnabled, sendCommunityHomePostPush } from "./push.js";
import { notePushSkipped } from "./push-skips.js";

/**
 * "Post novo no Baú": the push for a Baú post that just went live.
 *
 * WHEN. A post is *published* by one of four writes (create as published, edit
 * into published, "Publish now", a scheduled time arriving, the last of them
 * also from a feed read's catch-up), and a push that hooked each of them would
 * miss one. So none of them hooks anything. `community_home_posts.push_claimed_at`
 * is the single seam: `pushPendingCommunityHomePosts` stamps every published
 * post that has not been stamped, in ONE `UPDATE ... RETURNING`, and whoever
 * gets the row back is the only one who sends. That is exactly-once across
 * machines (two API instances racing the same post: one wins the row), across
 * the publish route and the 30 s sweep, and across an unpublish followed by a
 * publish (the stamp survives, so a post never notifies twice).
 *
 * THE STAMP IS TAKEN EVEN WHEN NOTHING IS SENT. With `bau_post_push` off, with
 * no push transport, or for a post that is stale, the row is still claimed and
 * simply not announced. Otherwise turning the flag on would announce every
 * post published while it was off, which is the one thing a switch must not do.
 *
 * WHO. Every member of the server, minus:
 *  - the author of the post (their own post is not news);
 *  - anybody who blocked the author;
 *  - for a members-only post, anybody who could not open it in full (only
 *    `MANAGE_SERVER` and the VIP cargo can; everyone else would get a push for
 *    a lock, which is an advert, not a notice). With the VIP flag off a
 *    members-only post is not in the feed at all, so it is not announced;
 * and then, in `sendCommunityHomePostPush`, by what only a push can know: a
 * socket in front of the person (the live corner card already told them), a
 * stored do-not-disturb, and the server's notification level. Each refusal
 * after the audience is built is a `pushSkipped.bau.*` count.
 *
 * QUIET. Posts claimed together (a staff member publishing three in a row, a
 * sweep that found several) are ONE push per person that says how many, and
 * the notification `tag` is per server, so a later post replaces an earlier one
 * on the device instead of stacking. The audience is walked a page at a time
 * so a large community is never held in memory, with a ceiling per claim.
 */

/** A claimed post older than this is stamped and never announced. */
export const BAU_PUSH_FRESH_MS = 30 * 60 * 1000;

const AUDIENCE_PAGE = 1000;
/**
 * A seat belt per claim, not a rule: 50 000 people is a very large community.
 * Past it the walk stops and says so (`capped` on the `push.bauPost` line), so
 * a community that outgrows it is a log search and not a silent gap.
 */
export const BAU_PUSH_MAX_MEMBERS = 50_000;
/** Posts claimed per call, so a backlog is worked off a tick at a time. */
export const BAU_PUSH_CLAIM_BATCH = 200;

interface ClaimedPost {
  id: string;
  server_id: string;
  author_id: string;
  title: string | null;
  visibility: "free" | "members";
  published_at: Date | null;
}

/**
 * Claim every published, unstamped post (of one server, or of all of them) and
 * announce the fresh ones. Never throws: a push is never a reason for a publish
 * to fail, and a rejection out of a timer reaches the process (CLAUDE.md,
 * pitfall 9). Returns the people a push was attempted for.
 */
export async function pushPendingCommunityHomePosts(
  serverId?: string,
): Promise<number> {
  if (!isCommunityHomeEnabled()) {
    return 0;
  }
  try {
    const pool = getPool();
    const staleScope = serverId ? "AND server_id = $2" : "";
    const claimScope = serverId ? "AND server_id = $1" : "";
    const scopeParams = serverId ? [serverId] : [];
    // Stale first, and not returned: a backlog (a long outage, a worker that
    // was off) is stamped in one statement and never held in memory.
    await pool.query(
      `UPDATE community_home_posts
          SET push_claimed_at = NOW()
        WHERE status = 'published'
          AND push_claimed_at IS NULL
          AND published_at < NOW() - ($1::int * INTERVAL '1 millisecond')
          ${staleScope}`,
      [BAU_PUSH_FRESH_MS, ...scopeParams],
    );
    // Then the fresh ones, a bounded batch at a time. SKIP LOCKED so two
    // machines claiming at once take different rows instead of queueing.
    const claimed = await pool.query<ClaimedPost>(
      `UPDATE community_home_posts p
          SET push_claimed_at = NOW()
         FROM (
           SELECT id FROM community_home_posts
            WHERE status = 'published'
              AND push_claimed_at IS NULL
              ${claimScope}
            ORDER BY published_at
            LIMIT ${BAU_PUSH_CLAIM_BATCH}
            FOR UPDATE SKIP LOCKED
         ) picked
        WHERE p.id = picked.id
        RETURNING p.id, p.server_id, p.author_id, p.title, p.visibility, p.published_at`,
      scopeParams,
    );
    if (claimed.rows.length === 0) {
      return 0;
    }
    const byServer = new Map<string, ClaimedPost[]>();
    for (const row of claimed.rows) {
      const list = byServer.get(row.server_id) ?? [];
      list.push(row);
      byServer.set(row.server_id, list);
    }
    let pushed = 0;
    for (const [id, posts] of byServer) {
      const progress = { pagesSent: 0 };
      try {
        pushed += await announceServerPosts(id, posts, progress);
      } catch (error) {
        console.error(
          `[community-home] post push failed for server ${id}:`,
          error,
        );
        // Nothing went out yet: the failure was before any vendor was called
        // (a lookup, a preference read), so the claim is handed back and the
        // next tick tries again, for as long as the post is fresh. Once a page
        // has been sent the posts stay claimed: finishing the rest could tell
        // some people twice, and a missed push is the lesser harm.
        if (progress.pagesSent === 0) {
          await pool
            .query(
              `UPDATE community_home_posts SET push_claimed_at = NULL
                WHERE id = ANY($1::uuid[])`,
              [posts.map((post) => post.id)],
            )
            .catch(() => {});
        }
      }
    }
    return pushed;
  } catch (error) {
    console.error("[community-home] post push claim failed:", error);
    return 0;
  }
}

async function announceServerPosts(
  serverId: string,
  claimed: readonly ClaimedPost[],
  progress: { pagesSent: number },
): Promise<number> {
  if (!isEnabled("bau_post_push", { serverId }) || !isAnyPushEnabled()) {
    return 0;
  }
  const now = Date.now();
  const vipOn = isCommunityHomeVipEnabled();
  const posts = claimed
    .filter(
      (post) =>
        (post.published_at?.getTime() ?? now) >= now - BAU_PUSH_FRESH_MS &&
        (post.visibility === "free" || vipOn),
    )
    .sort(
      (a, b) =>
        (a.published_at?.getTime() ?? 0) - (b.published_at?.getTime() ?? 0),
    );
  if (posts.length === 0) {
    return 0;
  }
  const pool = getPool();
  const server = await pool.query<{ name: string; community_home_enabled: boolean }>(
    `SELECT name, community_home_enabled FROM servers WHERE id = $1`,
    [serverId],
  );
  const row = server.rows[0];
  // The owner's own switch: a server that turned its Baú off announces nothing.
  if (!row || !row.community_home_enabled) {
    return 0;
  }
  const anyMembersOnly = posts.some((post) => post.visibility === "members");
  const authors = [...new Set(posts.map((post) => post.author_id))];

  let pushed = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  let walked = 0;
  while (walked < BAU_PUSH_MAX_MEMBERS) {
    const page = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM server_members
        WHERE server_id = $1 AND user_id > $2
        ORDER BY user_id
        LIMIT $3`,
      [serverId, after, AUDIENCE_PAGE],
    );
    if (page.rows.length === 0) {
      break;
    }
    const ids = page.rows.map((r) => r.user_id);
    after = ids[ids.length - 1]!;
    walked += ids.length;

    // Who may open a members-only post in full: the same two rules the feed
    // applies in `canUnlockMembers` (MANAGE_SERVER or the VIP cargo).
    const unlockers = new Set<string>();
    if (anyMembersOnly) {
      const [permissions, vips] = await Promise.all([
        computeMemberPermissionsBulk(serverId, ids, null),
        pool.query<{ user_id: string }>(
          `SELECT DISTINCT mr.user_id
             FROM member_roles mr
             JOIN roles r ON r.id = mr.role_id
            WHERE mr.server_id = $1
              AND r.system_key = 'vip'
              AND mr.user_id = ANY($2::uuid[])`,
          [serverId, ids],
        ),
      ]);
      for (const id of ids) {
        if (hasPermission(permissions.get(id) ?? 0n, Permission.MANAGE_SERVER)) {
          unlockers.add(id);
        }
      }
      for (const vip of vips.rows) {
        unlockers.add(vip.user_id);
      }
    }

    // `blocker -> author` pairs among this page: one direction, as everywhere
    // in the Baú. Somebody who blocked the author does not want their posts.
    const blocks = await pool.query<{ user_id: string; blocked_user_id: string }>(
      `SELECT user_id, blocked_user_id FROM user_blocks
        WHERE user_id = ANY($1::uuid[]) AND blocked_user_id = ANY($2::uuid[])`,
      [ids, authors],
    );
    const blockedAuthors = new Map<string, Set<string>>();
    for (const block of blocks.rows) {
      const set = blockedAuthors.get(block.user_id) ?? new Set<string>();
      set.add(block.blocked_user_id);
      blockedAuthors.set(block.user_id, set);
    }

    const recipients = new Map<string, (string | null)[]>();
    for (const userId of ids) {
      const titles: (string | null)[] = [];
      let hiddenByBlock = false;
      for (const post of posts) {
        if (post.author_id === userId) {
          continue;
        }
        if (post.visibility === "members" && !unlockers.has(userId)) {
          continue;
        }
        if (blockedAuthors.get(userId)?.has(post.author_id)) {
          hiddenByBlock = true;
          continue;
        }
        titles.push(post.title?.trim() ? post.title.trim() : null);
      }
      if (titles.length > 0) {
        recipients.set(userId, titles);
      } else if (hiddenByBlock) {
        notePushSkipped("bau", "blocked", userId, { serverId });
      }
    }
    if (recipients.size > 0) {
      pushed += await sendCommunityHomePostPush(
        { serverId, serverName: row.name, recipients },
        // Counted before the send starts delivering, not after it returns: a
        // rejection after some devices were reached must not look like
        // "nothing went out" and hand the claim back.
        () => {
          progress.pagesSent += 1;
        },
      );
    }
  }
  logEvent("push.bauPost", {
    serverId,
    posts: posts.length,
    walked,
    pushed,
    capped: walked >= BAU_PUSH_MAX_MEMBERS ? true : undefined,
  });
  return pushed;
}
