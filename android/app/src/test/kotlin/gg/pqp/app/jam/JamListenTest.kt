package gg.pqp.app.jam

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Ouvir com a banda": playback starts when the asked-for part's OWN file is decoded, never before, and the wish to start is
 * kept per take (QA of PR 1780: stopping one take cancelled another's pending start, and the band started without the part).
 */
class JamListenTest {
    private val ready = JamStemStatus.Ready
    private val loading = JamStemStatus.Loading

    @Test
    fun `nothing starts while the asked-for part is still loading, even when the song's band is ready`() {
        val step = JamListen.resolve(setOf("a"), mapOf("a" to loading), songReady = true, playing = false)
        assertFalse("the band without the part that was asked for is the wrong answer to the tap", step.play)
        assertEquals(setOf("a"), step.pending)
    }

    @Test
    fun `an unknown stem is a stem that is not decoded`() {
        assertFalse(JamListen.resolve(setOf("a"), emptyMap(), songReady = true, playing = false).play)
    }

    @Test
    fun `it starts when the part is decoded and the band is ready, and the wish is spent`() {
        val step = JamListen.resolve(setOf("a"), mapOf("a" to ready), songReady = true, playing = false)
        assertTrue(step.play)
        assertTrue(step.pending.isEmpty())
    }

    @Test
    fun `a decoded part waits for the band as a whole`() {
        val step = JamListen.resolve(setOf("a"), mapOf("a" to ready), songReady = false, playing = false)
        assertFalse(step.play)
        assertEquals(setOf("a"), step.pending)
    }

    @Test
    fun `two wishes start together, once each is decoded`() {
        val half = JamListen.resolve(setOf("a", "b"), mapOf("a" to ready, "b" to loading), songReady = true, playing = false)
        assertFalse(half.play)
        assertEquals(setOf("a", "b"), half.pending)
        val both = JamListen.resolve(half.pending, mapOf("a" to ready, "b" to ready), songReady = true, playing = false)
        assertTrue(both.play)
    }

    @Test
    fun `already playing, a decoded wish starts nothing a second time and is spent`() {
        val step = JamListen.resolve(setOf("a"), mapOf("a" to ready), songReady = true, playing = true)
        assertFalse(step.play)
        assertTrue(step.pending.isEmpty())
    }

    @Test
    fun `a part this phone cannot decode drops its wish and says so, the others carry on`() {
        val step = JamListen.resolve(setOf("a", "b"), mapOf("a" to JamStemStatus.Unplayable, "b" to ready), songReady = true, playing = false)
        assertTrue(step.failed)
        assertTrue(step.play)
        assertTrue(step.pending.isEmpty())
        val only = JamListen.resolve(setOf("a"), mapOf("a" to JamStemStatus.Unplayable), songReady = true, playing = false)
        assertTrue(only.failed)
        assertFalse(only.play)
    }

    private val instruments = mapOf("a" to JamInstrument.Bass, "b" to JamInstrument.Drums, "c" to JamInstrument.Bass)

    @Test
    fun `stopping one take leaves another take's wish alone`() {
        // The QA case: Listen on A (bass), Listen on B (drums) on a slow load, then stop A.
        val wishes = JamListen.wish(JamListen.wish(emptySet(), "a", JamInstrument.Bass, instruments::get), "b", JamInstrument.Drums, instruments::get)
        assertEquals(setOf("a", "b"), wishes)
        val after = JamListen.stopped(wishes, JamInstrument.Bass, instruments::get)
        assertEquals("B still starts when its file is ready", setOf("b"), after)
        assertTrue(JamListen.resolve(after, mapOf("b" to ready), songReady = true, playing = false).play)
    }

    @Test
    fun `a new wish for an instrument replaces the earlier take of the same instrument`() {
        val wishes = JamListen.wish(setOf("a", "b"), "c", JamInstrument.Bass, instruments::get)
        assertEquals(setOf("b", "c"), wishes)
    }
}
