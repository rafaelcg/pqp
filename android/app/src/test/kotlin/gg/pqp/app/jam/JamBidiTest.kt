package gg.pqp.app.jam

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A person's text inside the app's own sentence. The cases are the web's (`client/src/lib/bidi.test.ts`) and the
 * iOS ones (`JamBidiTests`), so the three clients agree, plus what an unclosed right-to-left override does to the
 * naming a row draws. Every control is written as an escape: a literal U+202E in a source file is invisible and
 * reorders the line it is on in an editor.
 */
class JamBidiTest {
    private val fsi = "⁨"
    private val pdi = "⁩"
    private val rlo = "‮"

    @Test
    fun `isolate wraps text in first-strong isolate characters`() {
        assertEquals("${fsi}Gabi$pdi", JamBidi.isolate("Gabi"))
        assertEquals("${fsi}مرحبا$pdi",JamBidi.isolate("مرحبا"))
    }

    @Test
    fun `every override, embedding and isolate control is dropped first, so the isolate cannot be closed early`() {
        assertEquals("abcdefghij", JamBidi.clean("a‮b‪c‬d⁧e⁩f⁦g⁨h‫i‭j"))
        assertEquals("", JamBidi.clean("‪‫‬‭‮⁦⁧⁨⁩"))
        assertEquals("${fsi}evil started by you $pdi", JamBidi.isolate("evil$pdi started by you $fsi"))
    }

    @Test
    fun `the implicit marks and the joiners stay because real text needs them`() {
        val text = "a‎b‏c؜d‍e‌f"
        assertEquals(text, JamBidi.clean(text))
        assertEquals("$fsi$text$pdi", JamBidi.isolate(text))
    }

    @Test
    fun `honest text of every kind displays unchanged`() {
        val honest = listOf(
            "אבי", // Hebrew
            "فيروز", // Arabic
            "Nguyễn Văn A", // Vietnamese, precomposed
            "Nguyễn Văn A", // Vietnamese, combining marks
            "👨‍👩‍👧‍👦 família", // family sequence
            "🇧🇷 Brasil", // flag
            "مهسا‌می", // Persian with a zero width non joiner
        )
        for (text in honest) {
            assertEquals(text, JamBidi.clean(text))
            assertEquals("$fsi$text$pdi", JamBidi.isolate(text))
        }
    }

    @Test
    fun `an empty value stays empty and an absent one is empty`() {
        assertEquals("", JamBidi.isolate(""))
        assertEquals("", JamBidi.isolate(rlo))
        assertEquals("", JamBidi.isolateOpt(null))
        assertEquals("${fsi}x$pdi", JamBidi.isolateOpt("x"))
    }

    @Test
    fun `cleaning what is isolated is cleaning the text`() {
        for (text in listOf("Gabi", "${rlo}Gabi", "אב")) {
            assertEquals(JamBidi.clean(text), JamBidi.clean(JamBidi.isolate(text)))
        }
    }

    // --- where it lands ---

    @Test
    fun `a track heading with an override in its label cannot reorder the dot or the instrument`() {
        assertEquals("Bass · ${fsi}take 2$pdi", JamNaming.heading("Bass", "${rlo}take 2"))
        assertFalse(JamNaming.heading("Bass", "${rlo}take 2").contains(rlo))
        // honest right-to-left text is wrapped and otherwise untouched
        assertEquals("Bass · ${fsi}אבי$pdi",JamNaming.heading("Bass", "אבי"))
    }

    @Test
    fun `a missing label is absent, never an empty slot`() {
        for (none in listOf(null, "", "   ", rlo, "$rlo$pdi ")) {
            assertEquals("Bass", JamNaming.heading("Bass", none))
        }
    }

    @Test
    fun `a typed value with nothing usable falls back to the app's own word`() {
        assertEquals("${fsi}rafa$pdi", JamNaming.drawn("${rlo}rafa", "Deleted account"))
        assertEquals("Deleted account", JamNaming.drawn(null, "Deleted account"))
        assertEquals("Deleted account", JamNaming.drawn("$rlo ", "Deleted account"))
        assertNull(JamNaming.drawn(null))
    }

    @Test
    fun `the people line isolates every name and the cleaned line is what TalkBack gets`() {
        val song = JamSongSummary(
            id = "s",
            channelId = "c",
            serverId = "x",
            title = "In Bloom",
            authorName = "${rlo}rafa",
            createdAt = "2026-11-01T10:00:00.000Z",
            updatedAt = "2026-11-01T10:00:00.000Z",
            trackCount = 2,
            contributorCount = 5,
        )
        val line = JamWho.line(song, listOf("${rlo}rafa", "duda"))
        assertEquals("${fsi}rafa$pdi, ${fsi}duda$pdi +3", line)
        assertEquals("rafa, duda +3", JamBidi.clean(line))
        assertEquals("${fsi}rafa$pdi +4", JamWho.line(song, null))
    }
}
