package gg.pqp.app.core

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException

/*
 * Cancellation is never an error a person should read.
 *
 * `runCatching` catches `CancellationException` like any other throwable, so a
 * read whose coroutine was cancelled (a screen leaving, a keystroke restarting
 * a search, a second `restore()` replacing the first) came back as a failure
 * and its `message` went on screen: "StandaloneCoroutine was cancelled", "The
 * coroutine scope left the composition", or OkHttp's "Canceled". Worse, the
 * code after the swallowed cancellation kept running and wrote state for work
 * that was no longer wanted. `PqpApp`'s push routing documents the same trap.
 *
 * A timeout is NOT a cancellation here. `TimeoutCancellationException` extends
 * `CancellationException` for coroutine plumbing reasons, but to a person it
 * is "the server did not answer", which is exactly the failure they should be
 * told about.
 */

/**
 * True when this throwable only says the work was called off: a coroutine's
 * own cancellation, or the `IOException("Canceled")` OkHttp throws for a call
 * that was cancelled.
 */
fun Throwable.isCancellation(): Boolean = when (this) {
    is TimeoutCancellationException -> false
    is CancellationException -> true
    is IOException -> this !is ApiException && message == OKHTTP_CANCELED
    else -> false
}

/**
 * What to show for this failure, or null when there is nothing to show.
 * Real failures keep the sentence they had: the server's own words for an
 * [ApiException], the exception's message for anything else.
 */
fun Throwable.userMessage(): String? {
    if (isCancellation()) return null
    return (this as? ApiException)?.serverMessage ?: message
}

/**
 * `runCatching` for suspending work: a failure is a [Result], a cancellation
 * is rethrown so the coroutine actually stops. Timeouts stay failures.
 *
 * OkHttp's `IOException("Canceled")` is rethrown as a [CancellationException]
 * too, so a call cancelled underneath this coroutine stops it the same way
 * rather than running the caller's failure handler.
 */
inline fun <T> runSuspendCatching(block: () -> T): Result<T> = try {
    Result.success(block())
} catch (timeout: TimeoutCancellationException) {
    Result.failure(timeout)
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: Throwable) {
    if (error.isCancellation()) throw CancellationException(error.message, error)
    Result.failure(error)
}

/** The message OkHttp's `RealCall` gives a cancelled call. */
private const val OKHTTP_CANCELED = "Canceled"
