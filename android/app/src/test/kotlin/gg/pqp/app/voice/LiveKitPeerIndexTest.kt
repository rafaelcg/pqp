package gg.pqp.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The SFU path's bookkeeping, which is the only part of it a JVM test can run.
 *
 * There is no device and no SFU here, so nothing in this module can prove that
 * audio arrives. What it can prove is that the record of *whose audio has
 * arrived* is not confused by the three cases that actually happen: a
 * participant present before they publish, a participant publishing more than
 * one audio track at once, and a room that was already in progress when this
 * device joined.
 */
class LiveKitPeerIndexTest {

    @Test
    fun `an unknown peer is connecting, not failed`() {
        val index = LiveKitPeerIndex()
        assertEquals(PeerMediaState.Connecting, index.stateFor("nobody"))
    }

    @Test
    fun `a peer with no tracks yet is connecting`() {
        val index = LiveKitPeerIndex()
        assertTrue(index.seen("alice"))
        assertFalse("seeing the same peer twice is not news", index.seen("alice"))
        assertEquals(PeerMediaState.Connecting, index.stateFor("alice"))
    }

    @Test
    fun `a subscribed voice track makes a peer connected`() {
        val index = LiveKitPeerIndex()
        assertTrue(index.voiceTrackAdded("alice", "TR_1"))
        assertEquals(PeerMediaState.Connected, index.stateFor("alice"))
    }

    /** A track arriving before any participant event still registers the peer. */
    @Test
    fun `a track can arrive before the participant is seen`() {
        val index = LiveKitPeerIndex()
        index.voiceTrackAdded("alice", "TR_1")
        assertFalse("the peer is already known", index.seen("alice"))
        assertEquals(PeerMediaState.Connected, index.stateFor("alice"))
    }

    /**
     * The reason tracks are a set and not a flag.
     *
     * Somebody sharing a screen with sound publishes a second audio track. Held
     * as a boolean, the first unsubscribe of the two clears it, and the person
     * goes grey in the middle of a sentence. The mesh path learned this the
     * same way (see `Peer.remoteAudio`, keyed per track).
     */
    @Test
    fun `losing one of two audio tracks leaves a peer connected`() {
        val index = LiveKitPeerIndex()
        index.voiceTrackAdded("alice", "TR_mic")
        index.voiceTrackAdded("alice", "TR_screen_audio")
        assertTrue(index.voiceTrackRemoved("alice", "TR_screen_audio"))
        assertEquals(PeerMediaState.Connected, index.stateFor("alice"))

        assertTrue(index.voiceTrackRemoved("alice", "TR_mic"))
        assertEquals(PeerMediaState.Connecting, index.stateFor("alice"))
    }

    @Test
    fun `repeats are absorbed rather than double counted`() {
        val index = LiveKitPeerIndex()
        assertTrue(index.voiceTrackAdded("alice", "TR_1"))
        assertFalse("the same track twice is not a change", index.voiceTrackAdded("alice", "TR_1"))
        assertTrue(index.voiceTrackRemoved("alice", "TR_1"))
        assertFalse("removing it twice is not a change", index.voiceTrackRemoved("alice", "TR_1"))
        assertFalse("nor is removing one that never arrived", index.voiceTrackRemoved("bob", "TR_9"))
    }

    @Test
    fun `forgetting a peer drops their tracks with them`() {
        val index = LiveKitPeerIndex()
        index.voiceTrackAdded("alice", "TR_1")
        assertTrue(index.forget("alice"))
        assertFalse("forgetting twice is not news", index.forget("alice"))
        assertEquals(PeerMediaState.Connecting, index.stateFor("alice"))
        assertEquals(0, index.size)
    }

    @Test
    fun `clear hands back everybody it was holding`() {
        val index = LiveKitPeerIndex()
        index.seen("alice")
        index.voiceTrackAdded("bob", "TR_2")
        assertEquals(setOf("alice", "bob"), index.peerIds())
        assertEquals(setOf("alice", "bob"), index.clear())
        assertEquals(emptySet<String>(), index.peerIds())
        assertEquals(0, index.size)
    }

    /**
     * The join snapshot, which is the only way the already-present are seen.
     *
     * LiveKit builds the participants named in the join response without
     * emitting `ParticipantConnected` for them, so [LiveKitPeerIndex.seedAll]
     * is what stands between "joined a call in progress" and "joined an empty
     * room". It reports back only what was news, because the caller turns that
     * into one peer state callback each.
     */
    @Test
    fun `seeding reports only the peers that were not already known`() {
        val index = LiveKitPeerIndex()
        index.voiceTrackAdded("alice", "TR_1")

        val fresh = index.seedAll(listOf("alice", "bob", "carol"))

        assertEquals(setOf("bob", "carol"), fresh)
        assertEquals(setOf("alice", "bob", "carol"), index.peerIds())
        assertEquals(
            "seeding must not forget a peer's tracks",
            PeerMediaState.Connected,
            index.stateFor("alice"),
        )
        assertEquals(PeerMediaState.Connecting, index.stateFor("bob"))
        assertEquals(emptySet<String>(), index.seedAll(listOf("alice", "bob")))
    }

