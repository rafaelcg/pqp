import {
  COMMUNITY_MEMBER_FLOOR,
  type CommunityCategory,
  type CommunitySettings,
  type CommunitySummary,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { invalidateServerAudience } from "./servers.js";

/**
 * Communities — a public directory of joinable servers, and the join path that
 * needs no invite.
 *
 * FOUR RULES HOLD THIS FILE TOGETHER, and every function exists to keep one of
 * them true:
 *
 * 1. THE FLAG IS CHECKED AT THE ROUTE, NOT HERE. `isCommunitiesEnabled` is
 *    exported from this module and called by `api/index.ts` before any handler
 *    body runs, so a deployment with the flag off answers 404 for every path in
 *    the feature and never reaches this file at all. Putting the check inside
 *    each function would mean the day somebody adds a fifth one, the fifth one
 *    is unflagged.
 *
 * 2. NOBODY BROWSES ANONYMOUSLY. Every read takes a `viewerId` and is called
 *    from a route behind the same auth every other `/api` route has. That is
 *    not decoration: pqp runs an 18+ gate with a real date-of-birth check
 *    (`services/age-gate.ts`), and a directory readable without signing in
 *    would route around it — an age gate you can browse past is not one. It is
 *    also what makes rule 3 expressible at all.
 *
 * 3. A BAN IS INVISIBILITY, NOT A REFUSAL AT THE DOOR. A server you are banned
 *    from does not appear in your directory, does not appear in your search
 *    results, and cannot be joined. Listing it and refusing the join would tell
 *    a banned person exactly where they are unwelcome and hand them a page to
 *    hammer; and the ban already outlives membership by design, which is the
 *    whole reason `server_bans` is a separate table.
 *
 * 4. A REPORT ABOUT A COMMUNITY DOES NOT GO TO ITS OWNER. That rule lives in
 *    `reports.ts` (see `resolveServerSubject`), and the operator's counterpart
 *    — `is_community_suspended`, settable only with the DATABASE_URL — is
 *    enforced here, in the one predicate every read path shares.
 */

/**
 * Whether this deployment has communities at all.
 *
 * DEFAULT OFF, AND THE DEFAULT IS THE POINT. Building a public directory of
 * joinable rooms is what moves a Brazilian instance out of the bucket the STF's
 * 26 June 2025 Art. 19 ruling still shelters (e-mail, private meetings, instant
 * messaging) and into "platform hosting public content", with a duty of care
 * attached — see docs/research/communities-orkut.html §08. That is a decision an
 * operator makes deliberately, with the moderation duty understood, and never
 * one they back into by upgrading.
 *
 * READ PER CALL rather than captured at module load, matching
 * `isInstanceModerator` and `isGifSearchConfigured`: a restart is all it should
 * take to change, and tests set it without import-order games.
 *
 * WHERE A PERCENTAGE ROLLOUT WOULD GO. This function is the single choke point
 * — every route calls it and nothing else asks the question — so a later
 * per-user or percentage rollout is a change of signature here (taking the
 * viewer) plus the call sites the type checker then points at, and nothing else.
 * Deliberately not built now: a bucketing scheme with no traffic to bucket is
 * machinery whose behaviour nobody can observe.
 */
export function isCommunitiesEnabled(): boolean {
  return process.env.COMMUNITIES_ENABLED === "true";
}

/**
 * The listing predicate, written once.
 *
 * Every read path in this file interpolates this string, and none of them
 * rebuild it: "what is publicly listed" is one question, and two copies of the
 * answer is how a suspended community stays visible in search after being
 * pulled from the grid. `$1` is always the viewer.
 */
const LISTED_SQL = `s.is_community
   AND NOT s.is_community_suspended
   AND NOT EXISTS (
     SELECT 1 FROM server_bans b WHERE b.server_id = s.id AND b.user_id = $1
   )`;

/**
 * The columns a stranger may read. Deliberately narrower than `SERVER_COLUMNS`
 * in servers.ts — no `owner_id`, no retention policy, no SSO domain. See
 * `communitySummarySchema`: this is the public projection of a server and
 * nothing that is not already visible to anyone who joined belongs in it.
 */
const DIRECTORY_COLUMNS = `s.id, s.name, s.community_tagline, s.community_category,
  s.member_count, s.created_at, s.icon_url, s.banner_url,
  EXISTS (
    SELECT 1 FROM server_members m WHERE m.server_id = s.id AND m.user_id = $1
  ) AS joined`;

interface DirectoryRow {
  id: string;
  name: string;
  community_tagline: string | null;
  community_category: CommunityCategory;
  member_count: number;
  created_at: Date;
  icon_url: string | null;
  banner_url: string | null;
  joined: boolean;
}

function toSummary(row: DirectoryRow): CommunitySummary {
  return {
    id: row.id,
    name: row.name,
    tagline: row.community_tagline,
    category: row.community_category,
    memberCount: row.member_count,
    joined: row.joined,
    createdAt: row.created_at.toISOString(),
    // Root-relative, resolved against the API base by whichever client renders
    // the card — the same treatment `avatarUrl` gets everywhere else.
    iconUrl: row.icon_url,
    bannerUrl: row.banner_url,
  };
}

export interface ListCommunitiesOptions {
  category?: CommunityCategory | null;
  /** Already trimmed and validated by `communitySearchQuerySchema`. */
  search?: string | null;
  limit: number;
  offset: number;
}

export interface CommunityListPage {
  communities: CommunitySummary[];
  hasMore: boolean;
}

/**
 * One page of the directory.
 *
 * ORDER IS SIZE, THEN AGE, and there is no ranking model behind it. Two sorts
 * a person can explain are worth more here than a score nobody can: "the
 * biggest ones" is what a directory is for, and `created_at DESC` as the
 * tiebreaker means a new community of equal size surfaces above an old one
 * rather than sitting at a permanently arbitrary position. `id` closes the
 * order completely so pagination is stable.
 *
 * THE MEMBER FLOOR APPLIES TO BROWSING AND NOT TO SEARCH. A grid whose first
 * page is forty rooms with one member each is not a directory; but somebody
 * typing the exact name of the community their friend made an hour ago is not
 * browsing, and answering "nothing found" for a server that plainly exists is
 * the one behaviour that reads as broken rather than as curation. See
 * `COMMUNITY_MEMBER_FLOOR`.
 *
 * A COMMUNITY YOU ARE ALREADY IN STAYS LISTED, carrying `joined: true` so the
 * card offers "open" instead of "join". Hiding it would make the directory
 * disagree with itself the moment you joined something from it — the card you
 * just clicked would vanish — and there is nothing to protect: you can already
 * see the server.
 *
 * Offset pagination rather than a keyset cursor, deliberately. The order key is
 * `member_count`, which changes under the reader as people join, so a keyset
 * cursor over it is not the stability guarantee it looks like; and the page
 * budget here is a few hundred rows behind a feature flag, where LIMIT/OFFSET
 * costs nothing measurable. `hasMore` is derived by asking for one row more
 * than the page and dropping it, so the client never has to guess.
 */
export async function listCommunities(
  viewerId: string,
  options: ListCommunitiesOptions,
): Promise<CommunityListPage> {
  const params: unknown[] = [viewerId];
  const filters: string[] = [LISTED_SQL];

  if (options.category) {
    params.push(options.category);
    filters.push(`s.community_category = $${params.length}`);
  }

  if (options.search) {
    // `%` and `_` are LIKE metacharacters; a search for "100%" must not become
    // a wildcard. Escaped here rather than in the schema because it is a
    // property of this query and not of the string.
    const pattern = `%${options.search.replace(/[%_\\]/g, "\\$&")}%`;
    params.push(pattern);
    filters.push(
      `(s.name ILIKE $${params.length} ESCAPE '\\'
        OR s.community_tagline ILIKE $${params.length} ESCAPE '\\')`,
    );
  } else {
    // Browsing only. See the note above on why search is exempt.
    params.push(COMMUNITY_MEMBER_FLOOR);
    filters.push(`s.member_count >= $${params.length}`);
  }

  params.push(options.limit + 1);
  const limitParam = `$${params.length}`;
  params.push(options.offset);
  const offsetParam = `$${params.length}`;

  const result = await getPool().query<DirectoryRow>(
    `SELECT ${DIRECTORY_COLUMNS}
     FROM servers s
     WHERE ${filters.join(" AND ")}
     ORDER BY s.member_count DESC, s.created_at DESC, s.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  const rows = result.rows.slice(0, options.limit);
  return {
    communities: rows.map(toSummary),
    hasMore: result.rows.length > options.limit,
  };
}

/**
 * One community, by id, as the directory would show it.
 *
 * Subject to the same predicate as the list — a suspended community, a private
 * server, or one the viewer is banned from is "not found" and not "forbidden".
 * The distinction matters: a 403 confirms the id names something.
 */
export async function getCommunity(
  viewerId: string,
  serverId: string,
): Promise<CommunitySummary | null> {
  const result = await getPool().query<DirectoryRow>(
    `SELECT ${DIRECTORY_COLUMNS}
     FROM servers s
     WHERE s.id = $2 AND ${LISTED_SQL}`,
    [viewerId, serverId],
  );
  const row = result.rows[0];
  return row ? toSummary(row) : null;
}

export type JoinCommunityResult =
  | { ok: true; serverId: string; serverName: string; joinedNow: boolean }
  | { ok: false; reason: "not_found" | "banned" };

/**
 * Join a community. No invite, no approval, one tap.
 *
 * MODELLED ON `redeemInvite` AND `joinServerBySso` RATHER THAN BESIDE THEM,
 * because the three differ only in what authorises the join and agree on
 * everything that matters: hold the server row `FOR UPDATE`, re-check the ban
 * inside the transaction, `INSERT ... ON CONFLICT DO NOTHING`, and invalidate
 * the audience cache only when a row was actually written. What is deliberately
 * NOT shared is the invite's use-counting — there is no invite to burn.
 *
 * IDEMPOTENT, and that is load-bearing rather than incidental. The client
 * navigates to the server immediately after this resolves, so a double tap, a
 * retry after a timeout, or a card clicked twice all have to be the same join —
 * and `joinedNow` is what lets the caller tell "welcome" from "you were already
 * here" without a second query.
 *
 * THE LISTING IS RE-CHECKED UNDER THE LOCK, not read from what the directory
 * showed. An owner unlisting their community, or an operator suspending it,
 * must beat a join that already had the card on screen — otherwise the window
 * between "pull the listing" and "the tab refreshes" is a window in which the
 * pulled listing still admits people.
 *
 * The member floor is NOT re-checked here. It is a browsing heuristic, not a
 * permission; refusing to admit the second member of a community would make the
 * floor unreachable and every new community permanently empty.
 */
export async function joinCommunity(
  serverId: string,
  userId: string,
): Promise<JoinCommunityResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const serverResult = await client.query<{
      id: string;
      name: string;
      is_community: boolean;
      is_community_suspended: boolean;
    }>(
      `SELECT id, name, is_community, is_community_suspended
       FROM servers WHERE id = $1 FOR UPDATE`,
      [serverId],
    );
    const server = serverResult.rows[0];
    // "Does not exist", "is not a community" and "has been suspended" are one
    // answer on purpose: a different reply for each would let a stranger
    // enumerate server ids and read the operator's moderation decisions off the
    // API.
    if (!server || !server.is_community || server.is_community_suspended) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }

    const banned = await client.query(
      `SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2`,
      [serverId, userId],
    );
    if (banned.rows.length > 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "banned" };
    }

    const inserted = await client.query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [serverId, userId],
    );

    await client.query("COMMIT");
    const joinedNow = (inserted.rowCount ?? 0) > 0;
    if (joinedNow) {
      // Same reasoning as `joinServerBySso`: the cache is widening, so missing
      // it costs a few silent seconds rather than a leak — and "you joined and
      // the room went quiet" is a bad first minute.
      invalidateServerAudience(serverId);
    }
    return { ok: true, serverId, serverName: server.name, joinedNow };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The owner's own view of their server's listing. */
export async function getCommunitySettings(
  serverId: string,
): Promise<CommunitySettings | null> {
  const result = await getPool().query<{
    is_community: boolean;
    community_tagline: string | null;
    community_category: CommunityCategory;
    is_community_suspended: boolean;
  }>(
    `SELECT is_community, community_tagline, community_category, is_community_suspended
     FROM servers WHERE id = $1`,
    [serverId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    isCommunity: row.is_community,
    tagline: row.community_tagline,
    category: row.community_category,
    suspended: row.is_community_suspended,
  };
}

export interface CommunityUpdate {
  isCommunity?: boolean;
  /** Explicit null clears; absent leaves it. */
  tagline?: string | null;
  category?: CommunityCategory;
}

/**
 * Apply the owner's opt-in, and hand back both sides of the change.
 *
 * SAME SHAPE AS `updateMessageRetention` AND `updateSsoEmailDomain`, and for
 * the same reason: a `UPDATE ... RETURNING` only knows what the row became, and
 * an audit entry that cannot say what it was is not an audit entry. The `FOR
 * UPDATE` read is what makes the before-value the one this write actually
 * replaced rather than whatever a concurrent PATCH left behind.
 *
 * SUSPENSION IS NOT WRITEABLE HERE and there is no code path that writes it.
 * An owner relisting a suspended community sets `is_community` back to true and
 * changes nothing — `is_community_suspended` still keeps it out of every read
 * path. That is the intended behaviour, not an oversight: the operator's
 * decision has to outrank the owner's or it is not a moderation tool.
 */
export async function updateCommunitySettings(
  serverId: string,
  update: CommunityUpdate,
): Promise<{ settings: CommunitySettings; previous: CommunitySettings } | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const before = await client.query<{
      is_community: boolean;
      community_tagline: string | null;
      community_category: CommunityCategory;
      is_community_suspended: boolean;
    }>(
      `SELECT is_community, community_tagline, community_category, is_community_suspended
       FROM servers WHERE id = $1 FOR UPDATE`,
      [serverId],
    );
    const previousRow = before.rows[0];
    if (!previousRow) {
      await client.query("ROLLBACK");
      return null;
    }

    // Absent means "not changing this", which is why each field is coalesced
    // against the row rather than defaulted to anything. Turning the listing
    // OFF deliberately leaves the tagline and category behind: an owner who
    // unlists and relists a week later should not have to retype the pitch, and
    // an unlisted row is invisible to every read path anyway.
    const result = await client.query<{
      is_community: boolean;
      community_tagline: string | null;
      community_category: CommunityCategory;
      is_community_suspended: boolean;
    }>(
      `UPDATE servers SET
         is_community = COALESCE($2, is_community),
         community_tagline = CASE WHEN $3::boolean THEN $4 ELSE community_tagline END,
         community_category = COALESCE($5, community_category)
       WHERE id = $1
       RETURNING is_community, community_tagline, community_category, is_community_suspended`,
      [
        serverId,
        update.isCommunity ?? null,
        update.tagline !== undefined,
        update.tagline ?? null,
        update.category ?? null,
      ],
    );
    await client.query("COMMIT");

    const row = result.rows[0]!;
    return {
      settings: {
        isCommunity: row.is_community,
        tagline: row.community_tagline,
        category: row.community_category,
        suspended: row.is_community_suspended,
      },
      previous: {
        isCommunity: previousRow.is_community,
        tagline: previousRow.community_tagline,
        category: previousRow.community_category,
        suspended: previousRow.is_community_suspended,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
