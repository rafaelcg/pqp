package gg.pqp.app.voice

import android.content.Context
import android.util.Log
import gg.pqp.app.core.IceServer
import java.util.concurrent.ConcurrentHashMap
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Whether one peer has a working media path.
 *
 * Reported per peer rather than for the room, because in a mesh they genuinely
 * differ: one participant can be unreachable while the rest of the call is
 * fine, and a single room-level flag would either hide that or condemn the
 * whole call for it.
 */
enum class PeerMediaState { Connecting, Connected, Failed }

/**
 * Full-mesh WebRTC audio, matching the server's default backend.
 *
 * The signalling relay is the same `/ws` socket the chat uses; this class owns
 * the peer connections and nothing else. It sends through [signal] and is fed
 * by the controller above it, so it has no opinion about rosters, foreground
 * services or the UI.
 *
 * **The politeness rule has to match `client/src/lib/peer-connection-manager.ts`
 * exactly.** There, `isImpolite(local, remote) = local > remote`: the peer whose
 * id sorts *higher* sends the initial offer. Invert it and two peers either both
 * offer (glare) or neither does (a silent deadlock where everyone sits in
 * `connecting` forever), and it looks fine until two *different* clients meet in
 * one room, which is exactly the case no single-client test covers.
 */
class VoiceEngine(
    private val context: Context,
    private val signal: (Map<String, Any?>) -> Unit,
    private val onPeerState: (String, PeerMediaState) -> Unit,
) {
    private var factory: PeerConnectionFactory? = null
    private var audioDeviceModule: JavaAudioDeviceModule? = null
    private var localAudio: AudioTrack? = null

    private val peers = ConcurrentHashMap<String, Peer>()

    @Volatile private var localPeerId: String? = null
    @Volatile private var iceServers: List<PeerConnection.IceServer> = emptyList()
    @Volatile private var deafened: Boolean = false

    private class Peer(val connection: PeerConnection) {
        /**
         * One ICE restart per peer, and only one.
         *
         * A failed connection is worth one more attempt at finding a path,
         * which is what an ICE restart is for. Retrying forever is not: without
         * TURN there is no path to find, and a loop of restarts burns battery
         * while the call stays silent either way.
         */
        @Volatile var restarted = false

        /**
         * Candidates that arrived before a remote description existed.
         *
         * They routinely do, and adding one early is an error rather than a
         * no-op, so they wait here until there is something to attach them to.
         */
        val pendingCandidates = mutableListOf<IceCandidate>()

        @Volatile var hasRemoteDescription = false

        /**
         * Remote tracks filed per **track**, not per peer.
         *
         * A peer can send more than one audio track: sharing a screen with its
         * sound publishes the machine's audio alongside the microphone. Keyed by
         * peer alone the second overwrites the first and takes the only handle
         * on the microphone with it, so deafening silences the screen and leaves
         * the presenter's voice playing. Neither half logs anything.
         */
        val remoteAudio = ConcurrentHashMap<String, AudioTrack>()
    }

    fun start(localPeerId: String, ice: List<IceServer>) {
        this.localPeerId = localPeerId
        this.iceServers = ice.flatMap { server ->
            server.urlList.map { url ->
                PeerConnection.IceServer.builder(url)
                    .setUsername(server.username.orEmpty())
                    .setPassword(server.credential.orEmpty())
                    .createIceServer()
            }
        }

        if (factory == null) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context)
                    .createInitializationOptions(),
            )
            // Hardware echo cancellation and noise suppression where the device
            // has them. Without AEC a speakerphone call feeds itself back into
            // the mesh and every other participant hears themselves.
            val adm = JavaAudioDeviceModule.builder(context)
                .setUseHardwareAcousticEchoCanceler(true)
                .setUseHardwareNoiseSuppressor(true)
                .createAudioDeviceModule()
            audioDeviceModule = adm
            factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                .createPeerConnectionFactory()
        }

        if (localAudio == null) {
            val source = factory!!.createAudioSource(MediaConstraints())
            localAudio = factory!!.createAudioTrack(LOCAL_AUDIO_ID, source)
        }
    }

    fun setMuted(muted: Boolean) {
        localAudio?.setEnabled(!muted)
    }

    /**
     * Deafening silences every remote track **and** forces the microphone off.
     *
     * Being heard while hearing nothing is a trap rather than a feature, and it
     * is what the web and iOS clients both do.
     */
    fun setDeafened(value: Boolean, mutedByUser: Boolean) {
        deafened = value
        peers.values.forEach { peer ->
            peer.remoteAudio.values.forEach { it.setEnabled(!value) }
        }
        localAudio?.setEnabled(!(value || mutedByUser))
    }

    fun addPeer(remotePeerId: String) {
        val local = localPeerId ?: return
        if (peers.containsKey(remotePeerId)) return

        val peer = createPeer(remotePeerId) ?: return
        peers[remotePeerId] = peer

        // Exactly one side offers, and it is the one whose id sorts higher.
        // See `Politeness.kt`, which is the single copy of that rule.
        if (isImpolite(local, remotePeerId)) negotiate(remotePeerId, peer)
    }

    fun removePeer(remotePeerId: String) {
        peers.remove(remotePeerId)?.connection?.dispose()
    }


    fun handleOffer(from: String, sdp: String) {
        val peer = peers.getOrPut(from) { createPeer(from) ?: return }
        peer.connection.setRemoteDescription(
            observer(
                onSet = {
                    peer.hasRemoteDescription = true
                    drainCandidates(peer)
                    answer(from, peer)
                },
            ),
            SessionDescription(SessionDescription.Type.OFFER, sdp),
        )
    }

    fun handleAnswer(from: String, sdp: String) {
        val peer = peers[from] ?: return
        peer.connection.setRemoteDescription(
            observer(
                onSet = {
                    peer.hasRemoteDescription = true
                    drainCandidates(peer)
                },
            ),
            SessionDescription(SessionDescription.Type.ANSWER, sdp),
        )
    }

    /**
     * A `null` candidate is end-of-candidates, not an error. Treating it as a
     * failure is a mesh that logs a warning per peer and works anyway, which is
     * the kind of noise that hides a real one.
     */
    fun handleCandidate(from: String, sdpMid: String?, sdpMLineIndex: Int?, candidate: String?) {
        if (candidate.isNullOrEmpty()) return
        val peer = peers[from] ?: return
        val ice = IceCandidate(sdpMid.orEmpty(), sdpMLineIndex ?: 0, candidate)
        if (peer.hasRemoteDescription) {
            peer.connection.addIceCandidate(ice)
        } else {
            synchronized(peer.pendingCandidates) { peer.pendingCandidates += ice }
        }
    }

    /** Tears the whole mesh down. The factory is kept for the next call. */
    fun stop() {
        peers.values.forEach { runCatching { it.connection.dispose() } }
        peers.clear()
        localPeerId = null
    }

    fun dispose() {
        stop()
        localAudio = null
        factory?.dispose()
        factory = null
        audioDeviceModule?.release()
        audioDeviceModule = null
    }

    val peerCount: Int get() = peers.size

    // --- internals ---

    private fun createPeer(remotePeerId: String): Peer? {
        val factory = factory ?: return null
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            // Keeps gathering after the first pair is found, which is what lets
            // an ICE restart find a TURN path when the direct one dies.
            continualGatheringPolicy =
                PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

        val connection = factory.createPeerConnection(
            config,
            PeerObserver(remotePeerId),
        ) ?: return null

        localAudio?.let { connection.addTrack(it, listOf(LOCAL_STREAM_ID)) }
        return Peer(connection)
    }

    private fun negotiate(remotePeerId: String, peer: Peer, iceRestart: Boolean = false) {
        val constraints = MediaConstraints().apply {
            if (iceRestart) {
                mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
            }
        }
        peer.connection.createOffer(
            observer(
                onCreate = { description ->
                    peer.connection.setLocalDescription(observer(), description)
                    signal(
                        mapOf(
                            "type" to "offer",
                            "from" to localPeerId,
                            "to" to remotePeerId,
                            "sdp" to description.description,
                        ),
                    )
                },
            ),
            constraints,
        )
    }

    private fun answer(remotePeerId: String, peer: Peer) {
        peer.connection.createAnswer(
            observer(
                onCreate = { description ->
                    peer.connection.setLocalDescription(observer(), description)
                    signal(
                        mapOf(
                            "type" to "answer",
                            "from" to localPeerId,
                            "to" to remotePeerId,
                            "sdp" to description.description,
                        ),
                    )
                },
            ),
            MediaConstraints(),
        )
    }

    private fun drainCandidates(peer: Peer) {
        synchronized(peer.pendingCandidates) {
            peer.pendingCandidates.forEach { peer.connection.addIceCandidate(it) }
            peer.pendingCandidates.clear()
        }
    }

    private inner class PeerObserver(private val remotePeerId: String) : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            signal(
                mapOf(
                    "type" to "ice-candidate",
                    "from" to localPeerId,
                    "to" to remotePeerId,
                    "candidate" to mapOf(
                        "candidate" to candidate.sdp,
                        "sdpMid" to candidate.sdpMid,
                        "sdpMLineIndex" to candidate.sdpMLineIndex,
                    ),
                ),
            )
        }

        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
            val track = receiver.track() ?: return
            if (track.kind() != MediaStreamTrack.AUDIO_TRACK_KIND) return
            val audio = track as AudioTrack
            audio.setEnabled(!deafened)
            // WebRTC plays a received audio track by itself, so there is
            // nothing to start here. The handle is kept only so that deafening
            // has something to switch off.
            peers[remotePeerId]?.remoteAudio?.put(audio.id(), audio)
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            Log.i(TAG, "peer $remotePeerId -> $newState")
            when (newState) {
                PeerConnection.PeerConnectionState.CONNECTED ->
                    onPeerState(remotePeerId, PeerMediaState.Connected)

                PeerConnection.PeerConnectionState.FAILED -> {
                    val peer = peers[remotePeerId]
                    val local = localPeerId
                    // The impolite side drives the restart, for the same reason
                    // it drives the first offer: two simultaneous restarts are
                    // glare wearing a different hat.
                    if (peer != null && local != null && !peer.restarted &&
                        isImpolite(local, remotePeerId)
                    ) {
                        peer.restarted = true
                        Log.i(TAG, "peer $remotePeerId failed; restarting ICE")
                        negotiate(remotePeerId, peer, iceRestart = true)
                        onPeerState(remotePeerId, PeerMediaState.Connecting)
                    } else {
                        onPeerState(remotePeerId, PeerMediaState.Failed)
                    }
                }

                else -> onPeerState(remotePeerId, PeerMediaState.Connecting)
            }
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(channel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onTrack(transceiver: RtpTransceiver) = Unit
    }

    private fun observer(
        onCreate: (SessionDescription) -> Unit = {},
        onSet: () -> Unit = {},
    ) = object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = onCreate(description)
        override fun onSetSuccess() = onSet()
        override fun onCreateFailure(error: String?) {
            Log.w(TAG, "createOffer/Answer failed: $error")
        }

        override fun onSetFailure(error: String?) {
            Log.w(TAG, "setDescription failed: $error")
        }
    }

    companion object {
        private const val TAG = "pqp.voice"
        private const val LOCAL_AUDIO_ID = "pqp-mic"
        private const val LOCAL_STREAM_ID = "pqp-local"
    }
}
