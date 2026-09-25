package gg.pqp.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The retry contract `IdempotencyAttempt` exists for: a genuine retry of the
 * same attempt (unchanged content) reuses its key, an edited input starts a
 * fresh attempt, and a successful create retires the key so a later,
 * unrelated attempt with the same content never replays an old room. Mirrors
 * `client/src/lib/idempotency.test.ts` on the web client.
 */
class IdempotencyAttemptTest {

    @Test
    fun `createIdempotencyKey returns distinct non-empty ids`() {
        val a = createIdempotencyKey()
        val b = createIdempotencyKey()
        assertTrue(a.isNotEmpty())
        assertTrue(b.isNotEmpty())
        assertNotEquals(a, b)
    }

    @Test
    fun `reuses the same key for unchanged content, a retry of the same attempt`() {
        val attempt = IdempotencyAttempt()
        val first = attempt.keyFor("Sala")
        val second = attempt.keyFor("Sala")
        assertEquals(first, second)
    }

    @Test
    fun `generates a fresh key when the content changes, a new attempt`() {
        val attempt = IdempotencyAttempt()
        val first = attempt.keyFor("Sala")
        val second = attempt.keyFor("Outra sala")
        assertNotEquals(first, second)
    }

    @Test
    fun `starts a new attempt after reset even for the same content`() {
        val attempt = IdempotencyAttempt()
        val first = attempt.keyFor("Sala")
        attempt.reset()
        val second = attempt.keyFor("Sala")
        assertNotEquals(first, second)
    }
}
