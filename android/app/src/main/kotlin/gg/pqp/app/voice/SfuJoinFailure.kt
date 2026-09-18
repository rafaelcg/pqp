package gg.pqp.app.voice

import gg.pqp.app.core.ApiException
import java.io.IOException
import kotlin.random.Random
import kotlinx.coroutines.TimeoutCancellationException

/**
 * Why the LiveKit leg of a join did not happen.
 *
 * ## The failure this exists for
 *
 * Every way an SFU join can go wrong used to arrive at the same sentence:
 * "Não foi possível conectar ao servidor de voz desta chamada." One string for
 * a token the server refused, a room the server says is peer-to-peer, a media
 * box nothing can reach, and a handshake that simply ran out of time. Those are
 * four different problems with four different owners, and on a phone with no
 * logs attached they were indistinguishable from each other and from "the
 * wifi is bad".
 *
 * `POST /api/voice/token` alone can answer 403 (unknown or mismatched voice
 * peer), 404 (channel not found, which is also what a ban looks like), 409
 * (this room runs peer-to-peer), 429 (the per-user write bucket), 502 (the
 * mint itself failed) and 503 (no SFU configured, or the permission read
 * failed). `Room.connect` can then fail on the signalling socket, on TLS, or
 * by never completing ICE inside livekit-android's own 20 s ceiling. All of it
 * reached the person as one sentence and reached logcat as one `Log.w` with no
 * status code in it.
 *
 * ## Why a separate file
 *
 * Nothing here touches `android.util.Log`, `Room`, or any Android type, so all
 * of it runs in `android/app/src/test`. The classification and the retry rule
 * are the two things that decide whether somebody is told the truth and
 * whether a transient failure gets a second chance, and both are exactly the
 * kind of `when` that is written once and never read again.
 */
enum class SfuFailureKind {
    /**
     * `POST /api/voice/token` said no: 400, 401, 403, 404, 429.
     *
     * The seat, the account or the channel is the problem, not the network.
     * Retrying the same request in the same second changes nothing, with the
     * one exception of 429, which is a bucket that refills.
     */
    TokenRefused,

    /**
     * The server says this room is not on LiveKit at all (409).
     *
     * A disagreement about state rather than a failure: the room's pin is not
     * visible to the instance that served the HTTP request, or the room was
     * unpinned between `welcome` and the mint. Never answered by building a
     * mesh instead, for the reason in [LiveKitEngine]'s header: the transport
     * is the server's to pin and a mesh peer in an SFU room is a name on the
     * roster nobody can hear.
     */
    TransportMismatch,

    /**
     * Nothing answered, or the media leg never came up: an IO failure, a 5xx,
     * a refused TLS handshake, a `Room.connect` that threw.
     *
     * The only class worth retrying on its own, and the only one where "try
     * again in a moment" is honest advice.
     */
    Unreachable,

    /** The whole attempt ran past [LiveKitEngine]'s own deadline. */
    TimedOut,
}

/**
 * One classified failure, with enough in it to write a log line somebody can
 * act on without a debugger.
 *
 * [detail] is deliberately the server's own sentence or the exception's own
 * class and message, never a rewrite: only the server knows whether a 404 was
 * a deleted channel or a ban, and only the SDK knows whether a connect died on
 * DNS, on TLS or on ICE.
 */
data class SfuFailure(
    val kind: SfuFailureKind,
    val detail: String,
    /** The HTTP status, when the failure came from the token mint. */
    val status: Int? = null,
) {
    /**
     * Whether trying the same thing again in a moment could plausibly work.
     *
     * A refusal is not retried, because a phone that retries a refusal in a
     * loop cannot be told to stop and the person is left watching "Conectando"
     * for the whole budget instead of being told what happened. 429 is the
     * exception: the bucket refills, and `writeLimiter` is capacity 30 refilling
     * at 2/s, so one backoff clears it.
     */
    val retryable: Boolean
        get() = when (kind) {
            SfuFailureKind.TokenRefused -> status == HTTP_TOO_MANY_REQUESTS
            SfuFailureKind.TransportMismatch -> false
            SfuFailureKind.Unreachable -> true
            SfuFailureKind.TimedOut -> false
        }

    /**
     * One line, one shape, every field always present.
     *
     * Fixed order and `key=value` on purpose: this is the line Rafael is asked
     * to `adb logcat` out of a phone that has just failed, and a line whose
     * fields move around is a line nobody can grep. A missing value is `-`
     * rather than absent, so the field count never changes.
     */
    fun logLine(channelId: String?, peerId: String?, attempt: Int): String =
        "sfu-join-failed kind=${kind.name} status=${status ?: "-"} attempt=$attempt " +
            "channel=${channelId ?: "-"} peer=${peerId ?: "-"} detail=$detail"

    companion object {
        const val HTTP_TOO_MANY_REQUESTS = 429
    }
}

