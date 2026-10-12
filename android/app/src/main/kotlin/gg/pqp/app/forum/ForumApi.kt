package gg.pqp.app.forum

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.getJson
import gg.pqp.app.social.postJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/*
 * The forum routes (the REST table at the top of `packages/shared/src/forums.ts`),
 * as extensions on [ApiClient] for the reason `SocialApi` gives: the plumbing
 * there is what these need.
 */

/** What the list asks for. Tags are AND; an empty list is no tag filter. */
data class ForumQuery(
    val sort: ForumSort? = null,
    val tagIds: List<String> = emptyList(),
    val status: ForumStatus? = null,
    val mine: Boolean = false,
    val q: String? = null,
    val cursor: String? = null,
    val limit: Int = ForumLimits.PAGE_SIZE,
)

/** The `forum_channels` flag for [serverId]. Off on any failure: that pauses posting, it hides nothing. */
suspend fun ApiClient.forumConfig(serverId: String): ForumConfig =
    getJson("/api/forum/config", mapOf("serverId" to serverId))

/**
 * `GET /api/channels/:forumId/posts`. `tag` repeats, which a map of query
 * parameters cannot say, so the URL is built here rather than by `getJson`.
 */
suspend fun ApiClient.forumPosts(forumId: String, query: ForumQuery): ForumPostListResponse {
    val url = url("/api/channels/$forumId/posts").newBuilder().apply {
        query.sort?.let { addQueryParameter("sort", it.wire) }
        query.tagIds.forEach { addQueryParameter("tag", it) }
        query.status?.let { addQueryParameter("status", it.wire) }
        if (query.mine) addQueryParameter("mine", "true")
        query.q?.trim()?.takeIf { it.isNotEmpty() }?.let { addQueryParameter("q", it.take(ForumLimits.SEARCH_MAX)) }
        query.cursor?.let { addQueryParameter("cursor", it) }
        addQueryParameter("limit", query.limit.toString())
    }.build()
    return decode(execute(Request.Builder().url(url).get()))
}

/** "Posts parecidos" for a title being typed. */
suspend fun ApiClient.similarForumPosts(forumId: String, title: String): List<ForumPostSummary> =
    getJson<SimilarForumPostsResponse>(
        "/api/channels/$forumId/posts/similar",
        mapOf("title" to title.trim().take(ForumLimits.TITLE_MAX)),
    ).posts

suspend fun ApiClient.createForumPost(forumId: String, request: CreateForumPostRequest): CreateForumPostResponse =
    postJson(
        "/api/channels/$forumId/posts",
        PqpJson.encodeToString(CreateForumPostRequest.serializer(), request),
    )

suspend fun ApiClient.forumPost(postId: String): ForumPostDetailResponse =
    getJson("/api/forum-posts/$postId")

suspend fun ApiClient.updateForumPost(postId: String, request: UpdateForumPostRequest): ForumPostSummary =
    patchForum(postId, PqpJson.encodeToJsonElement(UpdateForumPostRequest.serializer(), request) as JsonObject)

/**
 * "Tirar a solução": the one PATCH whose null is a value. [PqpJson] leaves
 * nulls off the wire, which would turn this into an empty body (a 400), so the
 * object is built by hand.
 */
suspend fun ApiClient.clearAcceptedAnswer(postId: String): ForumPostSummary =
    patchForum(postId, buildJsonObject { put("acceptedAnswerId", JsonNull) })

private suspend fun ApiClient.patchForum(postId: String, body: JsonObject): ForumPostSummary {
    val request = Request.Builder()
        .url(url("/api/forum-posts/$postId"))
        .patch(body.toString().toRequestBody(ApiClient.JSON_MEDIA_TYPE))
    return decode<ForumPostResponse>(execute(request)).post
}

suspend fun ApiClient.deleteForumPost(postId: String) {
    execute(Request.Builder().url(url("/api/forum-posts/$postId")).delete()).close()
}

suspend fun ApiClient.setForumPostFollow(postId: String, following: Boolean): ForumPostViewer {
    val request = Request.Builder()
        .url(url("/api/forum-posts/$postId/follow"))
        .put(
            PqpJson.encodeToString(SetForumPostFollowRequest.serializer(), SetForumPostFollowRequest(following))
                .toRequestBody(ApiClient.JSON_MEDIA_TYPE),
        )
    return decode<ForumPostViewerResponse>(execute(request)).viewer
}

suspend fun ApiClient.forumTags(forumId: String): List<ForumTag> =
    getJson<ForumTagsResponse>("/api/channels/$forumId/forum-tags").tags

suspend fun ApiClient.forumSettings(forumId: String): ForumSettings =
    getJson<ForumSettingsResponse>("/api/channels/$forumId/forum-settings").settings

/** The deep link a "Copiar link" hands out, the web's route for the same post. */
fun forumPostLink(baseUrl: String, serverId: String, forumId: String, postId: String): String =
    "${baseUrl.trimEnd('/')}/app/server/$serverId/channel/$forumId/post/$postId"
