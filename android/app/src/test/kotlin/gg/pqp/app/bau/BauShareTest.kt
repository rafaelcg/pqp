package gg.pqp.app.bau

import gg.pqp.app.core.PqpJson
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin twin of `packages/shared/src/community-home-share.test.ts` and
 * `client/src/lib/community-home/share-card.test.ts`: the same cases, so the
 * three clients agree on what a Baú post address is.
 */
class BauShareTest {

    private val server = "0f5b7a3e-1c2d-4e8f-9a0b-1234567890ab"
    private val post = "aa11bb22-cc33-4dd4-8ee5-ff6677889900"
    private val path = "/app/server/$server/bau/$post"

    // ---- parsePath

    @Test
    fun `path round-trips`() {
        assertEquals(path, BauShare.path(server, post))
        assertEquals(BauPostRef(server, post), BauShare.parsePath(path))
        assertEquals(BauPostRef(server, post), BauShare.parsePath("$path/"))
    }

    @Test
    fun `ids are lower-cased so a shouted link still matches the row`() {
        val shouted = "/app/server/${server.uppercase()}/bau/${post.uppercase()}"
        assertEquals(BauPostRef(server, post), BauShare.parsePath(shouted))
    }

    @Test
    fun `anything that is not a post address is refused`() {
        assertNull(BauShare.parsePath("/app/server/$server/bau"))
        assertNull(BauShare.parsePath("/app/server/$server"))
        assertNull(BauShare.parsePath("/app/server/$server/channel/$post"))
        assertNull(BauShare.parsePath("/app/server/not-a-uuid/bau/$post"))
        assertNull(BauShare.parsePath("/other/app/server/$server/bau/$post"))
        assertNull(BauShare.parsePath("$path/extra"))
    }

    // ---- findLinks

    @Test
    fun `a link in prose ignores a trailing sentence mark and a query`() {
        val text = "Olha o novo post https://pqp.gg$path?ref=x. Corre!"
        val link = BauShare.findLinks(text).single()
        assertEquals(server, link.serverId)
        assertEquals(post, link.postId)
        assertEquals("https://pqp.gg", link.origin)
        assertEquals("https://pqp.gg$path?ref=x", link.url)
        assertEquals(link.url, text.substring(link.start, link.end))
    }

    @Test
    fun `fragment and trailing slash are ignored`() {
        val link = BauShare.findLinks("https://pqp.gg$path/#comentarios").single()
        assertEquals(BauPostRef(server, post), link.ref)
    }

    @Test
    fun `several links come back in order and unrelated ones are skipped`() {
        val other = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
        val text = "https://example.com/a http://localhost:5173$path https://pqp.gg${BauShare.path(server, other)}"
        val links = BauShare.findLinks(text)
        assertEquals(listOf(post, other), links.map { it.postId })
        assertEquals("http://localhost:5173", links[0].origin)
    }

    @Test
    fun `text with no post link finds nothing`() {
        assertTrue(BauShare.findLinks("").isEmpty())
        assertTrue(BauShare.findLinks("https://pqp.gg/app/server/$server/channel/$post").isEmpty())
        assertTrue(BauShare.findLinks("pqp.gg$path").isEmpty())
    }

    @Test
    fun `origin is lower-cased, drops a default port and ignores credentials`() {
        assertEquals("https://pqp.gg", BauShare.findLinks("HTTPS://PQP.GG:443$path").single().origin)
        assertEquals("http://localhost:5173", BauShare.findLinks("http://localhost:5173$path").single().origin)
        // The host is evil.com, not pqp.gg.
        assertEquals("https://evil.com", BauShare.findLinks("https://pqp.gg@evil.com$path").single().origin)
    }

    // ---- bodyIsOnlyLink

