package gg.pqp.app.voicenotes

import gg.pqp.app.core.Attachment
import gg.pqp.app.core.Message
import gg.pqp.app.core.VoiceNote
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which note plays after this one. The rule is "the next one after it, from
 * somebody else, that I have not heard", and every clause is a case.
 */
class VoiceNoteQueueTest {

    private val me = "me"

    private fun entry(
        id: String,
        author: String = "ana",
        heard: Boolean = false,
        channel: String = "c1",
    ) = QueueEntry(
        attachmentId = id,
        messageId = "m-$id",
        channelId = channel,
        authorId = author,
        url = "https://example.invalid/$id",
        durationMs = 5_000,
        listenedByMe = heard,
    )

    private fun next(queue: List<QueueEntry>, from: String, local: Set<String> = emptySet()) =
        VoiceNoteQueue.nextUnheard(queue, from, me, local)?.attachmentId

    @Test
    fun `plays the next unheard note after the current one`() {
        val queue = listOf(entry("a"), entry("b"), entry("c"))
        assertEquals("b", next(queue, "a"))
        assertEquals("c", next(queue, "b"))
    }

    @Test
    fun `ends after the last note and never wraps around`() {
        val queue = listOf(entry("a"), entry("b"), entry("c"))
        assertNull(next(queue, "c"))
    }

    @Test
    fun `an unheard note before the current one is not turned back to`() {
        val queue = listOf(entry("a"), entry("b"), entry("c"))
        // Playing c from the middle of a backlog: a and b stay unheard.
        assertNull(next(queue, "c"))
    }

    @Test
    fun `skips notes the server says were heard`() {
        val queue = listOf(entry("a"), entry("b", heard = true), entry("c"))
        assertEquals("c", next(queue, "a"))
    }

    @Test
    fun `skips notes heard on this device since the transcript loaded`() {
        val queue = listOf(entry("a"), entry("b"), entry("c"))
        assertEquals("c", next(queue, "a", local = setOf("b")))
    }

    @Test
    fun `skips my own notes`() {
        val queue = listOf(entry("a"), entry("b", author = me), entry("c"))
        assertEquals("c", next(queue, "a"))
    }

    @Test
    fun `skips a run of heard and own notes to the first one that qualifies`() {
        val queue = listOf(
            entry("a"),
            entry("b", heard = true),
            entry("c", author = me),
            entry("d"),
            entry("e"),
        )
        assertEquals("d", next(queue, "a"))
    }

    @Test
    fun `a different person's notes continue, not only the same sender's`() {
        val queue = listOf(entry("a", author = "ana"), entry("b", author = "bia"))
        assertEquals("b", next(queue, "a"))
    }

    @Test
    fun `nothing left unheard ends the run`() {
        val queue = listOf(entry("a"), entry("b", heard = true), entry("c", author = me))
        assertNull(next(queue, "a"))
    }

    @Test
    fun `a current note that left the queue continues nowhere`() {
        // Its message was deleted while it played. Guessing would play
        // something nobody asked for.
        val queue = listOf(entry("b"), entry("c"))
        assertNull(next(queue, "a"))
    }

    @Test
    fun `an empty queue and an unknown self are both fine`() {
        assertNull(next(emptyList(), "a"))
        // Not signed in (myId null): nothing is "mine", everything else counts.
        assertEquals("b", VoiceNoteQueue.nextUnheard(listOf(entry("a"), entry("b")), "a", null, emptySet())?.attachmentId)
    }

    // --- building the queue from a transcript ---

    private fun message(id: String, author: String, vararg attachments: Attachment, blocked: Boolean = false) =
        Message(
            id = id,
            channelId = "c1",
            authorId = author,
            authorName = author,
            createdAt = "2026-10-08T12:00:00Z",
            attachments = attachments.toList(),
            blocked = blocked,
        )

    private fun voiceAttachment(id: String, heard: Boolean = false) = Attachment(
        id = id,
        filename = "voice-note.m4a",
        contentType = "audio/mp4",
        url = "https://example.invalid/$id",
        voice = VoiceNote(durationMs = 4_000, waveform = "", listenedByMe = heard),
    )

    private fun plainAudio(id: String) = Attachment(
        id = id,
        filename = "song.mp3",
        contentType = "audio/mpeg",
        url = "https://example.invalid/$id",
    )

    @Test
    fun `the queue is the voice notes of a transcript in reading order`() {
        val entries = VoiceNoteQueue.entriesOf(
            listOf(
                message("m1", "ana", voiceAttachment("v1")),
                message("m2", "bia", plainAudio("song")),
                message("m3", "ana"),
                message("m4", "bia", voiceAttachment("v2", heard = true)),
            ),
        )
        assertEquals(listOf("v1", "v2"), entries.map { it.attachmentId })
        assertEquals(listOf("m1", "m4"), entries.map { it.messageId })
        assertEquals(listOf(false, true), entries.map { it.listenedByMe })
        assertEquals(4_000L, entries.first().durationMs)
    }

    @Test
    fun `a blocked author's notes are not queued`() {
        val entries = VoiceNoteQueue.entriesOf(
            listOf(message("m1", "ana", voiceAttachment("v1"), blocked = true)),
        )
        assertEquals(emptyList<QueueEntry>(), entries)
    }

    @Test
    fun `a voice block on a non-audio attachment is not a note`() {
        val odd = Attachment(
            id = "x",
            filename = "x.png",
            contentType = "image/png",
            url = "https://example.invalid/x",
            voice = VoiceNote(durationMs = 1_000),
        )
        assertEquals(emptyList<QueueEntry>(), VoiceNoteQueue.entriesOf(listOf(message("m1", "ana", odd))))
    }
}