    @Test
    fun `seeding an empty room is not news about anybody`() {
        val index = LiveKitPeerIndex()
        assertEquals(emptySet<String>(), index.seedAll(emptyList()))
        assertEquals(0, index.size)
    }

    /**
     * Never Failed and never Silent, and that is a claim about the transport.
     *
     * On a mesh those two states are earned per peer, from a per-peer
     * connection and its packet counters. On an SFU there is one connection and
     * it is this device's own, so a per-peer verdict of "unreachable" would be
     * a fact this index cannot possibly know. When the SFU leg does collapse,
     * the whole call leaves (`Refusal.VoiceBackendUnreachable`) rather than
     * blaming individuals.
     */
    @Test
    fun `no peer is ever reported as failed or silent`() {
        val index = LiveKitPeerIndex()
        index.seen("alice")
        index.voiceTrackAdded("bob", "TR_2")
        index.voiceTrackRemoved("bob", "TR_2")
        listOf("alice", "bob", "carol").forEach { peer ->
            val state = index.stateFor(peer)
            assertTrue(
                "$peer was reported as $state",
                state == PeerMediaState.Connecting || state == PeerMediaState.Connected,
            )
        }
    }
}

/**
 * Which of a participant's video publications is the screen being shown.
 *
 * The SFU labels the source, so unlike the mesh there is no elimination to do;
 * what is left is the ordering: a re-share can publish its new track before
 * the old one's unsubscribe lands, and the dead one's exit must not take the
 * live one off the screen.
 */
class LiveKitScreenIndexTest {

    @Test
    fun `the first screen from a peer is shown`() {
        val index = LiveKitPeerIndex()
        assertTrue(index.screenTrackAdded("alice", "TR_1"))
        assertEquals("TR_1", index.screenTrackFor("alice"))
        assertEquals(setOf("alice"), index.screenPeerIds())
    }

    @Test
    fun `a second screen while one is live is not shown`() {
        val index = LiveKitPeerIndex()
        index.screenTrackAdded("alice", "TR_1")
        assertFalse(index.screenTrackAdded("alice", "TR_2"))
        assertEquals("TR_1", index.screenTrackFor("alice"))
    }

    @Test
    fun `removing the shown screen clears it, removing another does not`() {
        val index = LiveKitPeerIndex()
        index.screenTrackAdded("alice", "TR_1")
        assertFalse(
            "a sid never shown must not clear a live share",
            index.screenTrackRemoved("alice", "TR_2"),
        )
        assertEquals("TR_1", index.screenTrackFor("alice"))
        assertTrue(index.screenTrackRemoved("alice", "TR_1"))
        assertEquals(null, index.screenTrackFor("alice"))
        assertTrue(index.screenPeerIds().isEmpty())
    }

    @Test
    fun `a re-share after the old one ended is shown`() {
        val index = LiveKitPeerIndex()
        index.screenTrackAdded("alice", "TR_1")
        index.screenTrackRemoved("alice", "TR_1")
        assertTrue(index.screenTrackAdded("alice", "TR_2"))
        assertEquals("TR_2", index.screenTrackFor("alice"))
    }

    @Test
    fun `screens and voice tracks are separate facts`() {
        val index = LiveKitPeerIndex()
        index.screenTrackAdded("alice", "TR_1")
        assertEquals(
            "a screen alone does not make somebody audible",
            PeerMediaState.Connecting,
            index.stateFor("alice"),
        )
        index.voiceTrackAdded("alice", "TR_9")
        assertEquals(PeerMediaState.Connected, index.stateFor("alice"))
        index.voiceTrackRemoved("alice", "TR_9")
        assertEquals("TR_1", index.screenTrackFor("alice"))
    }

    @Test
    fun `forgetting a peer drops their screen`() {
        val index = LiveKitPeerIndex()
        index.screenTrackAdded("alice", "TR_1")
        index.forget("alice")
        assertEquals(null, index.screenTrackFor("alice"))
    }
}

/**
 * The camera slot: which of a participant's video publications is their face,
 * and whether it is worth drawing at all.
 *
 * The screen's twin, and it is a separate slot rather than a shared "video"
 * one for the reason the 5 Sep watch party found the hard way: a presenter can
 * have her screen and her camera up at the same time, and anything that keeps
 * one handle per peer loses whichever arrived second.
 */
class LiveKitCameraIndexTest {

    @Test
    fun `a camera and a screen from one peer are both held`() {
        val index = LiveKitPeerIndex()
        assertTrue(index.screenTrackAdded("alice", "TR_SCREEN"))
        assertTrue(index.cameraTrackAdded("alice", "TR_CAM"))
        assertEquals("TR_SCREEN", index.screenTrackFor("alice"))
        assertEquals("TR_CAM", index.cameraTrackFor("alice"))
        assertEquals(setOf("alice"), index.screenPeerIds())
        assertEquals(setOf("alice"), index.cameraPeerIds())
    }

