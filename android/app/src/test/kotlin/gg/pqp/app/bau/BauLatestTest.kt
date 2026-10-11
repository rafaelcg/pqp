package gg.pqp.app.bau

import com.sun.net.httpserver.HttpServer
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.TokenProvider
import java.net.InetSocketAddress
import java.util.concurrent.LinkedBlockingQueue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The channel list's Baú preview: `/home/latest` decoded onto the chat card,
 * which of the four shapes it draws, and the 404 that sends an older API back
 * to the plain row.
 */
class BauLatestTest {

    private val s = "11111111-1111-4111-8111-111111111111"

    private fun card(id: String, title: String?, isNew: Boolean, kind: String? = null, url: String? = null) = """
        {"postId":"$id","serverId":"$s","serverName":"QG","title":${title?.let { "\"$it\"" } ?: "null"},
         "teaser":null,"author":{"id":"u1","displayName":"Bia","avatarUrl":null},
         "mediaKind":${kind?.let { "\"$it\"" } ?: "null"},"mediaUrl":${url?.let { "\"$it\"" } ?: "null"},
         "visibility":"public","locked":false,"pinned":false,"likeCount":23,"commentCount":8,
         "publishedAt":"2026-10-11T20:00:00.000Z","isNew":$isNew}
    """.trimIndent()

    private fun parse(json: String) = parseBauLatest(PqpJson.parseToJsonElement(json).jsonObject)

    @Test
    fun `decodes the card chat already draws, plus isNew`() {
        val latest = parse(
            """{"unread":2,"lastSeenAt":"2026-10-10T00:00:00.000Z","posts":[
                ${card("p1", "Clutch 1v4", true, "youtube", "https://img/p1.jpg")},
                ${card("p2", "Camp do QG", true)},
                ${card("p3", "Velho", false)}]}""",
        )
        assertEquals(2, latest.unread)
        assertEquals("2026-10-10T00:00:00.000Z", latest.lastSeenAt)
        assertEquals(listOf("p1", "p2", "p3"), latest.posts.map { it.card.postId })
        assertEquals(listOf(true, true, false), latest.posts.map { it.isNew })
        assertEquals(23, latest.posts[0].card.likeCount)
        assertEquals("Bia", latest.posts[0].card.author?.displayName)
    }

    @Test
    fun `a post that does not decode is skipped, and a missing isNew is not new`() {
        val latest = parse(
            """{"unread":0,"posts":[{"nope":1},
                {"postId":"p9","serverId":"$s","title":"x","locked":false,"pinned":false,
                 "likeCount":0,"commentCount":0}]}""",
        )
        assertEquals(listOf("p9"), latest.posts.map { it.card.postId })
        assertFalse(latest.posts.single().isNew)
        assertNull(latest.lastSeenAt)
    }

    @Test
    fun `no answer from the route means the plain row with the old unread count`() {
        assertEquals(BauPreviewState.Plain(4), bauPreviewState(null, legacyUnread = 4, canPost = true))
    }

    @Test
    fun `an empty Bau invites the staff and is quiet for members`() {
        val empty = BauLatest(unread = 0, lastSeenAt = null, posts = emptyList())
        assertEquals(BauPreviewState.Empty(canPost = true), bauPreviewState(empty, 0, canPost = true))
        assertEquals(BauPreviewState.Empty(canPost = false), bauPreviewState(empty, 0, canPost = false))
    }

    @Test
    fun `something new is the card, naming the next new post and counting the rest`() {
        val latest = parse(
            """{"unread":3,"posts":[${card("p1", "A", true)},${card("p2", "B", true)},${card("p3", "C", true)}]}""",
        )
        val state = bauPreviewState(latest, 0, canPost = false) as BauPreviewState.Fresh
        assertEquals("p1", state.post.postId)
        assertEquals("p2", state.next?.postId)
        assertEquals(2, state.moreCount)
    }

