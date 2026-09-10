package gg.pqp.app.watch

import gg.pqp.app.core.Backend
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * A live HLS playlist for a channel's current screen share, and who is on it.
 *
 * This is the whole seam between the server's watch party and this phone, and
 * it is worth stating what it is NOT. It is not a call, not a peer connection,
 * not a LiveKit participant and not a seat on anybody's roster. A viewer costs
 * the media server exactly one thing: the egress that was already running for
 * the presenter. That is the point of the HLS path, and it is why a phone can
 * join an audience of six hundred without the room noticing.
 *
 * The contract lives in `packages/shared/src/live-hls.ts` and reaches this
 * client on two frames:
 *
 *  - `voice-stream { channelId, stream | null }`, sent to seats in the room.
 *  - `channel-live { channelId, stream | null, watching }`, sent to everybody
 *    who may VIEW the channel, seat or no seat: at socket auth for every live
 *    channel, when the egress starts, stops or changes URL, and on the
 *    audience keyframe clock (30 s) while the channel is live or watched.
 *
 * `GET /api/channels/:id/live` answers the same thing over HTTP, for the gap
 * before the socket has said anything.
 */
data class LiveStream(
    /**
     * Playable, absolute, and carrying this viewer's own credential.
     *
     * The server hands out `/api/voice/hls-playlist/<channel>/<startedAt>?t=…`
     * (root-relative) unless the operator turned signed URLs off, in which case
     * it is already an absolute bucket URL. [Backend.absolute] covers both.
     *
     * `?t=` IS THE AUTHORISATION, and this is the one thing a player on this
     * platform must get right. The token is minted per recipient, bound to the
     * user, the channel and the session, and the proxy accepts it *without* an
     * `Authorization` header. That matters because a Media3 data source applies
     * its default headers to every request it makes, segments included, and the
     * segment URLs the proxy writes are presigned R2 absolutes on a third-party
     * origin. Attaching our Clerk-derived bearer to those would hand a user's
     * token to the bucket. So the player sends no headers at all and lets the
     * token in the URL speak for it, exactly as Safari's native player does.
     */
    val hlsUrl: String,
    /** Unix ms. Names the session, and is part of the proxy path. */
    val startedAt: Long,
    val presenterPeerId: String,
    /** What the badge should claim, from the server that started the egress. */
    val delaySeconds: Int?,
)

/** What one channel's audience looks like right now. */
data class ChannelLive(
    val stream: LiveStream?,
    /** Watchers without a seat. Seats are on the voice roster. */
    val watching: Int,
) {
    val live: Boolean get() = stream != null

    companion object {
        val NOTHING = ChannelLive(stream = null, watching = 0)
    }
}

/** `GET /api/channels/:channelId/live`. */
@Serializable
data class ChannelLiveResponse(
    val stream: LiveStreamPayload? = null,
    val watching: Int = 0,
    val participants: Int = 0,
)

/**
 * The wire shape of `liveHlsStreamSchema`, kept separate from [LiveStream]
 * because the domain type carries a URL this device can actually fetch and the
 * wire one carries whatever the server wrote. Pinned against the shared schema
 * by `ModelShapeTest`.
 */
@Serializable
data class LiveStreamPayload(
    val hlsUrl: String,
    val startedAt: Long,
    val presenterPeerId: String,
    val delaySeconds: Int? = null,
    val topHeight: Int? = null,
)

fun LiveStreamPayload.resolve(): LiveStream? {
    val url = Backend.absolute(hlsUrl) ?: return null
    return LiveStream(
        hlsUrl = url,
        startedAt = startedAt,
        presenterPeerId = presenterPeerId,
        delaySeconds = delaySeconds,
    )
}

/**
 * A `stream` object off a `voice-stream` or `channel-live` frame.
 *
 * Every field is read defensively and a missing required one answers null,
 * which the caller reads as "nothing live". A frame from a server that grew a
 * field must not become a channel that cannot be watched, so this never throws.
 */
fun decodeLiveStream(frame: JsonObject): LiveStream? {
    val stream = runCatching { frame["stream"]?.jsonObject }.getOrNull() ?: return null
    val rawUrl = stream.text("hlsUrl") ?: return null
    val startedAt = stream.number("startedAt") ?: return null
    val presenter = stream.text("presenterPeerId") ?: return null
    val url = Backend.absolute(rawUrl) ?: return null
    return LiveStream(
        hlsUrl = url,
        startedAt = startedAt,
        presenterPeerId = presenter,
        delaySeconds = stream.count("delaySeconds"),
    )
}

/** `watching` off a `channel-live`. Absent is zero, never a guess. */
fun decodeWatching(frame: JsonObject): Int = frame.count("watching") ?: 0

fun channelIdOf(frame: JsonObject): String? = frame.text("channelId")

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.number(key: String): Long? =
    (this[key] as? JsonPrimitive)?.longOrNull

private fun JsonObject.count(key: String): Int? =
    (this[key] as? JsonPrimitive)?.intOrNull
