package gg.pqp.app.core

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import gg.pqp.app.protocol.RepoSources
import java.net.InetSocketAddress
import java.util.concurrent.LinkedBlockingQueue
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * `ApiClient` against a real socket.
 *
 * The JDK's own `HttpServer` rather than MockWebServer, so this needs no
 * dependency the app does not already have and cannot drift from OkHttp's
 * version. It is enough: what is under test here is the request this client
 * builds and what it does with the answer, not HTTP itself.
 */
class ApiClientTest {

    private lateinit var server: HttpServer
    private lateinit var baseUrl: String

    /** Every request the client made, in order, for assertions after the call. */
    private val received = LinkedBlockingQueue<Recorded>()

    /** Queued answers, one per request. */
    private val answers = LinkedBlockingQueue<Answer>()

    data class Recorded(val method: String, val path: String, val query: String?, val authorization: String?)

    data class Answer(val status: Int, val body: String)

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange: HttpExchange ->
            received += Recorded(
                method = exchange.requestMethod,
                path = exchange.requestURI.path,
                query = exchange.requestURI.query,
                authorization = exchange.requestHeaders.getFirst("Authorization"),
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

    private fun client(tokens: TokenProvider = TokenProvider { "t0" }) =
        ApiClient(tokens, ApiClient.defaultHttpClient(), PqpJson, baseUrl)

    /**
     * The page ceiling reaches the query string.
     *
     * `MESSAGE_PAGE_MAX` is read out of `packages/shared/src/api.ts`, so a
     * server that raises or lowers it fails this test rather than being
     * discovered as a 400 nobody sees (`ChatViewModel` wraps its history calls
     * in `runCatching`).
     */
    @Test
    fun `a page request is clamped to the shared MESSAGE_PAGE_MAX`() = runTest {
        val max = RepoSources.numberConstant("packages/shared/src/api.ts", "MESSAGE_PAGE_MAX")
        answers += Answer(200, """{"messages":[],"hasMore":false,"hasNewer":false}""")

        client().messages("chan", limit = max * 10)

        val request = received.take()
        assertEquals("/api/channels/chan/messages", request.path)
        assertTrue("limit was ${request.query}", request.query!!.contains("limit=$max"))
    }

    @Test
    fun `a page request below one is clamped up rather than sent as zero`() = runTest {
        answers += Answer(200, """{"messages":[],"hasMore":false,"hasNewer":false}""")
        client().messages("chan", limit = 0)
        assertTrue(received.take().query!!.contains("limit=1"))
    }

    /**
     * Oldest-first, one cursor per call. The server rejects both cursors at
     * once with a 400 rather than picking one, so the client must not send both.
     */
    @Test
    fun `only the cursor that was asked for travels`() = runTest {
        answers += Answer(200, """{"messages":[],"hasMore":false,"hasNewer":false}""")
        client().messages("chan", before = "m1")
        val query = received.take().query!!
        assertTrue(query.contains("before=m1"))
        assertTrue("after should be absent: $query", !query.contains("after="))
    }

    /**
     * A **fresh** token per request. Caching one makes everything work for
     * about sixty seconds and then 401 forever; that bug has already shipped
     * on the web client once.
     */
    @Test
    fun `every request resolves the token again`() = runTest {
        var issued = 0
        val rotating = TokenProvider { "token-${issued++}" }
        val api = client(rotating)

        answers += Answer(200, """{"servers":[]}""")
        answers += Answer(200, """{"servers":[]}""")
        api.servers()
        api.servers()

        assertEquals("Bearer token-0", received.take().authorization)
        assertEquals("Bearer token-1", received.take().authorization)
    }

    @Test
    fun `no token means no Authorization header rather than an empty one`() = runTest {
        answers += Answer(200, """{"servers":[]}""")
        client(TokenProvider { null }).servers()
        assertNull(received.take().authorization)
    }

    /**
     * Every error body in this API is `{"error": string}` and only the server
     * knows whether an invite was expired, revoked, exhausted or the caller
     * banned. Its sentence has to survive the trip.
     */
    @Test
    fun `a refusal carries the server's own sentence`() = runTest {
        answers += Answer(403, """{"error":"You are timed out until 18:00","code":"sanctioned"}""")
        val failure = runCatching { client().servers() }.exceptionOrNull()
        assertTrue("$failure", failure is ApiException)
        val error = failure as ApiException
        assertEquals(403, error.status)
        assertEquals("You are timed out until 18:00", error.serverMessage)
        assertEquals("sanctioned", error.code)
        assertTrue(error.isAgeGated)
    }

    @Test
    fun `a 401 is distinguishable, because it is the one that means signed out`() = runTest {
        answers += Answer(401, """{"error":"Unauthorized"}""")
        val error = runCatching { client().me() }.exceptionOrNull() as ApiException
        assertTrue(error.isUnauthorized)
        assertTrue(!error.isAgeGated)
    }

    /**
     * A refusal with a body that is not JSON at all still throws an
     * `ApiException` with the status, rather than a decode error from somewhere
     * unrelated. Cloudflare and Fly both answer with HTML on a bad day.
     */
    @Test
    fun `a non-JSON error body does not turn into a decode failure`() = runTest {
        answers += Answer(502, "<html><body>Bad gateway</body></html>")
        val error = runCatching { client().me() }.exceptionOrNull() as ApiException
        assertEquals(502, error.status)
        assertNull(error.serverMessage)
    }

    @Test
    fun `the age gate arrives on GET api me`() = runTest {
        answers += Answer(
            200,
            """{"id":"u1","displayName":"Rafa","avatarUrl":null,"ageGate":"pending"}""",
        )
        val me = client().me()
        assertEquals("/api/me", received.take().path)
        assertEquals("pending", me.ageGate)
        assertEquals("Rafa", me.displayName)
    }

    @Test
    fun `the age check posts a plain date and answers with the new state`() = runTest {
        answers += Answer(200, """{"ageGate":"passed"}""")
        assertEquals("passed", client().submitAgeCheck("1990-02-03"))
        val request = received.take()
        assertEquals("POST", request.method)
        assertEquals("/api/me/age-check", request.path)
    }

    /** Root-relative avatars, presigned absolute attachments, one helper. */
    @Test
    fun `url building keeps one slash between the base and the path`() {
        val api = client()
        assertEquals("$baseUrl/api/servers", api.url("/api/servers").toString())
        assertEquals(
            "$baseUrl/api/channels/c/messages?limit=50",
            api.url("/api/channels/c/messages", mapOf("limit" to "50")).toString(),
        )
    }
}
