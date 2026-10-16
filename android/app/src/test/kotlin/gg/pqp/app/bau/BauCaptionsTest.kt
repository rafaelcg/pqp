package gg.pqp.app.bau

import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Baú subtitles: the rules of `client/src/lib/community-home/captions.ts` and `community-home-media.tsx`, the WebVTT the
 * server writes (`server/src/speech/captions.ts`), and the wire shapes read from `packages/shared`.
 */
class BauCaptionsTest {

    private fun track(lang: String, source: Boolean = false) = BauCaptionTrack(lang = lang, source = source, vtt = "")

    // --- wire ---

    @Test
    fun `the post's captions block and the tracks decode the shared shapes`() {
        val captions = PqpJson.decodeFromString(BauPostCaptions.serializer(), """{"sourceLang":"pt","langs":["pt","en"],"durationMs":12345}""")
        assertEquals("pt", captions.sourceLang)
        assertEquals(listOf("pt", "en"), captions.langs)
        assertEquals(12_345L, captions.durationMs)
        // `durationMs` may be null (an older transcription), and an empty block must still decode.
        assertNull(PqpJson.decodeFromString(BauPostCaptions.serializer(), """{"sourceLang":"pt","langs":["pt"],"durationMs":null}""").durationMs)
        val response = PqpJson.decodeFromString(
            BauCaptionsResponse.serializer(),
            """{"tracks":[{"lang":"pt","source":true,"auto":true,"vtt":"WEBVTT\n\n"}]}""",
        )
        assertEquals(listOf("pt"), response.tracks.map { it.lang })
        val shared = RepoSources.read("packages/shared/src/community-home.ts")
        for (field in listOf("sourceLang", "langs", "durationMs", "lang", "source", "auto", "vtt", "tracks")) {
            assertTrue(field, shared.contains("$field: z"))
        }
    }

    @Test
    fun `a post decodes with and without captions`() {
        val base = """{"id":"p","serverId":"s","author":{"id":"a","displayName":"A","username":"a","tag":"a#1","avatarUrl":null},"createdAt":"2026-10-01T00:00:00Z""""
        assertNull(PqpJson.decodeFromString(BauPost.serializer(), "$base}").captions)
        assertEquals("en", PqpJson.decodeFromString(BauPost.serializer(), "$base,\"captions\":{\"sourceLang\":\"en\",\"langs\":[\"en\"],\"durationMs\":null}}").captions?.sourceLang)
    }

    @Test
    fun `the duration tolerance is the web's`() {
        val web = RepoSources.read("client/src/components/community-home/community-home-media.tsx")
        val tolerance = Regex("""CAPTIONS_DURATION_TOLERANCE_MS\s*=\s*([\d_]+)""").find(web)!!.groupValues[1].replace("_", "").toLong()
        assertEquals(tolerance, BauCaptions.DURATION_TOLERANCE_MS)
    }

    // --- on or off, which track ---

    @Test
    fun `subtitles start on for a video in another language, off for the reader's own`() {
        assertTrue(BauCaptions.onByDefault("en", "pt-BR", null))
        assertFalse(BauCaptions.onByDefault("pt", "pt-BR", null))
        assertFalse(BauCaptions.onByDefault("PT", "pt_BR", null))
        // A language Whisper could not tell is not assumed to be ours.
        assertTrue(BauCaptions.onByDefault("und", "pt-BR", null))
        assertTrue(BauCaptions.onByDefault("", "pt-BR", null))
    }

    @Test
    fun `a press of the button wins on every video after it`() {
        assertFalse(BauCaptions.onByDefault("en", "pt-BR", false))
        assertTrue(BauCaptions.onByDefault("pt", "pt-BR", true))
    }

    @Test
    fun `the reader's own language when there is a track in it, else what was said`() {
        val pt = track("pt")
        val en = track("en", source = true)
        assertEquals(pt, BauCaptions.pickTrack(listOf(en, pt), "pt-BR"))
        assertEquals(en, BauCaptions.pickTrack(listOf(pt, en), "es-MX"))
        assertEquals(pt, BauCaptions.pickTrack(listOf(pt), "fr"))
        assertNull(BauCaptions.pickTrack(emptyList(), "pt-BR"))
    }

