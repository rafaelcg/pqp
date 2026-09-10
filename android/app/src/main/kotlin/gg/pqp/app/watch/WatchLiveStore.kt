package gg.pqp.app.watch

import android.util.Log
import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * Which channels are live, and the one frame this client sends about it.
 *
 * ## The audience is seatless, and this class is where that is decided
 *
 * A watch party's whole economy is that a watcher is not a participant. Six
 * hundred people watching a stream is one LiveKit egress and six hundred
 * playlist readers; six hundred people *in the call* is a room that falls over,
 * which is exactly what happened on 5 September when a spike of 212 arrivals
 * met a mesh limit of eight.
 *
 * So the audience path here sends **exactly one kind of frame**,
 * `watch-live { channelId, watching }`, and nothing else. It never sends
 * `join-voice-room`. It never asks `POST /api/voice/token` for SFU
 * credentials. It builds no `PeerConnection` and no LiveKit `Room`. Nothing in
 * this file can reach [gg.pqp.app.voice.VoiceController], and that is
 * structural rather than a promise: this class does not have one.
 *
 * The server's half is `server/src/ws/voice.ts`: a `watch-live` runs
 * `canAccessChannel`, counts the *socket* in `hls-audience.ts`, and answers
 * that socket alone. Room seats are counted separately on the voice roster,
 * and the server refuses to double count a socket that holds one
 * (`!socketIsInRoom`). Joining the call afterwards is a deliberate second act
 * and is somebody else's code.
 *
 * ## And the same argument, applied to the way IN
 *
 * Refusing to join from here is only half of it: the app bar drew a join
 * button on every voice-room channel, and `watch_party` is one of those, so a
 * viewer was invited to take the seat this file exists to avoid. Deleting the
 * button outright would have taken it from the host too, and this client could
 * not tell them apart before joining because `welcome.canStream` is the answer
 * and `welcome` arrives after the seat is taken.
 *
 * So this store also reads `watch-party-update`, whose `viewerRole` the server
 * resolves per recipient. See [mayTakeWatchPartySeat] for the rule and [seats] for
 * what is kept. It is knowledge only; nothing here joins anything.
 *
 * ## Why a subscription is not a request for a frame
 *
 * The count reaches an audience on the server's own 30 s keyframe clock, never
 * once per arrival, for the same reason: a wave of arrivals must cost one frame
 * per viewer per keyframe rather than one frame to the whole server per
 * arrival. So this client subscribes and then waits. The one exception is the
 * answer to its own `watch-live`, which the server sends to that socket alone.
 *
 * ## Why the URL is never cached longer than the last frame
 *
 * Every `hlsUrl` that leaves the server carries a `?t=` token minted for this
 * user, this channel and this session, good for an hour. The keyframe restamps
 * it every 30 s, so a viewer who stays connected is handed a fresh credential
 * long before the old one could expire. Applying the newest frame is therefore
 * the whole expiry strategy, and it is why [channels] holds what the server
 * last said rather than what the player was first given.
 */