    @Test
    fun `bare link is only the link and words around it are not`() {
        val bare = "https://pqp.gg$path"
        assertTrue(BauShare.bodyIsOnlyLink(bare, BauShare.findLinks(bare).single()))
        val padded = " $bare\n"
        assertTrue(BauShare.bodyIsOnlyLink(padded, BauShare.findLinks(padded).single()))
        val noted = "Novo! $bare"
        assertFalse(BauShare.bodyIsOnlyLink(noted, BauShare.findLinks(noted).single()))
        val after = "$bare vem ver"
        assertFalse(BauShare.bodyIsOnlyLink(after, BauShare.findLinks(after).single()))
    }

    // ---- instance policy

    @Test
    fun `own instance is the app origin or the hosted app over https`() {
        val current = "http://localhost:5173"
        assertTrue(BauShare.isOwnInstanceOrigin("http://localhost:5173", current))
        assertTrue(BauShare.isOwnInstanceOrigin("https://pqp.gg", current))
        assertTrue(BauShare.isOwnInstanceOrigin("https://www.pqp.gg", null))
        assertFalse(BauShare.isOwnInstanceOrigin("http://pqp.gg", null))
        assertFalse(BauShare.isOwnInstanceOrigin("https://pqp.gg.evil.com", current))
        assertFalse(BauShare.isOwnInstanceOrigin("https://evil.com", current))
        assertFalse(BauShare.isOwnInstanceOrigin("http://localhost:3001", current))
        assertFalse(BauShare.isOwnInstanceOrigin("not an origin", current))
    }

    @Test
    fun `app url is normalised to an origin`() {
        assertEquals("https://staging.pqp-3yr.pages.dev", BauShare.ownOrigin("https://staging.pqp-3yr.pages.dev/"))
        assertEquals("http://10.0.2.2:5173", BauShare.ownOrigin("http://10.0.2.2:5173"))
        assertNull(BauShare.ownOrigin("nope"))
    }

    // ---- selection

    @Test
    fun `first same-instance link gets the card and a foreign instance stays plain`() {
        val other = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
        val body = "https://elsewhere.example$path https://pqp.gg${BauShare.path(server, other)}"
        val selected = BauShare.select(body, "https://app.example")!!
        assertEquals(other, selected.link.postId)
        assertFalse(selected.linkOnly)
        assertNull(BauShare.select("https://elsewhere.example$path", "https://app.example"))
        assertNull(BauShare.select(null))
        assertNull(BauShare.select(""))
        assertNull(BauShare.select("ola pessoal"))
    }

    @Test
    fun `an address inside code is a sample and gets no card`() {
        assertNull(BauShare.select("`https://pqp.gg$path`", null))
        assertNull(BauShare.select("```\nhttps://pqp.gg$path\n```", null))
        val mixed = "`x` e https://pqp.gg$path"
        val selected = BauShare.select(mixed, null)!!
        assertEquals(mixed.indexOf("https"), selected.link.start)
    }

    @Test
    fun `a message that is only the link is linkOnly`() {
        val selected = BauShare.select("https://pqp.gg$path", null)!!
        assertTrue(selected.linkOnly)
    }

    @Test
    fun `stripping keeps the words and drops the url`() {
        val body = "Saiu post novo!\nhttps://pqp.gg$path\nvem ver"
        val link = BauShare.select(body, null)!!.link
        assertEquals("Saiu post novo!\n\nvem ver", BauShare.stripLink(body, link))
        val inline = "olha https://pqp.gg$path. corre"
        assertEquals("olha . corre", BauShare.stripLink(inline, BauShare.select(inline, null)!!.link))
        val tail = "Novo!\n\n\nhttps://pqp.gg$path"
        assertEquals("Novo!", BauShare.stripLink(tail, BauShare.select(tail, null)!!.link))
    }

    @Test
    fun `a tapped bare url resolves only when it is exactly a same-instance address`() {
        val app = "https://app.example"
        assertEquals(BauPostRef(server, post), BauShare.refOfUrl("https://pqp.gg$path", app))
        assertEquals(BauPostRef(server, post), BauShare.refOfUrl("https://app.example$path/?x=1#y", app))
        assertNull(BauShare.refOfUrl("https://evil.example$path", app))
        assertNull(BauShare.refOfUrl("https://pqp.gg/app/server/$server", app))
        assertNull(BauShare.refOfUrl("see https://pqp.gg$path", app))
    }