    @Test
    fun `the language is asked for by its base, and a name has the reader's own spelling`() {
        assertEquals("pt", BauCaptions.requestLang("pt-BR"))
        assertEquals("en", BauCaptions.requestLang(""))
        assertEquals("Português", BauCaptions.languageName("pt", Locale.forLanguageTag("pt-BR")))
        assertEquals("English", BauCaptions.languageName("en", Locale.ENGLISH))
        assertNull(BauCaptions.languageName("und", Locale.ENGLISH))
        assertNull(BauCaptions.languageName("", Locale.ENGLISH))
    }

    // --- the vertical cut ---

    private fun source(durationMs: Long?, mustMatch: Boolean) = BauCaptionsSource("s", "p", "pt", durationMs, mustMatch)

    @Test
    fun `the main video always takes the subtitles`() {
        assertTrue(BauCaptions.fits(source(null, false), null))
        assertTrue(BauCaptions.fits(source(60_000, false), 99_000))
    }

    @Test
    fun `the vertical cut takes them only while its length agrees with the transcribed sound`() {
        assertTrue(BauCaptions.fits(source(60_000, true), 60_000))
        assertTrue(BauCaptions.fits(source(60_000, true), 61_500))
        assertFalse(BauCaptions.fits(source(60_000, true), 61_501))
        assertFalse(BauCaptions.fits(source(60_000, true), 40_000))
        // Not known yet, or never recorded: wait, never guess.
        assertFalse(BauCaptions.fits(source(60_000, true), null))
        assertFalse(BauCaptions.fits(source(null, true), 60_000))
    }

    // --- WebVTT ---

    @Test
    fun `the file the server writes reads as cues`() {
        val vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nBora jogar\nhoje?\n\n2\n00:00:04.000 --> 00:01:05.250\nTudo bem &amp; voc&ecirc;\n"
        val cues = BauCaptions.parseVtt(vtt)
        assertEquals(2, cues.size)
        assertEquals(CaptionCue(1_000, 3_500, "Bora jogar\nhoje?"), cues[0])
        // Escapes the server writes are undone; an entity it never writes is left as it came.
        assertEquals(CaptionCue(4_000, 65_250, "Tudo bem & voc&ecirc;"), cues[1])
    }

    @Test
    fun `an ordinary file of the same shape reads too, and nothing it cannot read throws`() {
        val vtt = "WEBVTT - nome\n\nNOTE um comentario\n\n01:02.500 --> 01:04,000 align:start\n<b>negrito</b> e <i>itálico</i>\n\nlixo sem tempo\n\n00:00:05.000 --> 00:00:04.000\nfim antes do começo\n\n00:00:06.000 --> 00:00:07.000\n\n"
        val cues = BauCaptions.parseVtt(vtt)
        assertEquals(listOf(CaptionCue(62_500, 64_000, "negrito e itálico")), cues)
        assertEquals(emptyList<CaptionCue>(), BauCaptions.parseVtt(""))
        assertEquals(emptyList<CaptionCue>(), BauCaptions.parseVtt("not a vtt at all"))
        // Windows line endings and an hour field.
        assertEquals(CaptionCue(3_600_000, 3_601_000, "uma hora"), BauCaptions.parseVtt("WEBVTT\r\n\r\n1\r\n01:00:00.000 --> 01:00:01.000\r\numa hora\r\n").single())
    }

    @Test
    fun `the cue to draw is the one on at that moment, none between`() {
        val cues = BauCaptions.parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\num\n\n00:00:05.000 --> 00:00:06.000\ndois\n")
        assertEquals("", BauCaptions.cueAt(cues, 0))
        assertEquals("um", BauCaptions.cueAt(cues, 1_000))
        assertEquals("um", BauCaptions.cueAt(cues, 2_999))
        assertEquals("", BauCaptions.cueAt(cues, 3_000))
        assertEquals("", BauCaptions.cueAt(cues, 4_500))
        assertEquals("dois", BauCaptions.cueAt(cues, 5_500))
        assertEquals("", BauCaptions.cueAt(cues, 9_000))
        assertEquals("", BauCaptions.cueAt(emptyList(), 1_000))
    }

    @Test
    fun `a long cue is still on while a shorter one that started inside it comes and goes`() {
        val cues = BauCaptions.parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:10.000\nlonga\n\n00:00:02.000 --> 00:00:03.000\ncurta\n")
        assertEquals("curta", BauCaptions.cueAt(cues, 2_500))
        assertEquals("longa", BauCaptions.cueAt(cues, 4_000))
    }
}
