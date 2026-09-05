package gg.pqp.app.voice

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.SystemClock
import android.util.Log
import gg.pqp.app.core.IceServer
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Whether one peer has a working media path.
 *
 * Reported per peer rather than for the room, because in a mesh they genuinely
 * differ: one participant can be unreachable while the rest of the call is
 * fine, and a single room-level flag would either hide that or condemn the
 * whole call for it.
 */
enum class PeerMediaState {
    Connecting,
    Connected,

    /**
     * The connection came up and no audio ever arrived on it.
     *
     * A separate value from [Failed] because it is a separate failure, and it
     * is the one that hides: ICE succeeded, DTLS completed, the roster is
     * right, and the person hears nothing. Anything that reads
     * `PeerConnectionState.CONNECTED` as "they can hear me" is wrong, and this
     * project has shipped that reading before.
     */
    Silent,
    Failed,
}

/**
 * Full-mesh WebRTC audio and screen video, matching the server's default backend.
 *
 * The signalling relay is the same `/ws` socket the chat uses; this class owns
 * the peer connections and nothing else. It sends through [signal] and is fed
 * by the controller above it, so it has no opinion about rosters, foreground
 * services or the UI.
 *
 * **Negotiation is the real perfect-negotiation pattern, not the one line of
 * it.** The politeness comparison has to match
 * `client/src/lib/peer-connection-manager.ts` exactly. There,
 * `isImpolite(local, remote) = local > remote`, and on a collision the
 * *impolite* side rolls its own offer back and takes the other's while the
 * polite side drops the incoming one on the floor. That convention is unusual
 * (the spec's roles are the other way round) but it is the one the shipped web
 * client uses, and an Android client that picks the spec's convention instead
 * would have both sides yield or neither.
 *
 * Getting only the *first* offer right is not enough, and that is what this
 * class used to have. The web client offers from either side whenever a track
 * appears: a screen share, a camera, or its four-second ICE-restart fallback.
 * An Android peer that applied every incoming offer unconditionally would call
 * `setRemoteDescription(offer)` while in `have-local-offer` and libwebrtc fails
 * the call outright. In practice that meant an Android user's call broke the
 * moment the web user on the other end shared a screen.
 *
 * All negotiation for one peer runs under that peer's [Peer.mutex] on a
 * coroutine, so the offer/answer sequence cannot interleave with itself. The
 * callback-shaped `SdpObserver` API is wrapped into suspend functions at the
 * bottom of this file for the same reason: the ordering rules here are hard
 * enough to hold without also being spread across four nested callbacks.
 */
