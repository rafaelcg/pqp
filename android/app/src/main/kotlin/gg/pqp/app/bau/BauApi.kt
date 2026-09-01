package gg.pqp.app.bau

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.getJson
import gg.pqp.app.social.postJson
import java.util.WeakHashMap

/**
 * The Baú, as endpoints. Extensions on [ApiClient] for the reason `SocialApi`
 * is: the plumbing there is what these need, and none of it has to change.
 *
 * Every `/home/…` route answers 404 while the instance flag is off, so a
 * caller asks [communityHomeConfig] first and never draws the surface on a
 * server that would 404 it.
 */

suspend fun ApiClient.communityHomeConfig(): CommunityHomeConfig =
    getJson("/api/community-home/config")

/** Published posts, newest first, already stripped for this viewer. */
suspend fun ApiClient.bauPosts(serverId: String): List<BauPost> =
    getJson<BauPostsResponse>("/api/servers/$serverId/home/posts").posts

/** Toggle. The response carries the new state; nothing is broadcast. */
suspend fun ApiClient.toggleBauLike(serverId: String, postId: String): BauLikeResponse =
    postJson("/api/servers/$serverId/home/posts/$postId/likes", "{}")

/** The whole list, oldest first, for "see all". The card only carries two. */
suspend fun ApiClient.bauComments(serverId: String, postId: String): List<BauComment> =
    getJson<BauCommentsResponse>("/api/servers/$serverId/home/posts/$postId/comments").comments

suspend fun ApiClient.addBauComment(serverId: String, postId: String, body: String): BauComment =
    postJson<BauCommentResponse>(
        "/api/servers/$serverId/home/posts/$postId/comments",
        PqpJson.encodeToString(CreateBauCommentRequest.serializer(), CreateBauCommentRequest(body)),
    ).comment

/**
 * The instance flag, asked once per session.
 *
 * Memoised the way iOS memoises its feature configs: a flag cannot change
 * while the app is running, and this answer gates a row on every server's
 * channel list, so asking on every open would be a round trip per tap.
 *
 * OFF ON ANY FAILURE, and a 404 is remembered as off: that is what production
 * answers until the Community Home branch is merged, and a client that kept
 * asking would be one useless request per channel list for every person on
 * the app. A transport failure is *not* remembered, so a phone that opened
 * its first server in a tunnel gets the real answer on the next one.
 */
object CommunityHomeConfigs {

    private val cache = WeakHashMap<ApiClient, CommunityHomeConfig>()

    suspend fun resolve(api: ApiClient): CommunityHomeConfig {
        synchronized(cache) { cache[api] }?.let { return it }

        val config = try {
            api.communityHomeConfig()
        } catch (failure: ApiException) {
            if (failure.status == 404) CommunityHomeConfig() else return CommunityHomeConfig()
        } catch (_: Exception) {
            return CommunityHomeConfig()
        }
        synchronized(cache) { cache[api] = config }
        return config
    }

    /** Tests only. */
    internal fun clear() = synchronized(cache) { cache.clear() }
}
