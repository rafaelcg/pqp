package gg.pqp.app.follow

import gg.pqp.app.core.ApiException
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Test

/** The status-and-sentence table the web keeps in `bauFollowErrorKey`, with the server's real sentences. */
class FollowOutcomeTest {

    private fun refused(status: Int, said: String?) = ApiException(status, said)

    @Test
    fun `429 is slow down`() {
        assertEquals(FollowFailure.Slow, FollowFailures.ofCreate(refused(429, "Too many requests")))
    }

    @Test
    fun `403 tells a blocked server from a channel you cannot manage`() {
        assertEquals(
            FollowFailure.Blocked,
            FollowFailures.ofCreate(refused(403, "This Baú does not accept that server")),
        )
        assertEquals(
            FollowFailure.Forbidden,
            FollowFailures.ofCreate(refused(403, "You need to manage webhooks or channels in that channel")),
        )
        assertEquals(FollowFailure.Forbidden, FollowFailures.ofCreate(refused(403, null)))
    }

    @Test
    fun `409 tells the cap from a duplicate`() {
        assertEquals(
            FollowFailure.Limit,
            FollowFailures.ofCreate(refused(409, "A server can follow at most 20 Baús")),
        )
        assertEquals(
            FollowFailure.Exists,
            FollowFailures.ofCreate(refused(409, "That channel already follows this Baú")),
        )
    }

    @Test
    fun `404 means the Bau no longer accepts follows and 400 a bad role`() {
        assertEquals(FollowFailure.Unavailable, FollowFailures.ofCreate(refused(404, "Not found")))
        assertEquals(FollowFailure.Invalid, FollowFailures.ofCreate(refused(400, "That role cannot be pinged")))
    }

    @Test
    fun `anything else, and a lost connection, is generic`() {
        assertEquals(FollowFailure.Generic, FollowFailures.ofCreate(refused(500, "boom")))
        assertEquals(FollowFailure.Generic, FollowFailures.ofCreate(IOException("offline")))
    }

    @Test
    fun `a change to an existing follow is one sentence, bar the rate limit`() {
        assertEquals(FollowFailure.Action, FollowFailures.ofAction(refused(404, "Follow not found")))
        assertEquals(FollowFailure.Action, FollowFailures.ofAction(IOException("offline")))
        assertEquals(FollowFailure.Slow, FollowFailures.ofAction(refused(429, null)))
    }
}
