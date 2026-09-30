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
 * hosting review's test plan asks for: the mic first, so the party can
 * never be live with it still open, state next so a failed share never
 * broadcasts silently, and Encerrar always leaves voice even when telling
 * the server the party ended fails.
 *
 * The go-live cases below are what two rounds of review added, on top of
 * Farol's original 5: an ambiguous `setLive` failure (the response lost or
 * thrown after the server already committed) must not be read as a plain
 * refusal, a `joinVoice` failure on an already-live party must not be read
 * as success, and -- the second round, after `muteMicrophone` moved ahead
 * of `setLive` -- a mute that fails must abort before the party goes live
 * at all, with cancellation still propagating rather than being read as an
 * ordinary failure.
 */
class WatchPartyHostSequenceTest {

    @Test
    fun `go-live mutes the mic, sets state, joins the room, then starts the capture, in that order`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            muteMicrophone = { calls += "muteMicrophone" },
            setLive = { calls += "setLive"; true },
            checkLive = { fail("must not re-check a setLive that did not throw") },
            joinVoice = { calls += "joinVoice" },
            endParty = { fail("must not end a party that was never joined-and-failed") },
            startScreenShare = { consent: String -> calls += "startScreenShare($consent)" },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Live, result)
        assertEquals(listOf("muteMicrophone", "setLive", "joinVoice", "startScreenShare(grant-1)"), calls)
    }

    // ------------------------------------------------- muteMicrophone fails first

    /**
     * The claim this whole reordering makes: a mute that does not land means
     * the party never goes live at all, not a live party with an open mic.
     * `GoLiveResult.Refused` is reused rather than a dedicated case, because
     * from the host's point of view "could not go live" is exactly what
     * happened -- see `performWatchPartyGoLive`'s own doc.
     */
    @Test
    fun `muteMicrophone failing aborts before setLive is ever called`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            muteMicrophone = { calls += "muteMicrophone"; throw IllegalStateException("engine not ready") },
            setLive = { fail("must not go live -- the mic could not be silenced") },
            checkLive = { fail("must not re-check") },
            joinVoice = { fail("must not join") },
            endParty = { fail("nothing to end") },
            startScreenShare = { fail("must not share") },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Refused, result)
        assertEquals(listOf("muteMicrophone"), calls)
    }

    @Test
    fun `cancellation of muteMicrophone propagates rather than being treated as an ordinary failure`() = runTest {
        var threw = false
        try {
            performWatchPartyGoLive(
                muteMicrophone = { throw CancellationException("scope gone") },
                setLive = { fail("must not go live") },
                checkLive = { fail("must not re-check") },
                joinVoice = { fail("must not join") },
                endParty = { fail("nothing to end") },
                startScreenShare = { fail("must not share") },
                consent = "grant-1",
            )
        } catch (e: CancellationException) {
            threw = true
        }
        assertTrue(threw)
    }

    @Test
    fun `a clean refusal (no throw) joins nothing, starts no capture, and is never re-checked`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            muteMicrophone = { calls += "muteMicrophone" },
            setLive = { calls += "setLive"; false },
            checkLive = { fail("a clean `false` is unambiguous -- checkLive must not run") },
            joinVoice = { calls += "joinVoice" },
            endParty = { fail("nothing to end -- the party never went live") },
            startScreenShare = { calls += "startScreenShare" },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Refused, result)
        assertEquals(listOf("muteMicrophone", "setLive"), calls)
    }

    // ---------------------------------------- an ambiguous `setLive` failure

    @Test
    fun `setLive throwing is re-checked, and a confirmed-live party still goes live`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            muteMicrophone = { calls += "muteMicrophone" },
            setLive = { calls += "setLive"; throw IllegalStateException("timeout") },
            checkLive = { calls += "checkLive"; true },
            joinVoice = { calls += "joinVoice" },
            endParty = { fail("the party is live and was joined -- nothing to end") },
            startScreenShare = { consent: String -> calls += "startScreenShare($consent)" },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Live, result)
        assertEquals(
            listOf("muteMicrophone", "setLive", "checkLive", "joinVoice", "startScreenShare(grant-1)"),
            calls,
        )
    }

    @Test
    fun `setLive throwing, re-checked and confirmed NOT live, is a refusal`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            muteMicrophone = { calls += "muteMicrophone" },
            setLive = { calls += "setLive"; throw IllegalStateException("timeout") },
            checkLive = { calls += "checkLive"; false },
            joinVoice = { fail("must not join a party the re-check says is not live") },
            endParty = { fail("nothing to end -- confirmed not live") },
            startScreenShare = { fail("must not share") },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Refused, result)
        assertEquals(listOf("muteMicrophone", "setLive", "checkLive"), calls)
    }

    @Test
    fun `setLive throwing AND the re-check itself throwing is still just a refusal, not a crash`() = runTest {
        val result = performWatchPartyGoLive(
            muteMicrophone = { },
            setLive = { throw IllegalStateException("timeout") },
            checkLive = { throw IllegalStateException("the re-check failed too") },
            joinVoice = { fail("must not join") },
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
                muteMicrophone = { },
                setLive = { throw CancellationException("scope gone") },
                checkLive = { fail("cancellation is not ambiguity -- must not re-check") },
                joinVoice = { fail("must not join") },
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
    fun `joinVoice failing on an already-live party ends it and reports JoinFailed(ended = true)`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            muteMicrophone = { calls += "muteMicrophone" },
            setLive = { calls += "setLive"; true },
            checkLive = { fail("must not re-check a setLive that did not throw") },
            joinVoice = { calls += "joinVoice"; throw IllegalStateException("no room") },
            endParty = { calls += "endParty"; true },
            startScreenShare = { fail("must not share -- the room was never entered") },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.JoinFailed(ended = true), result)
        assertEquals(listOf("muteMicrophone", "setLive", "joinVoice", "endParty"), calls)
    }

    @Test
    fun `joinVoice failing, and ALSO failing to end the party, is reported honestly`() = runTest {
        val result = performWatchPartyGoLive(
            muteMicrophone = { },
            setLive = { true },
            checkLive = { fail("must not re-check") },
            joinVoice = { throw IllegalStateException("no room") },
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
            muteMicrophone = { },
            setLive = { throw IllegalStateException("timeout") },
            checkLive = { true },
            joinVoice = { calls += "joinVoice"; throw IllegalStateException("no room") },
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
     * whatever mic the room hands it BEFORE the party can become live, even
     * for a host who is already seated in the room with an open mic and
     * whose `joinVoice` is therefore a no-op re-entry -- see
     * [performWatchPartyGoLive]'s own doc for why the mute runs first rather
     * than after the join.
     */
    @Test
    fun `muteMicrophone runs, and lands, before setLive even for a host already seated with an open mic`() = runTest {
        val calls = mutableListOf<String>()
        val result = performWatchPartyGoLive(
            muteMicrophone = { calls += "muteMicrophone" },
            setLive = {
                // If the mic were still open at this point, the party would
                // be going live before it was silenced -- exactly the window
                // this ordering exists to close.
                assertEquals(listOf("muteMicrophone"), calls)
                calls += "setLive"
                true
            },
            checkLive = { fail("must not re-check") },
            // A phone already `Connected` to this channel's room:
            // `VoiceController.join` returns immediately without doing
            // anything, exactly like this no-op.
            joinVoice = { calls += "joinVoice" },
            endParty = { fail("nothing to end") },
            startScreenShare = { calls += "startScreenShare" },
            consent = "grant-1",
        )
        assertEquals(GoLiveResult.Live, result)
        assertEquals(listOf("muteMicrophone", "setLive", "joinVoice", "startScreenShare"), calls)
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
