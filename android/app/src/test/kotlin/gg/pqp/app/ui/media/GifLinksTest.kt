package gg.pqp.app.ui.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The allowlist that decides whether a message body is drawn as a picture.
 *
 * Every case here has a counterpart in `client/src/lib/gif-media.test.ts` or
 * `packages/shared/src/api.test.ts`, deliberately: the three clients have to
 * agree about which bodies are media, and the ones that read as hostile are
 * the reason the predicate exists at all.
 */
class GifLinksTest {

    private val giphy = "https://media3.giphy.com/media/abc123/giphy.gif"
    private val tenor = "https://media.tenor.com/xyz/happy-dance.gif"

    @Test
    fun `an allowlisted host serving an image is media`() {
        assertTrue(GifLinks.isMediaUrl(giphy))
        assertTrue(GifLinks.isMediaUrl(tenor))
        assertTrue(GifLinks.isMediaUrl("https://i.giphy.com/abc123.gif"))
        assertTrue(GifLinks.isMediaUrl("https://c.tenor.com/abc/x.gif"))
        assertTrue(GifLinks.isMediaUrl("https://media.giphy.com/media/abc/giphy.webp"))
    }

    @Test
    fun `a query string does not stop it being media`() {
        // Both providers append tracking parameters to the URL the picker
        // hands back, so a check that looked at the whole string rather than
        // at the path would refuse every real GIF.
        assertTrue(GifLinks.isMediaUrl("https://media0.giphy.com/media/abc/giphy.gif?cid=1&ct=g"))
    }

    @Test
    fun `any other host is not media, however the URL is dressed up`() {
        assertFalse(GifLinks.isMediaUrl("https://evil.example/tracker.gif"))
        // The three ways a hostile host is made to read as a trusted one.
        assertFalse(GifLinks.isMediaUrl("https://giphy.com.evil.example/giphy.gif"))
        assertFalse(GifLinks.isMediaUrl("https://notgiphy.com/media/abc/giphy.gif"))
        assertFalse(GifLinks.isMediaUrl("https://media.giphy.com@evil.example/a.gif"))
        assertFalse(GifLinks.isMediaUrl("https://user:pw@media.giphy.com/media/abc/giphy.gif"))
    }

    @Test
    fun `the bare provider domain is not a media host`() {
        assertFalse(GifLinks.isMediaUrl("https://giphy.com/media/abc/giphy.gif"))
        assertFalse(GifLinks.isMediaUrl("https://tenor.com/view/abc.gif"))
    }

    @Test
    fun `http is refused even on an allowlisted host`() {
        assertFalse(GifLinks.isMediaUrl("http://media.giphy.com/media/abc/giphy.gif"))
    }

    @Test
    fun `a path that is not an image is not media`() {
        assertFalse(GifLinks.isMediaUrl("https://media.giphy.com/media/abc/giphy.mp4"))
        assertFalse(GifLinks.isMediaUrl("https://media.giphy.com/media/abc/"))
    }

    @Test
    fun `an extension in the query string does not count`() {
        // Only the path decides. `?x=.gif` on an HTML page would otherwise be
        // enough to get that page drawn as a picture.
        assertFalse(GifLinks.isMediaUrl("https://media.giphy.com/media/abc/page?x=.gif"))
    }

    @Test
    fun `a body that is only the URL is media`() {
        assertEquals(giphy, GifLinks.mediaBody(giphy))
        // Whitespace around it is still only the URL. A share sheet appends a
        // newline often enough that ignoring this would look random.
        assertEquals(giphy, GifLinks.mediaBody("  $giphy\n"))
    }

    @Test
    fun `a body with words around the URL stays text`() {
        // The rule that matters most: somebody wrote a sentence, and replacing
        // it with the picture would lose what they said.
        assertNull(GifLinks.mediaBody("look at this $giphy"))
        assertNull(GifLinks.mediaBody("$giphy lol"))
        assertNull(GifLinks.mediaBody("$giphy $tenor"))
    }

    @Test
    fun `ordinary text is not media`() {
        assertNull(GifLinks.mediaBody(""))
        assertNull(GifLinks.mediaBody("   "))
        assertNull(GifLinks.mediaBody("hello"))
        assertNull(GifLinks.mediaBody("not a url at all"))
    }

    @Test
    fun `something that is not a URL at all does not throw`() {
        // `URI` throws on plenty of ordinary text, and every message body in
        // the app goes through here.
        assertFalse(GifLinks.isMediaUrl("::::"))
        assertFalse(GifLinks.isMediaUrl("https://"))
        assertFalse(GifLinks.isMediaUrl("https://[bad"))
        assertFalse(GifLinks.isMediaUrl("mailto:someone@example.com"))
    }
}