    // ---- card JSON

    private fun decode(json: String): BauPostCard =
        PqpJson.decodeFromString(BauCardResponse.serializer(), json).card

    @Test
    fun `decodes a full image card`() {
        val card = decode(
            """{"card":{"postId":"$post","serverId":"$server","serverName":"QG","title":"Patch 1.2",
            "teaser":"O que mudou","author":{"id":"$server","displayName":"Ana","avatarUrl":"/api/avatars/x"},
            "mediaKind":"image","mediaUrl":"https://cdn/x.jpg","visibility":"public","locked":false,
            "pinned":true,"likeCount":3,"commentCount":2,"publishedAt":"2026-10-01T10:00:00.000Z","extra":1}}""",
        )
        assertEquals("Patch 1.2", card.title)
        assertEquals("Ana", card.author?.displayName)
        assertEquals(3, card.likeCount)
        assertTrue(card.pinned)
        assertEquals(BauCardPoster.Image, card.poster)
        assertFalse(card.showsPlayBadge)
    }

    @Test
    fun `decodes a locked video with null media and a null title`() {
        val card = decode(
            """{"card":{"postId":"$post","serverId":"$server","serverName":"QG","title":null,"teaser":null,
            "author":null,"mediaKind":"video","mediaUrl":null,
            "visibility":"vip","locked":true,"pinned":false,"likeCount":0,"commentCount":0,"publishedAt":null}}""",
        )
        assertTrue(card.locked)
        assertNull(card.title)
        assertNull(card.mediaUrl)
        assertNull("author is withheld on a locked post", card.author)
        // No file to take a frame from, but it is still a video: the plate says so.
        assertEquals(BauCardPoster.Plate, card.poster)
        assertFalse("a locked post never shows a play badge", card.showsPlayBadge)
    }

    @Test
    fun `decodes a text-only card`() {
        val card = decode(
            """{"card":{"postId":"$post","serverId":"$server","serverName":"QG","title":"Aviso","teaser":"Texto",
            "author":{"id":"$server","displayName":"Ana","avatarUrl":null},"mediaKind":null,"mediaUrl":null,
            "visibility":"public","locked":false,"pinned":false,"likeCount":0,"commentCount":0,"publishedAt":null}}""",
        )
        assertNull(card.mediaKind)
        assertEquals(BauCardPoster.None, card.poster)
        assertFalse(card.showsPlayBadge)
    }

    @Test
    fun `poster and play badge by media kind`() {
        fun card(kind: String?, url: String?, locked: Boolean = false) =
            BauPostCard(postId = post, serverId = server, mediaKind = kind, mediaUrl = url, locked = locked)
        assertEquals(BauCardPoster.VideoFrame, card("video", "https://cdn/v.mp4").poster)
        assertTrue(card("video", "https://cdn/v.mp4").showsPlayBadge)
        assertEquals(BauCardPoster.Image, card("youtube", "https://img.youtube/x.jpg").poster)
        assertTrue(card("youtube", "https://img.youtube/x.jpg").showsPlayBadge)
        assertEquals(BauCardPoster.Plate, card("twitch", null).poster)
        assertTrue(card("tiktok", null).showsPlayBadge)
        assertTrue(card("instagram", null).showsPlayBadge)
        assertEquals(BauCardPoster.None, card("file", null).poster)
        assertEquals(BauCardPoster.Image, card("image", "https://cdn/x.jpg").poster)
        assertFalse(card("image", "https://cdn/x.jpg").showsPlayBadge)
        assertFalse(card("video", "https://cdn/v.mp4", locked = true).showsPlayBadge)
    }

    // ---- cache

    private fun sampleCard() = BauPostCard(postId = post, serverId = server)

