package gg.pqp.app.push

import gg.pqp.app.core.ApiException
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The classification that decides what the Notifications row says. Before it
 * existed every failure read "this server cannot send notifications to Android
 * yet", including a phone that was simply offline.
 */
class PushFailureTest {

    private fun http(status: Int) = ApiException(status, "nope")

    @Test
    fun `409 means the server has no FCM leg`() {
        assertEquals(PushFailure.ServerNotConfigured, PushFailures.classifyRegistration(http(409)))
    }

    @Test
    fun `network errors are transient, not a server verdict`() {
        assertEquals(PushFailure.Transient, PushFailures.classifyRegistration(SocketTimeoutException()))
        assertEquals(PushFailure.Transient, PushFailures.classifyRegistration(UnknownHostException("api.pqp.gg")))
        assertEquals(PushFailure.Transient, PushFailures.classifyRegistration(IOException("reset")))
    }

    @Test
    fun `5xx, rate limits and an expired token are transient`() {
        for (status in listOf(500, 502, 503, 504, 429, 408, 425, 401)) {
            assertEquals("status $status", PushFailure.Transient, PushFailures.classifyRegistration(http(status)))
        }
    }

    @Test
    fun `other 4xx are the server refusing the request and are not retried`() {
        for (status in listOf(400, 403, 404, 413, 422)) {
            assertEquals("status $status", PushFailure.Rejected, PushFailures.classifyRegistration(http(status)))
        }
    }

    @Test
    fun `an unexpected exception is not mistaken for the network`() {
        assertEquals(PushFailure.Rejected, PushFailures.classifyRegistration(IllegalStateException("bad json")))
    }

    @Test
    fun `no token and no Play services is its own reason`() {
        assertEquals(
            PushFailure.PlayServicesMissing,
            PushFailures.classifyToken(IOException("SERVICE_NOT_AVAILABLE"), playServicesPresent = false),
        )
    }

    @Test
    fun `no token with Play services present is retried`() {
        assertEquals(
            PushFailure.Transient,
            PushFailures.classifyToken(IOException("SERVICE_NOT_AVAILABLE"), playServicesPresent = true),
        )
    }

    @Test
    fun `backoff grows, then runs out`() {
        val waits = generateSequence(0) { it + 1 }
            .map { PushFailures.backoffMillis(it) }
            .takeWhile { it != null }
            .map { it!! }
            .toList()
        assertTrue("some retries", waits.isNotEmpty())
        assertEquals(waits.sorted(), waits)
        assertTrue("first retry is not instant", waits.first() >= 1_000)
        assertTrue("never waits longer than ten minutes", waits.last() <= 600_000)
        assertNull(PushFailures.backoffMillis(waits.size))
        assertNotNull(PushFailures.backoffMillis(0))
    }
}
