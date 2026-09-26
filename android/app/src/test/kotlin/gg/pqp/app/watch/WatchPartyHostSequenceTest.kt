package gg.pqp.app.watch

import kotlinx.coroutines.CancellationException
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
 *
 * The go-live cases below are what a coordinator review of the first cut
 * added, on top of Farol's original 5: an ambiguous `setLive` failure (the
 * response lost or thrown after the server already committed) must not be
 * read as a plain refusal, and a `joinVoice` failure on an already-live
 * party must not be read as success.
 */
class WatchPartyHostSequenceTest {

    @Test
    fun `go-live sets state, joins the room, mutes the mic, then starts the capture, in that order`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            setLive = { calls += "setLive"; true },
            checkLive = { fail("must not re-check a setLive that did not throw") },
            joinVoice = { calls += "joinVoice" },
            muteMicrophone = { calls += "muteMicrophone" },
            endParty = { fail("must not end a party that was never joined-and-failed") },
            startScreenShare = { consent: String -> calls += "startScreenShare($consent)" },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Live, result)
        assertEquals(listOf("setLive", "joinVoice", "muteMicrophone", "startScreenShare(grant-1)"), calls)
    }

    @Test
    fun `a clean refusal (no throw) joins nothing, mutes nothing, starts no capture, and is never re-checked`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            setLive = { calls += "setLive"; false },
            checkLive = { fail("a clean `false` is unambiguous -- checkLive must not run") },
            joinVoice = { calls += "joinVoice" },
            muteMicrophone = { fail("nothing was joined -- there is no mic to silence") },
            endParty = { fail("nothing to end -- the party never went live") },
            startScreenShare = { calls += "startScreenShare" },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Refused, result)
        assertEquals(listOf("setLive"), calls)
    }

    // ---------------------------------------- an ambiguous `setLive` failure

    @Test
    fun `setLive throwing is re-checked, and a confirmed-live party still goes live`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            setLive = { calls += "setLive"; throw IllegalStateException("timeout") },
            checkLive = { calls += "checkLive"; true },
            joinVoice = { calls += "joinVoice" },
            muteMicrophone = { calls += "muteMicrophone" },
            endParty = { fail("the party is live and was joined -- nothing to end") },
            startScreenShare = { consent: String -> calls += "startScreenShare($consent)" },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Live, result)
        assertEquals(
            listOf("setLive", "checkLive", "joinVoice", "muteMicrophone", "startScreenShare(grant-1)"),
            calls,
        )
    }

    @Test
    fun `setLive throwing, re-checked and confirmed NOT live, is a refusal`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            setLive = { calls += "setLive"; throw IllegalStateException("timeout") },
            checkLive = { calls += "checkLive"; false },
            joinVoice = { fail("must not join a party the re-check says is not live") },
            muteMicrophone = { fail("must not run -- nothing was joined") },
            endParty = { fail("nothing to end -- confirmed not live") },
            startScreenShare = { fail("must not share") },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Refused, result)
        assertEquals(listOf("setLive", "checkLive"), calls)
    }

    @Test
    fun `setLive throwing AND the re-check itself throwing is still just a refusal, not a crash`() = runTest {
        val result = performWatchPartyGoLive(
            setLive = { throw IllegalStateException("timeout") },
            checkLive = { throw IllegalStateException("the re-check failed too") },
            joinVoice = { fail("must not join") },
            muteMicrophone = { fail("must not run") },
            endParty = { fail("nothing to end") },
            startScreenShare = { fail("must not share") },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Refused, result)
    }

    @Test
    fun `cancellation of setLive propagates rather than being treated as ambiguous`() = runTest {
        var threw = false
        try {
            performWatchPartyGoLive(
                setLive = { throw CancellationException("scope gone") },
                checkLive = { fail("cancellation is not ambiguity -- must not re-check") },
                joinVoice = { fail("must not join") },
                muteMicrophone = { fail("must not run") },
                endParty = { fail("nothing to end") },
                startScreenShare = { fail("must not share") },
                consent = "grant-1",
            )
        } catch (e: CancellationException) {
            threw = true
        }
        assertTrue(threw)
    }

    // --------------------------------------------- joinVoice fails, already live

    @Test
    fun `joinVoice failing on an already-live party ends it and reports JoinFailed(ended = true), muting nothing`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            setLive = { calls += "setLive"; true },
            checkLive = { fail("must not re-check a setLive that did not throw") },
            joinVoice = { calls += "joinVoice"; throw IllegalStateException("no room") },
            muteMicrophone = { fail("the room was never entered -- there is no mic to silence") },
            endParty = { calls += "endParty"; true },
            startScreenShare = { fail("must not share -- the room was never entered") },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.JoinFailed(ended = true), result)
        assertEquals(listOf("setLive", "joinVoice", "endParty"), calls)
    }

    @Test
    fun `joinVoice failing, and ALSO failing to end the party, is reported honestly`() = runTest {
        val result = performWatchPartyGoLive(
            setLive = { true },
            checkLive = { fail("must not re-check") },
            joinVoice = { throw IllegalStateException("no room") },
            muteMicrophone = { fail("must not run") },
            endParty = { throw IllegalStateException("network, again") },
            startScreenShare = { fail("must not share") },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.JoinFailed(ended = false), result)
    }

    @Test
    fun `joinVoice failing after the ambiguous-but-confirmed-live path still tries to end it`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            setLive = { throw IllegalStateException("timeout") },
            checkLive = { true },
            joinVoice = { calls += "joinVoice"; throw IllegalStateException("no room") },
            muteMicrophone = { fail("must not run") },
            endParty = { calls += "endParty"; true },
            startScreenShare = { fail("must not share") },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.JoinFailed(ended = true), result)
        assertEquals(listOf("joinVoice", "endParty"), calls)
    }

    // --------------------------------- Ir ao vivo forces the mic silent, always

    /**
     * The literal claim this whole change makes: "Ir ao vivo" silences
     * whatever mic the room hands it, even one this phone had already
     * published, unmuted, before the party went live -- see
     * [performWatchPartyGoLive]'s own doc for why the mute is unconditional
     * rather than a fresh-join default.
     */
    @Test
    fun `muteMicrophone runs even when joinVoice is a no-op re-entry into a room already held`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            setLive = { calls += "setLive"; true },
            checkLive = { fail("must not re-check") },
            // A phone already `Connected` to this channel's room:
            // `VoiceController.join` returns immediately without doing
            // anything, exactly like this no-op.
            joinVoice = { calls += "joinVoice" },
            muteMicrophone = { calls += "muteMicrophone" },
            endParty = { fail("nothing to end") },
            startScreenShare = { calls += "startScreenShare" },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Live, result)
        assertEquals(listOf("setLive", "joinVoice", "muteMicrophone", "startScreenShare"), calls)
    }

    // -------------------------------------------------------------- Encerrar

    @Test
    fun `end tells the server first, then leaves voice, and reports success`() = runTest {
        val calls = mutableListOf<String>()
        val ended = performWatchPartyEnd(
            setEnded = { calls += "setEnded"; true },
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

    /**
     * `setEnded` returning `false` WITHOUT throwing -- the server answered
     * cleanly but did not confirm the end (a null party in the response, the
     * same shape `setLive` already has to handle). A second Farol finding: the
     * first fix only closed the throwing case and left `setEnded` typed
     * `suspend () -> Unit`, which silently coerced this exact signal away.
     */
    @Test
    fun `end still leaves voice, and reports failure, when setEnded returns false without throwing`() = runTest {
        val calls = mutableListOf<String>()
        val ended = performWatchPartyEnd(
            setEnded = { calls += "setEnded"; false },
            leaveVoice = { calls += "leaveVoice" },
        )
        assertEquals(listOf("setEnded", "leaveVoice"), calls)
        assertFalse(ended)
    }

    /**
     * Cancelled while the end request is in flight (the screen was left, the
     * scope torn down): the cancellation still propagates, but the phone
     * leaves voice first, so its screen never keeps broadcasting after the
     * host pressed Encerrar. A third Farol finding.
     */
    @Test
    fun `end still leaves voice when cancelled mid-request, and rethrows the cancellation`() = runTest {
        val calls = mutableListOf<String>()
        var rethrown = false
        try {
            performWatchPartyEnd(
                setEnded = { calls += "setEnded"; throw CancellationException("scope gone") },
                leaveVoice = { calls += "leaveVoice" },
            )
        } catch (e: CancellationException) {
            rethrown = true
        }
        assertTrue(rethrown)
        assertEquals(listOf("setEnded", "leaveVoice"), calls)
    }

    private fun fail(message: String): Nothing = throw AssertionError(message)
}
