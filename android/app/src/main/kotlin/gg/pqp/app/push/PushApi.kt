package gg.pqp.app.push

import gg.pqp.app.core.ApiClient
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The three push endpoints, as a thin layer over [ApiClient] rather than as
 * methods on it.
 *
 * Deliberate: `ApiClient` is a file every feature in this app wants to append
 * to at once, and this whole surface can be written against the seams it
 * already exposes publicly (`url`, `execute`, `decode`). Nothing is gained by
 * editing it, and a merge conflict is avoided.
 */
class PushApi(private val api: ApiClient) {

    /**
     * What the server can actually send, and this account's one push setting.
     *
     * `GET /api/push/config` answers `{ enabled, publicKey, apns, dmDetails }`
     * today: `enabled` is the Web Push (VAPID) leg, `apns` the iOS one. There
     * is **no `fcm` member yet**, because there is no FCM leg on the server,
     * see [PushServerConfig.fcm].
     */
    suspend fun config(): PushServerConfig =
        api.decode(api.execute(Request.Builder().url(api.url(PATH_CONFIG)).get()))

    /**
     * Hand this device's FCM registration token to the server.
     *
     * Idempotent by design on the server side, and called on every launch,
     * because FCM rotates a token whenever it feels like it (app restore, data
     * cleared, a long silence) and the old one silently stops working. An app
     * that registers once, on the launch where permission was granted, works
     * until the day it quietly does not.
     */
    suspend fun register(token: String) {
        val body = PqpPushJson.encodeToString(
            FcmRegistration.serializer(),
            FcmRegistration(token = token),
        )
        api.execute(
            Request.Builder()
                .url(api.url(PATH_SUBSCRIPTIONS))
                .post(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ).close()
    }

    /**
     * Turning notifications off, or signing out.
     *
     * The token travels as a query parameter because that is the shape the
     * route already has for the APNs leg, and the server scopes the delete to
     * the caller's own rows so one account cannot unregister another's device.
     */
    suspend fun unregister(token: String) {
        api.execute(
            Request.Builder()
                .url(api.url(PATH_SUBSCRIPTIONS, mapOf("token" to token)))
                .delete(),
        ).close()
    }

    private companion object {
        const val PATH_CONFIG = "/api/push/config"
        const val PATH_SUBSCRIPTIONS = "/api/push/subscriptions"
    }
}

/**
 * The body `POST /api/push/subscriptions` would need for an Android device.
 *
 * THIS SHAPE DOES NOT PARSE ON THE SERVER TODAY. `pushRegistrationSchema` is a
 * union of exactly two members: an APNs body (`platform: "apns"` plus a
 * lowercase-hex token) and a Web Push body (an https endpoint plus ECDH keys).
 * An FCM registration token is neither, it is a long, opaque, mixed-case
 * string containing a `:`, so this request is refused with a 400 until the
 * server grows a third member. [PushController] expects that and treats it as
 * "the server has no FCM leg", not as an error worth showing anybody.
 */
@Serializable
private data class FcmRegistration(
    val platform: String = "fcm",
    val token: String,
)

/**
 * `GET /api/push/config`, decoded leniently.
 *
 * Unknown keys are ignored for the reason the rest of this client ignores them:
 * the API grows fields faster than the Android app models them, and a strict
 * parse turns each new one into a screen that cannot load.
 */
@Serializable
data class PushServerConfig(
    /** The Web Push (VAPID) leg. Irrelevant to a native app. */
    val enabled: Boolean = false,
    /** The APNs leg. Irrelevant here too, but it is what `fcm` will look like. */
    val apns: Boolean = false,
    /**
     * Whether the server can send to Firebase Cloud Messaging.
     *
     * **Absent from the response today**, hence the default. That absence is
     * the gate: with no `fcm` member the app reads false, offers no toggle and
     * asks for no permission, exactly the way the web client stays quiet about
     * analytics when its env var is unset. The day the server adds an FCM leg
     * and answers `fcm: true`, every already-installed build starts offering
     * notifications with no client change.
     */
    val fcm: Boolean = false,
    /** Whether a DM push may name the sender. Server-owned; shown, not decided. */
    @SerialName("dmDetails") val dmDetails: Boolean = false,
)

private val PqpPushJson = kotlinx.serialization.json.Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
}
