package gg.pqp.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two defects this class was written to close, pinned.
 *
 * Both were invisible to a single client watching itself, which is the whole
 * reason they survived to a store build:
 *
 *  1. The screen was one handle for the whole room, so the second person to
 *     share overwrote the first.
 *  2. Every inbound video was filed as a screen share, so a web peer's camera
 *     was drawn as if it were their desktop.
 *
 * Track handles are plain strings here. The rule is deliberately generic over
 * the track type precisely so that it can be exercised without libwebrtc's
 * native library, which every entry point of [VoiceEngine] needs.
 */
class RemoteVideoIndexTest {

    private fun index() = RemoteVideoIndex<String>()

    // --- one handle for the whole room -------------------------------------

    @Test
    fun `two peers sharing at once keep separate screens`() {
        val index = index()
        assertTrue(index.trackAdded("alice", "share-a", "track-a", "A"))
        assertTrue(index.trackAdded("bob", "share-b", "track-b", "B"))

        assertEquals("A", index.screenFor("alice"))
        assertEquals("B", index.screenFor("bob"))
        assertEquals(mapOf("alice" to "A", "bob" to "B"), index.screens())
    }

    @Test
    fun `one peer leaving does not take the other's screen with it`() {
        val index = index()
        index.trackAdded("alice", "share-a", "track-a", "A")
        index.trackAdded("bob", "share-b", "track-b", "B")

        assertTrue(index.forget("alice"))

        assertNull(index.screenFor("alice"))
        assertEquals("B", index.screenFor("bob"))
    }

    @Test
    fun `forgetting a peer with no screen reports no change`() {
        val index = index()
        index.trackAdded("alice", "share-a", "track-a", "A")
        assertFalse(index.forget("bob"))
    }

    @Test
    fun `clear names every peer that was showing something`() {
        val index = index()
        index.trackAdded("alice", "share-a", "track-a", "A")
        index.trackAdded("bob", "share-b", "track-b", "B")
        index.setCameraStreamId("carol", "cam-c")
        index.trackAdded("carol", "cam-c", "track-c", "C")

        // Carol is sending video, but it is her camera. She has no screen to
        // un-announce and must not be named here.
        assertEquals(setOf("alice", "bob"), index.clear())
        assertTrue(index.screens().isEmpty())
    }

    // --- camera versus screen ----------------------------------------------

    @Test
    fun `an announced camera is not a screen share`() {
        val index = index()
        index.setCameraStreamId("alice", "cam-a")

        assertFalse(index.trackAdded("alice", "cam-a", "track-cam", "CAM"))

        assertNull(index.screenFor("alice"))
        assertEquals("CAM", index.cameraFor("alice"))
    }

    @Test
    fun `a peer sending both has each filed correctly`() {
        val index = index()
        index.setCameraStreamId("alice", "cam-a")
        index.trackAdded("alice", "cam-a", "track-cam", "CAM")
        index.trackAdded("alice", "share-a", "track-share", "SCREEN")

        assertEquals("CAM", index.cameraFor("alice"))
        assertEquals("SCREEN", index.screenFor("alice"))
    }

    /**
     * The roster and the track race, and the camera announcement routinely
     * loses. Until it arrives the camera is the only video there is, so it is
     * classified as a screen; the announcement has to take it back.
     */
    @Test
    fun `a camera announced after its track arrives is reclassified`() {
        val index = index()
        assertTrue(index.trackAdded("alice", "cam-a", "track-cam", "CAM"))
        assertEquals("CAM", index.screenFor("alice"))

        assertTrue(index.setCameraStreamId("alice", "cam-a"))

        assertNull(index.screenFor("alice"))
        assertEquals("CAM", index.cameraFor("alice"))
    }

    @Test
    fun `a camera announced before its track never becomes a screen`() {
        val index = index()
        index.setCameraStreamId("alice", "cam-a")
        index.trackAdded("alice", "cam-a", "track-cam", "CAM")
        assertNull(index.screenFor("alice"))
    }

    /**
     * A sender's `removeTrack` only mutes the receiver's track, so a camera
     * turned off would otherwise sit in the map and be reclassified as a screen
     * share: a frozen frame, drawn as somebody's desktop.
     */
    @Test
    fun `a camera turned off is dropped rather than demoted to a screen`() {
        val index = index()
        index.setCameraStreamId("alice", "cam-a")
        index.trackAdded("alice", "cam-a", "track-cam", "CAM")

        assertFalse(index.setCameraStreamId("alice", null))

        assertNull(index.screenFor("alice"))
        assertNull(index.cameraFor("alice"))
    }

