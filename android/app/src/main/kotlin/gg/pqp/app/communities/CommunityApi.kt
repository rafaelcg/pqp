package gg.pqp.app.communities

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.getJson
import java.util.WeakHashMap
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** `GET /api/communities/config`: whether this deployment has communities at all. */
suspend fun ApiClient.communitiesConfig(): CommunitiesConfig =
    getJson("/api/communities/config")

/**
 * The server's public state. Manage Server to read, the same bit the web panel
 * is behind; anybody else is answered 403, and with communities off, 404.
 */
suspend fun ApiClient.communitySettings(serverId: String): CommunitySettings =
    getJson<CommunitySettingsResponse>("/api/servers/$serverId/community").community

/** `PATCH /api/servers/:id/community`; answers the settings as they now stand. */
suspend fun ApiClient.updateCommunity(serverId: String, body: UpdateCommunityBody): CommunitySettings {
    val json = PqpJson.encodeToString(UpdateCommunityBody.serializer(), body)
    return decode<CommunitySettingsResponse>(
        execute(
            Request.Builder()
                .url(url("/api/servers/$serverId/community"))
                .patch(json.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    ).community
}

/**
 * The instance flag, asked once per session and remembered, the way
 * `CommunityHomeConfigs` is. OFF ON ANY FAILURE, so a phone that cannot ask
 * draws nothing rather than a switch that can only 404; a transport failure is
 * not remembered, so the next open asks again.
 */
object CommunitiesConfigs {

    private val cache = WeakHashMap<ApiClient, CommunitiesConfig>()

    suspend fun resolve(api: ApiClient): CommunitiesConfig {
        synchronized(cache) { cache[api] }?.let { return it }
        val config = try {
            api.communitiesConfig()
        } catch (failure: ApiException) {
            // A 404 is an older server with no such route: remember it as off.
            if (failure.status == 404) CommunitiesConfig() else return CommunitiesConfig()
        } catch (_: Exception) {
            return CommunitiesConfig()
        }
        synchronized(cache) { cache[api] = config }
        return config
    }
}
