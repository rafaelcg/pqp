package gg.pqp.app.forward

import gg.pqp.app.core.ApiException

/**
 * Why one target did not get the forward (`forwardRefusalReasonSchema`).
 * Deliberately coarse on the server (a block and a privacy setting are both
 * [Unreachable]); an unknown future reason reads as [Unavailable], which says
 * "try again", the safe default.
 */
enum class ForwardRefusal(val wire: String) {
    NoAccess("no_access"),
    CannotSend("cannot_send"),
    BadTarget("bad_target"),
    StaysInServer("stays_in_server"),
    Unreachable("unreachable"),
    SlowMode("slow_mode"),
    RateLimited("rate_limited"),
    Automod("automod"),
    Unavailable("unavailable"),
    ;

    /** A wait is the only refusal worth trying again for without changing anything. */
    val isWait: Boolean get() = this == SlowMode || this == RateLimited

    companion object {
        fun fromWire(token: String?): ForwardRefusal =
            entries.firstOrNull { it.wire == token } ?: Unavailable
    }
}

/** A refused target with the wait the server named, in whole seconds rounded up. */
data class TargetRefusal(val refusal: ForwardRefusal, val waitSeconds: Int?)

/** What a request that never produced results (the whole call failed) means. */
sealed interface ForwardFailure {
    /**
     * Whether the request may have been carried out although no answer arrived:
     * only a failure that is not an answer from the server (a lost connection, a
     * 5xx, a 408). A 4xx is an answer, and nothing went out.
     */
    val mayHaveLanded: Boolean get() = this is Other

    /** 404: the flag went off, or the source is gone or unreadable (one answer on purpose). */
    data object Gone : ForwardFailure

    /** 422 `source_not_forwardable`: a DM or group message, a nudge. */
    data object NotForwardable : ForwardFailure

    /** 422 `source_empty`: nothing to show. */
    data object Empty : ForwardFailure

    /** 429: the route's own burst limit. */
    data object Slow : ForwardFailure

    /** Any other 4xx (a rejected body, an expired session): answered, nothing went out. */
    data class Rejected(val message: String?) : ForwardFailure

    /** A lost connection, a timeout or a 5xx. Worth another try, same nonce. */
    data class Other(val message: String?) : ForwardFailure
}

object ForwardOutcomes {

    fun refusalOf(result: ForwardResult): TargetRefusal {
        val refusal = ForwardRefusal.fromWire(result.reason)
        val wait = result.retryAfterMs?.takeIf { refusal.isWait && it > 0 }
            ?.let { ((it + 999L) / 1_000L).toInt().coerceAtLeast(1) }
        return TargetRefusal(refusal, wait)
    }

    fun failureOf(error: Throwable): ForwardFailure {
        if (error !is ApiException) return ForwardFailure.Other(error.message)
        val said = error.serverMessage.orEmpty()
        return when {
            error.status == 404 -> ForwardFailure.Gone
            error.status == 422 && said.contains("source_empty") -> ForwardFailure.Empty
            error.status == 422 -> ForwardFailure.NotForwardable
            error.status == 429 -> ForwardFailure.Slow
            // Any other 4xx was answered by the server: nothing went out, so the
            // request must not freeze. A 408 is a timeout, not an answer.
            error.status in 400..499 && error.status != 408 -> ForwardFailure.Rejected(error.serverMessage)
            else -> ForwardFailure.Other(error.serverMessage)
        }
    }
}
