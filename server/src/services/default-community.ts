import { getPool } from "../db.js";
import { findCommunityIdBySlug, joinCommunity } from "./communities.js";

/**
 * Put a brand new account somewhere with people in it.
 *
 * THE PROBLEM THIS SOLVES. A new account currently lands in an empty app and is
 * asked to name a community before it has seen one. That is a blank page as a
 * first impression, and the two ways out of it both assume the person already
 * has a group: create a room for people who are not here yet, or paste an
 * invite from a friend who already uses the product. Somebody who arrived from
 * a link and wanted to look around has neither.
 *
 * WHAT IT DOES NOT DO. It does not replace the create step. Onboarding still
 * offers "make your own", and it should: the default community is a floor, not
 * a destination. It only stops that from being the *only* door.
 *
 * FOUR RULES, and each one exists to stop a specific way an auto-join becomes
 * obnoxious:
 *
 *  1. **Configured, never hardcoded.** `DEFAULT_COMMUNITY_SLUG` is unset by
 *     default, so a self-hosted instance does not silently inherit pqp.gg's
 *     community. Unset means the whole feature is off, not that it falls back
 *     to something.
 *  2. **Only an account with no memberships at all.** Somebody who already has
 *     communities has already answered the question this is asking.
 *  3. **Only once, ever**, recorded in preferences rather than derived from
 *     membership. Deriving it from "are they in it" would put them back every
 *     time they left, which is the worst version of this feature.
 *  4. **Every failure is silent.** A missing slug, a suspended community, a
 *     community that is not listed, a database hiccup: none of them are worth
 *     failing a sign-in over. The person gets the app they would have got
 *     anyway.
 */

/** Unset means off. There is deliberately no default value. */
export function defaultCommunitySlug(): string | null {
  const raw = process.env.DEFAULT_COMMUNITY_SLUG?.trim();
  return raw ? raw : null;
}

async function hasAnyMembership(userId: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM server_members WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

async function alreadyPlaced(userId: string): Promise<boolean> {
  const result = await getPool().query<{ placed: boolean }>(
    `SELECT (settings ? 'defaultCommunityJoinedAt') AS placed
       FROM user_preferences WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]?.placed === true;
}

/**
 * Stamp the preference.
 *
 * Written ONLY after a join actually succeeded. The first version stamped on
 * failure too, reasoning that one attempt was enough; its own test showed why
 * that is wrong. An account that signs up while the community is missing or
 * suspended would be marked as "placed" and could never be placed again, even
 * once the community came back. Retrying is two indexed queries, and only for
 * accounts that still have no memberships at all, so the cost of getting this
 * the other way round is nothing.
 */
async function markPlaced(userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO user_preferences (user_id, settings)
     VALUES ($1, jsonb_build_object('defaultCommunityJoinedAt', to_jsonb(now())))
     ON CONFLICT (user_id) DO UPDATE
       SET settings = user_preferences.settings
                    || jsonb_build_object('defaultCommunityJoinedAt', to_jsonb(now()))`,
    [userId],
  );
}

export type PlacementResult =
  | { placed: false; reason: "disabled" | "has-servers" | "already" | "unavailable" }
  | { placed: true; serverId: string };

/**
 * Run the placement for one account. Safe to call on every bootstrap.
 *
 * Returns a reason rather than throwing, so the caller can log at debug level
 * and carry on. Nothing here is allowed to be the thing that stops somebody
 * signing in.
 */
export async function placeInDefaultCommunity(
  userId: string,
): Promise<PlacementResult> {
  const slug = defaultCommunitySlug();
  if (!slug) {
    return { placed: false, reason: "disabled" };
  }
  if (await alreadyPlaced(userId)) {
    return { placed: false, reason: "already" };
  }
  if (await hasAnyMembership(userId)) {
    // Not stamped: an account that already had communities never needed this,
    // and stamping it would be recording a decision that was never made.
    return { placed: false, reason: "has-servers" };
  }

  const serverId = await findCommunityIdBySlug(slug);
  if (!serverId) {
    // Not stamped. Missing, unlisted or suspended are all temporary states of
    // the community rather than facts about this person, and stamping here
    // would lock them out of a placement that starts working tomorrow.
    return { placed: false, reason: "unavailable" };
  }

  // `joinCommunity` is the same path the directory uses, so a suspended or
  // unlisted community refuses here exactly as it would there. Reusing it also
  // means the member count, the system join message and the roster all behave
  // the way they do for a normal join, rather than this inventing a second way
  // to become a member.
  const result = await joinCommunity(serverId, userId);
  if (!result.ok) {
    return { placed: false, reason: "unavailable" };
  }
  await markPlaced(userId);
  return { placed: true, serverId };
}
