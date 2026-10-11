package gg.pqp.app.voice

import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.VoiceParticipant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/**
 * Who sits in every voice room this account can see.
 *
 * The server sends a `voice-roster` for every occupied room this socket may
 * see right after `auth`, and then a roster or a delta every time one of
 * those rooms changes. Until now only the room this device was in kept any of
 * it ([VoiceController] drops frames for other channels). The channel list
 * needs the rest, to put faces under each room without joining it.
 *
 * One [VoiceRosterTracker] per room, so each room's `seq` and `size` checks
 * are exactly the ones the call itself relies on: a refused delta leaves that
 * room as it was until the server's next keyframe (about ten seconds).
 *
 * Deliberately has no `speaking`: the roster never carries it, because it
 * changes several times a sentence and goes to every member. The ring is
 * drawn only in this device's own call, from [VoiceController.speakingPeers].
 */
class VoiceRoomOccupancy {
    private val trackers = HashMap<String, VoiceRosterTracker>()
    private val rooms = LinkedHashMap<String, List<VoiceParticipant>>()

    fun current(): Map<String, List<VoiceParticipant>> = LinkedHashMap(rooms)

    /** A full roster. True when the room changed. */
    fun snapshot(channelId: String, participants: List<VoiceParticipant>, seq: Int?): Boolean {
        val tracker = trackers.getOrPut(channelId) { VoiceRosterTracker() }
        return put(channelId, tracker.snapshot(channelId, participants, seq))
    }

    /** A delta. True when it applied and changed the room; a refused delta changes nothing. */
    fun delta(
        channelId: String,
        seq: Int,
        size: Int,
        joined: List<VoiceParticipant> = emptyList(),
        updated: List<VoiceParticipant> = emptyList(),
        left: List<String> = emptyList(),
    ): Boolean {
        val tracker = trackers.getOrPut(channelId) { VoiceRosterTracker() }
        val room = tracker.delta(channelId, seq, size, joined, updated, left) ?: return false
        return put(channelId, room)
    }

    /**
     * The socket is gone. Every room is forgotten: the catch-up after the
     * next `auth` re-sends each occupied room whole, and a room that emptied
     * while this device was offline is never mentioned again, so keeping it
     * would leave its last occupants on screen forever.
     */
    fun clear(): Boolean {
        val had = rooms.isNotEmpty()
        trackers.clear()
        rooms.clear()
        return had
    }

    private fun put(channelId: String, room: List<VoiceParticipant>): Boolean {
        val before = rooms[channelId]
        if (room.isEmpty()) {
            rooms.remove(channelId)
            return before != null
        }
        rooms[channelId] = room
        return before != room
    }
}

/** [VoiceRoomOccupancy] fed by the socket, for the screens. */
class VoiceRoomsStore(
    frames: Flow<JsonObject>,
    realtimeState: Flow<RealtimeState>,
    scope: CoroutineScope,
) {
    private val occupancy = VoiceRoomOccupancy()
    private val lock = Any()
    private val _rooms = MutableStateFlow<Map<String, List<VoiceParticipant>>>(emptyMap())

    /** Voice channel id to the people in it, in join order. Empty rooms are absent. */
    val rooms: StateFlow<Map<String, List<VoiceParticipant>>> = _rooms.asStateFlow()

    init {
        scope.launch {
            frames.collect { frame -> onFrame(frame) }
        }
        scope.launch {
            realtimeState.collect { state ->
                if (state != RealtimeState.Ready) {
                    synchronized(lock) { if (occupancy.clear()) publish() }
                }
            }
        }
    }

    internal fun onFrame(frame: JsonObject) {
        val type = frame.str("type") ?: return
        if (type != "voice-roster" && type != "voice-roster-delta") return
        val channelId = frame.str("voiceChannelId") ?: return
        synchronized(lock) {
            val changed = if (type == "voice-roster") {
                occupancy.snapshot(channelId, frame.participants("participants"), frame.int("seq"))
            } else {
                val seq = frame.int("seq") ?: return
                val size = frame.int("size") ?: return
                occupancy.delta(
                    channelId = channelId,
                    seq = seq,
                    size = size,
                    joined = frame.participants("joined"),
                    updated = frame.participants("updated"),
                    left = frame.peerIds("left"),
                )
            }
            if (changed) publish()
        }
    }

    private fun publish() {
        _rooms.value = occupancy.current()
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

    private fun JsonObject.peerIds(key: String): List<String> = runCatching {
        this[key]!!.jsonArray.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    }.getOrDefault(emptyList())

    private fun JsonObject.participants(key: String): List<VoiceParticipant> = runCatching {
        this[key]!!.jsonArray.mapNotNull { element ->
            runCatching {
                PqpJson.decodeFromJsonElement(VoiceParticipant.serializer(), element.jsonObject)
            }.getOrNull()
        }
    }.getOrDefault(emptyList())
}