    private fun cacheOf(
        clock: LongArray,
        calls: AtomicInteger,
        result: () -> BauPostCard?,
    ): BauCardCache = BauCardCache(
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        fetch = { _, _, _ -> calls.incrementAndGet(); result() },
        now = { clock[0] },
    )

    @Test
    fun `a hit is reused for 60 seconds and then refetched`() = runBlocking {
        val clock = longArrayOf(0)
        val calls = AtomicInteger()
        val cache = cacheOf(clock, calls) { sampleCard() }
        assertNotNull(cache.load(server, post, "pt"))
        clock[0] = 59_000
        assertNotNull(cache.load(server, post, "pt"))
        assertEquals(1, calls.get())
        clock[0] = 61_000
        cache.load(server, post, "pt")
        assertEquals(2, calls.get())
    }

    @Test
    fun `a refusal is remembered for 30 seconds`() = runBlocking {
        val clock = longArrayOf(0)
        val calls = AtomicInteger()
        val cache = cacheOf(clock, calls) { null }
        assertNull(cache.load(server, post, "pt"))
        clock[0] = 29_000
        assertNull(cache.load(server, post, "pt"))
        assertEquals(1, calls.get())
        clock[0] = 31_000
        assertNull(cache.load(server, post, "pt"))
        assertEquals(2, calls.get())
    }

    @Test
    fun `a failure is a miss, not a crash`() = runBlocking {
        val calls = AtomicInteger()
        val cache = cacheOf(longArrayOf(0), calls) { throw java.io.IOException("offline") }
        assertNull(cache.load(server, post, null))
    }

    @Test
    fun `concurrent loads share one request and the language is part of the key`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val calls = AtomicInteger()
        val cache = BauCardCache(
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
            fetch = { _, _, _ -> calls.incrementAndGet(); gate.await(); sampleCard() },
        )
        val loads = (1..5).map { async(Dispatchers.Default) { cache.load(server, post, "pt") } }
        while (calls.get() == 0) kotlinx.coroutines.yield()
        gate.complete(Unit)
        val results = loads.awaitAll()
        assertEquals(1, calls.get())
        assertSame(results[0], results[4])
        cache.load(server, post, "en")
        assertEquals(2, calls.get())
    }

    @Test
    fun `the last waiter leaving cancels the request and the next ask refetches`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val started = CompletableDeferred<Unit>()
        val calls = AtomicInteger()
        val cache = BauCardCache(
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
            fetch = { _, _, _ ->
                calls.incrementAndGet()
                started.complete(Unit)
                gate.await()
                sampleCard()
            },
        )
        val waiter = async(Dispatchers.Default) { cache.load(server, post, "pt") }
        started.await()
        waiter.cancel()
        waiter.join()
        // Not poisoned: a new row for the same post starts a fresh request.
        gate.complete(Unit)
        assertNotNull(cache.load(server, post, "pt"))
        assertEquals(2, calls.get())
    }

    @Test
    fun `only a few requests are on the wire at once`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val active = AtomicInteger()
        val peak = AtomicInteger()
        val cache = BauCardCache(
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
            fetch = { _, _, _ ->
                // Not `updateAndGet { maxOf(it, active.incrementAndGet()) }`:
                // that lambda is retried on a lost compare-and-set, and every
                // retry incremented `active` again, so the peak overcounted.
                val now = active.incrementAndGet()
                peak.accumulateAndGet(now) { a, b -> maxOf(a, b) }
                gate.await()
                active.decrementAndGet()
                sampleCard()
            },
        )
        val ids = (1..12).map { "aaaaaaaa-0000-4000-8000-%012d".format(it) }
        val loads = ids.map { id -> async(Dispatchers.Default) { cache.load(server, id, null) } }
        kotlinx.coroutines.delay(200)
        gate.complete(Unit)
        loads.awaitAll()
        assertTrue("peak ${peak.get()}", peak.get() <= BauCardCache.MAX_IN_FLIGHT)
    }
}
