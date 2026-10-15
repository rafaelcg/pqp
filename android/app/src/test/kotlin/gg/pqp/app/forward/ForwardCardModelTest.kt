package gg.pqp.app.forward

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The states the forward card draws, without a screenshot. */
class ForwardCardModelTest {

    private val server = "11111111-1111-4111-8111-111111111111"
    private val item = "22222222-2222-4222-8222-222222222222"

    private fun post(
        title: String? = "Sessao 11",
        excerpt: String = "o clip inteiro",
        thumb: String? = null,
        kind: String? = null,
        restricted: Boolean = false,
    ) = MessageForward(
        v = 1, kind = FORWARD_KIND_BAU_POST, sourceServerId = server, sourceServerName = "QG",
        sourceServerIconUrl = "/api/servers/$server/icon?v=1", sourceId = item, title = title,
        excerpt = excerpt, mediaThumbUrl = thumb, mediaKind = kind, url = "https://pqp.gg/x",
        restricted = restricted,
    )

    private fun message(author: String? = "Rafa", channel: String? = "geral", excerpt: String = "bora") =
        MessageForward(
            v = 1, kind = FORWARD_KIND_MESSAGE, sourceServerId = server, sourceServerName = "QG",
            sourceChannelName = channel, sourceId = item, authorDisplayName = author,
            excerpt = excerpt, url = "https://pqp.gg/y",
        )

    @Test
    fun `a post with a poster draws title, excerpt and the thumbnail`() {
        val model = ForwardCards.model(post(thumb = "https://i.ytimg.com/vi/x/hq.jpg", kind = "youtube"))
        assertEquals(ForwardOrigin.Bau, model.origin)
        assertEquals("Sessao 11", model.heading)
        assertEquals("o clip inteiro", model.excerpt)
        assertEquals("https://i.ytimg.com/vi/x/hq.jpg", model.thumbUrl)
        assertEquals(ForwardGlyph.Youtube, model.glyph)
        assertFalse(model.isEmpty)
    }

    @Test
    fun `a text post has no thumbnail and no glyph`() {
        val model = ForwardCards.model(post())
        assertNull(model.thumbUrl)
        assertNull(model.glyph)
        assertFalse(model.isEmpty)
    }

    @Test
    fun `a media kind with no stored thumbnail draws a glyph for the kind`() {
        assertEquals(ForwardGlyph.Image, ForwardCards.model(post(kind = "image")).glyph)
        assertEquals(ForwardGlyph.Video, ForwardCards.model(post(kind = "video")).glyph)
        assertEquals(ForwardGlyph.Embed, ForwardCards.model(post(kind = "embed")).glyph)
        assertNull(ForwardCards.model(post(kind = "hologram")).glyph)
    }

    @Test
    fun `media alone is a card even with no words`() {
        val model = ForwardCards.model(post(title = null, excerpt = "", kind = "image"))
        assertFalse(model.isEmpty)
        assertNull(model.heading)
        assertEquals("", model.excerpt)
    }

    @Test
    fun `a snapshot with nothing to show says so`() {
        val model = ForwardCards.model(post(title = "  ", excerpt = " ", thumb = " "))
        assertTrue(model.isEmpty)
        assertEquals("", model.spokenSummary())
    }

    @Test
    fun `a message reads its channel and leads with its author`() {
        val model = ForwardCards.model(message())
        assertEquals(ForwardOrigin.Channel("geral"), model.origin)
        assertEquals("Rafa", model.heading)
        assertEquals("bora", model.excerpt)
    }

    @Test
    fun `a message with no channel name or author still draws`() {
        val model = ForwardCards.model(message(author = null, channel = null))
        assertEquals(ForwardOrigin.Channel(""), model.origin)
        assertNull(model.heading)
        assertFalse(model.isEmpty)
    }

    @Test
    fun `a stray hash on the channel name is not doubled`() {
        assertEquals(ForwardOrigin.Channel("geral"), ForwardCards.model(message(channel = "#geral")).origin)
    }

    @Test
    fun `a restricted card says so`() {
        assertTrue(ForwardCards.model(post(restricted = true)).restricted)
        assertFalse(ForwardCards.model(post()).restricted)
    }

    @Test
    fun `the server icon is passed through for the avatar to resolve`() {
        assertEquals("/api/servers/$server/icon?v=1", ForwardCards.model(post()).serverIconUrl)
        assertNull(ForwardCards.model(post().copy(sourceServerIconUrl = "")).serverIconUrl)
    }

    @Test
    fun `the spoken summary joins the heading and the excerpt`() {
        assertEquals("Sessao 11. o clip inteiro", ForwardCards.model(post()).spokenSummary())
        assertEquals("o clip inteiro", ForwardCards.model(post(title = null)).spokenSummary())
    }
}
