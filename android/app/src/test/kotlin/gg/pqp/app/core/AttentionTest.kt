package gg.pqp.app.core

import gg.pqp.app.protocol.RepoSources
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The same cases as the web's `client/src/lib/attention.test.ts`, with the grace this client uses.
 * The rule they pin is the one the server gate depends on: a (re)connected socket always hears the
 * current state, a change is sent once, and a send that did not leave is tried again.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AttentionTest {

    private class Rig(startForeground: Boolean = true, graceMs: Long = GRACE) {
        val scope = TestScope()
        var foreground = startForeground
        val sent = mutableListOf<Boolean>()
        var failSends = false
        val tracker = AttentionTracker(
            scope = scope,
            send = { value ->
                if (failSends) false else sent.add(value).let { true }
            },
            isForeground = { foreground },
            graceMs = graceMs,
        )

        fun advance(ms: Long) {
            scope.advanceTimeBy(ms)
            scope.runCurrent()
        }
    }

    @Test
    fun `sends the current state when the socket is ready, and not before`() {
        val rig = Rig()
        rig.tracker.evaluate()
        assertEquals(emptyList<Boolean>(), rig.sent)
        rig.tracker.setConnected(true)
        assertEquals(listOf(true), rig.sent)
    }

    @Test
    fun `reports background only after the grace`() {
        val rig = Rig()
        rig.tracker.setConnected(true)
        rig.foreground = false
        rig.tracker.evaluate()
        rig.advance(GRACE - 1)
        assertEquals(listOf(true), rig.sent)
        assertTrue(rig.tracker.declared)
        rig.advance(1)
        assertEquals(listOf(true, false), rig.sent)
        assertFalse(rig.tracker.declared)
    }

    @Test
    fun `cancels the report when the app comes back inside the grace`() {
        val rig = Rig()
        rig.tracker.setConnected(true)
        rig.foreground = false
        rig.tracker.evaluate()
        rig.advance(GRACE / 2)
        rig.foreground = true
        rig.tracker.evaluate()
        rig.advance(GRACE * 2)
        assertEquals(listOf(true), rig.sent)
    }

    @Test
    fun `re-checks when the grace ends, in case it came back with no event`() {
        val rig = Rig()
        rig.tracker.setConnected(true)
        rig.foreground = false
        rig.tracker.evaluate()
        rig.foreground = true
        rig.advance(GRACE)
        assertEquals(listOf(true), rig.sent)
        assertTrue(rig.tracker.declared)
    }

    @Test
    fun `reports coming back at once`() {
        val rig = Rig()
        rig.tracker.setConnected(true)
        rig.foreground = false
        rig.tracker.evaluate()
        rig.advance(GRACE)
        rig.foreground = true
        rig.tracker.evaluate()
        assertEquals(listOf(true, false, true), rig.sent)
    }

    @Test
    fun `does not repeat itself on extra events`() {
        val rig = Rig()
        rig.tracker.setConnected(true)
        repeat(3) { rig.tracker.evaluate() }
        rig.foreground = false
        repeat(3) { rig.tracker.evaluate() }
        rig.advance(GRACE)
        repeat(3) { rig.tracker.evaluate() }
        assertEquals(listOf(true, false), rig.sent)
    }

    @Test
    fun `re-announces background on a reconnect, because the new socket knows nothing`() {
        val rig = Rig()
        rig.tracker.setConnected(true)
        rig.foreground = false
        rig.tracker.evaluate()
        rig.advance(GRACE)
        rig.tracker.setConnected(false)
        rig.tracker.setConnected(true)
        // A socket that never hears "background" reads as in front of the person.
        assertEquals(listOf(true, false, false), rig.sent)
    }

    @Test
    fun `an app that starts in the background says so on connect, with no grace`() {
        val rig = Rig(startForeground = false)
        rig.tracker.setConnected(true)
        assertEquals(listOf(false), rig.sent)
    }

    @Test
    fun `a change made while disconnected is sent once on the next connect`() {
        val rig = Rig()
        rig.foreground = false
        rig.tracker.evaluate()
        rig.advance(GRACE)
        rig.foreground = true
        rig.tracker.evaluate()
        rig.foreground = false
        rig.tracker.evaluate()
        rig.advance(GRACE)
        assertEquals(emptyList<Boolean>(), rig.sent)
        rig.tracker.setConnected(true)
        assertEquals(listOf(false), rig.sent)
    }

    @Test
    fun `stops its timer on dispose`() {
        val rig = Rig()
        rig.tracker.setConnected(true)
        rig.foreground = false
        rig.tracker.evaluate()
        rig.tracker.dispose()
        rig.advance(GRACE * 2)
        assertEquals(listOf(true), rig.sent)
    }

    @Test
    fun `a send that did not leave is not counted as reported, and the next event retries it`() {
        val rig = Rig()
        rig.tracker.setConnected(true)
        rig.foreground = false
        rig.tracker.evaluate()
        rig.failSends = true
        rig.advance(GRACE)
        assertEquals(listOf(true), rig.sent)
        rig.failSends = false
        rig.tracker.evaluate()
        assertEquals(listOf(true, false), rig.sent)
    }

    @Test
    fun `the frame is the shared one`() {
        val frame = AttentionReporter.attentionFrame(false).toString()
        assertEquals("""{"type":"set-attention","foreground":false}""", frame)
        val shared = RepoSources.read("packages/shared/src/status.ts")
        assertTrue(shared.contains("""z.literal("set-attention")"""))
        assertTrue(Regex("""foreground:\s*z\.boolean\(\)""").containsMatchIn(shared))
    }

    @Test
    fun `the phone's grace is shorter than the web's, on purpose`() {
        val web = RepoSources.read("client/src/lib/attention.ts")
        val webGrace = Regex("""ATTENTION_BACKGROUND_GRACE_MS\s*=\s*([\d_]+)""").find(web)!!.groupValues[1].replace("_", "").toLong()
        // A page stays on screen on another window; a phone's app leaving the screen is the person not looking.
        assertTrue(AttentionTracker.BACKGROUND_GRACE_MS in 1 until webGrace)
    }

    private companion object {
        const val GRACE = 5_000L
    }
}
