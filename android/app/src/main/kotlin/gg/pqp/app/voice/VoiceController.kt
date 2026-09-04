package gg.pqp.app.voice

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.util.Log
import gg.pqp.app.core.IceServer
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.VoiceParticipant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.webrtc.EglBase
import org.webrtc.VideoTrack

enum class VoiceStage { Idle, Joining, Connected, Refused }

data class VoiceState(
    val channelId: String? = null,
    /** Null after a moderator move: the id is known, the name is not. */
    val channelName: String? = null,
    val stage: VoiceStage = VoiceStage.Idle,
    val participants: List<VoiceParticipant> = emptyList(),
    val muted: Boolean = false,
    val deafened: Boolean = false,
    /** Speakerphone rather than the earpiece. See [VoiceController.applyAudioRoute]. */
    val speakerphone: Boolean = true,
    /** This device is capturing and publishing its screen. */
    val sharingScreen: Boolean = false,
    /**
     * Peers this device could not build a media path to, or built one to and
     * heard nothing on.
     *
     * Surfaced, not swallowed. Without this the call bar says "2 in this call"
     * while nobody can hear anybody, which is the exact shape of failure a
     * half-working voice stack hides behind. The usual cause is the one already
     * on the pitfalls list in CLAUDE.md: STUN alone does not cross NAT, and
     * `GET /api/ice-servers` is serving no TURN.
     */
    val unreachablePeers: Int = 0,
    /** The server's own refusal, shown verbatim rather than reinterpreted. */
    val refusal: Refusal? = null,
    /**
     * A sentence from the server about this call, already written.
     *
     * Today that is only voice moderation. The frame carries the whole sentence
     * precisely so a client that renders nothing but this string is a correct
     * client, and so an eviction is never indistinguishable from a network
     * failure.
     */
    val notice: String? = null,
) {
    val isActive: Boolean get() = stage == VoiceStage.Joining || stage == VoiceStage.Connected

    /**
     * Everybody the roster says is presenting, in roster order.
     *
     * A list rather than a single participant: two people can share at once.
     * `self` is on the roster too, so a device sharing its own screen appears
     * here; the caller pairs this with the tracks that actually arrived, and no
     * track ever arrives for our own capture.
     */
    val presenters: List<VoiceParticipant>
        get() = participants.filter { it.sharingScreen }
}

enum class Refusal { RoomFull, TransportUnsupported, ScreenShareDenied }

/**
 * "Am I in a call", for the whole process.
 *
 * Application-scoped, because a call outlives the screen that started it and
 * every Activity that will ever be created for it. The foreground service is
 * started and stopped from here rather than from the UI, so a call cannot end
 * up alive with no notification (which Android kills) or notified with no call
 * (which is worse).
 */
