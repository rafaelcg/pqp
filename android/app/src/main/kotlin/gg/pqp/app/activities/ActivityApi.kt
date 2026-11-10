package gg.pqp.app.activities

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.getJson
import gg.pqp.app.social.postJson
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/*
 * The apps routes this build uses (`server/src/api/app-routes.ts`), as
 * extensions on [ApiClient] for the reason `SocialApi` gives. Reading the
 * config and the live sessions, starting and ending one, and the consent
 * routes. Joining is a socket frame, not a route (`ActivitySeat`).
 */

/**
 * `GET /api/apps/config?serverId=`. Off on any failure: a server with no
 * activities must look exactly as it did before they existed, so a lookup that
 * did not answer draws nothing rather than a button that may 404. A cancelled
 * lookup is not a failure and is rethrown.
 */
suspend fun ApiClient.activitiesConfig(serverId: String): ActivitiesConfig =
    try {
        getJson("/api/apps/config", mapOf("serverId" to serverId))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        ActivitiesConfig.Off
    }

/** `GET /api/servers/:serverId/app-sessions`: every live session in the channels the caller can VIEW. */
suspend fun ApiClient.serverActivitySessions(serverId: String): List<ChannelSession> =
    getJson<ChannelSessionsResponse>("/api/servers/$serverId/app-sessions").sessions

/** `POST /api/channels/:channelId/app-sessions`: 201 with the summary. Failures are a [StartRefusal]. */
suspend fun ApiClient.startActivity(channelId: String, appId: String): ActivitySession =
    try {
        postJson<ActivitySession>(
            "/api/channels/$channelId/app-sessions",
            PqpJson.encodeToString(StartActivityRequest.serializer(), StartActivityRequest(appId)),
        )
    } catch (e: ApiException) {
        throw StartRefusal.of(e)
    }

/** `POST /api/app-sessions/:sessionId/end`: false when it was already over. */
suspend fun ApiClient.endActivity(sessionId: String): Boolean =
    postJson<EndActivityResponse>("/api/app-sessions/$sessionId/end", "{}").ended

suspend fun ApiClient.activityConsents(): List<ActivityConsent> =
    getJson<ActivityConsentsResponse>("/api/me/app-consents").consents

suspend fun ApiClient.acceptActivity(appId: String, identityGranted: Boolean) {
    postJson<JsonObject>(
        "/api/apps/$appId/consent",
        PqpJson.encodeToString(ConsentRequest.serializer(), ConsentRequest(identityGranted)),
    )
}

/**
 * Why starting an activity did not happen, in the server's own classes
 * (docs/APPS.md, "Sessions"): the launcher says which in a sentence of its own
 * and never shows the raw code.
 */
sealed class StartRefusal(message: String) : Exception(message) {
    /** 409 `session_live`: somebody started one first; [session] is the one that is running. */
    class AlreadyLive(val session: ActivitySession?) : StartRefusal("session_live")

    /** 403 `cannot_start`: this person may not start activities in this channel. */
    object CannotStart : StartRefusal("cannot_start")

    /** 403 `app_unavailable`: a gate failed after the config was read ([reason] is `APP_UNAVAILABLE_REASONS`). */
    class Unavailable(val reason: String?) : StartRefusal("app_unavailable")

    /** 429 `rate_limited`. */
    object RateLimited : StartRefusal("rate_limited")

    /** 404 (the flag went off, the channel is gone, nothing to see) and anything else. */
    class Failed(val status: Int) : StartRefusal("failed")

    companion object {
        fun of(e: ApiException): StartRefusal = when {
            e.status == 409 && e.serverMessage == "session_live" ->
                AlreadyLive(
                    runCatching {
                        e.body?.get("session")?.let { PqpJson.decodeFromJsonElement(ActivitySession.serializer(), it) }
                    }.getOrNull(),
                )
            e.status == 403 && e.serverMessage == "cannot_start" -> CannotStart
            e.status == 403 && e.serverMessage == "app_unavailable" ->
                Unavailable(e.body?.get("reason")?.jsonPrimitive?.contentOrNull)
            e.status == 429 -> RateLimited
            else -> Failed(e.status)
        }
    }
}