    @Test
    fun `ending a share leaves the camera alone`() {
        val index = LiveKitPeerIndex()
        index.screenTrackAdded("alice", "TR_SCREEN")
        index.cameraTrackAdded("alice", "TR_CAM")
        assertTrue(index.screenTrackRemoved("alice", "TR_SCREEN"))
        assertEquals(
            "the camera must survive the share it was sitting next to",
            "TR_CAM",
            index.cameraTrackFor("alice"),
        )
        assertEquals(setOf("alice"), index.cameraPeerIds())
    }

    @Test
    fun `turning a camera off and on again is shown both times`() {
        val index = LiveKitPeerIndex()
        index.cameraTrackAdded("alice", "TR_1")
        assertTrue(index.cameraTrackRemoved("alice", "TR_1"))
        assertEquals(null, index.cameraTrackFor("alice"))
        assertTrue(index.cameraTrackAdded("alice", "TR_2"))
        assertEquals("TR_2", index.cameraTrackFor("alice"))
    }

    @Test
    fun `an unsubscribe for a sid never shown does not clear a live camera`() {
        val index = LiveKitPeerIndex()
        index.cameraTrackAdded("alice", "TR_1")
        assertFalse(index.cameraTrackRemoved("alice", "TR_2"))
        assertEquals("TR_1", index.cameraTrackFor("alice"))
    }

    /**
     * A reconnect re-subscribes what the room already had, so the same sid
     * comes back carrying a new track object. Refusing it as a duplicate is how
     * a tile ends up holding the track from before the drop, which never
     * receives another frame: a face frozen for the rest of the call.
     */
    @Test
    fun `the same sid arriving again is accepted, on both slots`() {
        val index = LiveKitPeerIndex()
        index.cameraTrackAdded("alice", "TR_CAM")
        index.screenTrackAdded("alice", "TR_SCREEN")
        assertTrue(
            "a reconnect re-subscribes the camera it already had",
            index.cameraTrackAdded("alice", "TR_CAM"),
        )
        assertTrue(
            "and the share it already had",
            index.screenTrackAdded("alice", "TR_SCREEN"),
        )
    }

    @Test
    fun `a second camera while one is live is ignored`() {
        val index = LiveKitPeerIndex()
        index.cameraTrackAdded("alice", "TR_1")
        assertFalse(index.cameraTrackAdded("alice", "TR_2"))
        assertEquals("TR_1", index.cameraTrackFor("alice"))
    }

    @Test
    fun `a muted camera is held but not drawn`() {
        val index = LiveKitPeerIndex()
        index.cameraTrackAdded("alice", "TR_1")
        assertTrue(index.setCameraMuted("alice", true))
        assertTrue(index.isCameraMuted("alice"))
        assertEquals(
            "a muted camera would draw one frozen frame; it is not a tile",
            emptySet<String>(),
            index.cameraPeerIds(),
        )
        assertEquals(
            "the subscription is untouched; only the drawing stopped",
            "TR_1",
            index.cameraTrackFor("alice"),
        )
        assertTrue(index.setCameraMuted("alice", false))
        assertEquals(setOf("alice"), index.cameraPeerIds())
    }

    @Test
    fun `a repeated mute changes nothing`() {
        val index = LiveKitPeerIndex()
        index.cameraTrackAdded("alice", "TR_1")
        assertTrue(index.setCameraMuted("alice", true))
        assertFalse(index.setCameraMuted("alice", true))
    }

    @Test
    fun `a mute for a peer with no camera is not a tile change`() {
        val index = LiveKitPeerIndex()
        index.voiceTrackAdded("alice", "TR_MIC")
        assertFalse(
            "nothing was being drawn, so nothing appears or disappears",
            index.setCameraMuted("alice", true),
        )
    }

    /**
     * The camera came back after being muted, so the mute must not come back
     * with it: the flag belongs to the publication that has gone, and a fresh
     * one that arrives unmuted would otherwise be invisible forever.
     */
    @Test
    fun `unsubscribing a muted camera clears the mute`() {
        val index = LiveKitPeerIndex()
        index.cameraTrackAdded("alice", "TR_1")
        index.setCameraMuted("alice", true)
        index.cameraTrackRemoved("alice", "TR_1")
        index.cameraTrackAdded("alice", "TR_2")
        assertFalse(index.isCameraMuted("alice"))
        assertEquals(setOf("alice"), index.cameraPeerIds())
    }

    @Test
    fun `forgetting a peer drops their camera`() {
        val index = LiveKitPeerIndex()
        index.cameraTrackAdded("alice", "TR_1")
        index.forget("alice")
        assertEquals(null, index.cameraTrackFor("alice"))
        assertTrue(index.cameraPeerIds().isEmpty())
    }

    @Test
    fun `clearing the room drops every camera`() {
        val index = LiveKitPeerIndex()
        index.cameraTrackAdded("alice", "TR_1")
        index.cameraTrackAdded("bob", "TR_2")
        assertEquals(setOf("alice", "bob"), index.clear())
        assertTrue(index.cameraPeerIds().isEmpty())
    }
}
