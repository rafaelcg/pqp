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
    /** 404: the flag went off, or the source is gone or unreadable (one answer on purpose). */
    data object Gone : ForwardFailure

    /** 422 `source_not_forwardable`: a DM or group message, a nudge. */
    data object NotForwardable : ForwardFailure

    /** 422 `source_empty`: nothing to show. */
    data object Empty : ForwardFailure

    /** 429: the route's own burst limit. */
    data object Slow : ForwardFailure

    /** Anything else, including a lost connection. Worth another try, same nonce. */
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
            else -> ForwardFailure.Other(error.serverMessage)
        }
    }
}
