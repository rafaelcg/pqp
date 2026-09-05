package gg.pqp.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The receiving half of a server mute on a mesh room, pinned.
 *
 * On mesh the server cannot touch anybody's media, so a moderator's mute is
 * only real because every receiving client stops playing the flagged peer.
 * This is the rule that does that on Android, and it has to survive the two
 * things that made it more than a boolean: the roster and the track race, and
 * deafening shares the same switch.
 *
 * Track handles are strings and `setEnabled` is a recording lambda, because
 * every entry point of [VoiceEngine] needs libwebrtc's native library and this
 * needs nothing, which is the point of the class existing.
 */
class RemoteAudioGateTest {

    private val applied = mutableListOf<Pair<String, Boolean>>()
    private val enabled = mutableMapOf<String, Boolean>()

    private fun gate() = RemoteAudioGate<String> { track, on ->
        applied += track to on
        enabled[track] = on
    }

    // --- the contract -------------------------------------------------------

    @Test
    fun `a peer the roster flags as server-muted stops playing`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "bob-mic")
        assertEquals(true, enabled["bob-mic"])

        assertTrue(gate.setServerMuted("bob", true))

        assertEquals(false, enabled["bob-mic"])
        assertFalse(gate.plays("bob"))
        assertTrue(gate.isServerMuted("bob"))
    }

    @Test
    fun `clearing the flag plays the peer again`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "bob-mic")
        gate.setServerMuted("bob", true)

        assertTrue(gate.setServerMuted("bob", false))

        assertEquals(true, enabled["bob-mic"])
        assertTrue(gate.plays("bob"))
    }

    @Test
    fun `a repeated roster is a no-op and touches no track`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "bob-mic")
        gate.setServerMuted("bob", true)
        applied.clear()

        assertFalse(gate.setServerMuted("bob", true))
        assertFalse(gate.setServerMuted("carol", false))

        assertEquals(emptyList<Pair<String, Boolean>>(), applied)
    }

    // --- the roster and the track race --------------------------------------

    @Test
    fun `a track that arrives after the mute never plays a frame`() {
        val gate = gate()
        gate.setServerMuted("bob", true)

        gate.trackAdded("bob", "t1", "bob-mic")

        assertEquals(listOf("bob-mic" to false), applied)
    }

    @Test
    fun `every audio track of a muted peer is switched, not just the first`() {
        val gate = gate()
        gate.trackAdded("bob", "mic", "bob-mic")
        gate.trackAdded("bob", "screen", "bob-screen-audio")

        gate.setServerMuted("bob", true)

        assertEquals(false, enabled["bob-mic"])
        assertEquals(false, enabled["bob-screen-audio"])
    }

    @Test
    fun `muting one peer leaves the others alone`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "bob-mic")
        gate.trackAdded("carol", "t2", "carol-mic")

        gate.setServerMuted("bob", true)

        assertEquals(false, enabled["bob-mic"])
        assertEquals(true, enabled["carol-mic"])
    }

    // --- deafening shares the switch ----------------------------------------

    @Test
    fun `undeafening does not bring a server-muted peer back`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "bob-mic")
        gate.trackAdded("carol", "t2", "carol-mic")
        gate.setServerMuted("bob", true)

        gate.setDeafened(true)
        assertEquals(false, enabled["bob-mic"])
        assertEquals(false, enabled["carol-mic"])

        gate.setDeafened(false)
        assertEquals(false, enabled["bob-mic"])
        assertEquals(true, enabled["carol-mic"])
    }

    @Test
    fun `lifting a mute while deafened keeps the peer silent`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "bob-mic")
        gate.setServerMuted("bob", true)
        gate.setDeafened(true)

        gate.setServerMuted("bob", false)

        assertEquals(false, enabled["bob-mic"])
        assertFalse(gate.plays("bob"))
    }

    @Test
    fun `a track arriving while deafened starts silent`() {
        val gate = gate()
        gate.setDeafened(true)

        gate.trackAdded("bob", "t1", "bob-mic")

        assertEquals(false, enabled["bob-mic"])
    }

    // --- lifecycle -----------------------------------------------------------

    @Test
    fun `a removed track is not switched again`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "bob-mic")
        gate.trackRemoved("bob", "t1")
        applied.clear()

        gate.setServerMuted("bob", true)

        assertEquals(emptyList<Pair<String, Boolean>>(), applied)
    }

    @Test
    fun `clearing the room forgets the per-peer flags but keeps deafening`() {
        val gate = gate()
        gate.setServerMuted("bob", true)
        gate.setDeafened(true)

        gate.clear()

        assertFalse(gate.isServerMuted("bob"))
        // Still deafened: that is this device's own setting.
        assertFalse(gate.plays("bob"))
        gate.setDeafened(false)
        assertTrue(gate.plays("bob"))
    }

    @Test
    fun `forgetting a peer clears their flag`() {
        val gate = gate()
        gate.setServerMuted("bob", true)

        gate.forget("bob")

        assertFalse(gate.isServerMuted("bob"))
        assertTrue(gate.plays("bob"))
    }
}
