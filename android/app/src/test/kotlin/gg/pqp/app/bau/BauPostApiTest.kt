package gg.pqp.app.bau

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.TokenProvider
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.LinkedBlockingQueue
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The three writes a post takes, against a real socket: create, and the
 * mint / PUT / claim dance for a file. The PUT is the one that matters most:
 * it goes to storage, not to the API, so it must carry the signed type and
 * length and must NOT carry our Bearer token.
 */
class BauPostApiTest {

    private lateinit var server: HttpServer
    private lateinit var baseUrl: String
    private val received = LinkedBlockingQueue<Recorded>()
    private val answers = LinkedBlockingQueue<Answer>()

    data class Recorded(
        val method: String,
        val path: String,
        val body: ByteArray,
        val authorization: String?,
        val contentType: String?,
        val contentLength: Long,
    ) {
        val text: String get() = body.decodeToString()
    }

    data class Answer(val status: Int, val body: String)

    private val post = """
        {"id":"p1","serverId":"s1","author":{"id":"u1","displayName":"Rafa","username":"rafa","tag":"rafa#0001"},
         "title":"Hello","body":"words","createdAt":"2026-10-10T12:00:00.000Z"}
    """.trimIndent()

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange: HttpExchange ->
            val body = exchange.requestBody.readBytes()
            received += Recorded(
                method = exchange.requestMethod,
                path = exchange.requestURI.path,
                body = body,
                authorization = exchange.requestHeaders.getFirst("Authorization"),
                contentType = exchange.requestHeaders.getFirst("Content-Type"),
                contentLength = exchange.requestHeaders.getFirst("Content-Length")?.toLong() ?: -1,
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
    fun `publishing is a POST of a published post, with only the fields it has`() = runTest {
        answers += Answer(201, """{"post":$post}""")

        val created = client().createBauPost(
            "s1",
            BauComposeDraft(title = "Hello", body = "words").toRequest()!!,
        )

        val request = received.take()
        assertEquals("POST", request.method)
        assertEquals("/api/servers/s1/home/posts", request.path)
        assertEquals("Bearer t0", request.authorization)
        val sent = PqpJson.parseToJsonElement(request.text).toString()
        assertTrue(sent, sent.contains("\"title\":\"Hello\""))
        assertTrue(sent, sent.contains("\"body\":\"words\""))
        assertTrue(sent, !sent.contains("mediaUploadId"))
        assertTrue(sent, !sent.contains("youtubeUrl"))
        assertEquals("p1", created.id)
    }

    @Test
    fun `status is always on the wire, because the servers default is a draft`() {
        val json = PqpJson.encodeToString(
            CreateBauPostRequest.serializer(),
            CreateBauPostRequest(title = "t"),
        )
        assertTrue(json, json.contains("\"status\":\"published\""))
        assertTrue(json, json.contains("\"visibility\":\"free\""))
    }

    @Test
    fun `a link rides as youtubeUrl, the one field all four providers share`() = runTest {
        answers += Answer(201, """{"post":$post}""")
        client().createBauPost("s1", BauComposeDraft(title = "t", link = "https://youtu.be/dQw4w9WgXcQ").toRequest()!!)
        val sent = received.take().text
        assertTrue(sent, sent.contains("\"youtubeUrl\":\"https://youtu.be/dQw4w9WgXcQ\""))
    }

    @Test
    fun `a refusal comes back as an ApiException the composer can name`() = runTest {
        answers += Answer(403, """{"error":"Staff only"}""")
        try {
            client().createBauPost("s1", CreateBauPostRequest(title = "t", body = "b"))
            fail("expected a refusal")
        } catch (failure: ApiException) {
            assertEquals(403, failure.status)
            assertEquals(BauRefusal.NotStaff, BauRefusal.from(failure))
        }
    }

    @Test
    fun `a file is minted, PUT straight to storage without our token, then claimed`() = runTest {
        val bytes = ByteArray(5_000) { (it % 251).toByte() }
        val file = File.createTempFile("bau", ".mp4").apply { writeBytes(bytes); deleteOnExit() }
        val uploadId = "11111111-1111-1111-1111-111111111111"
        answers += Answer(201, """{"uploadId":"$uploadId","key":"k","uploadUrl":"$baseUrl/storage/put?sig=1","expiresAt":"x","kind":"video"}""")
        answers += Answer(200, "{}")
        answers += Answer(200, """{"uploadId":"$uploadId","kind":"video","name":"clip.mp4","contentType":"video/mp4","byteSize":5000}""")

        val id = BauMediaUploader(client()).upload("s1", file, "video/mp4", "clip.mp4")

        assertEquals(uploadId, id)

        val mint = received.take()
        assertEquals("/api/servers/s1/home/media", mint.path)
        assertEquals("Bearer t0", mint.authorization)
        // The length that is signed is the length of the file that is sent.
        assertEquals(
            """{"contentType":"video/mp4","byteSize":5000,"filename":"clip.mp4"}""",
            mint.text,
        )

        val put = received.take()
        assertEquals("PUT", put.method)
        assertEquals("/storage/put", put.path)
        assertNull("storage refuses a request that also carries our Bearer", put.authorization)
        assertEquals("video/mp4", put.contentType)
        assertEquals(5_000L, put.contentLength)
        assertTrue(put.body.contentEquals(bytes))

        val claim = received.take()
        assertEquals("/api/servers/s1/home/media/claim", claim.path)
        assertEquals("""{"uploadId":"$uploadId"}""", claim.text)
    }

    @Test
    fun `storage refusing the PUT stops the upload before the claim`() = runTest {
        val file = File.createTempFile("bau", ".png").apply { writeBytes(ByteArray(10)); deleteOnExit() }
        answers += Answer(201, """{"uploadId":"u","key":"k","uploadUrl":"$baseUrl/storage/put","expiresAt":"x","kind":"image"}""")
        answers += Answer(403, "<Error/>")
        try {
            BauMediaUploader(client()).upload("s1", file, "image/png", "a.png")
            fail("expected the PUT to fail")
        } catch (failure: IllegalStateException) {
            assertTrue(failure.message.orEmpty().contains("403"))
        }
        received.take()
        received.take()
        assertTrue("no claim after a failed PUT", received.isEmpty())
    }

    @Test
    fun `a mint refused for size is a 413 the composer words as too large`() = runTest {
        val file = File.createTempFile("bau", ".mp4").apply { writeBytes(ByteArray(10)); deleteOnExit() }
        answers += Answer(413, """{"error":"File too large"}""")
        try {
            BauMediaUploader(client()).upload("s1", file, "video/mp4", "a.mp4")
            fail("expected a refusal")
        } catch (failure: ApiException) {
            assertEquals(BauRefusal.TooLarge, BauRefusal.from(failure))
        }
    }
}
