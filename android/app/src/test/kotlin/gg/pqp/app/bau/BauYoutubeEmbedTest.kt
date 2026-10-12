package gg.pqp.app.bau

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BauYoutubeEmbedTest {
    private val id = "dQw4w9WgXcQ"

    @Test
    fun `the page asks the no-cookie host to play inline`() {
        val page = BauYoutubeEmbed.playerPage(id)
        assertTrue(page.contains("host:'https://www.youtube-nocookie.com'"))
        assertTrue(page.contains("videoId:'$id'"))
        assertTrue(page.contains("playsinline:1"))
        assertTrue(page.contains("autoplay:1"))
        assertTrue(page.contains("rel:0"))
    }

    @Test
    fun `the page names the origin it is loaded under, without a trailing slash`() {
        assertTrue(BauYoutubeEmbed.playerPage(id, "https://pqp.gg/").contains("origin:'https://pqp.gg'"))
    }

    @Test
    fun `the page reports to the bridge the app installs`() {
        val page = BauYoutubeEmbed.playerPage(id)
        assertTrue(page.contains("window.${BauYoutubeEmbed.BRIDGE}.onState"))
        assertTrue(page.contains("window.${BauYoutubeEmbed.BRIDGE}.onError"))
        assertTrue(page.contains("function bauPause()"))
    }

    @Test
    fun `the poster is the public thumbnail`() {
        assertEquals("https://i.ytimg.com/vi/$id/hqdefault.jpg", BauYoutubeEmbed.posterUrl(id))
    }

    @Test
    fun `the page itself loads`() {
        assertTrue(BauYoutubeEmbed.mayLoad("https://pqp.gg/", isMainFrame = true))
        assertTrue(BauYoutubeEmbed.mayLoad("https://pqp.gg", isMainFrame = true))
        assertTrue(BauYoutubeEmbed.mayLoad("about:blank", isMainFrame = true))
    }

    @Test
    fun `the main frame never follows a link out`() {
        assertFalse(BauYoutubeEmbed.mayLoad("https://www.youtube.com/watch?v=$id", isMainFrame = true))
        assertFalse(BauYoutubeEmbed.mayLoad("https://youtu.be/$id", isMainFrame = true))
        assertFalse(BauYoutubeEmbed.mayLoad("https://pqp.gg/app", isMainFrame = true))
        assertFalse(BauYoutubeEmbed.mayLoad("https://evil.example/", isMainFrame = true))
    }

    @Test
    fun `the player frame may load over the web`() {
        assertTrue(BauYoutubeEmbed.mayLoad("https://www.youtube-nocookie.com/embed/$id", isMainFrame = false))
        assertTrue(BauYoutubeEmbed.mayLoad("https://www.youtube.com/embed/$id", isMainFrame = false))
    }

    @Test
    fun `an app scheme is refused everywhere`() {
        assertFalse(BauYoutubeEmbed.mayLoad("youtube://watch?v=$id", isMainFrame = false))
        assertFalse(BauYoutubeEmbed.mayLoad("intent://watch#Intent;end", isMainFrame = false))
        assertFalse(BauYoutubeEmbed.mayLoad("vnd.youtube:$id", isMainFrame = true))
        assertFalse(BauYoutubeEmbed.mayLoad(null, isMainFrame = false))
        assertFalse(BauYoutubeEmbed.mayLoad("not a url", isMainFrame = false))
    }

    @Test
    fun `player states are read`() {
        assertEquals(BauYoutubeEmbed.Event.PLAYING, BauYoutubeEmbed.event(1))
        assertEquals(BauYoutubeEmbed.Event.BUFFERING, BauYoutubeEmbed.event(3))
        for (stopped in listOf(0, 2, 5, -1)) {
            assertEquals("$stopped", BauYoutubeEmbed.Event.STOPPED, BauYoutubeEmbed.event(stopped))
        }
        assertNull(BauYoutubeEmbed.event(42))
    }

    @Test
    fun `a displaced player may not claim again until it has stopped`() {
        val gate = BauEmbedGate()
        assertTrue(gate.mayClaim())
        gate.yielded()
        assertFalse("a playing report in flight re-pauses", gate.mayClaim())
        gate.stopped()
        assertTrue("the person's own next tap claims", gate.mayClaim())
    }

    @Test
    fun `a disposed player never claims`() {
        val gate = BauEmbedGate()
        gate.dispose()
        assertFalse(gate.alive)
        assertFalse(gate.mayClaim())
        gate.stopped()
        assertFalse(gate.mayClaim())
    }
}
