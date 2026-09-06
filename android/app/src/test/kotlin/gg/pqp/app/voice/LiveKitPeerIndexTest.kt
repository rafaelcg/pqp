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