class VoiceEngine(
    private val context: Context,
    private val scope: CoroutineScope,
    private val signal: (Map<String, Any?>) -> Unit,
    private val onPeerState: (String, PeerMediaState) -> Unit,
    /** A peer's screen video arrived or went away. Null means "gone". */
    private val onRemoteScreen: (String, VideoTrack?) -> Unit = { _, _ -> },
    /** The person stopped the share from the system UI rather than from ours. */
    private val onScreenShareEnded: () -> Unit = {},
) {
    private var factory: PeerConnectionFactory? = null
    private var audioDeviceModule: JavaAudioDeviceModule? = null
    private var eglBase: EglBase? = null
    private var localAudio: AudioTrack? = null

    private val peers = ConcurrentHashMap<String, Peer>()

    /**
     * Which of each peer's incoming videos is their screen.
     *
     * Keyed by peer, because a room can hold more than one presenter and a
     * single handle would let the second share overwrite the first. Guarded by
     * [videoLock] rather than made concurrent: every mutation is a read, a
     * re-classification and a write that have to happen together, and the
     * callers are libwebrtc's signalling thread and the controller's coroutines.
     */
    private val remoteVideo = RemoteVideoIndex<VideoTrack>()
    private val videoLock = Any()

    /**
     * Whether each peer's audio may play: deafening and moderator mutes, both.
     *
     * The same shape as [remoteVideo] for the same reason. It used to be a
     * single `deafened` flag applied to whatever tracks existed at the time,
     * which was enough while deafening was the only thing that could silence a
     * peer. A server mute is per peer and arrives on the roster, usually before
     * the peer's track does, so it has to be remembered per peer and consulted
     * when the track finally lands. See [RemoteAudioGate].
     */
    private val remoteAudio = RemoteAudioGate<AudioTrack> { track, enabled ->
        runCatching { track.setEnabled(enabled) }
    }
    private val audioLock = Any()

    @Volatile private var localPeerId: String? = null
    @Volatile private var iceServers: List<PeerConnection.IceServer> = emptyList()

    private var statsJob: Job? = null

    // --- screen share ---
    private var screenCapturer: ScreenCapturerAndroid? = null
    private var screenSource: VideoSource? = null
    private var screenHelper: SurfaceTextureHelper? = null
    private var screenTrack: VideoTrack? = null

    /**
     * The stream id the screen video is published under.
     *
     * The far end classifies an incoming video stream by *elimination*: the
     * roster announces a `cameraStreamId`, and any other video stream is the
     * screen (see `remoteCameraStreamId` in the web's peer-connection manager).
     * This client has no camera, so every video it sends is a screen share and
     * the id only has to be stable and not the camera's. Prefixed anyway so a
     * capture is recognisable in an SDP dump.
     */
    private val screenStreamId = "pqp-screen-${java.util.UUID.randomUUID()}"

    val isSharingScreen: Boolean get() = screenTrack != null

    /** For a renderer: the same GL context the decoders draw into. */
    val eglContext: EglBase.Context? get() = eglBase?.eglBaseContext

    private class Peer(val connection: PeerConnection) {
        /**
         * Serialises this peer's offer/answer sequence.
         *
         * Every path that touches a description takes it: the initial offer, an
         * incoming offer, an incoming answer, an ICE restart and a
         * renegotiation for a screen share. Without it a share started while an
         * answer is in flight interleaves two sequences on the same connection,
         * which is a state machine error rather than a race that resolves
         * itself.
         */
        val mutex = Mutex()

        /**
         * ICE restarts, capped.
         *
         * A failed connection is worth more than one attempt at finding a path,
         * and the web client makes three. Retrying forever is not: without TURN
         * there is no path to find, and a loop of restarts burns battery while
         * the call stays silent either way.
         */
        @Volatile var restarts = 0

        /** True between createOffer and its answer. Half of glare detection. */
        @Volatile var makingOffer = false

        /**
         * Something this peer has not been told about our senders.
         *
         * Our own record rather than a reading of the connection, and it is the
         * half that survives a *removal*: stopping a share leaves no sender
         * behind to notice, and a peer never told about the stop keeps
         * rendering a frozen frame forever.
         */
        @Volatile var owedOffer = false

        /**
         * Candidates that arrived before a remote description existed.
         *
         * They routinely do, and adding one early is an error rather than a
         * no-op, so they wait here until there is something to attach them to.
         */
        val pendingCandidates = mutableListOf<IceCandidate>()

        @Volatile var hasRemoteDescription = false

        /** Our screen video on this connection, so it can be removed again. */
        @Volatile var screenSender: RtpSender? = null

        /** `SystemClock.elapsedRealtime` of the first CONNECTED, or 0. */
        @Volatile var connectedAt: Long = 0

        /** The last stats sample, so a climbing counter beats a stuck one. */
        @Volatile var stats: PeerMediaStats? = null
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
            // A GL context is what lets the hardware codecs hand frames around
            // as textures instead of copying them through the CPU. Created even
            // on a build that only ever sends audio, because the factory is
            // built once and a screen share cannot add codecs to it afterwards.
            val egl = EglBase.create()
            eglBase = egl
            factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                .setVideoEncoderFactory(
                    DefaultVideoEncoderFactory(egl.eglBaseContext, true, true),
                )
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                .createPeerConnectionFactory()
        }

        if (localAudio == null) {
            val source = factory!!.createAudioSource(MediaConstraints())
            localAudio = factory!!.createAudioTrack(LOCAL_AUDIO_ID, source)
        }

        startStatsPolling()
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
        synchronized(audioLock) { remoteAudio.setDeafened(value) }
        localAudio?.setEnabled(!(value || mutedByUser))
    }

    /**
     * The roster said a moderator muted, or unmuted, a peer.
     *
     * This is the receiving half of a server mute on a mesh room, and it is the
     * only half there is: the server has no hand on the media, so the person
     * goes quiet on this phone because this phone stops playing them. Fed from
     * every roster frame rather than only from a change, for the same reason
     * [setPeerCameraStreamId] is: the roster and the track race, and the gate
     * absorbs a repeat for free.
     */
    fun setPeerServerMuted(remotePeerId: String, muted: Boolean) {
        val changed = synchronized(audioLock) { remoteAudio.setServerMuted(remotePeerId, muted) }
        if (changed) Log.i(TAG, "peer $remotePeerId server-muted=$muted")
    }

    /**
     * The roster named which of a peer's audio streams is their screen's sound.
     *
     * A server mute must leave it playing (a watch-party host mutes the
     * chatter, not the film), and this is the only way to tell it from the
     * microphone. The audio twin of [setPeerCameraStreamId].
     */
    fun setPeerScreenAudioStreamId(remotePeerId: String, streamId: String?) {
        synchronized(audioLock) { remoteAudio.setScreenAudioStreamId(remotePeerId, streamId) }
    }

    fun addPeer(remotePeerId: String) {
        val local = localPeerId ?: return
        if (peers.containsKey(remotePeerId)) return

        val peer = createPeer(remotePeerId) ?: return
        peers[remotePeerId] = peer

        // Exactly one side offers first, and it is the one whose id sorts
        // higher. The polite side does not sit idle forever, though: if it is
        // already sharing a screen, the answer it eventually sends cannot carry
        // a sender the offer never described, so it re-offers afterwards. See
        // `settleAfterAnswer`.
        if (local > remotePeerId) {
            scope.launch { peer.mutex.withLock { negotiate(remotePeerId, peer) } }
        }
        retuneScreenSenders()
    }

    fun removePeer(remotePeerId: String) {
        val peer = peers.remove(remotePeerId) ?: return
        synchronized(audioLock) { remoteAudio.forget(remotePeerId) }
        if (synchronized(videoLock) { remoteVideo.forget(remotePeerId) }) {
            onRemoteScreen(remotePeerId, null)
        }
        runCatching { peer.connection.dispose() }
        retuneScreenSenders()
    }

    fun handleOffer(from: String, sdp: String) {
        val local = localPeerId ?: return
        val peer = peers.getOrPut(from) { createPeer(from) ?: return }
        scope.launch {
            peer.mutex.withLock {
                // Glare. Both sides offered at once, or an offer landed while
                // we were mid-exchange. Exactly one side must yield, and which
                // one is fixed by the id comparison the web client uses.
                val collision = peer.makingOffer ||
                    peer.connection.signalingState() != PeerConnection.SignalingState.STABLE
                if (collision) {
                    if (local < from) {
                        // Polite: drop their offer. Ours is the one that stands,
                        // and their answer to it is already on the way.
                        Log.i(TAG, "peer $from offer collision; ignoring theirs")
                        return@withLock
                    }
                    Log.i(TAG, "peer $from offer collision; rolling ours back")
                    runCatching {
                        peer.connection.setLocalAsync(
                            SessionDescription(SessionDescription.Type.ROLLBACK, ""),
                        )
                    }
                }

                val applied = runCatching {
                    peer.connection.setRemoteAsync(
                        SessionDescription(SessionDescription.Type.OFFER, sdp),
                    )
                }
                if (applied.isFailure) {
                    Log.w(TAG, "peer $from offer rejected: ${applied.exceptionOrNull()?.message}")
                    return@withLock
                }
                peer.hasRemoteDescription = true
                drainCandidates(peer)

                val answer = runCatching {
                    val description = peer.connection.createAnswerAsync(MediaConstraints())
                    peer.connection.setLocalAsync(description)
                    description
                }.getOrNull() ?: return@withLock

                signal(
                    mapOf(
                        "type" to "answer",
                        "from" to local,
                        "to" to from,
                        "sdp" to answer.description,
                    ),
                )

                // An answer can only describe the m-lines their offer carried.
                // A track we added *before* this connection first negotiated
                // (a screen share already running when they joined) sits on a
                // transceiver with no mid, and no other code path would ever
                // offer it. Without this the share silently never reaches
                // anybody who joined after it started.
                if (!hasUnnegotiatedSender(peer)) peer.owedOffer = false
            }
            settleAfterExchange(from, peer)
        }
    }

    fun handleAnswer(from: String, sdp: String) {
        val peer = peers[from] ?: return
        scope.launch {
            peer.mutex.withLock {
                val applied = runCatching {
                    peer.connection.setRemoteAsync(
                        SessionDescription(SessionDescription.Type.ANSWER, sdp),
                    )
                }
                if (applied.isFailure) {
                    Log.w(TAG, "peer $from answer rejected: ${applied.exceptionOrNull()?.message}")
                    return@withLock
                }
                peer.hasRemoteDescription = true
                // They answered, so they have our senders. This is the only
                // moment that is actually evidence of that; an offer having
                // been *sent* is not.
                peer.owedOffer = false
                drainCandidates(peer)
            }
            settleAfterExchange(from, peer)
        }
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
            runCatching { peer.connection.addIceCandidate(ice) }
        } else {
            synchronized(peer.pendingCandidates) { peer.pendingCandidates += ice }
        }
    }

    // --- screen share ---

    /**
     * Start capturing the screen and publish it to every peer.
     *
     * [permission] is the Intent the system consent dialog handed back. It is
     * single use: from Android 15 a fresh grant is required for every capture
     * session, so this is never cached and never reused.
     *
     * The caller is responsible for the foreground service already carrying the
     * `mediaProjection` type. From Android 14 `getMediaProjection` throws if it
     * does not, and the throw happens inside `startCapture` where it would look
     * like a capture failure rather than an ordering one.
     */
    fun startScreenShare(permission: Intent, profile: ScreenCaptureProfile): Boolean {
        val factory = factory ?: return false
        val egl = eglBase ?: return false
        if (screenTrack != null) return true

        return runCatching {
            val capturer = ScreenCapturerAndroid(
                permission,
                object : MediaProjection.Callback() {
                    override fun onStop() {
                        // The system's own "Stop sharing" chip, or the platform
                        // revoking the projection. Ours is not the only way out,
                        // and a UI that still says "sharing" after this is lying.
                        Log.i(TAG, "screen projection stopped by the system")
                        onScreenShareEnded()
                    }
                },
            )
            val helper = SurfaceTextureHelper.create("pqp-screen", egl.eglBaseContext)
            // `isScreencast` is not cosmetic: it tells the encoder this is
            // screen content, which turns off the resolution adaptation that
            // would otherwise blur text the moment the link dips.
            val source = factory.createVideoSource(true)
            capturer.initialize(helper, context, source.capturerObserver)
            capturer.startCapture(profile.width, profile.height, profile.frameRate)
            val track = factory.createVideoTrack(SCREEN_TRACK_ID, source)

            screenCapturer = capturer
            screenHelper = helper
            screenSource = source
            screenTrack = track
            Log.i(
                TAG,
                "screen capture started at ${profile.width}x${profile.height}" +
                    "@${profile.frameRate}fps",
            )

            peers.forEach { (peerId, peer) -> publishScreen(peerId, peer, track) }
            true
        }.getOrElse { error ->
            Log.w(TAG, "screen capture failed to start: ${error.message}")
            releaseScreenCapture()
            false
        }
    }

    /** Stop capturing and take the track off every peer. */
    fun stopScreenShare() {
        if (screenTrack == null) return
        peers.forEach { (peerId, peer) ->
            val sender = peer.screenSender ?: return@forEach
            peer.screenSender = null
            runCatching { peer.connection.removeTrack(sender) }
            peer.owedOffer = true
            requestNegotiation(peerId, peer)
        }
        releaseScreenCapture()
        Log.i(TAG, "screen capture stopped")
    }

    private fun publishScreen(peerId: String, peer: Peer, track: VideoTrack) {
        if (peer.screenSender != null) return
        val sender = runCatching {
            peer.connection.addTrack(track, listOf(screenStreamId))
        }.getOrNull() ?: return
        peer.screenSender = sender
        tuneScreenSender(sender)
        peer.owedOffer = true
        requestNegotiation(peerId, peer)
    }

    private fun releaseScreenCapture() {
        runCatching { screenCapturer?.stopCapture() }
        runCatching { screenCapturer?.dispose() }
        runCatching { screenSource?.dispose() }
        runCatching { screenHelper?.dispose() }
        screenCapturer = null
        screenSource = null
        screenHelper = null
        screenTrack = null
    }

    /**
     * Re-split the upload budget whenever the room's size changes.
     *
     * In a mesh the presenter sends a full copy of the screen to every peer, so
     * the number that was right for one viewer is four times too generous for
     * four. A ceiling set once at the start of a share is a ceiling that was
     * right once.
     */
    private fun retuneScreenSenders() {
        if (screenTrack == null) return
        peers.values.forEach { peer -> peer.screenSender?.let { tuneScreenSender(it) } }
    }

    /**
     * Point one screen sender at framerate rather than sharpness, and cap it.
     *
     * The size is **not** set here, unlike the web's `tuneScreenSender`. There,
     * `scaleResolutionDownBy` is the only knob a browser offers over a capture
     * it sized itself. Here the capture is a VirtualDisplay we built at the
     * size we wanted (see [screenCaptureProfileFor]), so the picture already
     * leaves at the intended resolution and a divisor on top would shrink it
     * twice.
     *
     * Failure is swallowed. A share running on the encoder's defaults is
     * enormously better than one that throws while starting.
     */
    private fun tuneScreenSender(sender: RtpSender) {
        runCatching {
            val parameters = sender.getParameters() ?: return
            parameters.degradationPreference =
                RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
            val ceiling = meshScreenBitrate(peers.size)
            parameters.encodings.forEach { encoding ->
                encoding.maxBitrateBps = ceiling
                encoding.maxFramerate = SCREEN_FRAME_RATE
            }
            sender.setParameters(parameters)
        }
    }

    /** Tears the whole mesh down. The factory is kept for the next call. */
    fun stop() {
        statsJob?.cancel()
        statsJob = null
        releaseScreenCapture()
        peers.forEach { (_, peer) -> runCatching { peer.connection.dispose() } }
        peers.clear()
        synchronized(audioLock) { remoteAudio.clear() }
        synchronized(videoLock) { remoteVideo.clear() }.forEach { onRemoteScreen(it, null) }
        localPeerId = null
    }

    fun dispose() {
        stop()
        localAudio = null
        factory?.dispose()
        factory = null
        audioDeviceModule?.release()
        audioDeviceModule = null
        eglBase?.release()
        eglBase = null
    }

    val peerCount: Int get() = peers.size

    /** The last stats sample for a peer, or null before the first one. */
    fun statsFor(remotePeerId: String): PeerMediaStats? = peers[remotePeerId]?.stats

    /** This peer's incoming screen video, for a renderer to attach to. */
    fun remoteScreenFor(remotePeerId: String): VideoTrack? =
        synchronized(videoLock) { remoteVideo.screenFor(remotePeerId) }

    /**
     * The roster named a peer's camera capture, or said their camera is off.
     *
     * Fed from every roster frame rather than only from a change, because the
     * roster and the track race in both directions: a camera can be announced
     * before its track arrives or after. The index absorbs a repeat for free.
     */
    fun setPeerCameraStreamId(remotePeerId: String, streamId: String?) {
        val changed = synchronized(videoLock) {
            remoteVideo.setCameraStreamId(remotePeerId, streamId)
        }
        if (changed) onRemoteScreen(remotePeerId, remoteScreenFor(remotePeerId))
    }

    /**
     * The roster says a peer is or is not presenting.
     *
     * The only end-of-share signal that can be trusted for a *re*-share: see
     * [RemoteVideoIndex.setSharingScreen].
     */
    fun setPeerSharingScreen(remotePeerId: String, sharing: Boolean) {
        val changed = synchronized(videoLock) {
            remoteVideo.setSharingScreen(remotePeerId, sharing)
        }
        if (changed) onRemoteScreen(remotePeerId, remoteScreenFor(remotePeerId))
    }

    // --- is anybody actually hearing anybody ---

    /**
     * Sample every peer connection on a timer, log it, and let a silent
     * connection contradict a healthy-looking state.
     *
     * The log line is the artefact: `adb logcat -s pqp.voice` is how anybody
     * settles the question this class exists to answer, and "the connection
     * state is connected" has never been an answer to it. The line names the
     * ICE candidate pair that was selected as well as the counters, because
     * host / srflx / relay is the difference between a call that works on one
     * network and one that works anywhere.
     */
    private fun startStatsPolling() {
        if (statsJob?.isActive == true) return
        statsJob = scope.launch {
            while (isActive) {
                delay(STATS_INTERVAL_MS)
                peers.forEach { (peerId, peer) -> sample(peerId, peer) }
            }
        }
    }

    private fun sample(remotePeerId: String, peer: Peer) {
        runCatching {
            peer.connection.getStats { report ->
                val stats = parseMediaStats(report)
                peer.stats = stats
                Log.i(TAG, "peer $remotePeerId ${stats.summary()}")
                judge(remotePeerId, peer, stats)
            }
        }
    }

    /**
     * A connection that has been up for a while and has received nothing.
     *
     * The grace period is generous on purpose. A peer that has just answered
     * legitimately has zero packets for a moment, and a false "cannot reach
     * everyone" on a working call would train people to ignore the one warning
     * that matters. Zero packets *ever*, well after the connection settled, is
     * not ambiguous.
     *
     * Recovery is symmetric: a counter that starts climbing puts the peer back
     * to Connected, because ICE does sometimes find a path late.
     */
    private fun judge(remotePeerId: String, peer: Peer, stats: PeerMediaStats) {
        val connectedAt = peer.connectedAt
        if (connectedAt == 0L) return
        val settled = SystemClock.elapsedRealtime() - connectedAt > SILENCE_GRACE_MS
        onPeerState(
            remotePeerId,
            if (stats.audioPacketsReceived == 0L && settled) {
                PeerMediaState.Silent
            } else {
                PeerMediaState.Connected
            },
        )
    }

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

        val peer = Peer(connection)
        localAudio?.let { connection.addTrack(it, listOf(LOCAL_STREAM_ID)) }
        // A share already running when somebody joins has to be on their
        // connection from the start, or they watch an empty tile until the
        // presenter happens to toggle it.
        screenTrack?.let { track ->
            runCatching { connection.addTrack(track, listOf(screenStreamId)) }
                .getOrNull()
                ?.let { sender ->
                    peer.screenSender = sender
                    tuneScreenSender(sender)
                }
        }
        return peer
    }

    private suspend fun negotiate(
        remotePeerId: String,
        peer: Peer,
        iceRestart: Boolean = false,
    ) {
        val local = localPeerId ?: return
        peer.makingOffer = true
        try {
            if (iceRestart) peer.connection.restartIce()
            val description = peer.connection.createOfferAsync(MediaConstraints())
            peer.connection.setLocalAsync(description)
            signal(
                mapOf(
                    "type" to "offer",
                    "from" to local,
                    "to" to remotePeerId,
                    "sdp" to description.description,
                ),
            )
            // `owedOffer` is deliberately not cleared here. Sending an offer is
            // not the same as the peer having received it: glare is resolved by
            // one side dropping the other's offer on the floor, and a debt
            // cleared on send would be forgotten exactly when it was not paid.
            // The answer is the acknowledgement, and that is where it clears.
        } catch (error: Throwable) {
            Log.w(TAG, "peer $remotePeerId offer failed: ${error.message}")
        } finally {
            peer.makingOffer = false
        }
    }

    /**
     * Tell this peer about a sender we just added or removed. Never throws.
     *
     * An offer is only legal from a settled connection, and nothing about the
     * moment somebody taps "share my screen" respects that: the pair may be
     * halfway through answering an offer of their own, or restarting ICE. The
     * tracks are already on the connection by the time this runs, so there is
     * nothing to undo and nothing to apologise for, only an offer that has to
     * wait its turn.
     */
    private fun requestNegotiation(remotePeerId: String, peer: Peer) {
        peer.owedOffer = true
        scope.launch { settleAfterExchange(remotePeerId, peer) }
    }

    /**
     * Offer whatever this peer has not been told, once the pair has settled.
     *
     * Checked and retried rather than fired once: right after our answer goes
     * out the remote is still applying it, and an offer landing in that window
     * is glare, which one side resolves by dropping it. Every attempt
     * re-checks, so the loop is a no-op the moment the peer knows, or is gone.
     */
    private suspend fun settleAfterExchange(remotePeerId: String, peer: Peer, attempt: Int = 0) {
        if (attempt >= RENEGOTIATION_ATTEMPTS) return
        if (peers[remotePeerId] !== peer) return
        if (!needsNegotiation(peer)) return
        delay(RENEGOTIATION_DELAY_MS * (attempt + 1))
        if (peers[remotePeerId] !== peer) return
        if (!needsNegotiation(peer)) return
        if (peer.makingOffer ||
            peer.connection.signalingState() != PeerConnection.SignalingState.STABLE
        ) {
            settleAfterExchange(remotePeerId, peer, attempt + 1)
            return
        }
        peer.mutex.withLock { negotiate(remotePeerId, peer) }
        settleAfterExchange(remotePeerId, peer, attempt + 1)
    }

    /**
     * Anything this peer has not been told about our senders.
     *
     * Two questions, not one. [hasUnnegotiatedSender] reads the connection and
     * catches a track that never got an m-line, including one added by a path
     * that never asked for an offer. `owedOffer` is our own record, and it is
     * the only one of the two that survives a removal.
     */
    private fun needsNegotiation(peer: Peer): Boolean =
        peer.owedOffer || hasUnnegotiatedSender(peer)

    /** A local track that no negotiated m-line carries: invisible to the peer. */
    private fun hasUnnegotiatedSender(peer: Peer): Boolean = runCatching {
        peer.connection.transceivers.any { it.mid == null && it.sender?.track() != null }
    }.getOrDefault(false)

    private fun drainCandidates(peer: Peer) {
        synchronized(peer.pendingCandidates) {
            peer.pendingCandidates.forEach {
                runCatching { peer.connection.addIceCandidate(it) }
            }
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
            when (val track = receiver.track()) {
                is AudioTrack -> {
                    // WebRTC plays a received audio track by itself, so there is
                    // nothing to start here. The gate switches it to the right
                    // state on the way in (deafened, or a moderator mute the
                    // roster announced before this track existed) and keeps the
                    // handle so either can switch it later.
                    // The stream id is what tells the microphone from the
                    // screen's sound once a moderator mutes this peer; see
                    // [RemoteAudioGate.plays].
                    val streamId = streams.firstOrNull()?.id
                    synchronized(audioLock) {
                        remoteAudio.trackAdded(remotePeerId, track.id(), streamId, track)
                    }
                }

                is VideoTrack -> {
                    // Not automatically a screen share. A web peer with their
                    // camera on and their screen shared sends both down this
                    // one connection, and the stream id is the only thing that
                    // tells them apart. The roster announced which id is the
                    // camera; the index does the elimination, exactly as
                    // `classifyVideo` does on the web.
                    val streamId = streams.firstOrNull()?.id ?: return
                    val changed = synchronized(videoLock) {
                        remoteVideo.trackAdded(remotePeerId, streamId, track.id(), track)
                    }
                    if (changed) {
                        onRemoteScreen(remotePeerId, remoteScreenFor(remotePeerId))
                    }
                }

                else -> Unit
            }
        }

        override fun onRemoveTrack(receiver: RtpReceiver) {
            val track = receiver.track() ?: return
            if (track.kind() == MediaStreamTrack.VIDEO_TRACK_KIND) {
                val changed = synchronized(videoLock) {
                    remoteVideo.trackRemoved(remotePeerId, track.id())
                }
                if (changed) {
                    onRemoteScreen(remotePeerId, remoteScreenFor(remotePeerId))
                }
            } else {
                synchronized(audioLock) { remoteAudio.trackRemoved(remotePeerId, track.id()) }
            }
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            Log.i(TAG, "peer $remotePeerId -> $newState")
            when (newState) {
                PeerConnection.PeerConnectionState.CONNECTED -> {
                    peers[remotePeerId]?.let { peer ->
                        if (peer.connectedAt == 0L) {
                            peer.connectedAt = SystemClock.elapsedRealtime()
                        }
                    }
                    onPeerState(remotePeerId, PeerMediaState.Connected)
                }

                PeerConnection.PeerConnectionState.FAILED -> {
                    val peer = peers[remotePeerId]
                    val local = localPeerId
                    // The impolite side drives the restart, for the same reason
                    // it drives the first offer: two simultaneous restarts are
                    // glare wearing a different hat.
                    if (peer != null && local != null &&
                        peer.restarts < MAX_ICE_RESTARTS && local > remotePeerId
                    ) {
                        peer.restarts += 1
                        Log.i(
                            TAG,
                            "peer $remotePeerId failed; ICE restart ${peer.restarts}",
                        )
                        onPeerState(remotePeerId, PeerMediaState.Connecting)
                        scope.launch {
                            peer.mutex.withLock {
                                negotiate(remotePeerId, peer, iceRestart = true)
                            }
                        }
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

        /**
         * Deliberately not the trigger for anything.
         *
         * libwebrtc fires this from inside the operations chain, where taking a
         * lock and starting another description exchange is a deadlock waiting
         * to happen. Every track this client adds is added by a path that knows
         * it did so and asks for the offer itself.
         */
        override fun onRenegotiationNeeded() = Unit
        override fun onTrack(transceiver: RtpTransceiver) = Unit
    }

    companion object {
        private const val TAG = "pqp.voice"
        private const val LOCAL_AUDIO_ID = "pqp-mic"
        private const val LOCAL_STREAM_ID = "pqp-local"
        private const val SCREEN_TRACK_ID = "pqp-screen-video"
        private const val STATS_INTERVAL_MS = 3_000L
        private const val SILENCE_GRACE_MS = 8_000L
        private const val MAX_ICE_RESTARTS = 3
        private const val RENEGOTIATION_ATTEMPTS = 5
        private const val RENEGOTIATION_DELAY_MS = 400L
    }
}

// --- SdpObserver, made sequential -------------------------------------------
//
// The offer/answer rules are order rules, and they are hard enough to hold
// without also being spread across four nested callbacks that each re-enter the
// class. These wrappers resume exactly once and throw on failure, so a caller
// reads top to bottom and a rejection is a `catch` rather than a branch nobody
// wrote.

private suspend fun PeerConnection.createOfferAsync(
    constraints: MediaConstraints,
): SessionDescription = suspendCancellableCoroutine { continuation ->
    createOffer(
        object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                if (continuation.isActive) continuation.resume(description)
            }

            override fun onCreateFailure(error: String?) {
                if (continuation.isActive) {
                    continuation.resumeWithException(IllegalStateException(error ?: "createOffer"))
                }
            }

            override fun onSetSuccess() = Unit
            override fun onSetFailure(error: String?) = Unit
        },
        constraints,
    )
}

private suspend fun PeerConnection.createAnswerAsync(
    constraints: MediaConstraints,
): SessionDescription = suspendCancellableCoroutine { continuation ->
    createAnswer(
        object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                if (continuation.isActive) continuation.resume(description)
            }

            override fun onCreateFailure(error: String?) {
                if (continuation.isActive) {
                    continuation.resumeWithException(IllegalStateException(error ?: "createAnswer"))
                }
            }

            override fun onSetSuccess() = Unit
            override fun onSetFailure(error: String?) = Unit
        },
        constraints,
    )
}

private suspend fun PeerConnection.setLocalAsync(description: SessionDescription) =
    suspendCancellableCoroutine { continuation ->
        setLocalDescription(setObserver(continuation), description)
    }

private suspend fun PeerConnection.setRemoteAsync(description: SessionDescription) =
    suspendCancellableCoroutine { continuation ->
        setRemoteDescription(setObserver(continuation), description)
    }

private fun setObserver(
    continuation: kotlinx.coroutines.CancellableContinuation<Unit>,
) = object : SdpObserver {
    override fun onSetSuccess() {
        if (continuation.isActive) continuation.resume(Unit)
    }

    override fun onSetFailure(error: String?) {
        if (continuation.isActive) {
            continuation.resumeWithException(IllegalStateException(error ?: "setDescription"))
        }
    }

    override fun onCreateSuccess(description: SessionDescription) = Unit
    override fun onCreateFailure(error: String?) = Unit
}
