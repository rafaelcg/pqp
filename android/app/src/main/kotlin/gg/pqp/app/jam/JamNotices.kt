package gg.pqp.app.jam

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/*
 * TAKE NOTICES on the wire, as `packages/shared/src/jam-public.ts` spells them (the section "TAKE NOTICES"), and the
 * two live frames that go with them. `JamPublicContractTest` pins every field against the zod schemas.
 *
 * THE MODEL, ONCE. A person who started a song that is public can be sent a part by somebody outside it. That part is
 * out of the mix and WAITS for the starter's answer (the starter's "inbox"). The server tells the starter it arrived
 * and tells the sender how it went:
 *
 *   take      (to the starter) one or more outside takes wait. ONE item per song; its count and instruments are the
 *             takes still waiting, so answering them empties it.
 *   accepted  (to the sender) the starter put it in the mix.
 *   refused   (to the sender) the starter declined it.
 *
 * Three doors, one state: a durable list (`GET /api/jam-public/notices`), two live frames (`jam-public-notice` for the
 * starter, `jam-take-decision` for the sender) and a push whose path is `/app/jam/<songId>`. A frame is only a nudge
 * ("read the list again"): a lost one costs nothing, the item is on the next read.
 */

/** `JAM_TAKE_NOTICE_KINDS`. An unknown kind reads as [Take], the schema's own `.catch("take")`. */
enum class JamTakeNoticeKind(val wire: String) {
    Take("take"),
    Accepted("accepted"),
    Refused("refused"),
    ;

    companion object {
        fun fromWire(token: String?): JamTakeNoticeKind = entries.firstOrNull { it.wire == token } ?: Take
    }
}

object JamTakeNoticeKindSerializer : KSerializer<JamTakeNoticeKind> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("JamTakeNoticeKind", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): JamTakeNoticeKind = JamTakeNoticeKind.fromWire(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: JamTakeNoticeKind) = encoder.encodeString(value.wire)
}

/** One open item of `GET /api/jam-public/notices`. */
@Serializable
data class JamTakeNotice(
    val id: String,
    @Serializable(with = JamTakeNoticeKindSerializer::class)
    val kind: JamTakeNoticeKind = JamTakeNoticeKind.Take,
    val songId: String,
    val title: String = "",
    val instruments: List<@Serializable(with = JamInstrumentSerializer::class) JamInstrument> = emptyList(),
    val count: Int = 1,
    val createdAt: String = "",
    val updatedAt: String = "",
) {
    val updatedAtMs: Long get() = parseJamInstant(updatedAt)
}

@Serializable
data class JamTakeNoticesResponse(val notices: List<JamTakeNotice> = emptyList())

/** `POST /api/jam-public/notices/ack`: spend one item (a tap on its button, or its X). */
@Serializable
data class AckJamTakeNoticeRequest(val id: String)

/**
 * One outside take waiting for the starter, with the song it is on. `track` is the private shape, so the starter can
 * hear it with the band; putting it in the mix is `PATCH /api/jam-tracks/:id { inMix: true }`.
 */
@Serializable
data class JamPublicInboxItem(
    val songId: String,
    val songTitle: String = "",
    val track: JamTrack,
)

@Serializable
data class JamPublicInboxResponse(val takes: List<JamPublicInboxItem> = emptyList())

/** `GET /api/jam-public/config`: whether public jams exist for this account at all. The phone reads only the flag. */
@Serializable
data class JamPublicMeConfig(
    val enabled: Boolean = false,
    val publishing: String = "open",
    val uploads: Boolean = false,
    val announce: Boolean? = null,
)

/**
 * The part of `GET /api/jam-songs/:id/public` the phone reads. [status] is `live` only for a song a stranger can open,
 * [autoAcceptOutside] is the starter's switch that changes what the waiting block says.
 */
@Serializable
data class JamPublication(
    val songId: String = "",
    val status: String = "",
    val pendingTakes: Int = 0,
    val autoAcceptOutside: Boolean = false,
)

