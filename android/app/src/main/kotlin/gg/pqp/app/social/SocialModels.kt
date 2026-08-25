package gg.pqp.app.social

import kotlinx.serialization.Serializable

/**
 * The wire shapes for friends, blocks and conversations.
 *
 * They live here rather than in `core/Models.kt` for the same reason the server
 * appended its friends routes as a self-contained section and iOS put them in
 * `SocialAPI.swift`: this feature is additive, and a file nobody else has to
 * open is a file nobody else has to merge.
 *
 * Every one of them is `publicUserSchema` or a narrow extension of it. That is
 * not a saving. A search result and a conversation participant are the two
 * places this product hands a person to somebody they may share nothing with,
 * so the narrow shape is the feature's whole safety story. Nothing wider may be
 * added here even if the server one day sends it.
 */

@Serializable
data class PublicUser(
    val id: String,
    val displayName: String,
    val username: String? = null,
    val tag: String? = null,
    val avatarUrl: String? = null,
)

/**
 * An accepted friend.
 *
 * `status` is the ONE place presence crosses a server boundary in this product,
 * and it can only ever be `online` / `idle` / `dnd` / `offline`: the server
 * resolves `invisible` to `offline` before it is ever written, so an invisible
 * friend arrives as offline by construction. Defaulted to `offline` so an API
 * that stops sending it degrades to "we do not know" rather than to a crash.
 */
@Serializable
data class Friend(
    val id: String,
    val displayName: String,
    val username: String? = null,
    val tag: String? = null,
    val avatarUrl: String? = null,
    val status: String = "offline",
    val friendsSince: String? = null,
) {
    fun asPublicUser(): PublicUser = PublicUser(id, displayName, username, tag, avatarUrl)
}

/**
 * A pending request, incoming or outgoing. Deliberately carries no status: until
 * you accept, the other person is a stranger, and a stranger must not learn
 * whether you are at your keyboard by the act of asking. The server sends none,
 * so there is nothing here to draw.
 */
@Serializable
data class FriendRequestEntry(
    val id: String,
    val displayName: String,
    val username: String? = null,
    val tag: String? = null,
    val avatarUrl: String? = null,
    val requestedAt: String? = null,
) {
    fun asPublicUser(): PublicUser = PublicUser(id, displayName, username, tag, avatarUrl)
}

@Serializable
data class FriendsResponse(
    val friends: List<Friend> = emptyList(),
    val incoming: List<FriendRequestEntry> = emptyList(),
    val outgoing: List<FriendRequestEntry> = emptyList(),
) {
    /** Requests waiting on this account. What the Pending tab's badge counts. */
    val pendingCount: Int get() = incoming.size
}

@Serializable
data class FriendRequestBody(val userId: String)

/**
 * What `POST /api/friends` answers: `pending` or `accepted`. `accepted` covers
 * both "they had already asked you" and "you already were friends", because the
 * caller's next question is only ever "may I show this person as a friend now".
 */
@Serializable
data class FriendRequestResult(val state: String = "pending") {
    val isAccepted: Boolean get() = state == "accepted"
}

@Serializable
data class UnreadCounts(val count: Int = 0, val mentions: Int = 0)

/**
 * One row of the conversation list.
 *
 * `participants` is everybody EXCEPT the viewer, which is a contract of
 * `dmSummarySchema` rather than an accident: a conversation has no name, so the
 * title and the avatars come from this list, and including yourself would put
 * your own face on every 1:1 and make a two-person row look like a three-person
 * one.
 *
 * `lastMessageAt` is null for a conversation nobody has spoken in yet, which is
 * a real state and not an edge case: opening a DM creates the channel before
 * there is anything in it.
 */
@Serializable
data class DmSummary(
    val channelId: String,
    val kind: String = "dm",
    val participants: List<PublicUser> = emptyList(),
    val lastMessageAt: String? = null,
    val unread: UnreadCounts = UnreadCounts(),
) {
    val isGroup: Boolean get() = kind == "group"
}

@Serializable
data class DmListResponse(val conversations: List<DmSummary> = emptyList())

@Serializable
data class DmResponse(val conversation: DmSummary)

@Serializable
data class CreateDmRequest(val userIds: List<String>)

@Serializable
data class UserSearchResponse(val users: List<PublicUser> = emptyList())

@Serializable
data class UserLookupResponse(val user: PublicUser)

@Serializable
data class BlockRequest(val userId: String)

/**
 * Body of `POST /api/channels/:id/read`. Sent empty, which the server reads as
 * "now": naming a timestamp is for a client that knows it has fallen behind,
 * and this one only ever marks a conversation read while looking at it.
 */
@Serializable
class MarkReadRequest

/** The `{ "ok": true }` every mutation here answers with. */
@Serializable
data class OkResponse(val ok: Boolean = true)

/**
 * People in one group conversation, matching the server's `DM_MAX_PARTICIPANTS`
 * and Discord's own cap. The caller is always one of them, so this many others
 * may be named.
 */
const val DM_MAX_RECIPIENTS: Int = 9

/** Below two characters a prefix search matches most of the directory. */
const val USER_SEARCH_MIN_LENGTH: Int = 2
