package gg.pqp.app.voicenotes

import gg.pqp.app.attachments.AttachmentConfig
import gg.pqp.app.attachments.CreateAttachmentRequest
import gg.pqp.app.attachments.CreateVoiceNote
import gg.pqp.app.core.Attachment
import gg.pqp.app.core.Message
import gg.pqp.app.core.PqpJson
import gg.pqp.app.ui.chat.MessagePermissions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decoding what the server sends, with the `voice` block and without it, and
 * encoding what this client sends. Old servers and old rows are the point:
 * the block is optional, its fields are optional, and none of that may make a
 * message stop rendering.
 */
class VoiceNoteModelTest {

    private fun attachment(extra: String = "") = PqpJson.decodeFromString(
        Attachment.serializer(),
        """{"id":"a1","filename":"voice-note.m4a","contentType":"audio/mp4","byteSize":4096,
           "width":null,"height":null,"url":"https://cdn.invalid/a1"$extra}""",
    )

    @Test
    fun `an attachment with no voice block is a plain file, as before`() {
        val decoded = attachment()
        assertNull(decoded.voice)
        assertFalse(decoded.isVoiceNote)
    }

    @Test
    fun `a voice block makes a voice note`() {
        val decoded = attachment(""","voice":{"durationMs":12345,"waveform":"AAAA","listenedByMe":true}""")
        assertTrue(decoded.isVoiceNote)
        assertEquals(12_345L, decoded.voice?.durationMs)
        assertEquals("AAAA", decoded.voice?.waveform)
        assertTrue(decoded.voice?.listenedByMe == true)
    }

    @Test
    fun `a server that predates receipts sends only the duration and waveform`() {
        val voice = attachment(""","voice":{"durationMs":900,"waveform":"AAAA"}""").voice
        assertEquals(900L, voice?.durationMs)
        assertFalse(voice?.listenedByMe == true)
        assertNull(voice?.listenedBy)
        assertEquals(emptyList<Any>(), voice?.listeners)
    }

    @Test
    fun `fields this build has never heard of are ignored`() {
        val voice = attachment(
            ""","voice":{"durationMs":900,"waveform":"AAAA","transcript":{"status":"done","text":"oi"},"playbackUrl":"https://x.invalid"}""",
        ).voice
        assertEquals(900L, voice?.durationMs)
    }

    @Test
    fun `an empty voice block still decodes`() {
        val decoded = attachment(""","voice":{}""")
        assertEquals(0L, decoded.voice?.durationMs)
        assertEquals("", decoded.voice?.waveform)
    }

    @Test
    fun `an audio file with a voice block that is not audio is not a voice note`() {
        val decoded = PqpJson.decodeFromString(
            Attachment.serializer(),
            """{"id":"a","filename":"x.png","contentType":"image/png","url":"u","voice":{"durationMs":1}}""",
        )
        assertFalse(decoded.isVoiceNote)
    }

    @Test
    fun `listenedBy reads user ids, which is what shared lists today`() {
        val voice = attachment(""","voice":{"durationMs":900,"waveform":"","listenedBy":["u1","u2"]}""").voice
        assertEquals(listOf("u1", "u2"), voice?.listeners?.map { it.userId })
        assertNull(voice?.listeners?.first()?.listenedAt)
    }

    @Test
    fun `listenedBy reads objects with a time, which is what the listens contract lists`() {
        val voice = attachment(
            ""","voice":{"durationMs":900,"waveform":"","listenedBy":[{"userId":"u1","listenedAt":"2026-10-08T21:06:00Z"}]}""",
        ).voice
        assertEquals("u1", voice?.listeners?.single()?.userId)
        assertEquals("2026-10-08T21:06:00Z", voice?.listeners?.single()?.listenedAt)
    }

    @Test
    fun `a listenedBy with junk in it keeps what it can read`() {
        val voice = attachment(""","voice":{"durationMs":900,"waveform":"","listenedBy":["u1",7,null,{"nope":1},{"userId":"u2"}]}""").voice
        assertEquals(listOf("u1", "7", "u2"), voice?.listeners?.map { it.userId })
    }

    @Test
    fun `a whole message with a voice note decodes, with and without the block`() {
        val message = PqpJson.decodeFromString(
            Message.serializer(),
            """{"id":"m1","channelId":"c1","authorId":"u1","authorName":"ana","body":"","createdAt":"2026-10-08T12:00:00Z",
               "attachments":[
                 {"id":"a1","filename":"voice-note.m4a","contentType":"audio/mp4","url":"u","voice":{"durationMs":5000,"waveform":"AAAA"}},
                 {"id":"a2","filename":"old.m4a","contentType":"audio/mp4","url":"u"}
               ]}""",
        )
        assertEquals(listOf(true, false), message.attachments.map { it.isVoiceNote })
    }

    // --- the config and the mint ---

    @Test
    fun `the config reads voiceNotes, and an older server reads as off`() {
        val on = PqpJson.decodeFromString(
            AttachmentConfig.serializer(),
            """{"enabled":true,"maxBytes":10485760,"voiceNotes":true}""",
        )
        assertTrue(on.voiceNotes)
        val old = PqpJson.decodeFromString(
            AttachmentConfig.serializer(),
            """{"enabled":true,"maxBytes":10485760}""",
        )
        assertFalse(old.voiceNotes)
        assertFalse(AttachmentConfig().voiceNotes)
    }

    @Test
    fun `a mint for an ordinary file carries no voice key`() {
        val body = PqpJson.encodeToString(
            CreateAttachmentRequest.serializer(),
            CreateAttachmentRequest(filename = "a.png", contentType = "image/png", byteSize = 10),
        )
        assertFalse(body, body.contains("voice"))
    }

    @Test
    fun `a mint for a voice note carries duration and waveform`() {
        val body = PqpJson.encodeToString(
            CreateAttachmentRequest.serializer(),
            CreateAttachmentRequest(
                filename = VOICE_NOTE_FILENAME,
                contentType = VOICE_NOTE_CONTENT_TYPE,
                byteSize = 20_000,
                voice = CreateVoiceNote(durationMs = 4_200, waveform = PeakNormalizer.encode(IntArray(50) { 5_000 })),
            ),
        )
        assertTrue(body, body.contains(""""contentType":"audio/mp4""""))
        assertTrue(body, body.contains(""""durationMs":4200"""))
        assertTrue(body, body.contains(""""waveform":"""))
    }

    @Test
    fun `the type is bare, because the claim compares it exactly`() {
        assertEquals("audio/mp4", VOICE_NOTE_CONTENT_TYPE)
        assertFalse(VOICE_NOTE_CONTENT_TYPE.contains(';'))
    }

    @Test
    fun `a voice note cannot be edited`() {
        val note = attachment(""","voice":{"durationMs":900,"waveform":""}""")
        val message = Message(
            id = "m",
            channelId = "c",
            authorId = "me",
            authorName = "me",
            createdAt = "2026-10-08T12:00:00Z",
            attachments = listOf(note),
        )
        assertFalse(MessagePermissions.canEdit(message, "me"))
        assertTrue(MessagePermissions.canEdit(message.copy(attachments = listOf(attachment())), "me"))
    }
}
