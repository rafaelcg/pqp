package gg.pqp.app.voicenotes

import gg.pqp.app.attachments.AttachmentConfig
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Attachment
import gg.pqp.app.core.MePreferences
import gg.pqp.app.core.NoteTranscript
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.VoiceTranscriptionPrefs
import gg.pqp.app.protocol.RepoSources
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transcript store, case for case with the web's `voice-note-transcript.test.ts` rules, and the
 * contracts it reads from `packages/shared`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NoteTranscriptsTest {

    private class Rig(
        var answer: suspend (String) -> NoteTranscript = { NoteTranscript("pending") },
    ) {
        val scope = TestScope()
        val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 16)
        val asked = mutableListOf<String>()
        val store = NoteTranscripts(
            scope = scope,
            frames = frames,
            requestFn = { id ->
                asked += id
                answer(id)
            },
        )

        init {
            scope.runCurrent()
        }

        fun frame(json: String) {
            frames.tryEmit(PqpJson.decodeFromString(JsonObject.serializer(), json))
            scope.runCurrent()
        }

        fun advance(ms: Long) {
            scope.advanceTimeBy(ms)
            scope.runCurrent()
        }

        fun status(id: String) = store.stored.value[id]?.status
    }

    private fun transcriptFrame(id: String, status: String, text: String? = null) =
        """{"type":"voice-note-transcript","channelId":"c","messageId":"m","attachmentId":"$id","transcript":{"status":"$status"${text?.let { ""","text":"$it"""" } ?: ""}}}"""

    // --- contract ---

    @Test
    fun `the statuses are the shared ones`() {
        val shared = RepoSources.enumValues("packages/shared/src/attachments.ts", "noteTranscriptStatusSchema")
        for (status in shared) {
            assertEquals(status, NoteTranscripts.decodeTranscript(PqpJson.decodeFromString(JsonObject.serializer(), """{"status":"$status"}"""))?.status)
        }
        // A status a newer server adds is not a transcript this build can draw.
        assertNull(NoteTranscripts.decodeTranscript(PqpJson.decodeFromString(JsonObject.serializer(), """{"status":"queued_for_review"}""")))
    }

    @Test
    fun `a voice block decodes with a transcript, and without one`() {
        val with = PqpJson.decodeFromString(
            Attachment.serializer(),
            """{"id":"a","filename":"v.webm","contentType":"audio/webm","url":"u","voice":{"durationMs":1,"waveform":"","transcript":{"status":"done","text":"oi","language":"pt"}}}""",
        ).voice!!
        assertEquals(NoteTranscript("done", "oi", "pt"), with.transcript)
        val without = PqpJson.decodeFromString(
            Attachment.serializer(),
            """{"id":"a","filename":"v.webm","contentType":"audio/webm","url":"u","voice":{"durationMs":1,"waveform":""}}""",
        ).voice!!
        assertNull(without.transcript)
    }

    @Test
    fun `the preference reads as on until turned off, and says what it keeps`() {
        assertTrue(VoiceTranscriptionPrefs().mineOn)
        assertTrue(VoiceTranscriptionPrefs().showOn)
        assertFalse(VoiceTranscriptionPrefs(mine = false).mineOn)
        assertTrue(VoiceTranscriptionPrefs(mine = false).showOn)
        val prefs = PqpJson.decodeFromString(MePreferences.serializer(), """{"voiceTranscription":{"show":false}}""")
        assertFalse(prefs.voiceTranscription!!.showOn)
        assertTrue(prefs.voiceTranscription!!.mineOn)
        assertNull(PqpJson.decodeFromString(MePreferences.serializer(), "{}").voiceTranscription)
        // Both halves are keys of the shared preference.
        val shared = RepoSources.read("packages/shared/src/api.ts")
        assertTrue(Regex("""voiceTranscription:\s*z\s*\.object\(\{\s*mine:\s*z\.boolean\(\)\.optional\(\),\s*show:\s*z\.boolean\(\)\.optional\(\)""").containsMatchIn(shared))
    }

    @Test
    fun `the attachments config says transcription is on only with notes on too`() {
        val config = PqpJson.decodeFromString(AttachmentConfig.serializer(), """{"enabled":true,"maxBytes":1,"voiceNotes":false,"voiceTranscription":true}""")
        assertFalse(config.transcriptionOn)
        assertTrue(PqpJson.decodeFromString(AttachmentConfig.serializer(), """{"enabled":true,"voiceNotes":true,"voiceTranscription":true}""").transcriptionOn)
        assertFalse(PqpJson.decodeFromString(AttachmentConfig.serializer(), """{"enabled":true,"voiceNotes":true}""").transcriptionOn)
    }

    // --- resolve ---

    @Test
    fun `no base means no transcript, whatever a frame said`() {
        assertNull(NoteTranscripts.resolve(null, NoteTranscript("done", "x")))
    }

    @Test
    fun `the stored answer wins, except that a done base is final`() {
        val none = NoteTranscript("none")
        val pending = NoteTranscript("pending")
        val done = NoteTranscript("done", "oi")
        assertEquals(none, NoteTranscripts.resolve(none, null))
        assertEquals(pending, NoteTranscripts.resolve(none, pending))
        assertEquals(done, NoteTranscripts.resolve(done, pending))
        assertEquals(NoteTranscript("failed"), NoteTranscripts.resolve(pending, NoteTranscript("failed")))
    }

    // --- frames ---

    @Test
    fun `a frame lands in the store, newest answer last`() {
        val rig = Rig()
        rig.frame(transcriptFrame("a", "pending"))
        rig.frame(transcriptFrame("a", "done", "oi gente"))
        assertEquals(NoteTranscript("done", "oi gente"), rig.store.stored.value["a"])
        // Something that is not a transcript frame, or one naming an unknown status, changes nothing.
        rig.frame("""{"type":"voice-note-listened","attachmentId":"a"}""")
        rig.frame(transcriptFrame("b", "mystery"))
        assertEquals(setOf("a"), rig.store.stored.value.keys)
    }

    @Test
    fun `the store is a cache, not a ledger`() {
        val rig = Rig()
        repeat(NoteTranscripts.MAX_STORED + 25) { rig.frame(transcriptFrame("n$it", "done", "t$it")) }
        assertEquals(NoteTranscripts.MAX_STORED, rig.store.stored.value.size)
        assertFalse("n0" in rig.store.stored.value)
        assertTrue("n${NoteTranscripts.MAX_STORED + 24}" in rig.store.stored.value)
    }

    @Test
    fun `a card seeing a transcript block marks transcription as seen`() {
        val rig = Rig()
        assertFalse(rig.store.seen.value)
        rig.store.markAvailable()
        assertTrue(rig.store.seen.value)
    }

    // --- asking ---

    @Test
    fun `asking shows pending at once and asks once however fast the button is pressed`() {
        val rig = Rig(answer = { kotlinx.coroutines.awaitCancellation() })
        rig.store.request("a")
        rig.store.request("a")
        rig.store.request("a")
        rig.scope.runCurrent()
        assertEquals("pending", rig.status("a"))
        assertEquals(listOf("a"), rig.asked)
    }

    @Test
    fun `a settled answer replaces the pending one`() {
        val rig = Rig(answer = { NoteTranscript("done", "feito") })
        rig.store.request("a")
        rig.scope.runCurrent()
        assertEquals(NoteTranscript("done", "feito"), rig.store.stored.value["a"])
        assertEquals(TranscriptRequest.Idle, rig.store.requests.value["a"] ?: TranscriptRequest.Idle)
    }

    @Test
    fun `a note that settled while the 202 was on its way stays settled`() {
        val rig = Rig(answer = { id ->
            // The frame beats the HTTP answer.
            rig202Frame(id)
            NoteTranscript("pending")
        })
        rigRef = rig
        rig.store.request("a")
        rig.scope.runCurrent()
        assertEquals("done", rig.status("a"))
    }

    private var rigRef: Rig? = null
    private fun rig202Frame(id: String) {
        rigRef!!.frames.tryEmit(PqpJson.decodeFromString(JsonObject.serializer(), transcriptFrame(id, "done", "ja foi")))
        rigRef!!.scope.runCurrent()
    }

    @Test
    fun `the server saying no takes the pending away and stops offering the button`() {
        val rig = Rig(answer = { throw ApiException(403, "no") })
        rig.store.request("a")
        rig.scope.runCurrent()
        assertNull(rig.store.stored.value["a"])
        assertEquals(TranscriptRequest.Refused, rig.store.requests.value["a"])
        val gone = Rig(answer = { throw ApiException(404, "gone") })
        gone.store.request("b")
        gone.scope.runCurrent()
        assertEquals(TranscriptRequest.Refused, gone.store.requests.value["b"])
    }

    @Test
    fun `the limiter keeps the button away for a moment, then gives it back`() {
        val rig = Rig(answer = { throw ApiException(429, "slow") })
        rig.store.request("a")
        rig.scope.runCurrent()
        assertNull(rig.store.stored.value["a"])
        assertEquals(TranscriptRequest.Slow, rig.store.requests.value["a"])
        rig.advance(NoteTranscripts.SLOW_DOWN_MS)
        assertEquals(TranscriptRequest.Idle, rig.store.requests.value["a"] ?: TranscriptRequest.Idle)
    }

    @Test
    fun `a request that did not get through is a failure the person can retry`() {
        val rig = Rig(answer = { throw java.io.IOException("offline") })
        rig.store.request("a")
        rig.scope.runCurrent()
        assertNull(rig.store.stored.value["a"])
        assertEquals(TranscriptRequest.Failed, rig.store.requests.value["a"])
        rig.answer = { NoteTranscript("done", "agora foi") }
        rig.store.request("a")
        rig.scope.runCurrent()
        assertEquals("done", rig.status("a"))
        assertEquals(2, rig.asked.size)
    }

    @Test
    fun `a pending answer asks again a little later, a few times, then lets go`() {
        val rig = Rig(answer = { NoteTranscript("pending") })
        rig.store.request("a")
        rig.scope.runCurrent()
        assertEquals(1, rig.asked.size)
        repeat(NoteTranscripts.RECHECK_LIMIT) { rig.advance(NoteTranscripts.RECHECK_AFTER_MS) }
        // The first ask plus one recheck per allowed round; the last one still pending is given up on and
        // the card falls back to its read.
        assertEquals(1 + NoteTranscripts.RECHECK_LIMIT, rig.asked.size)
        assertNull(rig.store.stored.value["a"])
        rig.advance(NoteTranscripts.RECHECK_AFTER_MS * 3)
        assertEquals(1 + NoteTranscripts.RECHECK_LIMIT, rig.asked.size)
    }

    @Test
    fun `a recheck stops the moment a frame settles the note`() {
        val rig = Rig(answer = { NoteTranscript("pending") })
        rig.store.request("a")
        rig.scope.runCurrent()
        rig.frame(transcriptFrame("a", "done", "chegou"))
        rig.advance(NoteTranscripts.RECHECK_AFTER_MS * 3)
        assertEquals(1, rig.asked.size)
        assertEquals("done", rig.status("a"))
    }
}
