package gg.pqp.app.push

import gg.pqp.app.core.ApiException
import java.io.IOException

/**
 * Why push could not be switched on, as the person would have to act on it.
 *
 * One bucket used to cover all of these ("the server cannot send to Android
 * yet"), which sent a person with a flaky connection to go and ask the
 * maintainers for a server feature that already existed. Each kind here needs
 * a different thing from a different party, and only one of them (the server
 * has no FCM leg) is permanent.
 */
enum class PushFailure {
    /** The API answered 409: no `FCM_*` credentials. Nothing to retry. */
    ServerNotConfigured,

    /** No route to the API, a timeout, a 5xx. Worth another try, later. */
    Transient,

    /** Android is not letting this app draw notifications. The user's call. */
    PermissionDenied,

    /** No Google Play services on the phone, or none that answers. */
    PlayServicesMissing,

    /** The server looked at the registration and said no. Retrying repeats it. */
    Rejected,
}

/**
 * The pure half of registration failure handling: classification and the
 * backoff schedule, kept free of Android types so a JVM test can pin every
 * branch. [PushController] owns the I/O and the state; this owns the opinions.
 */
object PushFailures {

    /**
     * Classify what `POST /api/push/subscriptions` threw.
     *
     * 409 is the server's "this leg is not configured" (see the route in
     * `server/src/api/index.ts`). 401, 408, 425, 429 and every 5xx are things a
     * later attempt can fix: a Clerk token that expired between the refresh and
     * the call, a rate limit, a deploy in progress. Any other status is the
     * server refusing the request itself, which a retry only repeats. A plain
     * [IOException] is the network.
     */
    fun classifyRegistration(error: Throwable): PushFailure = when (error) {
        is ApiException -> when {
            error.status == 409 -> PushFailure.ServerNotConfigured
            error.status in TRANSIENT_STATUSES || error.status >= 500 -> PushFailure.Transient
            else -> PushFailure.Rejected
        }
        is IOException -> PushFailure.Transient
        else -> PushFailure.Rejected
    }

    /**
     * Classify a failure to obtain an FCM token at all.
     *
     * With Play services absent there is nothing to retry, so that wins. With
     * them present, `FirebaseMessaging.getToken` fails for network reasons
     * (`SERVICE_NOT_AVAILABLE` and friends) far more often than for anything
     * else, and a transient classification costs only a few cheap retries.
     */
    fun classifyToken(@Suppress("UNUSED_PARAMETER") error: Throwable, playServicesPresent: Boolean): PushFailure =
        if (playServicesPresent) PushFailure.Transient else PushFailure.PlayServicesMissing

    /**
     * Wait before retry number [attempt] (0 is the first retry), or null once
     * the schedule is spent. Exhausting it is not terminal: the next launch,
     * sign-in or token rotation starts again from zero.
     */
    fun backoffMillis(attempt: Int): Long? = BACKOFF_MS.getOrNull(attempt)

    private val TRANSIENT_STATUSES = setOf(401, 408, 425, 429)

    private val BACKOFF_MS = longArrayOf(5_000, 15_000, 45_000, 120_000, 300_000).toList()
}
