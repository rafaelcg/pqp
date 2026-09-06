package gg.pqp.app.voice

/**
 * Who, on an SFU, is actually delivering audio to this device.
 *
 * The twin of [RemoteVideoIndex] for the one question the SFU path has to
 * answer honestly: a participant being *in the room* is not the same as their
 * voice arriving, and a client that reports the first as the second is the
 * shape of failure this project has shipped before (see [PeerMediaState.Silent]
 * on the mesh side).
 *
 * Pure and separate from the LiveKit SDK on purpose: there is no device in this
 * module's test suite, so the bookkeeping is the only part of the SFU path that
 * can be tested at all, and it is worth keeping it in one testable place.
 *
 * ### What this does not feed, yet
 *
 * Nothing the person sees. [stateFor] is handed to
 * `VoiceController.onPeerMediaState`, which folds it into `unreachablePeers`,
 * and that counter only counts [PeerMediaState.Failed] and
 * [PeerMediaState.Silent]. This index returns neither, ever (see [stateFor],
 * and the test that pins it), so on the LiveKit path `unreachablePeers` is
 * permanently 0 and the call bar's warning never appears. That is deliberate
 * rather than broken: an SFU has one connection and it is this device's own, so
 * a per-peer verdict of "unreachable" is not this index's to give, and the
 * transport reports its own collapse by leaving the call instead.
 *
 * What it is for is the honest answer to "is this participant's voice actually
 * arriving here", which is the fact a speaking indicator or a per-peer
 * connecting state would be built from. Until one of those exists, this is
 * bookkeeping with no display attached to it.
 *
 * Keyed by pqp **peer id**, which on this transport is the LiveKit participant
 * identity. The server mints the token with the WS-assigned peer id as the
 * identity (`createLiveKitSession`, called with `body.peerId`). LiveKit is the
 * source of media; `/ws` stays the source of who. Nothing here ever sees a
 * user id.
 */
class LiveKitPeerIndex {

    private class Peer {
        /** Voice track sids currently subscribed. A set, not a flag: see below. */
        val voiceTracks = mutableSetOf<String>()
    }

    private val peers = mutableMapOf<String, Peer>()

    /**
     * A participant appeared in the room, with no media yet.
     *
     * True when this is news. Reported as [PeerMediaState.Connecting] rather
     * than as a failure: somebody who has joined but not yet published is
     * normal for the first second of every call, and calling that "unreachable"
     * would put a warning on every healthy join.
     */
    fun seen(peerId: String): Boolean {
        if (peers.containsKey(peerId)) return false
        peers[peerId] = Peer()
        return true
    }

    /**
     * One of this participant's voice tracks was subscribed.
     *
     * Tracked as a **set of track sids**, not a boolean, for the same reason
     * `Peer.remoteAudio` on the mesh side is keyed per track: a participant can
     * have more than one audio publication at once (a screen share with sound
     * publishes a second one), so a flag would be cleared by the *first*
     * unsubscribe and mark somebody silent while they are still talking. The
     * caller is responsible for having already filtered out
     * `SCREEN_SHARE_AUDIO`; this only refuses to assume there is exactly one of
     * whatever it is given.
     */
    fun voiceTrackAdded(peerId: String, trackSid: String): Boolean {
        val peer = peers.getOrPut(peerId) { Peer() }
        return peer.voiceTracks.add(trackSid)
    }

    fun voiceTrackRemoved(peerId: String, trackSid: String): Boolean {
        val peer = peers[peerId] ?: return false
        return peer.voiceTracks.remove(trackSid)
    }

    /**
     * Everybody who was already in the room when this device joined.
     *
     * Returns the ids that were news, so the caller can report exactly those.
     * A separate entry point from [seen] because the join snapshot is the case
     * that has no event behind it: LiveKit builds the already-present
     * participants from the join response without emitting
     * `ParticipantConnected` for them, so a client that only listened for that
     * event would never see the people it just walked in on.
     */
    fun seedAll(peerIds: Collection<String>): Set<String> =
        peerIds.filterTo(mutableSetOf()) { seen(it) }

    /** True when the peer was known. */
    fun forget(peerId: String): Boolean = peers.remove(peerId) != null

    /** Every peer id this index holds, then empties itself. */
    fun clear(): Set<String> {
        val known = peers.keys.toSet()
        peers.clear()
        return known
    }

    fun peerIds(): Set<String> = peers.keys.toSet()

    val size: Int get() = peers.size

    /**
     * What the call bar should say about this peer.
     *
     * Never [PeerMediaState.Failed]. On an SFU there is exactly one connection
     * and it is this device's own: a peer whose audio has not arrived is a fact
     * about the room, not about a path between two people, and the transport
     * reports its own collapse through the room's disconnect rather than by
     * condemning individuals. [PeerMediaState.Silent] is likewise not reachable
     * from here: the mesh earns it from packet counters, and the counters this
     * transport exposes are in the other libwebrtc's types.
     */
    fun stateFor(peerId: String): PeerMediaState {
        val peer = peers[peerId] ?: return PeerMediaState.Connecting
        return if (peer.voiceTracks.isEmpty()) {
            PeerMediaState.Connecting
        } else {
            PeerMediaState.Connected
        }
    }
}
