package gg.pqp.app.core

import gg.pqp.app.core.RealtimeClient.AttemptOutcome
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a refused connection does to the client, and when it stops being a
 * blip and becomes "sign in again".
 *
 * A 4401 close used to end the reconnect loop for good. That was the
 * "fica conectando" support case: Clerk tokens live about a minute, a phone
 * that was asleep hands over a dead one, the server closes 4401, and the app
 * sat on "Something went wrong" until it was force-closed, when the very next
 * attempt with a fresh token would have succeeded. The web client retries and
 * counts (`client/src/lib/realtime.ts`); this pins that Android now does the
 * same, and that the count behaves.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class UnauthorizedStreakTest {

    // --- the pure rule ---

    @Test
    fun `a refusal counts`() {
        assertEquals(1, RealtimeClient.streakAfter(0, AttemptOutcome.Refused))
        assertEquals(2, RealtimeClient.streakAfter(1, AttemptOutcome.Refused))
    }

    /**
     * A provider with nothing to hand over is the same fact from the other
     * side: no credential the server would take. Clerk answers null while the
     * session is PENDING and after it is gone, and only time tells the two
     * apart, which is what the count is for.
     */
    @Test
    fun `a missing token counts like a refusal`() {
        assertEquals(1, RealtimeClient.streakAfter(0, AttemptOutcome.NoToken))
        assertEquals(3, RealtimeClient.streakAfter(2, AttemptOutcome.NoToken))
    }

    @Test
    fun `the server's ready clears it`() {
        assertEquals(0, RealtimeClient.streakAfter(5, AttemptOutcome.Ready))
    }

    /**
     * A server restart or a tunnel change between two refusals is not
     * evidence the session is fine. If it reset the count, a flaky network
     * could keep a dead session on "reconnecting" forever, one lucky TCP
     * failure at a time.
     */
    @Test
    fun `an ordinary drop leaves it alone`() {
        assertEquals(0, RealtimeClient.streakAfter(0, AttemptOutcome.Dropped))
        assertEquals(1, RealtimeClient.streakAfter(1, AttemptOutcome.Dropped))
    }

    /**
     * One refusal is a stale token, and the next attempt with a fresh one is
     * the fix. Two in a row means the server will not have this session at
     * all. Same threshold as the web's `adviseFrom`.
     */
    @Test
    fun `two refusals in a row is refused for good, one is not`() {
        assertEquals(2, RealtimeClient.REFUSED_FOR_GOOD)
        assertFalse(RealtimeClient.refusedForGood(0))
        assertFalse(RealtimeClient.refusedForGood(1))
        assertTrue(RealtimeClient.refusedForGood(2))
        assertTrue(RealtimeClient.refusedForGood(7))
    }

    /**
     * The part of the old behaviour worth keeping: a refused session is not
     * hammered. 4401 goes on the same slow schedule as 4429, and everything
     * else stays on the quick one, because a server restart wants clients
     * back in half a second, not five.
     */
    @Test
    fun `a refusal is retried on the throttled schedule`() {
        assertTrue(RealtimeClient.throttles(RealtimeClient.CLOSE_UNAUTHORIZED))
        assertTrue(RealtimeClient.throttles(RealtimeClient.CLOSE_RATE_LIMITED))
        assertFalse(RealtimeClient.throttles(1000))
        assertFalse(RealtimeClient.throttles(1006))
        assertFalse(RealtimeClient.throttles(0))
    }

    // --- the loop itself, on the one path that opens no socket ---

    private fun client(scope: kotlinx.coroutines.CoroutineScope, tokens: TokenProvider) =
        RealtimeClient(
            tokens = tokens,
            scope = scope,
            http = OkHttpClient(),
            // Never dialled on this path: a null token bails before the socket.
            url = "ws://127.0.0.1:1/ws",
        )

    /**
     * The regression the whole change is for: a refused attempt no longer
     * ends the loop. With no token to offer, the client says `Refused`, waits
     * the throttled backoff, and tries again, counting as it goes.
     */
    @Test
    fun `a refused attempt keeps retrying instead of stopping`() = runTest {
        val client = client(backgroundScope) { null }
        client.connect()
        runCurrent()

        assertEquals(RealtimeState.Refused, client.state.value)
        assertEquals(1, client.unauthorizedStreak.value)
        assertFalse("one refusal is a stale token, not a dead session", RealtimeClient.refusedForGood(1))

        // The first throttled wait is 5 to 7.5 seconds. Nothing happens
        // before it ends: that is the "not hammered" half of the rule.
        advanceTimeBy(4_999)
        runCurrent()
        assertEquals(1, client.unauthorizedStreak.value)

        advanceTimeBy(2_502)
        runCurrent()
        assertEquals(2, client.unauthorizedStreak.value)
        assertEquals(RealtimeState.Refused, client.state.value)
        assertTrue("two in a row is the banner's cue to offer sign in again", RealtimeClient.refusedForGood(2))

        client.disconnect()
    }

    /** The banner's "Try now" cuts the wait short without waiting it out. */
    @Test
    fun `retryNow skips the backoff`() = runTest {
        val client = client(backgroundScope) { null }
        client.connect()
        runCurrent()
        assertEquals(1, client.unauthorizedStreak.value)

        client.retryNow()
        runCurrent()
        assertEquals(2, client.unauthorizedStreak.value)

        client.disconnect()
    }

    /**
     * Signing out is the fix the streak asks for, so it must not carry the
     * old count into the next account's first connect.
     */
    @Test
    fun `disconnect resets the count`() = runTest {
        val client = client(backgroundScope) { null }
        client.connect()
        runCurrent()
        assertEquals(1, client.unauthorizedStreak.value)

        client.disconnect()
        assertEquals(0, client.unauthorizedStreak.value)
        assertEquals(RealtimeState.Idle, client.state.value)
    }
}
