package gg.pqp.app.jam

import gg.pqp.app.core.PqpJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * The seven jam frames (`jamFrameSchema` in `packages/shared/src/jam.ts`),
 * decoded.
 *
 * They reach every socket that sent `join-channel` for the jam channel, through
 * the channel relay, and a change reaches the writer's own socket too, so every
 * consumer applies a frame by id and idempotently. No frame names a voter and
 * none carries anything about the viewer: a person's own votes come from the
 * detail read and from the answer to their own vote.
 *
 * Not yet members of `chatServerMessageSchema` (the union `WireProtocolTest`
 * derives "what the server sends" from), the same arrangement the voice note
 * frames have, so that test cannot see them on its own: `JamContractTest` holds
 * these seven against `JAM_FRAME_TYPES` instead.
 */
sealed interface JamFrame {
    val channelId: String

    data class SongCreated(override val channelId: String, val song: JamSongSummary) : JamFrame
    data class SongUpdated(override val channelId: String, val song: JamSongSummary) : JamFrame
    data class SongDeleted(override val channelId: String, val songId: String) : JamFrame
    data class TrackAdded(override val channelId: String, val song: JamSongSummary, val track: JamTrack) : JamFrame
    data class TrackUpdated(override val channelId: String, val song: JamSongSummary, val track: JamTrack) : JamFrame
    data class TrackDeleted(override val channelId: String, val song: JamSongSummary, val trackId: String) : JamFrame
    data class TrackVotes(
        override val channelId: String,
        val songId: String,
        val trackId: String,
        val voteCount: Int,
    ) : JamFrame

    companion object {
        /** True for a frame type this decoder owns, whether or not the frame then decodes. */
        fun isJam(frame: JsonObject): Boolean = frame["type"]?.jsonPrimitive?.contentOrNull?.startsWith("jam-") == true

        /**
         * Null for any other frame, and for a jam frame that does not decode: a
         * frame the screen cannot read is a frame it waits out (the next read
         * says the same thing), never a crash.
         */
        fun decode(frame: JsonObject): JamFrame? = runCatching {
            fun string(key: String): String? = frame[key]?.jsonPrimitive?.contentOrNull
            fun song(): JamSongSummary = decode(JamSongSummary.serializer(), frame.getValue("song"))
            fun track(): JamTrack = decode(JamTrack.serializer(), frame.getValue("track"))
            val channelId = string("channelId") ?: return@runCatching null
            when (frame["type"]?.jsonPrimitive?.contentOrNull) {
                "jam-song-created" -> SongCreated(channelId, song())
                "jam-song-updated" -> SongUpdated(channelId, song())
                "jam-song-deleted" -> SongDeleted(channelId, string("songId") ?: return@runCatching null)
                "jam-track-added" -> TrackAdded(channelId, song(), track())
                "jam-track-updated" -> TrackUpdated(channelId, song(), track())
                "jam-track-deleted" -> TrackDeleted(channelId, song(), string("trackId") ?: return@runCatching null)
                "jam-track-votes" -> TrackVotes(
                    channelId,
                    string("songId") ?: return@runCatching null,
                    string("trackId") ?: return@runCatching null,
                    frame["voteCount"]?.jsonPrimitive?.intOrNull ?: return@runCatching null,
                )
                else -> null
            }
        }.getOrNull()

        private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, element: JsonElement): T =
            PqpJson.decodeFromJsonElement(serializer, element.jsonObject)
    }
}
