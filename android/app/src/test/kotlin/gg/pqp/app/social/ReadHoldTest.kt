package gg.pqp.app.social

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `GET /api/dms` counts unread from the read cursor, so a snapshot requested
 * before `POST /api/channels/:id/read` landed still carries the old count.
 * Applying it puts the badge back on the conversation somebody is reading,
 * which is the one place a stale badge is guaranteed to be noticed.
 */
class ReadHoldTest {

    @Test
    fun `a read still in flight always wins`() {
        assertTrue(
            SocialRepository.readHoldApplies(
                snapshotStartedAt = 5_000,
                settledAt = null,
                inFlight = true,
            ),
        )
    }

    @Test
    fun `a snapshot older than the read is not applied`() {
        assertTrue(
            SocialRepository.readHoldApplies(
                snapshotStartedAt = 4_000,
                settledAt = 4_500,
                inFlight = false,
            ),
        )
    }

    @Test
    fun `a snapshot started after the read settled is trusted again`() {
        // This is what releases the hold: no timer, no set to remember to
        // empty. The server is then right to put a badge back, because a badge
        // it reports now is about something that arrived after the read.
        assertFalse(
            SocialRepository.readHoldApplies(
                snapshotStartedAt = 5_000,
                settledAt = 4_500,
                inFlight = false,
            ),
        )
    }

    @Test
    fun `a conversation never read is never held`() {
        assertFalse(
            SocialRepository.readHoldApplies(
                snapshotStartedAt = 5_000,
                settledAt = null,
                inFlight = false,
            ),
        )
    }
}