    @Test
    fun `turning a camera off leaves a live share alone`() {
        val index = index()
        index.setCameraStreamId("alice", "cam-a")
        index.trackAdded("alice", "cam-a", "track-cam", "CAM")
        index.trackAdded("alice", "share-a", "track-share", "SCREEN")

        assertFalse(index.setCameraStreamId("alice", null))

        assertEquals("SCREEN", index.screenFor("alice"))
    }

    @Test
    fun `a repeated camera announcement changes nothing`() {
        val index = index()
        index.setCameraStreamId("alice", "cam-a")
        index.trackAdded("alice", "cam-a", "track-cam", "CAM")
        assertFalse(index.setCameraStreamId("alice", "cam-a"))
    }

    // --- a share ending ----------------------------------------------------

    @Test
    fun `a removed video track clears the screen`() {
        val index = index()
        index.trackAdded("alice", "share-a", "track-a", "A")
        assertTrue(index.trackRemoved("alice", "track-a"))
        assertNull(index.screenFor("alice"))
    }

    @Test
    fun `removing an unknown track is a no-op`() {
        val index = index()
        index.trackAdded("alice", "share-a", "track-a", "A")
        assertFalse(index.trackRemoved("alice", "track-zzz"))
        assertEquals("A", index.screenFor("alice"))
    }

    /**
     * Sharing, stopping and sharing again. The dead first stream stays in the
     * map when the far end only mutes it, and it is still the first non-camera
     * entry, so the returning tile renders a stream with no frames in it.
     */
    @Test
    fun `a second share replaces the dead first one`() {
        val index = index()
        index.setSharingScreen("alice", true)
        index.trackAdded("alice", "share-1", "track-1", "FIRST")

        assertTrue(index.setSharingScreen("alice", false))
        assertNull(index.screenFor("alice"))

        index.setSharingScreen("alice", true)
        index.trackAdded("alice", "share-2", "track-2", "SECOND")

        assertEquals("SECOND", index.screenFor("alice"))
    }

    @Test
    fun `a repeated sharing frame cannot take a live share away`() {
        val index = index()
        index.setSharingScreen("alice", true)
        index.trackAdded("alice", "share-1", "track-1", "FIRST")

        assertFalse(index.setSharingScreen("alice", true))

        assertEquals("FIRST", index.screenFor("alice"))
    }

    @Test
    fun `a share ending never touches the camera`() {
        val index = index()
        index.setCameraStreamId("alice", "cam-a")
        index.trackAdded("alice", "cam-a", "track-cam", "CAM")
        index.setSharingScreen("alice", true)
        index.trackAdded("alice", "share-1", "track-1", "SCREEN")

        assertTrue(index.setSharingScreen("alice", false))

        assertNull(index.screenFor("alice"))
        assertEquals("CAM", index.cameraFor("alice"))
    }

    @Test
    fun `a share ending only affects the peer it names`() {
        val index = index()
        index.setSharingScreen("alice", true)
        index.trackAdded("alice", "share-a", "track-a", "A")
        index.setSharingScreen("bob", true)
        index.trackAdded("bob", "share-b", "track-b", "B")

        index.setSharingScreen("alice", false)

        assertNull(index.screenFor("alice"))
        assertEquals("B", index.screenFor("bob"))
    }

    // --- first wins ---------------------------------------------------------

    @Test
    fun `a second screen from one peer does not displace the first`() {
        val index = index()
        index.trackAdded("alice", "share-1", "track-1", "FIRST")
        assertFalse(index.trackAdded("alice", "share-2", "track-2", "SECOND"))
        assertEquals("FIRST", index.screenFor("alice"))
    }

    @Test
    fun `losing the first screen promotes the second`() {
        val index = index()
        index.trackAdded("alice", "share-1", "track-1", "FIRST")
        index.trackAdded("alice", "share-2", "track-2", "SECOND")
        assertTrue(index.trackRemoved("alice", "track-1"))
        assertEquals("SECOND", index.screenFor("alice"))
    }
}
