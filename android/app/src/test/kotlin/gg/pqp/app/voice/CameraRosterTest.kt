package gg.pqp.app.voice

import gg.pqp.app.core.VoiceParticipant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Who gets a tile in the camera strip.
 *
 * The test to be suspicious of here is the easy one, "three people with cameras
 * produce three tiles", which passes on any implementation including one that
 * drops half the room. The ones worth having are the races: a camera whose
 * owner the roster has not named, a roster that names somebody with no camera,
 * and this device's own row.
 */
class CameraRosterTest {

    private fun participant(peerId: String, name: String) =
        VoiceParticipant(peerId = peerId, userId = "u_$peerId", displayName = name)

    @Test
    fun `nobody on camera is an empty strip`() {
        val entries = cameraRailEntries(
            participants = listOf(participant("p1", "Ana"), participant("p2", "Bea")),
            cameraPeerIds = emptySet(),
            localPeerId = "p1",
        )
        assertTrue(entries.isEmpty())
    }

    @Test
    fun `only the people with a camera get a tile`() {
        val entries = cameraRailEntries(
            participants = listOf(
                participant("p1", "Ana"),
                participant("p2", "Bea"),
                participant("p3", "Cau"),
            ),
            cameraPeerIds = setOf("p3"),
            localPeerId = "p1",
        )
        assertEquals(listOf("p3"), entries.map { it.peerId })
        assertEquals("Cau", entries.single().displayName)
    }

    @Test
    fun `the strip follows roster order`() {
        val entries = cameraRailEntries(
            participants = listOf(
                participant("p1", "Ana"),
                participant("p2", "Bea"),
                participant("p3", "Cau"),
            ),
            cameraPeerIds = setOf("p3", "p2"),
            localPeerId = null,
        )
        assertEquals(listOf("p2", "p3"), entries.map { it.peerId })
    }

    /**
     * This client publishes no camera on either transport, so its own peer id
     * can only reach the strip through a bug somewhere else. It is excluded
     * here rather than trusted not to happen, because the visible result would
     * be somebody's own face in the strip with no way to turn it off.
     */
    @Test
    fun `this device never appears in its own strip`() {
        val entries = cameraRailEntries(
            participants = listOf(participant("me", "Rafa"), participant("p2", "Bea")),
            cameraPeerIds = setOf("me", "p2"),
            localPeerId = "me",
        )
        assertEquals(listOf("p2"), entries.map { it.peerId })
    }

    /**
     * The picture and the name arrive over different connections: LiveKit
     * delivers the media and `/ws` delivers the roster, and on a busy join the
     * media wins often enough to matter. Waiting for the name would be a face
     * that is missing from this phone and present on every other client, which
     * is the exact failure this whole change is about.
     */
    @Test
    fun `a camera the roster has not named yet still gets a tile`() {
        val entries = cameraRailEntries(
            participants = listOf(participant("p1", "Ana")),
            cameraPeerIds = setOf("p1", "stranger"),
            localPeerId = null,
        )
        assertEquals(listOf("p1", "stranger"), entries.map { it.peerId })
        assertEquals("Ana", entries[0].displayName)
        assertNull(
            "no name yet, so the caller prints a placeholder rather than nothing",
            entries[1].displayName,
        )
    }

    /** An empty roster is the extreme of the same race, and must still draw. */
    @Test
    fun `cameras arriving before any roster still draw`() {
        val entries = cameraRailEntries(
            participants = emptyList(),
            cameraPeerIds = setOf("p2", "p1"),
            localPeerId = null,
        )
        assertEquals(listOf("p1", "p2"), entries.map { it.peerId })
    }

    @Test
    fun `an unnamed camera that turns out to be ours is still excluded`() {
        val entries = cameraRailEntries(
            participants = emptyList(),
            cameraPeerIds = setOf("me"),
            localPeerId = "me",
        )
        assertTrue(entries.isEmpty())
    }

    /**
     * The strip keys its tiles by peer id, and a duplicate key crashes a
     * `LazyRow` at runtime rather than at compile time. A peer on the roster
     * twice is not supposed to happen; a crash in the call bar over it would
     * take the whole app down mid-call.
     */
    @Test
    fun `a peer listed twice on the roster gets one tile`() {
        val entries = cameraRailEntries(
            participants = listOf(participant("p1", "Ana"), participant("p1", "Ana")),
            cameraPeerIds = setOf("p1"),
            localPeerId = null,
        )
        assertEquals(1, entries.size)
    }
}
