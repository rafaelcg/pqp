import {
  DEPOIMENTOS_PER_DAY,
  PROFILE_COMMUNITY_LIMIT,
  type Depoimento,
  type ProfileCommunity,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { noBlockBetweenSql } from "./blocks.js";
import { areFriendsSql } from "./friends.js";
import { toPublicUserSummary } from "./users.js";

/**
 * Depoimentos: writing, publishing, and the two reads.
 *
 * The wire contract and the cultural argument are in
 * `packages/shared/src/depoimentos.ts`; the storage invariants and both
 * triggers are on the `depoimentos` table in schema.sql. What this file owns is
 * the enforcement, and there are four rules:
 *
 * - ONLY FRIENDS WRITE, checked with `areFriendsSql` verbatim — the same
 *   fragment the DM privacy check uses, so "friend" means one thing on this
 *   instance. The predicate rides INSIDE the INSERT rather than being asked
 *   first, so an unfriend (or a block, which deletes the friendship through its
 *   own trigger) landing mid-request cannot be raced.
 *
 * - ONLY THE SUBJECT PUBLISHES. `subject_id = $actor` is on the UPDATE, which
 *   is why an author cannot publish their own words from a second session.
 *
 * - REFUSING DELETES. There is no `reject` verb here at all: refusing, taking
 *   an approved one down, and the author withdrawing theirs are one DELETE with
 *   one predicate, differing only in who is asking. That is deliberate — the
 *   whole "Não aceita!" mitigation is that nothing refused is KEPT, and a
 *   distinct "rejected" path is exactly where a graveyard would grow.
 *
 * - A REFUSAL IS NOT AN ORACLE. `DepoimentoRefusedError` carries a reason for
 *   the log and the route's branching, but the route answers every refusal with
 *   one sentence — the deal `FriendRequestRefusedError` and `DmRefusedError`
 *   both make. Probing this endpoint must not report who has blocked you.
 *
 * A CHARACTER NEITHER WRITES NOR RECEIVES. Same shape as the friendship
 * refusal: characters are accounts you cannot relate to, and the friends gate
 * already makes both directions unreachable in practice. It is restated here
 * because "the fictional stranger left a testimonial on my profile" is a
 * promise the product makes and a config file cannot keep.
 */

export type DepoimentoRefusalReason =
  | "self"
  | "not-friends"
  | "character"
  | "blocked";

/** Why a depoimento could not be written. Never reaches the response body. */
export class DepoimentoRefusedError extends Error {
  constructor(readonly reason: DepoimentoRefusalReason) {
    super("Cannot write a depoimento for this user");
    this.name = "DepoimentoRefusedError";
  }
}

/** Too many written today — the durable cap, counted in Postgres. */
export class DepoimentoFloodError extends Error {
  constructor(readonly limit: number) {
    super(`You can write ${limit} depoimentos a day.`);
    this.name = "DepoimentoFloodError";
  }
}

interface DepoimentoRow {
  id: string;
  body: string;
  created_at: Date;
  approved_at: Date | null;
  author_id: string;
  display_name: string;
  username: string | null;
  discriminator: string | null;
  avatar_url: string | null;
}

function toDepoimento(row: DepoimentoRow): Depoimento {
  return {
    id: row.id,
    author: toPublicUserSummary({ ...row, id: row.author_id }),
    body: row.body,
    createdAt: row.created_at.toISOString(),
    approvedAt: row.approved_at?.toISOString() ?? null,
  };
}

/** The join every read shares: the row, plus its author as a public user. */
const DEPOIMENTO_SELECT = `d.id, d.body, d.created_at, d.approved_at,
    u.id AS author_id, u.display_name, u.username, u.discriminator, u.avatar_url
  FROM depoimentos d
  JOIN users u ON u.id = d.author_id`;

interface WriteOptions {
  /** Test seam for the daily cap; production callers never pass it. */
  maxPerDay?: number;
}

/**
 * Write (or replace) the one depoimento this author has standing about this
 * subject. Always lands PENDING — including when it replaces an approved one,
 * which is the same thing the author could have done by withdrawing and
 * rewriting, so refusing would only add an error to a possible sequence.
 *
 * Returns the stored depoimento. A lost race — the friendship ending between
 * the guard and the INSERT — comes back as the same `not-friends` refusal the
 * guard would have raised, because that is what is now true.
 */
export async function writeDepoimento(
  authorId: string,
  subjectId: string,
  body: string,
  options: WriteOptions = {},
): Promise<Depoimento> {
  if (authorId === subjectId) {
    // The table's CHECK would refuse this too, but as a 500.
    throw new DepoimentoRefusedError("self");
  }

  /**
   * Characters and blocks, asked first so the reason is knowable for the log.
   * Neither is trusted to stay true — the INSERT re-asks the friendship, and a
   * block deletes the friendship through its own trigger, so a block landing
   * after this read still loses at the INSERT.
   */
  const guard = await getPool().query<{
    any_character: boolean;
    no_block: boolean;
    is_friend: boolean;
  }>(
    `SELECT (SELECT bool_or(COALESCE(is_character, FALSE)) FROM users
              WHERE id = ANY(ARRAY[$1::uuid, $2::uuid])) AS any_character,
            ${noBlockBetweenSql("$1::uuid", "$2::uuid")} AS no_block,
            ${areFriendsSql("$1::uuid", "$2::uuid")} AS is_friend`,
    [authorId, subjectId],
  );
  const row = guard.rows[0];
  if (row?.any_character) {
    throw new DepoimentoRefusedError("character");
  }
  if (!row?.no_block) {
    throw new DepoimentoRefusedError("blocked");
  }
  if (!row.is_friend) {
    throw new DepoimentoRefusedError("not-friends");
  }

  /**
   * The durable cap: how many people may have something standing from you,
   * written in the last day.
   *
   * IT IS A COUNT OF ROWS, AND IT CANNOT BE ANYTHING ELSE. A cap that survived
   * deletion would need a log of depoimentos that no longer exist — which is
   * precisely the graveyard this feature refuses to keep, and refuses for a
   * reason that outweighs a tighter rate limit. So refusing one does hand its
   * author that slot back, and a rewrite of the same person's spends nothing
   * extra: what the cap bounds is BREADTH, ten people a day, which is the
   * shape "papering the instance" would have to take. Depth against ONE person
   * — write, they refuse, write again — is bounded by `depoimentoLimiter` in
   * the route instead, and by that person's block button.
   *
   * THE TARGET'S OWN ROW IS EXCLUDED FROM THE COUNT, which is what makes the
   * cap "ten OTHER people" and a rewrite genuinely free. Counting it would mean
   * an author who has spent the day's budget cannot fix a typo in something
   * they already wrote — a refusal with no safety value at all, since the row
   * it would protect is one that already exists.
   */
  const cap = options.maxPerDay ?? DEPOIMENTOS_PER_DAY;
  const written = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM depoimentos
      WHERE author_id = $1 AND subject_id <> $2
        AND created_at > NOW() - INTERVAL '1 day'`,
    [authorId, subjectId],
  );
  if (Number(written.rows[0]?.count ?? 0) >= cap) {
    throw new DepoimentoFloodError(cap);
  }

  /**
   * The friendship predicate rides inside the INSERT: between the guard above
   * and here, the friendship may have ended (an unfriend, or a block whose
   * trigger swept the row). Re-asking in the same statement means Postgres
   * serialises the question rather than this process guessing at it.
   *
   * ON CONFLICT is what "one standing depoimento per pair" means in practice —
   * and it resets `approved_at`, so replacing an approved one returns it to the
   * subject's queue rather than quietly editing what is already on their card.
   */
  const inserted = await getPool().query<DepoimentoRow>(
    `WITH upserted AS (
       INSERT INTO depoimentos (author_id, subject_id, body)
       SELECT $1, $2, $3
       WHERE ${areFriendsSql("$1::uuid", "$2::uuid")}
       ON CONFLICT (author_id, subject_id) DO UPDATE
         SET body = EXCLUDED.body, created_at = NOW(), approved_at = NULL
       RETURNING id, body, created_at, approved_at, author_id
     )
     SELECT d.id, d.body, d.created_at, d.approved_at,
            u.id AS author_id, u.display_name, u.username, u.discriminator,
            u.avatar_url
       FROM upserted d JOIN users u ON u.id = d.author_id`,
    [authorId, subjectId, body],
  );
  const created = inserted.rows[0];
  if (!created) {
    throw new DepoimentoRefusedError("not-friends");
  }
  return toDepoimento(created);
}

/**
 * Publish one. Only the subject may, and only something still pending —
 * `approved_at IS NULL` makes a double tap idempotent rather than re-stamping
 * the publication date and jumping the thing back to the top of the profile.
 *
 * Returns the author's id when it published, so the route knows who to nudge,
 * and null when there was nothing to publish (already published, refused a
 * moment ago, or never addressed to this caller — all one 404, because telling
 * them apart would report on a row they may not be entitled to know about).
 */
export async function approveDepoimento(
  subjectId: string,
  depoimentoId: string,
): Promise<string | null> {
  const result = await getPool().query<{ author_id: string }>(
    `UPDATE depoimentos SET approved_at = NOW()
      WHERE id = $1 AND subject_id = $2 AND approved_at IS NULL
      RETURNING author_id`,
    [depoimentoId, subjectId],
  );
  return result.rows[0]?.author_id ?? null;
}

/**
 * Make it not exist: the subject refusing a pending one, the subject taking a
 * published one down months later, or the author withdrawing theirs. ONE
 * operation on purpose — all three are "delete this row", their differences are
 * entirely in who is asking, and all three are silent to the other side.
 *
 * The silence is not politeness here, it is the mitigation. A notification on
 * refusal would tell the author "they read it and said no", which is the one
 * fact deleting the row exists to withhold, and it would make refusing socially
 * expensive in a feature whose entire safety rests on refusing being cheap.
 */
export async function deleteDepoimento(
  actorId: string,
  depoimentoId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM depoimentos
      WHERE id = $1 AND (subject_id = $2 OR author_id = $2)`,
    [depoimentoId, actorId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * A profile's published depoimentos, newest published first — "o top" is
 * whoever the subject approved most recently, which is the ordering Orkut users
 * competed over and the reason it is `approved_at DESC` and not `created_at`.
 *
 * VISIBILITY MATCHES THE PROFILE CARD'S. The card opens on people you share a
 * server with or are friends with, so that is the audience here: the same pair
 * of predicates `assertReachable` uses for DM privacy, plus the block check.
 * Nothing wider — this must not become a way to read a stranger's profile — and
 * nothing narrower, or a depoimento would be less visible than the person's
 * name in the members list beside it.
 *
 * A blocked pair sees nothing of each other's, in both directions. The rows
 * are gone anyway (the block trigger deletes any between the two), but the
 * predicate also covers depoimentos written by a THIRD party: somebody you
 * blocked cannot read your profile's depoimentos through this route.
 */
export async function listApprovedDepoimentos(
  viewerId: string,
  subjectId: string,
): Promise<Depoimento[]> {
  if (viewerId !== subjectId) {
    const visible = await getPool().query<{ visible: boolean }>(
      `SELECT ${noBlockBetweenSql("$1::uuid", "$2::uuid")}
              AND (${areFriendsSql("$1::uuid", "$2::uuid")}
                   OR EXISTS (
                     SELECT 1 FROM server_members mine
                     JOIN server_members theirs
                       ON theirs.server_id = mine.server_id
                      AND theirs.user_id = $2
                     WHERE mine.user_id = $1
                   )) AS visible`,
      [viewerId, subjectId],
    );
    if (!visible.rows[0]?.visible) {
      return [];
    }
  }

  const result = await getPool().query<DepoimentoRow>(
    `SELECT ${DEPOIMENTO_SELECT}
      WHERE d.subject_id = $1 AND d.approved_at IS NOT NULL
        AND ${noBlockBetweenSql("d.author_id", "$2::uuid")}
      ORDER BY d.approved_at DESC, d.id DESC`,
    [subjectId, viewerId],
  );
  return result.rows.map(toDepoimento);
}

/**
 * The subject's own queue: everything waiting on them, OLDEST FIRST.
 *
 * The opposite order to the profile, and deliberately. This is a to-do list,
 * and the thing somebody has been waiting longest to hear about should be the
 * one you answer first — newest-first would bury a patient friend under a
 * chatty one. §05's risk note also lands here: the inbox shows the AUTHOR
 * before the text, so nobody is ambushed by a paragraph from a name they were
 * not ready to read.
 */
export async function listPendingDepoimentos(
  subjectId: string,
): Promise<Depoimento[]> {
  const result = await getPool().query<DepoimentoRow>(
    `SELECT ${DEPOIMENTO_SELECT}
      WHERE d.subject_id = $1 AND d.approved_at IS NULL
      ORDER BY d.created_at ASC, d.id ASC`,
    [subjectId],
  );
  return result.rows.map(toDepoimento);
}

// -------------------------------------------- community badges on a profile

export interface ProfileCommunityBadges {
  communities: ProfileCommunity[];
  total: number;
}

/**
 * The community chips on somebody's card.
 *
 * FOUR THINGS ARE FILTERED, and each one is a different promise:
 *
 * - `is_community` — a private server is never advertised on anybody's profile.
 *   This is the one that matters: it means turning the switch off on the
 *   directory turns this off too, and that no membership anyone believed was
 *   private can leak through a profile card.
 * - `NOT is_community_suspended` — the operator's kill switch reaches here for
 *   free. A listing they pull stops appearing on every profile at once, with no
 *   per-member fan-out and nothing to remember to also do.
 * - `show_on_profile` — this member's own opt-out, per membership.
 * - the viewer's ban — a community that banned you is not shown to you, matching
 *   `LISTED_SQL` in communities.ts.
 *
 * ORDERED BY SIZE, like the directory itself, so the chips a stranger reads
 * first are the rooms they are most likely to recognise. `id` closes the order
 * so the same six chips come back on every read.
 *
 * `total` counts every qualifying membership, not just the six returned, which
 * is what lets the card render "+N" without a second request.
 */
export async function listProfileCommunities(
  viewerId: string,
  subjectId: string,
): Promise<ProfileCommunityBadges> {
  const result = await getPool().query<{
    id: string;
    name: string;
    total: string;
  }>(
    `SELECT s.id, s.name, COUNT(*) OVER ()::text AS total
       FROM server_members sm
       JOIN servers s ON s.id = sm.server_id
      WHERE sm.user_id = $2
        AND sm.show_on_profile
        AND s.is_community
        AND NOT s.is_community_suspended
        AND NOT EXISTS (
          SELECT 1 FROM server_bans b
           WHERE b.server_id = s.id AND b.user_id = $1
        )
      ORDER BY s.member_count DESC, s.id DESC
      LIMIT $3`,
    [viewerId, subjectId, PROFILE_COMMUNITY_LIMIT],
  );
  return {
    communities: result.rows.map((row) => ({ id: row.id, name: row.name })),
    // The window count rides on every row and is identical across them; zero
    // rows means zero memberships, which is the only case it is missing from.
    total: Number(result.rows[0]?.total ?? 0),
  };
}

/**
 * Flip one membership's badge opt-out. Returns false when the caller is not in
 * that server, so the route can 404 rather than silently succeeding at nothing.
 *
 * Deliberately allowed on a NON-community membership too. The column is inert
 * there today, but refusing would mean a member who opts a server out has that
 * choice quietly forgotten if the owner later lists it — which is the one
 * direction this switch must never fail in.
 */
export async function setProfileVisibility(
  userId: string,
  serverId: string,
  showOnProfile: boolean,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE server_members SET show_on_profile = $3
      WHERE user_id = $1 AND server_id = $2`,
    [userId, serverId, showOnProfile],
  );
  return (result.rowCount ?? 0) > 0;
}
