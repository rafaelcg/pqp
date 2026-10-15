package gg.pqp.app.forward

import gg.pqp.app.core.ApiException
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a refused target, a failed call and the config flag each mean to the sheet. */
class ForwardOutcomeTest {

    private fun refused(reason: String?, retryAfterMs: Long? = null) =
        ForwardResult(ok = false, target = ForwardTargetRef(channelId = "c"), reason = reason, retryAfterMs = retryAfterMs)

    @Test
    fun `every reason the server names maps to itself`() {
        val wire = listOf(
            "no_access", "cannot_send", "bad_target", "stays_in_server", "unreachable",
            "slow_mode", "rate_limited", "automod", "unavailable",
        )
        assertEquals(wire, wire.map { ForwardOutcomes.refusalOf(refused(it)).refusal.wire })
    }

    @Test
    fun `a reason from the future reads as try again`() {
        assertEquals(ForwardRefusal.Unavailable, ForwardOutcomes.refusalOf(refused("brand_new")).refusal)
        assertEquals(ForwardRefusal.Unavailable, ForwardOutcomes.refusalOf(refused(null)).refusal)
    }

    @Test
    fun `a wait is rounded up to whole seconds and only for the two waits`() {
        assertEquals(2, ForwardOutcomes.refusalOf(refused("slow_mode", 1200)).waitSeconds)
        assertEquals(1, ForwardOutcomes.refusalOf(refused("rate_limited", 1)).waitSeconds)
        assertEquals(5, ForwardOutcomes.refusalOf(refused("rate_limited", 5000)).waitSeconds)
        assertNull(ForwardOutcomes.refusalOf(refused("slow_mode", 0)).waitSeconds)
        assertNull(ForwardOutcomes.refusalOf(refused("slow_mode", null)).waitSeconds)
        assertNull(ForwardOutcomes.refusalOf(refused("automod", 3000)).waitSeconds)
    }

    @Test
    fun `only slow mode and the rate limit are waits`() {
        assertTrue(ForwardRefusal.SlowMode.isWait)
        assertTrue(ForwardRefusal.RateLimited.isWait)
        assertFalse(ForwardRefusal.NoAccess.isWait)
        assertFalse(ForwardRefusal.StaysInServer.isWait)
    }

    @Test
    fun `a failed call is read from its status and its words`() {
        assertEquals(ForwardFailure.Gone, ForwardOutcomes.failureOf(ApiException(404, "Not found")))
        assertEquals(ForwardFailure.NotForwardable, ForwardOutcomes.failureOf(ApiException(422, "source_not_forwardable")))
        assertEquals(ForwardFailure.Empty, ForwardOutcomes.failureOf(ApiException(422, "source_empty")))
        assertEquals(ForwardFailure.Slow, ForwardOutcomes.failureOf(ApiException(429, "Slow down")))
        assertTrue(ForwardOutcomes.failureOf(ApiException(500, "boom")) is ForwardFailure.Other)
        assertTrue(ForwardOutcomes.failureOf(IOException("offline")) is ForwardFailure.Other)
    }

    // ---- the flag

    @Test
    fun `the flag is read, kept for a minute and then read again`() = runTest {
        ForwardConfigs.clear()
        val api = gg.pqp.app.core.ApiClient(gg.pqp.app.core.TokenProvider { null })
        var clock = 1_000L
        var calls = 0
        var enabled = true
        val fetch: suspend () -> ForwardConfig = { calls += 1; ForwardConfig(enabled) }

        assertTrue(ForwardConfigs.enabled(api, { clock }, fetch))
        assertTrue(ForwardConfigs.enabled(api, { clock + 30_000 }, fetch))
        assertEquals(1, calls)

        // An operator turned it off: the phone follows within the minute.
        enabled = false
        clock += ForwardConfigs.TTL_MS
        assertFalse(ForwardConfigs.enabled(api, { clock }, fetch))
        assertEquals(2, calls)
    }

    @Test
    fun `a 404 is off, remembered as an answer`() = runTest {
        ForwardConfigs.clear()
        val api = gg.pqp.app.core.ApiClient(gg.pqp.app.core.TokenProvider { null })
        var calls = 0
        val fetch: suspend () -> ForwardConfig = { calls += 1; throw ApiException(404, "Not found") }
        assertFalse(ForwardConfigs.enabled(api, { 0L }, fetch))
        assertFalse(ForwardConfigs.enabled(api, { 1_000L }, fetch))
        assertEquals(1, calls)
    }

    @Test
    fun `a failure is off but never remembered`() = runTest {
        ForwardConfigs.clear()
        val api = gg.pqp.app.core.ApiClient(gg.pqp.app.core.TokenProvider { null })
        var calls = 0
        val fetch: suspend () -> ForwardConfig = { calls += 1; throw IOException("tunnel") }
        assertFalse(ForwardConfigs.enabled(api, { 0L }, fetch))
        assertFalse(ForwardConfigs.enabled(api, { 1L }, fetch))
        assertEquals(2, calls)
    }
}