class VoiceController(
    private val context: Context,
    private val session: SessionStore,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(VoiceState())
    val state: StateFlow<VoiceState> = _state.asStateFlow()

    private val _remoteScreens = MutableStateFlow<Map<String, VideoTrack>>(emptyMap())

    /**
     * Every screen being shared *to* this device, keyed by the presenter's peer
     * id.
     *
     * A map rather than one handle because a voice room can hold more than one
     * presenter: the server allows it and the web client renders it. Held as a
     * single track, the second share to arrive simply overwrote the first, so
     * one of the two presenters disappeared from this device with nothing
     * anywhere saying why.
     */
    val remoteScreens: StateFlow<Map<String, VideoTrack>> = _remoteScreens.asStateFlow()

    private val peerMedia = java.util.concurrent.ConcurrentHashMap<String, PeerMediaState>()

    private val engine = VoiceEngine(
        context = context,
        scope = scope,
        signal = { frame -> session.realtime.send(frame.toJsonObject()) },
        onPeerState = { peerId, mediaState ->
            peerMedia[peerId] = mediaState
            _state.value = _state.value.copy(
                // Silent counts as unreachable, because to the person holding
                // the phone it is the same thing. A connection that came up and
                // carries no audio is the failure this line exists to admit;
                // hiding it behind a green state is how a voice app ships
                // broken and reads as finished.
                unreachablePeers = peerMedia.values.count {
                    it == PeerMediaState.Failed || it == PeerMediaState.Silent
                },
            )
        },
        onRemoteScreen = { peerId, track ->
            _remoteScreens.value = _remoteScreens.value.toMutableMap().apply {
                if (track == null) remove(peerId) else put(peerId, track)
            }
        },
        // Posted rather than run inline: this arrives on the projection's own
        // callback thread, from inside the capturer we are about to dispose.
        onScreenShareEnded = { scope.launch { stopScreenShare() } },
    )

    /** The GL context a `SurfaceViewRenderer` has to be initialised with. */
    val eglContext: EglBase.Context? get() = engine.eglContext

    private val audioManager =
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var focusRequest: AudioFocusRequest? = null
    private var previousAudioMode: Int = AudioManager.MODE_NORMAL

    /** Kept so a socket reconnect can rejoin the same room. */
    @Volatile private var wantedChannel: Pair<String, String?>? = null

    /**
     * The socket dropped while we were in a call, so the room has to be rebuilt.
     *
     * Set on the way *down* rather than inferred on the way up. The previous
     * version tried to notice a second `Ready` and computed
     * `wasReady && state == Ready` inside the branch where `state` is by
     * definition not `Ready`, so it was always false and the rejoin never fired
     * once. Meanwhile the server had already dropped the peer, which left the
     * app showing a live call, with a live microphone, in a room it was no
     * longer in.
     */
    @Volatile private var needsRejoin = false

    private var pendingIce: List<IceServer> = emptyList()

    init {
        scope.launch { listen() }
        scope.launch { followConnection() }
    }

    /**
     * The caller is responsible for having RECORD_AUDIO granted, because the
     * permission prompt belongs to the screen that asked, and a foreground
     * service of type `microphone` cannot legally start without it.
     */
    fun join(channelId: String, channelName: String?) {
        if (_state.value.channelId == channelId && _state.value.stage == VoiceStage.Connected) {
            return
        }
        enter(channelId, channelName)
    }

    private fun enter(channelId: String, channelName: String?) {
        wantedChannel = channelId to channelName
        needsRejoin = false
        peerMedia.clear()
        _state.value = VoiceState(
            channelId = channelId,
            channelName = channelName,
            stage = VoiceStage.Joining,
            muted = _state.value.muted,
            deafened = _state.value.deafened,
            speakerphone = _state.value.speakerphone,
        )

        // The notification comes up before the microphone is touched. Android
        // 14 and later refuse a `microphone` foreground service started the
        // other way round, and a call held by a backgrounded process with no
        // notification is killed within a minute regardless of version.
        VoiceService.start(context)

        scope.launch {
            pendingIce = resolveIceServers()
            session.realtime.send(
                buildJsonObject {
                    put("type", "join-voice-room")
                    put("voiceChannelId", channelId)
                    // Declared up front so the server refuses the join *before*
                    // creating a peer. This client cannot do LiveKit, and a
                    // mesh client that appears in an SFU room is a person in
                    // everyone's roster who can neither hear nor be heard.
                    put("transports", buildJsonArray { add(JsonPrimitive("mesh")) })
                },
            )
        }
    }

    /**
     * ICE servers, and never an empty list.
     *
     * A failed call to `/api/ice-servers` used to leave the peer connection
     * with no servers at all, which is not "degraded, STUN only" but "host
     * candidates only": it works on one wifi and nowhere else, and it looks
     * exactly like pitfall #1 arriving through a different door. The web client
     * has always fallen back to the same public STUN hosts the API serves, so
     * this does too.
     */
    private suspend fun resolveIceServers(): List<IceServer> {
        val fetched = runCatching { session.api.iceServers() }.getOrNull()
        if (!fetched.isNullOrEmpty()) return fetched
        Log.w(TAG, "no ICE servers from the API; falling back to public STUN")
        return DEFAULT_STUN.map { url -> IceServer(urls = JsonPrimitive(url)) }
    }

    fun leave() {
        wantedChannel = null
        needsRejoin = false
        if (_state.value.channelId != null) {
            session.realtime.send(buildJsonObject { put("type", "leave-voice-room") })
        }
        teardown()
        _state.value = VoiceState(
            muted = _state.value.muted,
            speakerphone = _state.value.speakerphone,
        )
    }

    fun toggleMute() {
        val muted = !_state.value.muted
        _state.value = _state.value.copy(muted = muted)
        engine.setMuted(muted || _state.value.deafened)
        pushVoiceState()
    }

    fun toggleDeafen() {
        val deafened = !_state.value.deafened
        _state.value = _state.value.copy(deafened = deafened)
        engine.setDeafened(deafened, _state.value.muted)
        pushVoiceState()
    }

    fun toggleSpeakerphone() {
        val speakerphone = !_state.value.speakerphone
        _state.value = _state.value.copy(speakerphone = speakerphone)
        applyAudioRoute(speakerphone)
    }

    fun dismissRefusal() {
        // A refused *join* leaves nothing behind, so the stage goes back to
        // idle. A refused screen share happened inside a live call and must not
        // end it: clearing the stage there would hang up on everybody because
        // the room was already carrying two screens.
        val wasJoinRefusal = _state.value.refusal != Refusal.ScreenShareDenied
        _state.value = _state.value.copy(
            refusal = null,
            stage = if (wasJoinRefusal) VoiceStage.Idle else _state.value.stage,
        )
    }

    fun dismissNotice() {
        _state.value = _state.value.copy(notice = null)
    }

    // --- screen share ---

    /**
     * Publish this device's screen, with a consent grant the UI just obtained.
     *
     * The order below is the whole feature and it is the order Android
     * enforces: consent first (only a user gesture can raise that dialog), then
     * the foreground service has to already be running with the
     * `mediaProjection` type, and only then may the projection be created. From
     * Android 14 a projection created before its service throws, and the throw
     * lands inside the capturer where it reads like a capture failure rather
     * than an ordering one.
     */
    fun startScreenShare(permission: Intent) {
        if (!_state.value.isActive) return
        if (_state.value.sharingScreen) return
        // The capture is started from inside the service, after its
        // `startForeground` has returned. Doing it here would race that call
        // and lose. See the class comment on [VoiceService].
        VoiceService.startProjection(context, permission)
    }

    /**
     * Called by [VoiceService] once it is foreground with the projection type.
     *
     * Not public: the ordering rule above is the whole reason this is a
     * separate entry point, and a caller that skipped [startScreenShare] would
     * be skipping it.
     */
    internal fun beginScreenCapture(permission: Intent) {
        if (!_state.value.isActive) {
            VoiceService.dropProjection(context)
            return
        }

        val (width, height) = displaySizeOf(context)
        val profile = screenCaptureProfileFor(width, height)
        if (!engine.startScreenShare(permission, profile)) {
            VoiceService.dropProjection(context)
            return
        }

        _state.value = _state.value.copy(sharingScreen = true)
        // Announced after the capture is alive, never before: a roster that
        // says somebody is presenting while nothing is on the wire puts an
        // empty tile in front of everybody else.
        session.realtime.send(
            buildJsonObject {
                put("type", "set-sharing-screen")
                put("sharing", true)
                // This capture carries no audio. `MediaProjection` can record
                // the device's playback from Android 10, but only from apps
                // that allow it, and a system audio track nobody can rely on is
                // worse than an honest silent share.
                put("audioStreamId", JsonNull)
            },
        )
    }

    fun stopScreenShare() {
        if (!engine.isSharingScreen && !_state.value.sharingScreen) return
        engine.stopScreenShare()
        VoiceService.dropProjection(context)
        _state.value = _state.value.copy(sharingScreen = false)
        session.realtime.send(
            buildJsonObject {
                put("type", "set-sharing-screen")
                put("sharing", false)
                put("audioStreamId", JsonNull)
            },
        )
    }

    private fun pushVoiceState() {
        // Both flags travel together. A partial update would make the server
        // merge stale halves after a missed frame, and the client always knows
        // both values anyway.
        session.realtime.send(
            buildJsonObject {
                put("type", "set-voice-state")
                put("muted", _state.value.muted)
                put("deafened", _state.value.deafened)
            },
        )
    }

    // --- signalling ---

    private suspend fun listen() {
        session.realtime.frames.collect { frame ->
            when (frame.str("type")) {
                "welcome" -> onWelcome(frame)
                "peer-joined" -> onPeerJoined(frame)
                "peer-updated" -> onPeerUpdated(frame)
                "peer-left" -> onPeerLeft(frame)
                "voice-roster" -> onRoster(frame)
                "voice-room-full" -> onRefused(frame, Refusal.RoomFull)
                "voice-transport-unsupported" -> onRefused(frame, Refusal.TransportUnsupported)
                "screen-share-denied" -> onScreenShareDenied(frame)
                "voice-moderation" -> onModeration(frame)
                "offer" -> frame.str("sdp")?.let { engine.handleOffer(frame.str("from")!!, it) }
                "answer" -> frame.str("sdp")?.let { engine.handleAnswer(frame.str("from")!!, it) }
                "ice-candidate" -> onCandidate(frame)
            }
        }
    }

    /**
     * A call survives a socket drop by being **rebuilt, not resumed**.
     *
     * The server drops the voice peer when the socket closes, and a reconnect
     * mints a *new* peer id, so every peer connection in the old mesh is
     * addressed to a peer that no longer exists.
     *
     * The flag is set on the way down, in the branch that actually observes the
     * drop. Trying to infer it from a second `Ready` does not work: the socket
     * always passes through `Reconnecting`, and the previous attempt cleared
     * its own evidence on the way past.
     */
    private suspend fun followConnection() {
        session.realtime.state.collect { state ->
            when (state) {
                RealtimeState.Ready -> {
                    val wanted = wantedChannel
                    if (needsRejoin && wanted != null) {
                        Log.i(TAG, "socket back; rebuilding the call in ${wanted.first}")
                        engine.stop()
                        enter(wanted.first, wanted.second)
                    }
                }

                RealtimeState.Refused -> {
                    if (wantedChannel != null) leave()
                }

                RealtimeState.Connecting,
                RealtimeState.Reconnecting,
                RealtimeState.Idle,
                -> {
                    if (wantedChannel == null) return@collect
                    // The server has already dropped our peer. Say so rather
                    // than keep showing a room we are no longer in.
                    needsRejoin = true
                    engine.stop()
                    peerMedia.clear()
                    _remoteScreens.value = emptyMap()
                    // `engine.stop` released the capture, so the service must
                    // stop claiming the projection type as well. A foreground
                    // service that declares `mediaProjection` with no live
                    // projection behind it is one the platform is entitled to
                    // kill, which would take the rejoining call with it.
                    VoiceService.dropProjection(context)
                    _state.value = _state.value.copy(
                        stage = VoiceStage.Joining,
                        participants = emptyList(),
                        unreachablePeers = 0,
                        sharingScreen = false,
                    )
                }
            }
        }
    }

    private fun onWelcome(frame: JsonObject) {
        val channelId = frame.str("voiceChannelId") ?: return
        if (channelId != _state.value.channelId) return

        val transport = frame.str("transport")
        if (transport != null && transport != "mesh") {
            // Binding, not advisory. A client that cannot use the room's
            // transport must leave and say so rather than build the other one.
            onRefused(frame, Refusal.TransportUnsupported)
            return
        }

        val peerId = frame.str("peerId") ?: return
        acquireAudioFocus()
        engine.start(peerId, pendingIce)
        engine.setMuted(_state.value.muted || _state.value.deafened)

        val peers = frame.participants("peers")
        peers.forEach { engine.addPeer(it.peerId) }
        applyVideoRoster(peers)

        _state.value = _state.value.copy(
            stage = VoiceStage.Connected,
            participants = peers + listOfNotNull(frame.participant("self")),
        )

        // Re-declare mute and deafen, every single join.
        //
        // The server creates the peer with `muted: false, deafened: false` and
        // waits to be told otherwise (`server/src/ws/voice.ts`, where the reset
        // is commented as expecting exactly this frame). It is not an
        // optimisation to skip it when both are false: this client only ever
        // sent `set-voice-state` from the two toggles, so joining with a
        // standing mute, switching channels, or rebuilding the room after a
        // dropped socket all left everyone else's roster saying this person was
        // live while their microphone was off. The web does the same thing on
        // every new peer id (`client/src/components/voice/voice-state-sync.ts`).
        pushVoiceState()
    }

    private fun onPeerJoined(frame: JsonObject) {
        if (!_state.value.isActive) return
        val peer = frame.participant("peer") ?: return
        engine.addPeer(peer.peerId)
        applyVideoRoster(listOf(peer))
        _state.value = _state.value.copy(
            participants = _state.value.participants.filterNot { it.peerId == peer.peerId } + peer,
        )
    }

    /**
     * Somebody already in the room changed their name or picture.
     *
     * The same body as [onPeerJoined] minus `engine.addPeer`: the media path
     * to this peer exists and is fine, and renegotiating it over a rename
     * would drop their audio for the length of an ICE round trip. Before this
     * branch existed the frame fell through the `when` and the roster kept
     * the old name for the rest of the call, which is a small wrong thing
     * that looks exactly like a bug in the rename.
     *
     * A peer the roster does not know is ignored rather than added. Adding one
     * here would create a participant with no media path behind it; their
     * `peer-joined` is the frame that carries the invitation to build one.
     */
    private fun onPeerUpdated(frame: JsonObject) {
        if (!_state.value.isActive) return
        val peer = frame.participant("peer") ?: return
        if (_state.value.participants.none { it.peerId == peer.peerId }) return
        applyVideoRoster(listOf(peer))
        _state.value = _state.value.copy(
            participants = _state.value.participants.map {
                if (it.peerId == peer.peerId) peer else it
            },
        )
    }

    private fun onPeerLeft(frame: JsonObject) {
        val peerId = frame.str("peerId") ?: return
        engine.removePeer(peerId)
        peerMedia.remove(peerId)
        _state.value = _state.value.copy(
            participants = _state.value.participants.filterNot { it.peerId == peerId },
        )
    }

    private fun onRoster(frame: JsonObject) {
        if (frame.str("voiceChannelId") != _state.value.channelId) return
        val participants = frame.participants("participants")
        _state.value = _state.value.copy(participants = participants)
        applyVideoRoster(participants)
    }

    /**
     * Tell the engine what the roster says about everybody's video.
     *
     * Two facts travel on every participant and neither can be read off the
     * media itself. `cameraStreamId` names which of a peer's video streams is
     * their camera, and without it every inbound video is filed as a screen
     * share: a web peer with their camera on had it rendered as if it were
     * their desktop. `sharingScreen` is the only end-of-share signal there is,
     * because the screen is the one stream defined negatively and so announces
     * no id to go null.
     *
     * Re-applied from whole rosters rather than from diffs. The roster and the
     * track race in both directions, and the index absorbs a repeat for free.
     */
    private fun applyVideoRoster(participants: List<VoiceParticipant>) {
        participants.forEach { participant ->
            engine.setPeerCameraStreamId(participant.peerId, participant.cameraStreamId)
            engine.setPeerSharingScreen(participant.peerId, participant.sharingScreen)
        }
    }

    private fun onRefused(frame: JsonObject, refusal: Refusal) {
        if (frame.str("voiceChannelId") != _state.value.channelId) return
        wantedChannel = null
        needsRejoin = false
        teardown()
        _state.value = VoiceState(
            stage = VoiceStage.Refused,
            refusal = refusal,
            speakerphone = _state.value.speakerphone,
        )
    }

    /**
     * The room already has as many screens as its transport allows.
     *
     * The capture is torn down rather than left running quietly: the roster
     * will not carry us as a presenter, so a live projection would be a
     * recording nobody asked for and nobody can see.
     */
    private fun onScreenShareDenied(frame: JsonObject) {
        if (frame.str("voiceChannelId") != _state.value.channelId) return
        engine.stopScreenShare()
        VoiceService.dropProjection(context)
        _state.value = _state.value.copy(
            sharingScreen = false,
            refusal = Refusal.ScreenShareDenied,
        )
    }

    /**
     * A moderator acted on this device's voice session.
     *
     * This is the one frame where doing nothing is a safety problem rather than
     * a missing feature. The server drops the peer straight after sending it
     * and never sends us our own `peer-left`, so a client that ignores it keeps
     * a frozen roster, a foreground service and, worst of all, an open
     * microphone: somebody removed from a call is still recording.
     *
     * Guarded to the room we are actually in, so a stale or forged frame about
     * some other channel does nothing.
     */
    private fun onModeration(frame: JsonObject) {
        if (frame.str("voiceChannelId") != _state.value.channelId) return
        val message = frame.str("message")
        when (frame.str("action")) {
            "moved" -> {
                val target = frame.str("movedToChannelId")
                if (target != null) {
                    // Followed with an ordinary join, which re-runs every
                    // server-side admission check, so this can never put us
                    // somewhere we could not have gone ourselves. The name is
                    // not on the frame and there is no endpoint to ask; the bar
                    // says "in voice" until the roster names it.
                    teardown()
                    enter(target, null)
                } else {
                    leave()
                }
            }

            "disconnected" -> leave()

            // "muted" / "unmuted" are informational: the server has already
            // applied them, and the notice below is the whole client response.
            else -> Unit
        }
        _state.value = _state.value.copy(notice = message)
    }

    private fun onCandidate(frame: JsonObject) {
        val from = frame.str("from") ?: return
        val candidate = frame["candidate"]
        if (candidate == null || candidate is JsonNull) return
        val obj = candidate.jsonObject
        engine.handleCandidate(
            from = from,
            sdpMid = obj.str("sdpMid"),
            sdpMLineIndex = obj["sdpMLineIndex"]?.jsonPrimitive?.intOrNull,
            candidate = obj.str("candidate"),
        )
    }

    // --- audio session ---

    private fun acquireAudioFocus() {
        previousAudioMode = audioManager.mode
        // `MODE_IN_COMMUNICATION` enables the platform's own echo cancellation
        // and puts the volume rocker on the call stream instead of the media
        // one.
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener { }
            .build()
        focusRequest = request
        audioManager.requestAudioFocus(request)
        applyAudioRoute(_state.value.speakerphone)
    }

    /**
     * Send the call to the speaker, not the earpiece.
     *
     * THIS IS NOT A PREFERENCE, IT IS THE DIFFERENCE BETWEEN AUDIBLE AND NOT.
     * `MODE_IN_COMMUNICATION` on its own routes to the *earpiece*, which is the
     * right default for a phone call held against a face and completely wrong
     * for a voice channel somebody joined while doing something else: the audio
     * is technically playing, at a volume nobody more than three centimetres
     * away can hear, and it presents as "voice does not work".
     *
     * A wired headset or a Bluetooth device wins over both. Asking for the
     * built-in speaker only when it is the device we mean leaves the platform's
     * own preference order intact, which is what routes a headset correctly
     * without this code knowing headsets exist.
     */
    private fun applyAudioRoute(speakerphone: Boolean) {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (!speakerphone) {
                    audioManager.clearCommunicationDevice()
                    return@runCatching
                }
                val speaker = audioManager.availableCommunicationDevices.firstOrNull {
                    it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                }
                if (speaker != null) audioManager.setCommunicationDevice(speaker)
            } else {
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = speakerphone
            }
        }
    }

    private fun releaseAudioFocus() {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = false
            }
        }
        focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        focusRequest = null
        audioManager.mode = previousAudioMode
    }

    private fun teardown() {
        engine.stop()
        peerMedia.clear()
        _remoteScreens.value = emptyMap()
        releaseAudioFocus()
        VoiceService.stop(context)
    }

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull

    private fun JsonObject.participant(key: String): VoiceParticipant? = runCatching {
        PqpJson.decodeFromJsonElement(VoiceParticipant.serializer(), this[key]!!.jsonObject)
    }.getOrNull()

    private fun JsonObject.participants(key: String): List<VoiceParticipant> = runCatching {
        this[key]!!.jsonArray.mapNotNull { element ->
            runCatching {
                PqpJson.decodeFromJsonElement(VoiceParticipant.serializer(), element.jsonObject)
            }.getOrNull()
        }
    }.getOrDefault(emptyList())

    private fun Map<String, Any?>.toJsonObject(): JsonObject = buildJsonObject {
        forEach { (key, value) -> put(key, value.toJsonElement()) }
    }

    private fun Any?.toJsonElement(): JsonElement = when (this) {
        null -> JsonNull
        is String -> JsonPrimitive(this)
        is Number -> JsonPrimitive(this)
        is Boolean -> JsonPrimitive(this)
        is Map<*, *> -> buildJsonObject {
            forEach { (key, value) -> put(key.toString(), value.toJsonElement()) }
        }
        else -> JsonPrimitive(toString())
    }

    companion object {
        private const val TAG = "pqp.voice"

        /**
         * The same three hosts `server/src/services/ice.ts` serves when it has
         * no TURN of its own. Duplicated rather than fetched, because the point
         * of a fallback is that the fetch is what failed.
         */
        private val DEFAULT_STUN = listOf(
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            "stun:stun.cloudflare.com:3478",
        )
    }
}
