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
 * How many un-answered outgoing requests one account may have standing.
 *
 * This is the durable half of the abuse story (the API adds a token bucket on
 * top): every pending request is a contact made with a stranger, so the cap
 * bounds how many strangers one account can have knocked on, however slowly it
 * knocked. Counted in the database, so it survives restarts and replicas.
 * Discord's cap is in the same range; nobody with a real social graph hits it.
 */
export const FRIEND_MAX_OUTGOING_PENDING = 100;
