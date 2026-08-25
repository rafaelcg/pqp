package gg.pqp.app.voice

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.util.Log
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
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

enum class VoiceStage { Idle, Joining, Connected, Refused }

data class VoiceState(
    val channelId: String? = null,
    val channelName: String? = null,
    val stage: VoiceStage = VoiceStage.Idle,
    val participants: List<VoiceParticipant> = emptyList(),
    val muted: Boolean = false,
    val deafened: Boolean = false,
    /**
     * Peers this device could not build a media path to.
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
) {
    val isActive: Boolean get() = stage == VoiceStage.Joining || stage == VoiceStage.Connected
}

enum class Refusal { RoomFull, TransportUnsupported }

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

    private val peerMedia = java.util.concurrent.ConcurrentHashMap<String, PeerMediaState>()

    private val engine = VoiceEngine(
        context = context,
        signal = { frame -> session.realtime.send(frame.toJsonObject()) },
        onPeerState = { peerId, mediaState ->
            peerMedia[peerId] = mediaState
            _state.value = _state.value.copy(
                unreachablePeers = peerMedia.values.count { it == PeerMediaState.Failed },
            )
        },
    )

    private val audioManager =
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var focusRequest: AudioFocusRequest? = null
    private var previousAudioMode: Int = AudioManager.MODE_NORMAL

    /** Kept so a socket reconnect can rejoin the same room. */
    @Volatile private var wantedChannel: Pair<String, String>? = null

    init {
        scope.launch { listen() }
        scope.launch { followConnection() }
    }

    /**
     * The caller is responsible for having RECORD_AUDIO granted, because the
     * permission prompt belongs to the screen that asked, and a foreground
     * service of type `microphone` cannot legally start without it.
     */
    fun join(channelId: String, channelName: String) {
        if (_state.value.channelId == channelId && _state.value.isActive) return

        wantedChannel = channelId to channelName
        _state.value = VoiceState(
            channelId = channelId,
            channelName = channelName,
            stage = VoiceStage.Joining,
            muted = _state.value.muted,
        )

        // The notification comes up before the microphone is touched. Android
        // 14 and later refuse a `microphone` foreground service started the
        // other way round, and a call held by a backgrounded process with no
        // notification is killed within a minute regardless of version.
        VoiceService.start(context)

        scope.launch {
            val ice = runCatching { session.api.iceServers() }.getOrDefault(emptyList())
            pendingIce = ice
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

    private var pendingIce: List<gg.pqp.app.core.IceServer> = emptyList()

    fun leave() {
        wantedChannel = null
        if (_state.value.channelId != null) {
            session.realtime.send(buildJsonObject { put("type", "leave-voice-room") })
        }
        teardown()
        _state.value = VoiceState(muted = _state.value.muted)
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

    fun dismissRefusal() {
        _state.value = _state.value.copy(refusal = null, stage = VoiceStage.Idle)
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
                "peer-left" -> onPeerLeft(frame)
                "voice-roster" -> onRoster(frame)
                "voice-room-full" -> onRefused(frame, Refusal.RoomFull)
                "voice-transport-unsupported" -> onRefused(frame, Refusal.TransportUnsupported)
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
     * addressed to a peer that no longer exists. `ready` therefore tears the
     * whole thing down and rejoins.
     */
    private suspend fun followConnection() {
        var wasReady = false
        session.realtime.state.collect { state ->
            when (state) {
                RealtimeState.Ready -> {
                    val wanted = wantedChannel
                    if (wasReady && wanted != null) {
                        engine.stop()
                        join(wanted.first, wanted.second)
                    }
                    wasReady = true
                }
                RealtimeState.Refused -> {
                    if (wantedChannel != null) leave()
                    wasReady = false
                }
                else -> wasReady = wasReady && state == RealtimeState.Ready
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

        _state.value = _state.value.copy(
            stage = VoiceStage.Connected,
            participants = peers + listOfNotNull(frame.participant("self")),
        )
    }

    private fun onPeerJoined(frame: JsonObject) {
        if (!_state.value.isActive) return
        val peer = frame.participant("peer") ?: return
        engine.addPeer(peer.peerId)
        _state.value = _state.value.copy(
            participants = _state.value.participants.filterNot { it.peerId == peer.peerId } + peer,
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
        _state.value = _state.value.copy(participants = frame.participants("participants"))
    }

    private fun onRefused(frame: JsonObject, refusal: Refusal) {
        if (frame.str("voiceChannelId") != _state.value.channelId) return
        wantedChannel = null
        teardown()
        _state.value = VoiceState(stage = VoiceStage.Refused, refusal = refusal)
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
        // `MODE_IN_COMMUNICATION` is what routes to the earpiece, enables the
        // platform's own echo cancellation and puts the volume rocker on the
        // call stream instead of the media one.
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
    }

    private fun releaseAudioFocus() {
        focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        focusRequest = null
        audioManager.mode = previousAudioMode
    }

    private fun teardown() {
        engine.stop()
        peerMedia.clear()
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
    }
}