    @Test
    fun `one new post on top of seen ones is a card with no footer`() {
        val latest = parse("""{"unread":1,"posts":[${card("p1", "A", true)},${card("p2", "B", false)}]}""")
        val state = bauPreviewState(latest, 0, canPost = false) as BauPreviewState.Fresh
        assertNull(state.next)
        assertEquals(0, state.moreCount)
    }

    @Test
    fun `seen shrinks to the slim row with the latest post`() {
        val latest = parse("""{"unread":0,"posts":[${card("p1", "A", false)}]}""")
        val state = bauPreviewState(latest, 0, canPost = true)
        assertTrue(state is BauPreviewState.Seen)
        assertEquals("p1", (state as BauPreviewState.Seen).post.postId)
    }

    @Test
    fun `the card leads with the newest new post, not with my own newer one`() {
        val latest = parse(
            """{"unread":2,"posts":[${card("mine", "Meu", false)},${card("p2", "B", true)},${card("p3", "C", true)}]}""",
        )
        val state = bauPreviewState(latest, 0, canPost = true) as BauPreviewState.Fresh
        assertEquals("p2", state.post.postId)
        assertEquals("p3", state.next?.postId)
        assertEquals(1, state.moreCount)
    }

    @Test
    fun `an unread count with no decodable new post keeps the count instead of hiding it`() {
        val oldOnly = parse("""{"unread":2,"posts":[${card("p1", "A", false)}]}""")
        assertEquals(BauPreviewState.Plain(2), bauPreviewState(oldOnly, 0, canPost = false))
        val none = BauLatest(unread = 1, lastSeenAt = null, posts = emptyList())
        assertEquals(BauPreviewState.Plain(1), bauPreviewState(none, 0, canPost = true))
    }

    @Test
    fun `the thumbnail never pulls a frame out of a video`() {
        fun c(kind: String?, url: String?, locked: Boolean = false) =
            BauPostCard(postId = "p", serverId = s, mediaKind = kind, mediaUrl = url, locked = locked)
        assertEquals(BauThumb.Image, bauThumb(c("image", "https://x/i.png")))
        assertEquals(BauThumb.Image, bauThumb(c("youtube", "https://x/poster.jpg")))
        assertEquals(BauThumb.Plate, bauThumb(c("video", "https://x/v.mp4")))
        assertEquals(BauThumb.Plate, bauThumb(c("twitch", null)))
        assertEquals(BauThumb.Plate, bauThumb(c("image", "https://x/i.png", locked = true)))
        assertEquals(BauThumb.Text, bauThumb(c(null, null)))
    }

    // --- against a socket -------------------------------------------------

    private lateinit var server: HttpServer
    private lateinit var baseUrl: String
    private val paths = LinkedBlockingQueue<String>()
    private val answers = LinkedBlockingQueue<Pair<Int, String>>()

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            paths += exchange.requestURI.toString()
            val (status, body) = answers.poll() ?: (500 to """{"error":"none queued"}""")
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        baseUrl = "http://127.0.0.1:${server.address.port}"
    }

    @After
    fun stop() {
        server.stop(0)
    }

    private fun client() = ApiClient(TokenProvider { "t0" }, ApiClient.defaultHttpClient(), PqpJson, baseUrl)

    @Test
    fun `asks for three and decodes the answer`() = runTest {
        answers += 200 to """{"unread":1,"lastSeenAt":null,"posts":[${card("p1", "A", true)}]}"""
        val latest = client().bauLatest(s)
        assertEquals("/api/servers/$s/home/latest?limit=3", paths.take())
        assertEquals("p1", latest?.posts?.single()?.card?.postId)
    }

    @Test
    fun `a 404 is an API without the route, answered as null`() = runTest {
        answers += 404 to """{"error":"Not found"}"""
        assertNull(client().bauLatest(s))
    }

    @Test
    fun `any other failure throws, so it is not mistaken for no route`() = runTest {
        answers += 500 to """{"error":"boom"}"""
        try {
            client().bauLatest(s)
            fail("expected a throw")
        } catch (e: ApiException) {
            assertEquals(500, e.status)
        }
    }
}
