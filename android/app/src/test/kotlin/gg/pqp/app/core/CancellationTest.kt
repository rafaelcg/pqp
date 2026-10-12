package gg.pqp.app.core

import java.io.IOException
import java.net.UnknownHostException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A cancelled read must never reach the screen as an error, and must never
 * keep running as if it had failed. See `Cancellation.kt`.
 */
class CancellationTest {

    // --- what counts as a cancellation ---

    @Test
    fun `a coroutine cancellation is a cancellation`() {
        assertTrue(CancellationException("StandaloneCoroutine was cancelled").isCancellation())
    }

    @Test
    fun `an OkHttp cancelled call is a cancellation`() {
        assertTrue(IOException("Canceled").isCancellation())
    }

    @Test
    fun `a timeout is a real failure, not a cancellation`() = runTest {
        val timeout = runCatching { withTimeout(1) { awaitCancellation() } }.exceptionOrNull()
        assertTrue(timeout is CancellationException)
        assertFalse(timeout!!.isCancellation())
    }

    @Test
    fun `offline and server failures are not cancellations`() {
        assertFalse(UnknownHostException("api.pqp.gg").isCancellation())
        assertFalse(IOException("unexpected end of stream").isCancellation())
        assertFalse(ApiException(503, "Service unavailable").isCancellation())
        // A server that happened to answer with the word is still the server.
        assertFalse(ApiException(500, "Canceled").isCancellation())
    }

    // --- what a person is shown ---

    @Test
    fun `cancellations show nothing`() {
        assertNull(CancellationException("Job was cancelled").userMessage())
        assertNull(IOException("Canceled").userMessage())
    }

    @Test
    fun `real failures keep their sentence`() {
        assertEquals("Service unavailable", ApiException(503, "Service unavailable").userMessage())
        assertEquals("HTTP 502", ApiException(502, null).userMessage())
        assertEquals("api.pqp.gg", UnknownHostException("api.pqp.gg").userMessage())
    }

    // --- runSuspendCatching ---

    @Test
    fun `failures come back as a Result`() = runTest {
        val result = runSuspendCatching { throw ApiException(500, "boom") }
        assertEquals("boom", (result.exceptionOrNull() as ApiException).serverMessage)
    }

    @Test
    fun `a timeout inside comes back as a failure`() = runTest {
        val result = runSuspendCatching { withTimeout(1) { awaitCancellation() } }
        assertTrue(result.isFailure)
    }

    /**
     * The shape of `SessionStore.restore()`: a second call cancels the first
     * while it waits on the network. With `runCatching` the first one carried
     * on past its own cancellation and wrote "Failed: ...was cancelled" over
     * the second one's work.
     */
    @Test
    fun `a cancelled caller stops instead of reporting a failure`() = runTest {
        val started = CompletableDeferred<Unit>()
        var reported: String? = null
        var ranPastTheRead = false

        val job = launch {
            runSuspendCatching {
                started.complete(Unit)
                awaitCancellation()
            }.onFailure { reported = it.message }
            ranPastTheRead = true
        }
        started.await()
        job.cancel()
        job.join()

        assertNull(reported)
        assertFalse(ranPastTheRead)
        assertTrue(job.isCancelled)
    }

    @Test
    fun `runCatching is the trap this replaces`() = runTest {
        val started = CompletableDeferred<Unit>()
        var reported: String? = null

        val job = launch {
            runCatching {
                started.complete(Unit)
                delay(Long.MAX_VALUE)
            }.onFailure { reported = it.message }
            yield()
        }
        started.await()
        job.cancel()
        job.join()

        // Documented so the next person reaching for runCatching sees why not.
        assertTrue(reported.orEmpty().contains("cancelled", ignoreCase = true))
    }
}