/**
 * What went wrong, from the throwable that said so.
 *
 * [ApiException] is checked before [IOException] and that ordering is
 * load-bearing rather than stylistic: `ApiException` *is* an `IOException`
 * (`ApiClient.kt`), so the other order would classify every refusal the server
 * ever wrote as an unreachable network and retry all of them.
 */
fun classifySfuFailure(error: Throwable): SfuFailure = when (error) {
    is TimeoutCancellationException ->
        SfuFailure(SfuFailureKind.TimedOut, "the SFU join did not finish inside its deadline")

    is ApiException -> tokenFailure(error)

    // `LiveKitEngine`'s own "no voice channel to mint a token for", which is
    // this client losing track of the call rather than anything the server did.
    is IllegalStateException ->
        SfuFailure(SfuFailureKind.TokenRefused, describe(error))

    is IOException -> SfuFailure(SfuFailureKind.Unreachable, describe(error))

    // Everything livekit-android throws out of `Room.connect`:
    // `RoomException.ConnectException` for a refused join and for ICE that
    // never completed inside its 20 s ceiling, and whatever the signalling
    // socket raises underneath it.
    else -> SfuFailure(SfuFailureKind.Unreachable, describe(error))
}

private fun tokenFailure(error: ApiException): SfuFailure {
    val kind = when {
        error.status == HTTP_CONFLICT -> SfuFailureKind.TransportMismatch
        error.status >= HTTP_SERVER_ERROR -> SfuFailureKind.Unreachable
        else -> SfuFailureKind.TokenRefused
    }
    return SfuFailure(kind, error.serverMessage ?: "no message", error.status)
}

private fun describe(error: Throwable): String =
    "${error::class.java.simpleName}: ${error.message ?: "no message"}"

private const val HTTP_CONFLICT = 409
private const val HTTP_SERVER_ERROR = 500

/**
 * How many times the media leg is attempted before the person is told.
 *
 * Three, and bounded twice: by this count and by [LiveKitEngine]'s single
 * deadline over the whole sequence, so the worst case is still one sentence
 * after the same wait the web and iOS clients allow. Neither of those retries
 * at all; a phone is the client that most often fails on the first packet of a
 * handshake and succeeds on the second, which is the whole argument for the
 * difference.
 */
const val SFU_CONNECT_ATTEMPTS = 3

/**
 * How long to wait before attempt `attempt + 1`, or 0 when there is no next
 * attempt.
 *
 * **Jittered, and for the reason `reconnect-jitter.ts` exists on the web.** The
 * failure this retry is most useful against is an SFU or a token endpoint that
 * has just started failing, which is exactly the moment every phone in every
 * room is retrying at once. A fixed 800 ms and 2400 ms would put all of them on
 * the same two instants and roughly triple the load on something already
 * unhealthy, which is how a retry prolongs an outage instead of surviving one.
 * Half to one and a half times the schedule spreads them across a second and a
 * half without changing the ceiling that matters.
 *
 * [jitter] is a parameter rather than a call to [Random] inside, so the two
 * ends of the range can be pinned by a test; nothing but a test passes it.
 */
fun sfuRetryDelayMs(attempt: Int, jitter: Double = Random.nextDouble()): Long {
    if (attempt < 1 || attempt >= SFU_CONNECT_ATTEMPTS) return 0L
    var delay = SFU_RETRY_BASE_MS
    repeat(attempt - 1) { delay *= SFU_RETRY_FACTOR }
    val spread = SFU_RETRY_JITTER_FLOOR + jitter.coerceIn(0.0, 1.0)
    return (delay * spread).toLong()
}

private const val SFU_RETRY_BASE_MS = 800L
private const val SFU_RETRY_FACTOR = 3L

/** Half the scheduled wait is the floor; the jitter adds up to one more. */
private const val SFU_RETRY_JITTER_FLOOR = 0.5

/**
 * Which sentence the person sees, per failure class.
 *
 * Pure, and separate from the composable that shows it, so the mapping can be
 * held to "every kind has its own sentence" by a test. A `when` that quietly
 * collapsed two kinds onto one string would put this whole change back where it
 * started.
 */
fun refusalFor(kind: SfuFailureKind): Refusal = when (kind) {
    SfuFailureKind.TokenRefused -> Refusal.VoiceTokenRefused
    SfuFailureKind.TransportMismatch -> Refusal.VoiceTransportMismatch
    SfuFailureKind.Unreachable -> Refusal.VoiceBackendUnreachable
    SfuFailureKind.TimedOut -> Refusal.VoiceBackendTimedOut
}