@Serializable
data class JamPublicationResponse(val publication: JamPublication? = null)

/**
 * Where a song lives, from the one read that answers for any song: the deep link's resolver. A standalone public jam
 * has no channel and no server (`channelId` and `serverId` are null on the wire), which [JamSongSummary] cannot hold,
 * so a push for one is read through this instead of failing to decode.
 */
@Serializable
data class JamSongPlace(val song: Place) {
    @Serializable
    data class Place(
        val id: String,
        val serverId: String? = null,
        val channelId: String? = null,
        val title: String = "",
    )
}

// --- the two live frames ------------------------------------------------------------------------------------------

/** `JAM_PUBLIC_NOTICE_KINDS`. An unknown kind reads as [Consent], the schema's own `.catch("consent")`. */
enum class JamPublicNoticeKind(val wire: String) {
    Consent("consent"),
    Take("take"),
    Removed("removed"),
    Unpublished("unpublished"),
    PartRemoved("part-removed"),
    Approved("approved"),
    Rejected("rejected"),
    ;

    companion object {
        fun fromWire(token: String?): JamPublicNoticeKind = entries.firstOrNull { it.wire == token } ?: Consent
    }
}

/**
 * The frames of the public side of jam. Not members of `chatServerMessageSchema` (the same arrangement as the seven
 * song frames), so `JamPublicContractTest` holds them against the shared schemas and `WireProtocolTest` names them.
 * Sent to the one account they are about, on every socket it holds.
 */
sealed interface JamPublicFrame {
    /**
     * `jam-public-notice`. The phone draws only `take` (to the starter): [admitted] says auto-accept already put the
     * take in the mix and nothing waits. The other kinds (consent, takedowns, review) belong to public jam, which the
     * phone does not have, and are decoded so a reader can tell them from a frame it cannot read.
     */
    data class Notice(
        val kind: JamPublicNoticeKind,
        val songId: String,
        val title: String,
        val trackId: String?,
        val reason: String?,
        val admitted: Boolean,
        val instrument: JamInstrument?,
    ) : JamPublicFrame

    /** `jam-take-decision`, to the SENDER: the starter [accepted] or refused their [instrument] part. */
    data class Decision(
        val accepted: Boolean,
        val songId: String,
        val title: String,
        val instrument: JamInstrument,
    ) : JamPublicFrame

    companion object {
        fun isPublic(frame: JsonObject): Boolean = when (frame["type"]?.jsonPrimitive?.contentOrNull) {
            "jam-public-notice", "jam-take-decision" -> true
            else -> false
        }

        /** Null for any other frame and for one that does not decode: a nudge that cannot be read is a nudge not given. */
        fun decode(frame: JsonObject): JamPublicFrame? = runCatching {
            fun string(key: String): String? = frame[key]?.jsonPrimitive?.contentOrNull
            when (frame["type"]?.jsonPrimitive?.contentOrNull) {
                "jam-public-notice" -> Notice(
                    kind = JamPublicNoticeKind.fromWire(string("kind")),
                    songId = string("songId") ?: return@runCatching null,
                    title = string("title") ?: return@runCatching null,
                    trackId = string("trackId"),
                    reason = string("reason"),
                    admitted = frame["admitted"]?.jsonPrimitive?.booleanOrNull ?: false,
                    instrument = string("instrument")?.let { JamInstrument.fromWire(it) },
                )
                "jam-take-decision" -> Decision(
                    accepted = string("decision").let { decision ->
                        if (decision != "accepted" && decision != "refused") return@runCatching null
                        decision == "accepted"
                    },
                    songId = string("songId") ?: return@runCatching null,
                    title = string("title") ?: return@runCatching null,
                    instrument = JamInstrument.fromWire(string("instrument")),
                )
                else -> null
            }
        }.getOrNull()
    }
}
