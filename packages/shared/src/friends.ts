import { z } from "zod";
import { publicUserSchema } from "./api.js";
import { userStatusSchema } from "./status.js";

/**
 * Friends: the wire contract for the first *mutual* relationship in this
 * product.
 *
 * Everything else here is either one-directional (a block) or mediated by a
 * server (membership). A friendship is different: both people said yes, and
 * that consent is what a few other features key off — a friend may DM you past
 * a `server_members` privacy setting, and a friend sees your status without
 * sharing a server with you.
 *
 * THE MODEL IS ONE ROW PER UNORDERED PAIR, with a state and a direction —
 * never two mirrored rows. Mirrored rows invite the classic split-brain: one
 * half accepted, the other declined, and now the answer to "are these two
 * friends" depends on who is asking.
 *
 * SEMANTICS (Discord's, deliberately):
 * - A request to somebody whose request to *you* is already pending accepts it.
 *   Both people asked; there is nothing left to confirm.
 * - Declining is silent. The sender is never notified and never told apart
 *   from "still pending" by any push — their outgoing entry simply no longer
 *   appears. Anything louder makes declining socially expensive, and people
 *   who find declining expensive stop declining.
 * - Re-requesting after a decline is allowed. The defence against somebody
 *   abusing that is a rate limit plus a block — not a permanent tombstone that
 *   would turn one mis-click of "decline" into an unfixable state.
 * - A block kills the relationship in every state, both directions, silently.
 */

/** Body of `POST /api/friends`. */
export const friendRequestSchema = z.object({
  userId: z.string().uuid(),
});

export type FriendRequest = z.infer<typeof friendRequestSchema>;

/**
 * What `POST /api/friends` answers. `accepted` covers both the auto-accept
 * (they had already asked you) and "you were already friends" — the caller's
 * next question is only ever "may I show this person as a friend now".
 */
export const friendRequestResultSchema = z.object({
  state: z.enum(["pending", "accepted"]),
});

export type FriendRequestResult = z.infer<typeof friendRequestResultSchema>;

/**
 * An accepted friend. This is the ONE place presence crosses a server
 * boundary, and the type is the guard: `userStatusSchema` cannot carry
 * `invisible`, so an invisible friend arrives as `offline` by construction —
 * the same guarantee the members panel gets.
 */
export const friendSchema = publicUserSchema.extend({
  status: userStatusSchema,
  friendsSince: z.string(),
});

export type Friend = z.infer<typeof friendSchema>;

/**
 * A pending request, incoming or outgoing. Deliberately `publicUserSchema`
 * plus a timestamp and NOTHING more — above all no status. Until you accept,
 * the other person is a stranger, and a stranger must not learn whether you
 * are at your keyboard by the act of asking.
 */
export const friendRequestEntrySchema = publicUserSchema.extend({
  requestedAt: z.string(),
});

export type FriendRequestEntry = z.infer<typeof friendRequestEntrySchema>;

/** `GET /api/friends`: the whole relationship surface in one read. */
export const friendsResponseSchema = z.object({
  friends: z.array(friendSchema),
  incoming: z.array(friendRequestEntrySchema),
  outgoing: z.array(friendRequestEntrySchema),
});

export type FriendsResponse = z.infer<typeof friendsResponseSchema>;

/**
 * "Something changed about your friendships — read them again."
 *
 * WHY THIS EXISTS. Until now there was no friend frame on the socket at all, so
 * a request reached the person it was aimed at only when they next fetched: on
 * a reload, or on the friends view's 15s poll, which runs only while that view
 * is the thing on screen. Somebody sitting in a channel — which is where people
 * sit — could be stared at by a pending request indefinitely and see nothing.
 * That is not a cadence problem to tune; it is a missing edge, and one frame is
 * the whole of it.
 *
 * CONTENT-FREE, ON PURPOSE. It names nobody and carries no list. The recipient
 * re-reads `GET /api/friends`, which is a single bounded query they were
 * entitled to make anyway, so this frame discloses *nothing they could not
 * already ask for* — the property that lets it be added without re-arguing any
 * of the privacy positions above. `channel-activity` makes the same trade for
 * the same reason.
 *
 * WHEN IT IS SENT — and, much more importantly, when it is NOT:
 *
 * - `request`: a NEW pending row now exists, delivered to the person who was
 *   asked. Re-sending an already-pending request does not send it, exactly as
 *   re-sending does not touch `created_at`: if resending rang a bell, resending
 *   would be a way to keep ringing one.
 * - `accepted`: the handshake completed, delivered to the person who asked
 *   first. They consented to hearing about this by asking.
 * - `depoimento`: something changed in the depoimento relationship between two
 *   FRIENDS — one of them wrote you one (delivered to the subject, whose queue
 *   just grew) or the subject published yours (delivered to the author, whose
 *   words are now public and who is entitled to know that). It rides this frame
 *   rather than getting its own because the recipient's answer is identical:
 *   re-read the two bounded lists you were already entitled to read. See
 *   `packages/shared/src/depoimentos.ts`.
 *
 * NOTHING is sent for a decline, a cancel, an unfriend, or a block — nor for a
 * REFUSED or REMOVED depoimento, which is the same rule one step further in and
 * matters more there. Refusing a depoimento deletes it, and a frame announcing
 * that would hand the author the one signal the deletion exists to deny them:
 * "they read it and said no". Those are silent by design — see the note at the
 * top of this file — and a frame is exactly the kind of "louder" this product
 * decided against. A client that refetches on a nudge and sees a name gone
 * learned it only because it was already looking.
 */
export const friendActivitySchema = z.object({
  type: z.literal("friend-activity"),
  kind: z.enum(["request", "accepted", "depoimento"]),
});

export type FriendActivity = z.infer<typeof friendActivitySchema>;

/**
 * The nudge a `POST /api/friends` outcome earns, if any — the send route's four
 * results mapped to the one decision that matters, as a pure function so the
 * "resending is not a bell" rule is pinned by a test rather than by a comment
 * beside an `if`.
 *
 * Returns who to nudge relative to the actor: `target` for a fresh request,
 * `target` again for an auto-accept (they asked first, so they are the one
 * waiting to hear), and `null` for the two outcomes where nothing changed.
 */
export function friendNudgeFor(
  result: "pending" | "accepted" | "already-friends" | "already-pending",
): FriendActivity["kind"] | null {
  switch (result) {
    case "pending":
      return "request";
    case "accepted":
      return "accepted";
    // Nothing changed, so nothing to hear about. `already-pending` in
    // particular MUST stay silent.
    case "already-friends":
    case "already-pending":
      return null;
  }
}

/**
 * How many un-answered outgoing requests one account may have standing.
 *
 * This is the durable half of the abuse story (the API adds a token bucket on
 * top): every pending request is a contact made with a stranger, so the cap
 * bounds how many strangers one account can have knocked on, however slowly it
 * knocked. Counted in the database, so it survives restarts and replicas.
 * Discord's cap is in the same range; nobody with a real social graph hits it.
 */
export const FRIEND_MAX_OUTGOING_PENDING = 100;
