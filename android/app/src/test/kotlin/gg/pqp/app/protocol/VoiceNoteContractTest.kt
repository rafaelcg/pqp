package gg.pqp.app.protocol

import gg.pqp.app.voicenotes.VOICE_NOTE_CONTENT_TYPE
import gg.pqp.app.voicenotes.VOICE_NOTE_MAX_DURATION_MS
import gg.pqp.app.voicenotes.VOICE_NOTE_MIN_DURATION_MS
import gg.pqp.app.voicenotes.VOICE_NOTE_WAVEFORM_PEAKS
import gg.pqp.app.voicenotes.noteByteBudget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The voice note numbers against `packages/shared/src/attachments.ts`, which
 * owns them. Same reasoning as `AttachmentContractTest`: every value on the
 * Android side is a hand-copy, and a wrong one is a 400 from a mint nobody
 * sees, after somebody has spoken for a minute.
 */
class VoiceNoteContractTest {

    private val shared = "packages/shared/src/attachments.ts"

    private fun source() = RepoSources.stripComments(RepoSources.read(shared))

    @Test
    fun `the duration floor matches`() {
        assertEquals(
            RepoSources.numberConstant(shared, "VOICE_NOTE_MIN_DURATION_MS").toLong(),
            VOICE_NOTE_MIN_DURATION_MS,
        )
    }

    @Test
    fun `the five minute ceiling matches`() {
        val match = Regex("""VOICE_NOTE_MAX_DURATION_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)""")
            .find(source())
            ?: error("VOICE_NOTE_MAX_DURATION_MS is no longer a product in $shared")
        val expected = match.groupValues.drop(1).fold(1L) { total, part -> total * part.toLong() }
        assertEquals(expected, VOICE_NOTE_MAX_DURATION_MS)
    }

    @Test
    fun `the waveform is the same number of peaks`() {
        assertEquals(
            RepoSources.numberConstant(shared, "VOICE_NOTE_WAVEFORM_PEAKS"),
            VOICE_NOTE_WAVEFORM_PEAKS,
        )
    }

    @Test
    fun `the container this client records is one the server takes for a voice note`() {
        val block = Regex("""VOICE_NOTE_CONTENT_TYPES\s*=\s*\[(.*?)]""", RegexOption.DOT_MATCHES_ALL)
            .find(source())
            ?: error("No VOICE_NOTE_CONTENT_TYPES in $shared")
        val types = Regex(""""([^"]+)"""").findAll(block.groupValues[1]).map { it.groupValues[1] }.toList()
        assertTrue("audio/mp4 is not a voice note type any more: $types", VOICE_NOTE_CONTENT_TYPE in types)
    }

    @Test
    fun `the byte budget is still sixteen KiB a second plus thirty-two`() {
        // Not evaluated, so read the arithmetic: if the server changes the
        // formula this fails and the copy is rechecked instead of drifting.
        assertTrue(
            "noteByteBudget changed in $shared",
            Regex("""16\s*\*\s*1024\s*\*\s*Math\.ceil\(durationMs\s*/\s*1000\)\s*\+\s*32\s*\*\s*1024""")
                .containsMatchIn(source()),
        )
        assertEquals(16L * 1024 * 3 + 32L * 1024, noteByteBudget(2_500))
    }

    @Test
    fun `the waveform is still base64 of 64 bytes, 88 characters`() {
        assertTrue(
            "The waveform regex changed in $shared",
            source().contains("""[A-Za-z0-9+/]{86}=="""),
        )
    }

    @Test
    fun `the voice block on a stored attachment still has the fields the card reads`() {
        val keys = RepoSources.objectKeys(shared, "voiceNoteSchema")
        for (field in listOf("durationMs", "waveform", "listenedByMe", "listenedBy")) {
            assertTrue("voiceNoteSchema lost $field: $keys", field in keys)
        }
    }

    @Test
    fun `the mint voice block still takes duration and waveform`() {
        assertEquals(listOf("durationMs", "waveform"), RepoSources.objectKeys(shared, "createVoiceNoteSchema"))
    }
}
