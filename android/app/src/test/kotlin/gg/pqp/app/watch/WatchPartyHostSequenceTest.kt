package gg.pqp.app.watch

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ir ao vivo and Encerrar, as an ordered list of effects rather than a
 * paragraph in a controller. This is the "go-live/end sequencing" the
 * hosting review's test plan asks for: state first, so a failed share never
 * broadcasts silently, and Encerrar always leaves voice even when telling
 * the server the party ended fails.
 */
class WatchPartyHostSequenceTest {

    @Test
    fun `go-live sets state, then joins the room, then starts the capture, in that order`() = runTest {
        val calls = mutableListOf<String>()
        val went = performWatchPartyGoLive(
            setLive = { calls += "setLive"; true },
            joinVoice = { calls += "joinVoice" },
            startScreenShare = { consent: String -> calls += "startScreenShare($consent)" },
            consent = "grant-1",
        )
        assertTrue(went)
        assertEquals(listOf("setLive", "joinVoice", "startScreenShare(grant-1)"), calls)
    }

    @Test
    fun `a refused state transition joins nothing and starts no capture`() = runTest {
        val calls = mutableListOf<String>()
        val went = performWatchPartyGoLive(
            setLive = { calls += "setLive"; false },
            joinVoice = { calls += "joinVoice" },
            startScreenShare = { calls += "startScreenShare" },
            consent = "grant-1",
        )
        assertFalse(went)
        assertEquals(listOf("setLive"), calls)
    }

    @Test
    fun `a setLive that throws is not swallowed here -- the caller decides what that means`() = runTest {
        var threw = false
        try {
            performWatchPartyGoLive<String>(
                setLive = { throw IllegalStateException("network") },
                joinVoice = { fail("must not join after a failed state transition") },
                startScreenShare = { fail("must not share after a failed state transition") },
                consent = "grant-1",
            )
        } catch (e: IllegalStateException) {
            threw = true
        }
        assertTrue(threw)
    }

    @Test
    fun `end tells the server first, then leaves voice, and reports success`() = runTest {
        val calls = mutableListOf<String>()
        val ended = performWatchPartyEnd(
            setEnded = { calls += "setEnded" },
            leaveVoice = { calls += "leaveVoice" },
        )
        assertEquals(listOf("setEnded", "leaveVoice"), calls)
        assertTrue(ended)
    }

    @Test
    fun `end still leaves voice when telling the server the party ended fails, and says so`() = runTest {
        val calls = mutableListOf<String>()
        val ended = performWatchPartyEnd(
            setEnded = { calls += "setEnded"; throw IllegalStateException("network") },
            leaveVoice = { calls += "leaveVoice" },
        )
        assertEquals(listOf("setEnded", "leaveVoice"), calls)
        assertFalse(ended)
    }

    private fun fail(message: String): Nothing = throw AssertionError(message)
}