class WatchLiveStore(
    private val frames: Flow<JsonObject>,
    private val realtimeState: Flow<RealtimeState>,
    private val send: (JsonObject) -> Unit,
    /**
     * The channel this device holds a voice seat in, or null.
     *
     * A seat is already on the roster, so announcing a watch as well would ask
     * the server to count the same person twice. It refuses to, but sending it
     * anyway would make this client's intent unreadable from a packet capture,
     * which is how the two halves of a count drift apart.
     */
    private val seatedChannelId: () -> String?,
    /** `GET /api/channels/:id/live`, for the gap before the socket speaks. */
    private val seed: suspend (String) -> ChannelLiveResponse?,
    /**
     * This account's own id, or null before the session has resolved.
     *
     * Read lazily for the same reason [seatedChannelId] is: the store outlives
     * the sign-in, and a snapshot taken at construction is the answer from
     * before there was an account.
     */
    private val selfUserId: () -> String?,
    scope: CoroutineScope,
) {
    private val _channels = MutableStateFlow<Map<String, ChannelLive>>(emptyMap())

    /** What the server last said about every channel it has mentioned. */
    val channels: StateFlow<Map<String, ChannelLive>> = _channels.asStateFlow()

    private val _seats = MutableStateFlow<Map<String, WatchPartySeatRule>>(emptyMap())

    /**
     * This account's standing in every active watch party it may see.
     *
     * KNOWLEDGE, NOT A JOIN. Nothing here takes a seat and nothing here can:
     * the claim above about this class not being able to reach
     * [gg.pqp.app.voice.VoiceController] is still structural and still true.
     * What this map does is let the surface that DOES join stop offering it to
     * people the server would turn away, which is [mayTakeWatchPartySeat].
     *
     * A channel absent from this map has no party this account is part of, and
     * that reads as an ordinary voice room rather than as a closed one.
     */
    val seats: StateFlow<Map<String, WatchPartySeatRule>> = _seats.asStateFlow()

    /** Whether the join control belongs on this channel's app bar at all. */
    fun mayTakeSeat(channelId: String): Boolean =
        mayTakeWatchPartySeat(canStartWatchParty = false, party = _seats.value[channelId])

    /** The channel this socket has announced a seatless watch on, or null. */
    @Volatile
    private var watching: String? = null

    init {
        scope.launch { listen() }
        scope.launch { followConnection() }
    }

    fun live(channelId: String): ChannelLive = _channels.value[channelId] ?: ChannelLive.NOTHING

    private suspend fun listen() {
        frames.collect { frame ->
            when (frame["type"]?.jsonPrimitive?.contentOrNull) {
                // The room's own copy. A seat hears this and not the
                // channel-level frame's count, so the stream is taken and the
                // count left alone: whatever the audience frame last said is
                // still the truth about people without seats.
                "voice-stream" -> {
                    val channelId = channelIdOf(frame) ?: return@collect
                    put(channelId) { it.copy(stream = decodeLiveStream(frame)) }
                }
                // The channel-level frame: everyone who may VIEW, seat or no
                // seat. Carries a URL restamped for this recipient and the
                // seatless watcher count.
                "channel-live" -> {
                    val channelId = channelIdOf(frame) ?: return@collect
                    val stream = decodeLiveStream(frame)
                    val watchers = decodeWatching(frame)
                    put(channelId) { it.copy(stream = stream, watching = watchers) }
                }
                // The watch party EVENT, resolved per recipient, and the only
                // thing that tells this phone whether it is running the party
                // or watching it. It arrives at socket auth for every active
                // party this account may see (`catchUpWatchParties`) as well
                // as on every change, so the answer is here before anybody can
                // tap anything. `party: null` means there is nothing here for
                // this account any more, and takes the entry away.
                "watch-party-update" -> {
                    val channelId = channelIdOf(frame) ?: return@collect
                    val seat = decodeWatchPartySeat(frame, selfUserId())
                    _seats.value = if (seat == null) {
                        _seats.value - channelId
                    } else {
                        _seats.value + (channelId to seat)
                    }
                }
            }
        }
    }

    /**
     * A reconnect is a new socket, and the server counts watchers per socket.
     *
     * Without this, refreshing the phone's connection at an event silently
     * drops every viewer out of the count, which is the number the host is
     * watching to decide whether the stream is working.
     */
    private suspend fun followConnection() {
        realtimeState.collect { state ->
            if (state != RealtimeState.Ready) return@collect
            watching?.let { announce(it, true) }
        }
    }

    /**
     * "I am on this channel's playlist without a seat."
     *
     * Idempotent: saying it twice sends one frame, so a Compose recomposition
     * is not a second viewer. Announcing a different channel retracts the old
     * one first, because one socket watches one thing.
     */
    fun watch(channelId: String) {
        if (seatedChannelId() == channelId) {
            // Already counted on the roster. Watching from inside the room is
            // a perfectly ordinary thing to do, it just is not a second person.
            return
        }
        if (watching == channelId) return
        watching?.let { announce(it, false) }
        watching = channelId
        announce(channelId, true)
    }

    /** The stage went away. Take the count back. */
    fun unwatch(channelId: String) {
        if (watching != channelId) return
        watching = null
        announce(channelId, false)
    }

    /**
     * Ask HTTP what the socket has not said yet.
     *
     * Never overwrites a frame: the frame is newer than the request by
     * definition, and this only exists to cover a channel opened before the
     * socket was up. A failure is silence, because a channel with no watch
     * party is the ordinary case and 404 is its answer on a server with the
     * feature off.
     */
    suspend fun seedFromApi(channelId: String) {
        if (_channels.value.containsKey(channelId)) return
        val response = runCatching { seed(channelId) }
            .onFailure { Log.d(TAG, "no live state for $channelId: ${it.message}") }
            .getOrNull() ?: return
        if (_channels.value.containsKey(channelId)) return
        _channels.value = _channels.value + (
            channelId to ChannelLive(
                stream = response.stream?.resolve(),
                watching = response.watching,
            )
            )
    }

    private fun announce(channelId: String, watching: Boolean) {
        send(
            buildJsonObject {
                put("type", "watch-live")
                put("channelId", channelId)
                put("watching", watching)
            },
        )
    }

    private inline fun put(channelId: String, update: (ChannelLive) -> ChannelLive) {
        val current = _channels.value
        _channels.value = current + (channelId to update(current[channelId] ?: ChannelLive.NOTHING))
    }

    private companion object {
        const val TAG = "WatchLive"
    }
}
