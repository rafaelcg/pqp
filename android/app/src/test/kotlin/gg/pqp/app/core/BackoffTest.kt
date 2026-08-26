package gg.pqp.app.core

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reconnect schedule.
 *
 * Pitfall #9 in `CLAUDE.md` is a hosted deploy where every client dropped at
 * once and came back at once. The jitter is what stops the second half of that,
 * and it is the part nobody notices is missing until a restart.
 *
 * Asserted as ranges rather than as exact values, because the jitter means
 * there is no exact value. The range *is* the contract: `[base, base * 1.5]`,
 * where base doubles per attempt and caps at 30 seconds.
 */
class BackoffTest {

    private fun assertRange(attempt: Int, throttled: Boolean = false, base: Long) {
        val expected = base..(base + base / 2)
        repeat(300) {
            val delay = RealtimeClient.backoffMillis(attempt, throttled)
            assertTrue(
                "attempt $attempt (throttled=$throttled) gave ${delay}ms, outside $expected",
                delay in expected,
            )
        }
    }

    @Test
    fun `the first retry is quick`() {
        assertRange(attempt = 1, base = 500)
    }

    @Test
    fun `each attempt doubles the base`() {
        assertRange(attempt = 1, base = 500)
        assertRange(attempt = 2, base = 1_000)
        assertRange(attempt = 3, base = 2_000)
        assertRange(attempt = 4, base = 4_000)
        assertRange(attempt = 5, base = 8_000)
        assertRange(attempt = 6, base = 16_000)
    }

    /**
     * The shift is clamped at 5, so the base stops doubling before it can
     * overflow the shift on a long outage. Every later attempt sits on the same
     * base, and the whole delay stays under the ceiling the comment promises.
     */
    @Test
    fun `it stops doubling rather than overflowing`() {
        (7..64).forEach { attempt -> assertRange(attempt, base = 16_000) }
        (1..500).forEach { attempt ->
            assertTrue(
                "attempt $attempt escaped the ceiling",
                RealtimeClient.backoffMillis(attempt) <= 30_000L,
            )
        }
    }

    /**
     * A 4429 close is the server saying "slower", so the base starts ten times
     * higher. It reaches the 30 second cap, which plain failures never do.
     */
    @Test
    fun `a 4429 close backs off ten times harder`() {
        assertRange(attempt = 1, throttled = true, base = 5_000)
        assertRange(attempt = 2, throttled = true, base = 10_000)
        assertRange(attempt = 3, throttled = true, base = 20_000)
        assertRange(attempt = 4, throttled = true, base = 30_000)
        assertRange(attempt = 20, throttled = true, base = 30_000)
    }

    /**
     * Without jitter every client dropped by one server restart returns at the
     * same instant and knocks it over again. Three hundred draws coming back
     * identical is the cheapest way to notice it was removed.
     */
    @Test
    fun `the delay is jittered`() {
        val draws = (1..300).map { RealtimeClient.backoffMillis(4) }.toSet()
        assertTrue("Every draw came back identical: the jitter is gone", draws.size > 20)
    }

    /**
     * No attempt number produces a delay short enough to be a spin. A 4401 is a
     * refusal and stops the loop before it reaches here, but a zero here would
     * be a client hammering the server as fast as it can open a socket.
     */
    @Test
    fun `every delay is long enough to be a wait`() {
        (1..500).forEach { attempt ->
            assertTrue(RealtimeClient.backoffMillis(attempt) >= 500L)
            assertTrue(RealtimeClient.backoffMillis(attempt, throttled = true) >= 5_000L)
        }
    }

    /**
     * The 30 second cap is on the base, so the jitter can carry a throttled
     * attempt to 45. Worth stating: 45 seconds is the longest a client will sit
     * silent after a rate limit, and that is the number to quote when somebody
     * asks why the app took so long to come back.
     */
    @Test
    fun `the worst case a rate-limited client waits is forty-five seconds`() {
        val worst = (1..2_000).maxOf { RealtimeClient.backoffMillis(it % 40 + 1, throttled = true) }
        assertTrue("$worst", worst in 30_000L..45_000L)
    }
}
