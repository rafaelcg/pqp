package gg.pqp.app.follow

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.deleteJson
import gg.pqp.app.social.getJson
import gg.pqp.app.social.postJson
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Seguir, as endpoints. Extensions on [ApiClient] like the Baú's and
 * Encaminhar's. Every route answers 404 while the instance's Community Home is
 * off, and the per-source `bau_follow` flag is read server side: the state read
 * answers `enabled: false` and the rest is a 404, except taking a follow down,
 * which always works.
 */

/** Is this Baú followable by the viewer, and what do they follow of it. */
suspend fun ApiClient.bauFollowState(serverId: String): BauFollowState =
    getJson("/api/servers/$serverId/home/follow")

/** Servers of the viewer where they may set a follow up, with channels and roles. */
suspend fun ApiClient.bauFollowDestinations(serverId: String): BauFollowDestinations =
    getJson("/api/servers/$serverId/home/follow/destinations")

suspend fun ApiClient.createBauFollow(serverId: String, request: CreateBauFollowRequest): BauFollow =
    postJson<BauFollowResponse>(
        "/api/servers/$serverId/home/follow",
        PqpJson.encodeToString(CreateBauFollowRequest.serializer(), request),
    ).follow

/** What a text channel follows. 403 for somebody who cannot manage it. */
suspend fun ApiClient.channelBauFollows(channelId: String): List<BauFollow> =
    getJson<ChannelBauFollows>("/api/channels/$channelId/bau-follows").follows

/** Resume a paused follow, or change its ping. */
suspend fun ApiClient.updateBauFollow(followId: String, request: UpdateBauFollowRequest): BauFollow {
    val body = PqpJson.encodeToString(UpdateBauFollowRequest.serializer(), request)
    return decode<BauFollowResponse>(
        execute(
            Request.Builder()
                .url(url("/api/bau-follows/$followId"))
                .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    ).follow
}

suspend fun ApiClient.deleteBauFollow(followId: String) {
    deleteJson<FollowOk>("/api/bau-follows/$followId")
}

/** The source's staff (MANAGE_SERVER): who follows, who is blocked, and the owner's switch. */
suspend fun ApiClient.bauFollowers(serverId: String): BauFollowers =
    getJson("/api/servers/$serverId/home/followers")

/** "Permitir seguir". Answers the same shape as [bauFollowers]. */
suspend fun ApiClient.setBauFollowAllowed(serverId: String, allowed: Boolean): BauFollowers {
    val body = PqpJson.encodeToString(
        UpdateBauFollowConfigRequest.serializer(),
        UpdateBauFollowConfigRequest(allowed),
    )
    return decode<BauFollowers>(
        execute(
            Request.Builder()
                .url(url("/api/servers/$serverId/home/follow-config"))
                .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    )
}

/** Remove a follower; with [block] also refuse its whole server from following again. */
suspend fun ApiClient.removeBauFollower(serverId: String, followId: String, block: Boolean) {
    deleteJson<FollowOk>(
        "/api/servers/$serverId/home/followers/$followId" + if (block) "?block=1" else "",
    )
}

suspend fun ApiClient.unblockBauFollower(serverId: String, blockedServerId: String) {
    deleteJson<FollowOk>("/api/servers/$serverId/home/follow-blocks/$blockedServerId")
}
