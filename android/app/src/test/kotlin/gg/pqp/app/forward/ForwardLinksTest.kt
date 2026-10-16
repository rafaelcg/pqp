package gg.pqp.app.forward

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Where a tap on a forward card goes: in the app for this instance, a browser for the rest. */
class ForwardLinksTest {

    private val server = "11111111-1111-4111-8111-111111111111"
    private val channel = "33333333-3333-4333-8333-333333333333"
    private val item = "22222222-2222-4222-8222-222222222222"
    private val own = "https://pqp.gg"

    private fun forward(url: String) = MessageForward(
        v = 1, kind = FORWARD_KIND_BAU_POST, sourceServerId = server, sourceServerName = "QG",
        sourceId = item, excerpt = "x", url = url,
    )

    private fun resolve(url: String, appOrigin: String? = own) = ForwardLinks.resolve(forward(url), appOrigin)

    @Test
    fun `a Bau post on this instance opens in the app`() {
        assertEquals(
            ForwardOpen.BauPost(server, item),
            resolve("https://pqp.gg/app/server/$server/bau/$item"),
        )
    }

    @Test
    fun `a message jump link on this instance opens in the app`() {
        assertEquals(
            ForwardOpen.Message(server, channel, item),
            resolve("https://pqp.gg/app/server/$server/channel/$channel/message/$item"),
        )
        assertEquals(ForwardLinks.messagePath(server, channel, item), "/app/server/$server/channel/$channel/message/$item")
    }

    @Test
    fun `a query, a fragment or a trailing slash does not change where it goes`() {
        assertEquals(
            ForwardOpen.BauPost(server, item),
            resolve("https://pqp.gg/app/server/$server/bau/$item/?utm_source=x#top"),
        )
    }

    @Test
    fun `www and a shouted id are this instance too`() {
        assertEquals(
            ForwardOpen.BauPost(server, item),
            resolve("https://www.pqp.gg/app/server/${server.uppercase()}/bau/${item.uppercase()}"),
        )
    }

    @Test
    fun `the origin the app is built against is this instance`() {
        val local = "http://localhost:5173"
        assertEquals(
            ForwardOpen.BauPost(server, item),
            resolve("$local/app/server/$server/bau/$item", appOrigin = local),
        )
        // And another origin is not, even with the same path.
        assertTrue(resolve("http://localhost:5173/app/server/$server/bau/$item", appOrigin = null) is ForwardOpen.External)
    }

    @Test
    fun `another host goes to the browser with the url untouched`() {
        val url = "https://elsewhere.example/app/server/$server/bau/$item"
        assertEquals(ForwardOpen.External(url), resolve(url))
    }

    @Test
    fun `a lookalike host goes to the browser`() {
        assertTrue(resolve("https://pqp.gg.evil.example/app/server/$server/bau/$item") is ForwardOpen.External)
        assertTrue(resolve("https://evilpqp.gg/app/server/$server/bau/$item") is ForwardOpen.External)
        assertTrue(resolve("http://pqp.gg/app/server/$server/bau/$item") is ForwardOpen.External)
    }

    @Test
    fun `a path this build does not know goes to the browser even on this instance`() {
        assertTrue(resolve("https://pqp.gg/c/some-community/p/$item") is ForwardOpen.External)
        assertTrue(resolve("https://pqp.gg/app/server/$server/channel/$channel") is ForwardOpen.External)
        assertTrue(resolve("https://pqp.gg/app/server/not-a-uuid/bau/$item") is ForwardOpen.External)
    }

    @Test
    fun `a value that is not a url at all is kept for the browser check to refuse`() {
        val open = resolve("nonsense")
        assertEquals(ForwardOpen.External("nonsense"), open)
        assertFalse(ForwardLinks.isBrowsable("nonsense"))
    }

    @Test
    fun `only http and https reach a browser`() {
        assertTrue(ForwardLinks.isBrowsable("https://pqp.gg/c/x"))
        assertTrue(ForwardLinks.isBrowsable("  http://localhost:5173/x "))
        assertFalse(ForwardLinks.isBrowsable("intent://scan/#Intent;scheme=zxing;end"))
        assertFalse(ForwardLinks.isBrowsable("javascript:alert(1)"))
        assertFalse(ForwardLinks.isBrowsable("file:///etc/passwd"))
        assertFalse(ForwardLinks.isBrowsable("content://media/external/1"))
        assertFalse(ForwardLinks.isBrowsable(""))
    }
}
