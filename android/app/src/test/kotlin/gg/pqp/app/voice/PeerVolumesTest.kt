package gg.pqp.app.voice

import gg.pqp.app.core.VoiceParticipant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Per-person volume: the rules every surface shares, and how the mesh gate
 * carries a level onto tracks that arrive after the slider moved.
 */
class PeerVolumesTest {

    // --- the listener's levels ----------------------------------------------

    @Test
    fun `everybody starts at 100 percent`() {
        assertEquals(1.0, PeerVolumes().volumeFor("ana"), 0.0)
    }

    @Test
    fun `a level is clamped to zero through the ceiling`() {
        val volumes = PeerVolumes()
        assertEquals(PEER_VOLUME_MAX, volumes.set("ana", 7.0), 0.0)
        assertEquals(0.0, volumes.set("ana", -1.0), 0.0)
        assertEquals(PEER_VOLUME_DEFAULT, volumes.set("ana", Double.NaN), 0.0)
    }

    @Test
    fun `levels are per person`() {
        val volumes = PeerVolumes()
        volumes.set("ana", 0.4)
        assertEquals(0.4, volumes.volumeFor("ana"), 0.0)
        assertEquals(1.0, volumes.volumeFor("bob"), 0.0)
    }

    @Test
    fun `mute goes back to the level before it, not to 100 percent`() {
        val volumes = PeerVolumes()
        volumes.set("ana", 0.4)
        assertEquals(0.0, volumes.toggleMute("ana"), 0.0)
        assertTrue(volumes.isMuted("ana"))
        assertEquals(0.4, volumes.toggleMute("ana"), 0.0)
        assertFalse(volumes.isMuted("ana"))
    }

    @Test
    fun `dragging the slider to zero and tapping mute restores the last audible level`() {
        val volumes = PeerVolumes()
        volumes.set("ana", 1.5)
        volumes.set("ana", 0.0)
        assertEquals(1.5, volumes.toggleMute("ana"), 0.0)
    }

    @Test
    fun `unmuting somebody who was never turned down gives 100 percent`() {
        val volumes = PeerVolumes()
        volumes.set("ana", 0.0)
        assertEquals(PEER_VOLUME_DEFAULT, volumes.toggleMute("ana"), 0.0)
    }

    // --- who the control is for ---------------------------------------------

    private fun person(peer: String, user: String) =
        VoiceParticipant(peerId = peer, userId = user, displayName = user)

    @Test
    fun `the list leaves out this device and repeats no account`() {
        val state = VoiceState(
            localPeerId = "p-me",
            participants = listOf(
                person("p-me", "me"),
                person("p-ana", "ana"),
                person("p-ana2", "ana"),
                person("p-bob", "bob"),
            ),
        )
        assertEquals(listOf("ana", "bob"), state.otherParticipants().map { it.userId })
    }

    // --- the mesh gate ------------------------------------------------------

    private val levels = mutableMapOf<String, Double>()
    private val enabled = mutableMapOf<String, Boolean>()

    private fun gate() = RemoteAudioGate<String>(
        applyVolume = { track, volume -> levels[track] = volume },
    ) { track, on -> enabled[track] = on }

    @Test
    fun `a track arrives at the level already chosen for its peer`() {
        val gate = gate()
        gate.setVolume("bob", 0.3)
        gate.trackAdded("bob", "t1", "s1", "bob-mic")
        assertEquals(0.3, levels["bob-mic"]!!, 0.0)
    }

    @Test
    fun `moving the slider reaches every track of the peer, a share's sound too`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "s1", "bob-mic")
        gate.trackAdded("bob", "t2", "s2", "bob-share")
        assertTrue(gate.setVolume("bob", 1.5))
        assertEquals(1.5, levels["bob-mic"]!!, 0.0)
        assertEquals(1.5, levels["bob-share"]!!, 0.0)
    }

    @Test
    fun `a repeat of the same level is a no-op`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "s1", "bob-mic")
        assertTrue(gate.setVolume("bob", 0.5))
        assertFalse(gate.setVolume("bob", 0.5))
    }

    @Test
    fun `a server mute leaves the chosen level alone`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "s1", "bob-mic")
        gate.setVolume("bob", 0.4)

        gate.setServerMuted("bob", true)
        assertEquals(false, enabled["bob-mic"])
        assertEquals(0.4, gate.volumeFor("bob"), 0.0)
        assertEquals(0.4, levels["bob-mic"]!!, 0.0)

        gate.setServerMuted("bob", false)
        assertEquals(true, enabled["bob-mic"])
        assertEquals(0.4, levels["bob-mic"]!!, 0.0)
    }

    // --- the SFU's levels ---------------------------------------------------

    private fun sfu() = PeerAudioLevels<String> { track, volume -> levels[track] = volume }

    @Test
    fun `a level moved after the track was already subscribed reaches it`() {
        val sfu = sfu()
        sfu.trackSubscribed("bob", "bob-mic")
        assertEquals(1.0, levels["bob-mic"]!!, 0.0)

        assertTrue(sfu.setLevel("bob", 0.25) { listOf("bob-mic", "bob-share") })

        assertEquals(0.25, levels["bob-mic"]!!, 0.0)
        assertEquals(0.25, levels["bob-share"]!!, 0.0)
    }

    @Test
    fun `a track that subscribes after the level was chosen starts at it`() {
        val sfu = sfu()
        sfu.setLevel("bob", 1.5) { emptyList() }
        sfu.trackSubscribed("bob", "bob-mic")
        assertEquals(1.5, levels["bob-mic"]!!, 0.0)
    }

    @Test
    fun `an SFU level repeat applies nothing and one peer does not move another`() {
        val sfu = sfu()
        assertTrue(sfu.setLevel("bob", 0.5) { listOf("bob-mic") })
        levels.clear()
        var scanned = false
        assertFalse(sfu.setLevel("bob", 0.5) { scanned = true; listOf("bob-mic") })
        assertTrue(levels.isEmpty())
        assertFalse("a repeat must not scan the room", scanned)
        sfu.trackSubscribed("ana", "ana-mic")
        assertEquals(1.0, levels["ana-mic"]!!, 0.0)
    }

    @Test
    fun `a scan that throws leaves the level unapplied so the next frame retries`() {
        val sfu = sfu()
        try {
            sfu.setLevel("bob", 0.4) { error("room went away") }
        } catch (_: IllegalStateException) {
        }
        assertEquals(1.0, sfu.levelFor("bob"), 0.0)
        assertTrue(sfu.setLevel("bob", 0.4) { listOf("bob-mic") })
        assertEquals(0.4, levels["bob-mic"]!!, 0.0)
    }

    @Test
    fun `a forgotten peer comes back at 100 percent`() {
        val sfu = sfu()
        sfu.setLevel("bob", 0.3) { emptyList() }
        sfu.forget("bob")
        assertEquals(1.0, sfu.levelFor("bob"), 0.0)
    }

    @Test
    fun `deafening and undeafening do not move the level`() {
        val gate = gate()
        gate.trackAdded("bob", "t1", "s1", "bob-mic")
        gate.setVolume("bob", 0.4)
        gate.setDeafened(true)
        gate.setDeafened(false)
        assertEquals(0.4, levels["bob-mic"]!!, 0.0)
    }
}
