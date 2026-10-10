package gg.pqp.app.bau

import gg.pqp.app.bau.BauChannelRefs.Part
import gg.pqp.app.core.Channel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The phone's copy of the web's `channel-refs.test.ts`: same cases, same answers. */
class BauChannelRefsTest {

    private val geral = "11111111-2222-4333-8444-555555555555"
    private val voz = "22222222-2222-4333-8444-555555555555"
    private val secret = "33333333-2222-4333-8444-555555555555"
    private val category = "44444444-2222-4333-8444-555555555555"

    private fun channel(id: String, name: String, type: String = "text") =
        Channel(id = id, name = name, type = type)

    private val channels = listOf(
        channel(category, "texto", "category"),
        channel(geral, "geral"),
        channel(voz, "Sala-de-voz", "voice"),
        channel("55555555-2222-4333-8444-555555555555", "geral-2"),
    )

    @Test
    fun `a stored reference becomes a link with the channel's current name`() {
        assertEquals(
            listOf(Part.Text("manda no "), Part.Link(geral, "geral"), Part.Text(" hoje")),
            BauChannelRefs.parse("manda no <#$geral> hoje", channels),
        )
    }

    @Test
    fun `the id is matched case-insensitively`() {
        assertEquals(
            listOf(Part.Link(geral, "geral")),
            BauChannelRefs.parse("<#${geral.uppercase()}>", channels),
        )
    }

    @Test
    fun `a channel the viewer cannot see is unavailable and never named`() {
        val parts = BauChannelRefs.parse("veja <#$secret>", channels)
        assertEquals(listOf(Part.Text("veja "), Part.Unavailable(secret)), parts)
    }

    @Test
    fun `a category is not a link`() {
        assertEquals(listOf(Part.Unavailable(category)), BauChannelRefs.parse("<#$category>", channels))
    }

    @Test
    fun `old plain text hash resolves when exactly one channel has the name`() {
        assertEquals(
            listOf(
                Part.Text("Testa aí e manda um áudio no "),
                Part.Link(geral, "geral"),
                Part.Text(" dizendo o que achou"),
            ),
            BauChannelRefs.parse("Testa aí e manda um áudio no #geral dizendo o que achou", channels),
        )
        assertEquals(
            listOf(Part.Link(voz, "Sala-de-voz"), Part.Text("!")),
            BauChannelRefs.parse("#sala-de-voz!", channels),
        )
    }

    @Test
    fun `unknown ambiguous mid-word and url hashes stay text`() {
        val dup = channels + channel("66666666-2222-4333-8444-555555555555", "GERAL")
        for ((text, list) in listOf(
            "#nada" to channels,
            "#geral" to dup,
            "a#geral" to channels,
            "https://x.com/p#geral" to channels,
            "#geralzao" to channels,
            "&#geral;" to channels,
        )) {
            assertEquals(text, listOf<Part>(Part.Text(text)), BauChannelRefs.parse(text, list))
        }
        assertEquals(emptyList<Part>(), BauChannelRefs.parse("", channels))
        assertEquals(listOf<Part>(Part.Text("oi #geral")), BauChannelRefs.parse("oi #geral", emptyList()))
    }

    @Test
    fun `findQuery finds the token under the caret`() {
        assertEquals(BauChannelRefs.Query(9, 12, "ge"), BauChannelRefs.findQuery("manda no #ge", 12))
        assertEquals(BauChannelRefs.Query(0, 1, ""), BauChannelRefs.findQuery("#", 1))
        assertEquals(BauChannelRefs.Query(3, 7, "voz"), BauChannelRefs.findQuery("oi\n#voz resto", 7))
        assertNull(BauChannelRefs.findQuery("page#anchor", 11))
        assertNull(BauChannelRefs.findQuery("<#$geral>", 5))
        assertNull(BauChannelRefs.findQuery("#geral ", 7))
        assertNull(BauChannelRefs.findQuery("sem hash", 4))
    }

    @Test
    fun `filter lists everything but categories, prefix before substring, capped`() {
        assertEquals(listOf("geral", "Sala-de-voz", "geral-2"), BauChannelRefs.filter(channels, "").map { it.name })
        assertEquals(listOf("Sala-de-voz"), BauChannelRefs.filter(channels, "VOZ").map { it.name })
        assertEquals(listOf("geral", "geral-2"), BauChannelRefs.filter(channels, "ger").map { it.name })
        assertEquals(listOf("geral-2"), BauChannelRefs.filter(channels, "2").map { it.name })
        assertTrue(BauChannelRefs.filter(channels, "zzz").isEmpty())
        val many = (1..20).map { channel("id$it", "c$it") }
        assertEquals(BauChannelRefs.MAX_SUGGESTIONS, BauChannelRefs.filter(many, "").size)
    }

    @Test
    fun `apply swaps the token for the name and one space`() {
        val text = "manda no #ge agora"
        val query = BauChannelRefs.findQuery(text, 12)!!
        assertEquals(
            BauChannelRefs.Insertion("manda no #geral agora", 16),
            BauChannelRefs.apply(text, query, channels[1], channels),
        )
        val end = BauChannelRefs.findQuery("fala no #", 9)!!
        assertEquals(
            BauChannelRefs.Insertion("fala no #geral ", 15),
            BauChannelRefs.apply("fala no #", end, channels[1], channels),
        )
    }

    @Test
    fun `apply inserts the raw token when two channels share the name`() {
        val dup = channels + channel("66666666-2222-4333-8444-555555555555", "GERAL")
        val query = BauChannelRefs.findQuery("#ge", 3)!!
        assertEquals("<#$geral> ", BauChannelRefs.apply("#ge", query, dup[1], dup).value)
    }

    @Test
    fun `display and stored forms round trip`() {
        val stored = "manda no <#$geral> e na <#$voz>"
        val display = BauChannelRefs.toDisplay(stored, channels)
        assertEquals("manda no #geral e na #Sala-de-voz", display)
        assertEquals(stored, BauChannelRefs.toStored(display, channels))
        // A token the editor cannot name stays a token both ways.
        assertEquals("veja <#$secret>", BauChannelRefs.toDisplay("veja <#$secret>", channels))
        assertEquals("veja <#$secret>", BauChannelRefs.toStored("veja <#$secret>", channels))
        assertEquals("oi #nada e a#geral", BauChannelRefs.toStored("oi #nada e a#geral", channels))
    }

    @Test
    fun `the draft is limited on what the server will store`() {
        // 4000 characters of "#geral " fit on screen but become <#uuid> on the wire.
        val text = "#geral ".repeat(570)
        assertTrue(text.length <= BAU_BODY_MAX)
        val draft = BauComposeDraft(title = "t", body = text)
        assertNull(draft.problem())
        assertEquals(BauComposeProblem.BodyTooLong, draft.problem(channels))
        assertNull(draft.toRequest(channels))
        val ok = BauComposeDraft(title = "t", body = "oi #geral")
        assertEquals("oi <#$geral>", ok.toRequest(channels)!!.body)
        assertNotNull(ok.toRequest())
        assertFalse(ok.toRequest()!!.body!!.contains("<#"))
    }
}
