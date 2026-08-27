package gg.pqp.app.social

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The inbox is sorted by comparing ISO strings, so a locally invented timestamp
 * has to be the same *shape* as the server's and cannot be trusted to be the
 * same clock.
 *
 * Both halves are real. `Instant.now().toString()` prints as many fractional
 * digits as the clock has; the server's `toISOString()` always prints three.
 * And a phone running slow stamps a message that just arrived into the middle
 * of the list.
 */
class BumpedTimestampTest {

    private val serverShape = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$""")

    @Test
    fun `the shape matches what the server writes`() {
        val at = SocialRepository.bumpedTimestamp(
            Instant.parse("2026-08-26T10:00:00.500Z"),
            newestKnown = null,
        )
        assertTrue("$at is not the server's shape", serverShape.matches(at))
        assertEquals("2026-08-26T10:00:00.500Z", at)
    }

    @Test
    fun `a whole second still carries three fractional digits`() {
        // `Instant.toString()` drops the fraction entirely here, and
        // "…:00Z" sorts ABOVE "…:00.001Z" lexicographically, which is
        // backwards.
        val at = SocialRepository.bumpedTimestamp(
            Instant.parse("2026-08-26T10:00:00Z"),
            newestKnown = null,
        )
        assertEquals("2026-08-26T10:00:00.000Z", at)
    }

    @Test
    fun `microsecond precision does not sort under a same-millisecond server row`() {
        val server = "2026-08-26T10:00:00.123Z"
        val at = SocialRepository.bumpedTimestamp(
            Instant.parse("2026-08-26T10:00:00.123456Z"),
            newestKnown = server,
        )
        assertTrue("$at must sort above $server", at > server)
    }

    @Test
    fun `a slow phone clock cannot bury a message that just arrived`() {
        // The phone thinks it is ten minutes ago. The row still goes on top.
        val newest = "2026-08-26T10:00:00.000Z"
        val at = SocialRepository.bumpedTimestamp(
            Instant.parse("2026-08-26T09:50:00.000Z"),
            newestKnown = newest,
        )
        assertTrue("$at must sort above $newest", at > newest)
    }

    @Test
    fun `a conversation nobody has spoken in yet is not a floor`() {
        val at = SocialRepository.bumpedTimestamp(
            Instant.parse("2026-08-26T10:00:00.250Z"),
            newestKnown = null,
        )
        assertEquals("2026-08-26T10:00:00.250Z", at)
    }

    @Test
    fun `an unparseable stored value is ignored rather than thrown on`() {
        val at = SocialRepository.bumpedTimestamp(
            Instant.parse("2026-08-26T10:00:00.250Z"),
            newestKnown = "not a timestamp",
        )
        assertEquals("2026-08-26T10:00:00.250Z", at)
    }
}
