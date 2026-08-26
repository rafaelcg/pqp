package gg.pqp.app.voice

/**
 * Which of a peer's incoming video streams is their screen, and which is their
 * camera, for every peer at once.
 *
 * Two facts about a mesh make this a real piece of logic rather than a variable.
 *
 * **A room can hold more than one presenter.** The server allows it and the web
 * client renders it, so a receiver that keeps "the remote screen" as a single
 * handle shows whichever share arrived last and silently loses the other. That
 * is not a subtle failure: two people share, and one of them vanishes from
 * everybody's screen with nothing in any log about it.
 *
 * **A single peer can send two videos at once.** A web peer in a call with
 * their camera on and their screen shared is sending both down one connection,
 * and an incoming track carries nothing but its stream id (`a=msid`) to tell
 * them apart. The roster is what disambiguates: a participant announces
 * `cameraStreamId` over `set-camera`, and everything else from that peer is a
 * screen. Classifying by *elimination* like this is exactly what
 * `classifyVideo` in `client/src/lib/peer-connection-manager.ts` does, and the
 * two have to agree, because most people in any call here are on the web.
 *
 * Held generically over the track type so the whole rule is testable on the JVM.
 * Every entry point of [VoiceEngine] needs libwebrtc's native library loaded;
 * this needs nothing, which is the point.
 *
 * Not thread safe on its own. [VoiceEngine] confines it to `synchronized`
 * blocks, because the callers are libwebrtc's signalling thread and the
 * controller's coroutines and they genuinely do race.
 */
class RemoteVideoIndex<T : Any> {

    private class PeerVideo<T : Any> {
        /** Stream id to track, in arrival order, which decides first-wins ties. */
        val streams = LinkedHashMap<String, T>()

        /** Track id to the stream it arrived on, so a removal can find it. */
        val streamIdByTrack = HashMap<String, String>()

        /** The stream id this peer announced as their camera, or null. */
        var cameraStreamId: String? = null

        /** What the roster last said about this peer presenting. */
        var sharingScreen: Boolean = false

        var screen: T? = null
        var camera: T? = null
    }

    private val peers = HashMap<String, PeerVideo<T>>()

    /** Every peer with a live screen, keyed by peer id. */
    fun screens(): Map<String, T> =
        peers.mapNotNull { (peerId, video) -> video.screen?.let { peerId to it } }.toMap()

    fun screenFor(peerId: String): T? = peers[peerId]?.screen

    fun cameraFor(peerId: String): T? = peers[peerId]?.camera

    /**
     * File an incoming video track. Returns true when this peer's screen
     * changed, which is the only thing anything above here renders.
     */
    fun trackAdded(peerId: String, streamId: String, trackId: String, track: T): Boolean {
        val video = peers.getOrPut(peerId) { PeerVideo() }
        video.streams[streamId] = track
        video.streamIdByTrack[trackId] = streamId
        return classify(video)
    }

    /**
     * A track ended. Returns true when this peer's screen changed.
     *
     * libwebrtc does deliver `onRemoveTrack`, unlike a browser, so this is a
     * real signal here rather than the dead code it would be on the web. It is
     * still not the *only* signal: see [setSharingScreen].
     */
    fun trackRemoved(peerId: String, trackId: String): Boolean {
        val video = peers[peerId] ?: return false
        val streamId = video.streamIdByTrack.remove(trackId) ?: return false
        video.streams.remove(streamId)
        return classify(video)
    }

    /**
     * The roster named this peer's camera stream, or said the camera is off.
     *
     * Turning it off drops the stream outright rather than leaving it to be
     * reclassified as a screen share. A sender's `removeTrack` only *mutes* the
     * receiver's track, so the dead camera would otherwise sit in the map and
     * be drawn as a frozen frame the first time the peer stopped presenting.
     * The web client has the same line for the same reason.
     */
    fun setCameraStreamId(peerId: String, streamId: String?): Boolean {
        val video = peers.getOrPut(peerId) { PeerVideo() }
        if (video.cameraStreamId == streamId) return false
        val previous = video.cameraStreamId
        video.cameraStreamId = streamId
        if (streamId == null && previous != null) {
            video.streams.remove(previous)
            video.streamIdByTrack.entries.removeAll { it.value == previous }
        }
        return classify(video)
    }

    /**
     * The roster said this peer started or stopped presenting.
     *
     * The screen is the one incoming stream defined *negatively*, as "video
     * from this peer that is not their announced camera", so unlike the camera
     * it announces no id and has no natural end. Without this, a peer who
     * shares, stops and shares again leaves the first, dead stream in the map;
     * it is still the first non-camera entry, so the tile the roster just
     * brought back renders a stream with no frames in it. Permanently.
     *
     * Only the true to false edge drops anything, so a repeated roster frame
     * cannot take a live share away, and the camera is never touched.
     */
    fun setSharingScreen(peerId: String, sharing: Boolean): Boolean {
        val video = peers.getOrPut(peerId) { PeerVideo() }
        if (video.sharingScreen == sharing) return false
        video.sharingScreen = sharing
        if (sharing) return false
        val camera = video.cameraStreamId
        val dropped = video.streams.keys.filter { it != camera }
        if (dropped.isEmpty()) return false
        dropped.forEach { video.streams.remove(it) }
        video.streamIdByTrack.entries.removeAll { it.value in dropped }
        return classify(video)
    }

    /** The peer left. Returns true if they were showing a screen. */
    fun forget(peerId: String): Boolean = peers.remove(peerId)?.screen != null

    /** Returns the peers that were showing a screen, so each can be un-announced. */
    fun clear(): Set<String> {
        val showing = peers.filterValues { it.screen != null }.keys.toSet()
        peers.clear()
        return showing
    }

    /**
     * Re-derive both slots from the streams currently held.
     *
     * The announced id wins and everything else is a screen, which is
     * byte-for-byte the old behaviour for a peer that never turns a camera on
     * (the overwhelmingly common case, since this app has no camera to send).
     * Both slots are first-wins so that a second video arriving cannot take a
     * live one away.
     */
    private fun classify(video: PeerVideo<T>): Boolean {
        var camera: T? = null
        var screen: T? = null
        for ((id, track) in video.streams) {
            if (video.cameraStreamId != null && id == video.cameraStreamId) {
                if (camera == null) camera = track
            } else {
                if (screen == null) screen = track
            }
        }
        val changed = screen !== video.screen
        video.screen = screen
        video.camera = camera
        return changed
    }
}
