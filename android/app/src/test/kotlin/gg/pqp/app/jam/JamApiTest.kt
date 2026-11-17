package gg.pqp.app.jam

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.TokenProvider
import java.net.InetSocketAddress
import java.util.concurrent.LinkedBlockingQueue
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The jam routes against a real socket (the JDK's own `HttpServer`, as `ApiClientTest` does): the request each call
 * builds, and what it does with an answer. Above all that a refusal is an exception: a delete the server refused must
 * not read as a delete that worked, or the screen drops a track the server still has.
 */
class JamApiTest {
    private lateinit var server: HttpServer
    private lateinit var baseUrl: String

    private data class Recorded(val method: String, val path: String, val query: String?, val body: String)
    private data class Answer(val status: Int, val body: String)

    private val received = LinkedBlockingQueue<Recorded>()
    private val answers = LinkedBlockingQueue<Answer>()

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange: HttpExchange ->
            received += Recorded(
                exchange.requestMethod,
                exchange.requestURI.path,
                exchange.requestURI.query,
                exchange.requestBody.readBytes().decodeToString(),
            )
            val answer = answers.poll() ?: Answer(500, """{"error":"no answer queued"}""")
            val bytes = answer.body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            if (answer.status == 204) {
                exchange.sendResponseHeaders(204, -1)
            } else {
                exchange.sendResponseHeaders(answer.status, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            exchange.close()
        }
        server.start()
        baseUrl = "http://127.0.0.1:${server.address.port}"
    }

    @After
    fun stop() = server.stop(0)

    private fun client() = ApiClient(TokenProvider { "t0" }, ApiClient.defaultHttpClient(), PqpJson, baseUrl)

    @Test
    fun `a delete the server refused is an exception, not a delete`() = runTest {
        for (status in listOf(401, 403, 404, 500)) {
            answers += Answer(status, """{"error":"nope"}""")
            try {
                client().deleteJamTrack("t1")
                fail("a $status read as a deleted track")
            } catch (e: ApiException) {
                assertEquals(status, e.status)
            }
            answers += Answer(status, """{"error":"nope"}""")
            try {
                client().deleteJamSong("s1")
                fail("a $status read as a deleted song")
            } catch (e: ApiException) {
                assertEquals(status, e.status)
            }
        }
        // And a 204 is the one answer that is a delete.
        received.clear()
        answers += Answer(204, "")
        client().deleteJamTrack("t1")
        answers += Answer(204, "")
        client().deleteJamSong("s1")
        assertEquals(listOf("DELETE /api/jam-tracks/t1", "DELETE /api/jam-songs/s1"), received.map { "${it.method} ${it.path}" })
    }

    @Test
    fun `the list asks for a page, clamps the limit, and carries the cursor`() = runTest {
        answers += Answer(200, """{"songs":[],"nextCursor":null}""")
        client().jamSongs("chan", cursor = "abc", limit = 500)
        val request = received.take()
        assertEquals("/api/channels/chan/jam-songs", request.path)
        assertTrue(request.query!!, request.query!!.contains("limit=${JamLimits.PAGE_MAX}"))
        assertTrue(request.query!!.contains("cursor=abc"))
    }

    @Test
    fun `a vote is a PUT, taking it back a DELETE, and the in-mix switch a PATCH with the one field`() = runTest {
        val vote = """{"trackId":"t","songId":"s","voteCount":2,"voted":true}"""
        answers += Answer(200, vote)
        assertTrue(client().voteJamTrack("t").voted)
        answers += Answer(200, vote.replace("true", "false"))
        assertFalse(client().unvoteJamTrack("t").voted)
        answers += Answer(
            200,
            """{"track":{"id":"t","songId":"s"},"song":{"id":"s","channelId":"c","title":"x"}}""",
        )
        client().setJamTrackInMix("t", inMix = true)
        val calls = generateSequence { received.poll() }.toList()
        assertEquals(listOf("PUT /api/jam-tracks/t/vote", "DELETE /api/jam-tracks/t/vote", "PATCH /api/jam-tracks/t"), calls.map { "${it.method} ${it.path}" })
        assertEquals("""{"inMix":true}""", calls.last().body)
    }

    @Test
    fun `a config that cannot be read is off, so an unflagged server never gets a row that may 404`() = runTest {
        answers += Answer(500, """{"error":"boom"}""")
        assertFalse(client().jamConfig("srv").enabled)
        answers += Answer(200, """{"enabled":true,"uploads":true}""")
        assertTrue(client().jamConfig("srv").enabled)
    }
}
