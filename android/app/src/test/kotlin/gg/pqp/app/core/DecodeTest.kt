package gg.pqp.app.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What `PqpJson` does with frames that are not exactly what this client
 * expects.
 *
 * All four settings on that decoder are load-bearing and none of them has an
 * obvious failure mode: get one wrong and the app decodes fewer messages, or
 * sends frames the server's zod rejects, and neither says anything.
 */
class DecodeTest {

    private val minimalMessage = """
        {
          "id": "11111111-1111-1111-1111-111111111111",
          "channelId": "22222222-2222-2222-2222-222222222222",
          "authorId": "33333333-3333-3333-3333-333333333333",
          "authorName": "Rafa",
          "authorAvatarUrl": null,
          "body": "oi",
          "createdAt": "2026-08-21T12:00:00.000Z"
        }
    """.trimIndent()

    /**
     * The API grows fields faster than this client models them. A strict parse
     * would turn each new one into a channel that cannot load.
     */
    @Test
    fun `a message carrying fields this client has never heard of still decodes`() {
        val withFuture = minimalMessage.dropLast(1) +
            ""","embeds":[{"url":"https://pqp.gg"}],"thread":{"id":"x"},"somethingNew":42}"""
        val message = PqpJson.decodeFromString(Message.serializer(), withFuture)
        assertEquals("oi", message.body)
        assertEquals("Rafa", message.authorName)
    }

    /**
     * `blocked` is on the wire and absent from `messageSchema`: the server adds
     * it in `mapMessage` so a blocked author's row still travels and paging
     * stays correct.
     */
    @Test
    fun `a blocked author's row decodes with the flag set`() {
        val blocked = minimalMessage.dropLast(1) + ""","blocked":true}"""
        assertTrue(PqpJson.decodeFromString(Message.serializer(), blocked).blocked)
        assertFalse(PqpJson.decodeFromString(Message.serializer(), minimalMessage).blocked)
    }

    /**
     * Nullable-on-the-wire fields that are non-null in Kotlin land on their
     * default rather than throwing. That is `coerceInputValues`, and without it
     * a message whose `editedAt` is explicitly null fails to decode.
     */
    @Test
    fun `an explicit null on a defaulted field coerces rather than throwing`() {
        val nulled = minimalMessage.dropLast(1) +
            ""","reactions":null,"attachments":null,"isWebhook":null}"""
        val message = PqpJson.decodeFromString(Message.serializer(), nulled)
        assertTrue(message.reactions.isEmpty())
        assertTrue(message.attachments.isEmpty())
        assertFalse(message.isWebhook)
    }

    /**
     * `explicitNulls = false` keeps `"replyToId": null` out of outbound frames.
     * The server's zod treats a present-but-null field as the wrong type rather
     * than as absent, so encoding one is a silently rejected frame.
     */
    @Test
    fun `an absent optional is omitted from an outbound frame, not sent as null`() {
        val encoded = PqpJson.encodeToString(
            AgeDeclaration.serializer(),
            AgeDeclaration("1990-01-01"),
        )
        assertFalse(encoded.contains("null"))
        assertEquals("""{"dateOfBirth":"1990-01-01"}""", encoded)
    }

    /**
     * `iceServerSchema` is `z.union([z.string(), z.array(z.string())])`, which
     * is what the WebRTC spec allows and what every TURN provider disagrees
     * about. A Kotlin field cannot be both, so it is decoded raw and normalised.
     */
    @Test
    fun `an ICE server's urls decode from either a string or an array`() {
        val single = PqpJson.decodeFromString(
            IceServer.serializer(),
            """{"urls":"stun:stun.l.google.com:19302"}""",
        )
        assertEquals(listOf("stun:stun.l.google.com:19302"), single.urlList)

        val many = PqpJson.decodeFromString(
            IceServer.serializer(),
            """{"urls":["turn:a.example:3478","turns:a.example:5349"],"username":"u","credential":"c"}""",
        )
        assertEquals(listOf("turn:a.example:3478", "turns:a.example:5349"), many.urlList)
        assertEquals("u", many.username)
    }

    /**
     * `kind` is what the row *is*; `type` is what it carries. Conflating them
     * renders a category as an empty text channel.
     */
    @Test
    fun `a category decodes as a category and not as a text channel`() {
        val category = PqpJson.decodeFromString(
            Channel.serializer(),
            """{"id":"c","serverId":"s","kind":"server","name":"General","type":"category","position":0}""",
        )
        assertTrue(category.isCategory)
        assertFalse(category.isText)
        assertFalse(category.isVoice)

        val dm = PqpJson.decodeFromString(
            Channel.serializer(),
            """{"id":"c","serverId":null,"kind":"dm","name":"Rafa","type":"text","position":0}""",
        )
        assertTrue(dm.isText)
        assertEquals("dm", dm.kind)
        assertNull(dm.serverId)
    }

    /**
     * A roster entry from an API that predates the voice-state fields reads as
     * "not muted", which is also a participant's state on join.
     */
    @Test
    fun `a roster entry without the voice-state fields defaults to unmuted`() {
        val participant = PqpJson.decodeFromString(
            VoiceParticipant.serializer(),
            """{"peerId":"p1","userId":"u1","displayName":"Rafa","avatarUrl":null}""",
        )
        assertFalse(participant.muted)
        assertFalse(participant.deafened)
        assertFalse(participant.sharingScreen)
        assertNull(participant.cameraStreamId)
    }

    /**
     * An unknown member of the inbound union has to be ignored, not thrown on.
     * That is why frames are dispatched as raw `JsonObject`.
     */
    @Test
    fun `an unmodelled frame still parses as a JsonObject`() {
        val frame: JsonObject = PqpJson.decodeFromString(
            JsonObject.serializer(),
            """{"type":"sanction-notice","reason":"timeout","until":"2026-01-01T00:00:00Z"}""",
        )
        assertEquals("sanction-notice", frame["type"].toString().trim('"'))
    }

    @Test
    fun `an outbound frame round-trips through the same decoder`() {
        val frame = buildJsonObject {
            put("type", "message-create")
            put("channelId", "c")
            put("body", "oi")
            put("nonce", "n")
        }
        val encoded = PqpJson.encodeToString(JsonObject.serializer(), frame)
        assertEquals(frame, PqpJson.decodeFromString(JsonObject.serializer(), encoded))
    }
}
