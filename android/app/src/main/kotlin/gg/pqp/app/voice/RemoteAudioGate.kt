package gg.pqp.app.voice

/**
 * Whether each peer's incoming audio is allowed to play, for every peer at once.
 *
 * Two things can switch a remote track off and they have nothing to do with
 * each other. **Deafening** is this device's own choice and covers the whole
 * room. A **server mute** is a moderator's decision about one participant and
 * travels on the roster (`VoiceParticipant.serverMuted`). On a mesh room the
 * server never touches media, so the mute is real only because every receiving
 * client enforces it here, exactly the way an eviction is real because every
 * client acts on the roster it is handed. A client that ignored the flag would
 * keep playing a person the whole room believes is silent.
 *
 * The two combine as an `or`, and both have to be remembered rather than
 * applied once, because the roster and the track race in both directions. The
 * roster that says "muted" routinely lands before the peer's audio track
 * exists, so the flag has to be waiting when the track arrives; and undeafening
 * has to leave a server-muted peer silent, so deafening cannot simply set every
 * track back to enabled.
 *
 * Held generically over the track type so the whole rule is testable on the
 * JVM, like [RemoteVideoIndex]. Every entry point of [VoiceEngine] needs
 * libwebrtc's native library; this needs nothing but the [apply] callback, which
 * the engine binds to `AudioTrack.setEnabled`.
 *
 * Not thread safe on its own. [VoiceEngine] confines it to `synchronized`
 * blocks, because the callers are libwebrtc's signalling thread and the
 * controller's coroutines.
 */
class RemoteAudioGate<T : Any>(
    /** Switch one track's playout on or off. */
    private val apply: (track: T, enabled: Boolean) -> Unit,
) {

    private class PeerAudio<T : Any> {
        /**
         * Track id to track. Per **track**, not per peer: a peer sharing a
         * screen with its sound sends a second audio track alongside the
         * microphone, and a single handle would lose one of them.
         */
        val tracks = HashMap<String, T>()

        /** What the roster last said about a moderator muting this peer. */
        var serverMuted: Boolean = false
    }

    private val peers = HashMap<String, PeerAudio<T>>()

    private var deafened: Boolean = false

    /** True when this peer's audio should currently be heard. */
    fun plays(peerId: String): Boolean =
        !deafened && peers[peerId]?.serverMuted != true

    /** The roster's view of this peer, whether or not a track has arrived. */
    fun isServerMuted(peerId: String): Boolean = peers[peerId]?.serverMuted == true

    /**
     * A remote audio track arrived. It is switched to the right state at once,
     * so a track that lands after the roster already flagged its peer never
     * plays a frame.
     */
    fun trackAdded(peerId: String, trackId: String, track: T) {
        val audio = peers.getOrPut(peerId) { PeerAudio() }
        audio.tracks[trackId] = track
        apply(track, plays(peerId))
    }

    fun trackRemoved(peerId: String, trackId: String) {
        peers[peerId]?.tracks?.remove(trackId)
    }

    /**
     * The roster said a moderator muted or unmuted this peer.
     *
     * Returns true when the peer's flag changed, so the caller can log it or
     * refresh a tile; the tracks themselves are already switched. Fed from
     * whole rosters rather than from diffs, and a repeat is a no-op.
     */
    fun setServerMuted(peerId: String, muted: Boolean): Boolean {
        val audio = peers.getOrPut(peerId) { PeerAudio() }
        if (audio.serverMuted == muted) return false
        audio.serverMuted = muted
        refresh(peerId, audio)
        return true
    }

    /**
     * This device stopped, or resumed, listening to the whole room.
     *
     * Resuming re-derives every peer rather than enabling every track, which is
     * the whole reason this class holds the mute flags: undeafening must not
     * bring a server-muted peer back.
     */
    fun setDeafened(value: Boolean) {
        if (deafened == value) return
        deafened = value
        peers.forEach { (peerId, audio) -> refresh(peerId, audio) }
    }

    /** The peer left. Their tracks are gone with the connection. */
    fun forget(peerId: String) {
        peers.remove(peerId)
    }

    /**
     * The room is gone. Deafening survives, because it is this device's own
     * setting and the person did not change it; the per-peer flags do not,
     * because the next room mints new peer ids and sends a fresh roster.
     */
    fun clear() {
        peers.clear()
    }

    private fun refresh(peerId: String, audio: PeerAudio<T>) {
        val enabled = plays(peerId)
        audio.tracks.values.forEach { apply(it, enabled) }
    }
}
