package gg.pqp.app.core

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import gg.pqp.app.protocol.RepoSources
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.LinkedBlockingQueue
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The requests the chat actions make, against a real socket.
 *
 * Editing, deleting and pinning are the three things in this transcript that
 * are **not** WebSocket frames: there is no `message-edit` on the wire, only
 * `PATCH /api/messages/:id`, and the socket's job is limited to relaying the
 * `message-update` that follows. A wrong verb or a wrong path on any of them
 * is a 404 that `ChatViewModel` catches and turns into a sentence in a dialog,
 * so nothing crashes and nothing works.
 *
 * The same JDK `HttpServer` harness `ApiClientTest` uses, for the same reason:
 * no dependency the app does not already have.
 */
class ChatActionsApiTest {

    private lateinit var server: HttpServer
    private lateinit var baseUrl: String
    private val received = LinkedBlockingQueue<Recorded>()
    private val answers = LinkedBlockingQueue<Answer>()

    data class Recorded(val method: String, val path: String, val query: String?, val body: String)

    data class Answer(val status: Int, val body: String)

    private val message = """
        {"id":"m1","channelId":"c1","authorId":"u1","authorName":"Rafa",
         "body":"hello","createdAt":"2026-09-06T12:00:00.000Z","pinnedAt":null}
    """.trimIndent()

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange: HttpExchange ->
            val body = exchange.requestBody.readBytes().decodeToString()
            received += Recorded(
                method = exchange.requestMethod,
                path = exchange.requestURI.path,
                query = exchange.requestURI.query,
                body = body,
            )
            val answer = answers.poll() ?: Answer(500, """{"error":"no answer queued"}""")
            val bytes = answer.body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(answer.status, bytes.size.toLong())
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
    fun `an edit is a PATCH carrying only the new body`() = runTest {
        answers += Answer(200, """{"message":$message}""")

        val edited = client().editMessage("m1", "hello, again")

        val request = received.take()
        assertEquals("PATCH", request.method)
        assertEquals("/api/messages/m1", request.path)
        // Only `body`: `updateMessageSchema` in shared takes nothing else, and
        // a client that also sent an id or a channel would be describing a
        // message it does not own the truth about.
        assertEquals("""{"body":"hello, again"}""", request.body)
        assertEquals("m1", edited.id)
    }

    @Test
    fun `a delete is a DELETE and its body is not decoded`() = runTest {
        // The route answers `{"ok": true}` and nothing reads that flag, so
        // this must not throw on a response shape it never modelled.
        answers += Answer(200, """{"ok":true}""")
        client().deleteMessage("m1")
        val request = received.take()
        assertEquals("DELETE", request.method)
        assertEquals("/api/messages/m1", request.path)
    }

    @Test
    fun `pinning posts and unpinning deletes the same path`() = runTest {
        answers += Answer(200, """{"message":$message}""")
        answers += Answer(200, """{"message":$message}""")

        client().pinMessage("m1")
        client().unpinMessage("m1")

        val pin = received.take()
        assertEquals("POST", pin.method)
        assertEquals("/api/messages/m1/pin", pin.path)
        val unpin = received.take()
        assertEquals("DELETE", unpin.method)
        assertEquals("/api/messages/m1/pin", unpin.path)
    }

    @Test
    fun `the pin list is read off the channel`() = runTest {
        answers += Answer(200, """{"messages":[$message]}""")
        val pinned = client().pinnedMessages("c1")
        assertEquals("/api/channels/c1/pins", received.take().path)
        assertEquals(listOf("m1"), pinned.map { it.id })
    }

    @Test
    fun `a refused action carries the server's own sentence`() = runTest {
        // Only the server knows which refusal it was: somebody else's message,
        // a channel past `MAX_PINS_PER_CHANNEL`, a role lost since the sheet
        // opened. The dialog shows this string verbatim.
        answers += Answer(403, """{"error":"Only owners and admins can pin messages"}""")
        val thrown = runCatching { client().pinMessage("m1") }.exceptionOrNull()
        assertTrue(thrown is ApiException)
        assertEquals("Only owners and admins can pin messages", (thrown as ApiException).serverMessage)
        assertEquals(403, thrown.status)
    }

    @Test
    fun `members are read for the mention picker`() = runTest {
        answers += Answer(
            200,
            """{"members":[{"id":"u1","displayName":"Rafael","username":"rafa","nickname":null,
               "avatarUrl":null,"role":"owner"}]}""",
        )
        val members = client().serverMembers("s1")
        assertEquals("/api/servers/s1/members", received.take().path)
        assertEquals(listOf("rafa"), members.map { it.username })
    }

    // --- gifs ---

    @Test
    fun `a GIF search sends the query and trending sends none`() = runTest {
        answers += Answer(200, """{"gifs":[]}""")
        answers += Answer(200, """{"gifs":[]}""")

        client().searchGifs("cat party")
        client().trendingGifs()

        val search = received.take()
        assertEquals("/api/gifs/search", search.path)
        assertTrue("query was ${search.query}", search.query!!.contains("q=cat"))
        assertEquals("/api/gifs/trending", received.take().path)
    }

    @Test
    fun `a picked GIF is staged as an attachment, never uploaded`() = runTest {
        answers += Answer(
            201,
            """{"attachment":{"id":"a1","filename":"cat","contentType":"image/gif",
               "byteSize":0,"url":"https://static.klipy.com/cat.gif"}}""",
        )

        val attachment = client().createGifAttachment(
            "c1",
            CreateGifAttachmentRequest(url = "https://static.klipy.com/cat.gif", width = 200, height = 200, title = "cat"),
        )

        val request = received.take()
        assertEquals("POST", request.method)
        // One call, not the mint-then-PUT dance: the bytes stay with the
        // provider, which is what makes the picker work on a deployment with
        // no object storage at all.
        assertEquals("/api/channels/c1/attachments/gif", request.path)
        assertTrue(request.body.contains("static.klipy.com"))
        assertEquals("a1", attachment.id)
    }

    @Test
    fun `an off deployment reads as off rather than as an error`() = runTest {
        answers += Answer(200, """{"enabled":false}""")
        assertEquals(false, client().gifConfig().enabled)
    }

    /**
     * The GIF host allowlist is shared, and the picker's own results have to
     * satisfy it or the message renders as a bare URL. `GifLinks` is the
     * Android copy; this asserts the provider the API is built around is still
     * the one whose URLs that copy accepts.
     */
    @Test
    fun `the picker's provider is still on the shared media allowlist`() {
        val shared = File(RepoSources.root, "packages/shared/src/gifs.ts").readText()
        assertTrue(
            "The GIF media host allowlist changed; GifLinks is a hand-copy of it.",
            shared.contains("static\\.klipy\\.com"),
        )
    }
}
