package gg.pqp.app.social

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Friends, blocks and conversations, as endpoints.
 *
 * Extensions on `ApiClient` rather than methods inside it: the plumbing there
 * (a fresh token per request, the cancellable call, the `{"error": …}` body
 * turned into an `ApiException`) is what these need, and none of it has to
 * change for them. That also keeps the whole feature out of a file three
 * parallel branches are editing.
 */

// --- friends ---------------------------------------------------------------

/**
 * The whole relationship surface in one read: friends with their status,
 * requests waiting on you, requests you have standing.
 */
suspend fun ApiClient.friends(): FriendsResponse = getJson("/api/friends")

/**
 * Send a request, by user id. The id can only have come from the exact
 * `name#1234` lookup or the budgeted prefix search, which is why friends add no
 * discovery surface of their own.
 *
 * Every refusal answers with one sentence on purpose. "You blocked them" and
 * "they blocked you" read identically, because telling them apart would make
 * this route an oracle for whether a specific person has blocked you. Show the
 * server's wording; never guess a friendlier one.
 */
suspend fun ApiClient.sendFriendRequest(userId: String): FriendRequestResult =
    postJson("/api/friends", PqpJson.encodeToString(FriendRequestBody.serializer(), FriendRequestBody(userId)))

/** Accept a request somebody sent us. 404 when none is waiting, which is what a stale list looks like. */
suspend fun ApiClient.acceptFriendRequest(userId: String): OkResponse =
    postJson("/api/friends/$userId/accept", "{}")

/**
 * Decline, cancel, or unfriend. ONE call, because the server models all three
 * as "make this row not exist" and their differences are entirely in who is
 * looking. All three are silent to the other side, which is the social contract
 * that makes declining cheap enough that people actually do it.
 */
suspend fun ApiClient.removeFriendship(userId: String): OkResponse =
    deleteJson("/api/friends/$userId")

// --- blocks ----------------------------------------------------------------

/**
 * Block somebody. No separate unfriend call belongs beside this: the database
 * trigger deletes the friendship itself, in both directions, and issuing both
 * would race it.
 */
suspend fun ApiClient.blockUser(userId: String): OkResponse =
    postJson("/api/blocks", PqpJson.encodeToString(BlockRequest.serializer(), BlockRequest(userId)))

// --- discovery -------------------------------------------------------------

/** Prefix search over handles. Excludes the caller server-side. */
suspend fun ApiClient.searchUsers(query: String): List<PublicUser> =
    getJson<UserSearchResponse>("/api/users/search", mapOf("q" to query)).users

/**
 * Exact `name#1234` lookup: the half of discovery that is not enumerable. It
 * exists because prefix search is the tightest-budgeted endpoint on the server,
 * and somebody who already knows a full tag should not have to go fishing.
 */
suspend fun ApiClient.lookupUser(tag: String): PublicUser =
    getJson<UserLookupResponse>("/api/users/lookup", mapOf("tag" to tag)).user

// --- conversations ---------------------------------------------------------

suspend fun ApiClient.conversations(): List<DmSummary> =
    getJson<DmListResponse>("/api/dms").conversations

/**
 * Open a conversation, or get back the one that already exists. One id opens a
 * 1:1, more than one opens a group.
 *
 * The 1:1 case is idempotent server-side through `dm_pairs`, and reopening is
 * what brings the history back rather than starting a second empty thread
 * beside it. A group is always created new: there is no canonical identity for
 * a set of people, so two taps do make two groups, and that is deliberate.
 *
 * A refusal is usually a privacy setting or a block, and the server's own
 * wording is the only honest thing to show.
 */
suspend fun ApiClient.openConversation(userIds: List<String>): DmSummary =
    postJson<DmResponse>(
        "/api/dms",
        PqpJson.encodeToString(CreateDmRequest.serializer(), CreateDmRequest(userIds)),
    ).conversation

/**
 * Close a conversation. Hide, never delete: only this account's own membership
 * row goes, and the channel, its history and the other participant are
 * untouched.
 *
 * A 1:1 therefore comes back the moment either side says anything in it: the
 * server restores both participants before it writes the message. That is why
 * the client must treat activity in a conversation it has never heard of as
 * "re-read the list", not as a frame to drop. See `SocialRepository`.
 */
suspend fun ApiClient.closeConversation(channelId: String): OkResponse =
    deleteJson("/api/dms/$channelId")

/**
 * Move this account's read cursor in a channel to now, which is what clears an
 * unread badge. Sent for a conversation the moment it is opened.
 */
suspend fun ApiClient.markChannelRead(channelId: String): OkResponse =
    postJson("/api/channels/$channelId/read", "{}")

// --- plumbing --------------------------------------------------------------
//
// `ApiClient`'s own `get`/`post` helpers are private, and widening them would
// be an edit to a file two other branches are also touching. These three are
// the same three lines each, built out of the parts that are already public.

@PublishedApi
internal suspend inline fun <reified T> ApiClient.getJson(
    path: String,
    query: Map<String, String> = emptyMap(),
): T = decode(execute(Request.Builder().url(url(path, query)).get()))

@PublishedApi
internal suspend inline fun <reified T> ApiClient.postJson(path: String, body: String): T =
    decode(
        execute(
            Request.Builder()
                .url(url(path))
                .post(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    )

@PublishedApi
internal suspend inline fun <reified T> ApiClient.deleteJson(path: String): T =
    decode(execute(Request.Builder().url(url(path)).delete()))
