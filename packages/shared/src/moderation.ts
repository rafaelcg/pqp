import { z } from "zod";
import { type MemberRole } from "./api.js";

/**
 * WHO MAY DO WHAT TO WHOM — the rank rule, as one pure function both clients
 * ask before drawing a single moderation control.
 *
 * The server already owns this decision: `requireOutranked` in
 * `server/src/api/index.ts` refuses kick, ban, timeout, disconnect, move and
 * mute against the owner, and refuses an admin acting on a peer. That check is
 * the authority and stays the authority — nothing here can grant anything.
 *
 * WHY IT ALSO LIVES HERE. A UI that offers an action the server will refuse is
 * worse than a UI that omits it: the moderator taps, waits, and reads a 403 in
 * the middle of the situation they were trying to handle. Both clients had
 * therefore already grown their own copy of the rule, and the two disagreed —
 * the web members panel implemented it (`canModerate`) while the iOS one gated
 * on "not the owner, not me" alone, so an iOS admin was shown Kick against
 * another admin and got the 403 every time. One function, one set of tests, and
 * the two clients can no longer drift.
 *
 * It is deliberately about RANK ONLY. Whether the actor is even a manager, and
 * whether the target is present in the room being acted on, are separate
 * questions that the callers already answer with their own data.
 */

/** The actions the rank rule governs — the same six `requireOutranked` names. */
export const MODERATION_ACTIONS = [
  "kick",
  "ban",
  "timeout",
  "disconnect",
  "move",
  "mute",
] as const;

export const moderationActionSchema = z.enum(MODERATION_ACTIONS);
export type ModerationAction = z.infer<typeof moderationActionSchema>;

/** Who is acting, and on whom. Ids so "is this me" is answerable here. */
export interface ModerationSubjects {
  actorRole: MemberRole;
  actorId: string | null;
  /** The target's role in this server, or null when they are not a member. */
  targetRole: MemberRole | null;
  targetId: string;
}

/**
 * Whether a moderation control should be drawn at all.
 *
 * Four refusals, in the order the server applies them:
 *
 * 1. **Only managers moderate.** A plain member sees none of this, which is the
 *    invariant the new author-surface menus turn into a test: the same popover
 *    that offers an owner a timeout must offer a member nothing.
 * 2. **Never yourself.** The server answers 400 "use leave instead"; offering
 *    it would be a button whose only outcome is a scolding.
 * 3. **Never the owner.** Nobody outranks them, including themselves.
 * 4. **An admin may not act on an admin.** Only the owner may, or a 28-day
 *    timeout becomes the way one admin deposes a peer.
 *
 * `targetRole === null` — somebody who is not a member of this server — is
 * allowed through, because a pre-emptive ban of a non-member is a real
 * capability (`POST /api/servers/:id/bans` takes any existing user). Callers
 * that need presence, like a voice disconnect, check that themselves.
 */
export function canModerateMember(
  action: ModerationAction,
  { actorRole, actorId, targetRole, targetId }: ModerationSubjects,
): boolean {
  void action; // Every action shares one rule today; named so a divergence has a home.
  if (actorRole !== "owner" && actorRole !== "admin") {
    return false;
  }
  if (actorId && actorId === targetId) {
    return false;
  }
  if (targetRole === "owner") {
    return false;
  }
  if (targetRole === "admin" && actorRole !== "owner") {
    return false;
  }
  return true;
}

/**
 * The subset of `MODERATION_ACTIONS` an actor may aim at a target. Handed to a
 * menu builder so the menu is a projection of the rule rather than a list of
 * `if`s beside it.
 */
export function allowedModerationActions(
  subjects: ModerationSubjects,
): ModerationAction[] {
  return MODERATION_ACTIONS.filter((action) =>
    canModerateMember(action, subjects),
  );
}

/**
 * Whether this actor may delete somebody else's message, or pin in a server
 * channel. Both are `canManageServer` on the server — a flat manager check with
 * no rank rule, because a message is not a person: an admin removing an owner's
 * post is a moderator doing their job, not a coup.
 *
 * Here because iOS had it wrong in both directions at once — Delete was gated
 * on "is it mine", so an owner could not remove anything, while Pin was gated
 * on nothing, so a plain member was offered a button that always 403'd.
 */
export function canManageMessages(actorRole: MemberRole | null): boolean {
  return actorRole === "owner" || actorRole === "admin";
}
