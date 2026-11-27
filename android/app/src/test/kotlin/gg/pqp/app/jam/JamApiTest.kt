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
import org.junit.Assert.assertNull
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

    /** What the last request said about its body: the bucket checks both against what was signed. */
    @Volatile private var lastContentType: String? = null
    @Volatile private var lastContentLength: Long = -1
    private val answers = LinkedBlockingQueue<Answer>()

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange: HttpExchange ->
            lastContentType = exchange.requestHeaders.getFirst("Content-Type")
            lastContentLength = exchange.requestHeaders.getFirst("Content-Length")?.toLongOrNull() ?: -1
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
    fun `the notice routes are the shared ones, and an ack carries exactly the id`() = runTest {
        answers += Answer(200, """{"enabled":true,"publishing":"open","uploads":true}""")
        assertTrue(client().jamPublicConfig().enabled)
        answers += Answer(200, """{"takes":[]}""")
        client().jamPublicInbox()
        answers += Answer(200, """{"notices":[{"id":"n1","kind":"take","songId":"s","title":"x","instruments":["bass"],"count":1,"createdAt":"","updatedAt":""}]}""")
        assertEquals("n1", client().jamTakeNotices().notices.single().id)
        answers += Answer(200, """{"ok":true}""")
        client().ackJamTakeNotice("n1")
        val calls = generateSequence { received.poll() }.toList()
        assertEquals(
            listOf("GET /api/jam-public/config", "GET /api/jam-public/inbox", "GET /api/jam-public/notices", "POST /api/jam-public/notices/ack"),
            calls.map { "${it.method} ${it.path}" },
        )
        assertEquals("""{"id":"n1"}""", calls.last().body)
    }

    @Test
    fun `a failed ack is an exception, so the caller decides what it costs`() = runTest {
        answers += Answer(500, """{"error":"boom"}""")
        try {
            client().ackJamTakeNotice("n1")
            fail("a refused ack read as spent")
        } catch (e: ApiException) {
            assertEquals(500, e.status)
        }
    }

    @Test
    fun `where a song lives reads a standalone public song, whose channel is null, without failing`() = runTest {
        answers += Answer(200, """{"song":{"id":"s1","channelId":null,"serverId":null,"title":"Solta","trackCount":1},"tracks":[],"viewer":{}}""")
        val place = client().jamSongPlace("s1")
        assertEquals("s1", place.id)
        assertNull(place.channelId)
        assertNull(place.serverId)
        answers += Answer(200, """{"song":{"id":"s2","channelId":"c","serverId":"srv","title":"Canal"},"tracks":[],"viewer":{}}""")
        val inChannel = client().jamSongPlace("s2")
        assertEquals("srv", inChannel.serverId)
        assertEquals("c", inChannel.channelId)
        assertEquals("/api/jam-songs/s1", received.take().path)
    }

    @Test
    fun `a missing song is a 404 exception the router turns into gone`() = runTest {
        answers += Answer(404, """{"error":"jam_not_found"}""")
        try {
            client().jamSongPlace("nope")
            fail("a missing song read as a place")
        } catch (e: ApiException) {
            assertEquals(404, e.status)
        }
    }

    @Test
    fun `the publication is read for its starter and is null for everybody else`() = runTest {
        answers += Answer(200, """{"publication":{"songId":"s","status":"live","pendingTakes":2,"autoAcceptOutside":true,"extra":1}}""")
        val publication = client().jamPublication("s")!!
        assertEquals("live", publication.status)
        assertEquals(2, publication.pendingTakes)
        assertTrue(publication.autoAcceptOutside)
        answers += Answer(200, """{"publication":null}""")
        assertNull(client().jamPublication("s"))
    }

    private val trackAnswer =
        """{"track":{"id":"t","songId":"s","gain":0.5},"song":{"id":"s","channelId":"c","title":"x"}}"""
    private val songAnswer = """{"song":{"id":"s","channelId":"c","title":"Lithium"}}"""

    @Test
    fun `adjusting a take is a PATCH of only the fields that changed`() = runTest {
        answers += Answer(200, trackAnswer)
        val answer = client().updateJamTrack("t", UpdateJamTrackRequest.of(TrackPatch(offsetMs = -2000.0, trimEndMs = 750.0)))
        assertEquals(0.5, answer.track.gain, 0.0)
        val request = received.take()
        assertEquals("PATCH", request.method)
        assertEquals("/api/jam-tracks/t", request.path)
        assertEquals("""{"offsetMs":-2000.0,"trimEndMs":750.0}""", request.body)
        // A gain alone, as the slider sends it.
        answers += Answer(200, trackAnswer)
        client().updateJamTrack("t", UpdateJamTrackRequest.of(TrackPatch(gain = 1.25)))
        assertEquals("""{"gain":1.25}""", received.take().body)
    }

    @Test
    fun `a refused adjustment is an exception the screen can name, and the flag is told apart from a permission`() = runTest {
        answers += Answer(403, """{"error":"You cannot edit somebody else's track"}""")
        try {
            client().updateJamTrack("t", UpdateJamTrackRequest.of(TrackPatch(gain = 0.5)))
            fail("a 403 read as a saved adjustment")
        } catch (e: ApiException) {
            assertEquals(JamWriteFailure.Denied, jamWriteFailureOf(e))
        }
        answers += Answer(403, """{"error":"jam_channels_off"}""")
        try {
            client().updateJamTrack("t", UpdateJamTrackRequest.of(TrackPatch(gain = 0.5)))
            fail("a 403 read as a saved adjustment")
        } catch (e: ApiException) {
            assertEquals(JamWriteFailure.Off, jamWriteFailureOf(e))
        }
        answers += Answer(422, """{"error":"jam_trim_invalid"}""")
        try {
            client().updateJamTrack("t", UpdateJamTrackRequest.of(TrackPatch(trimStartMs = 99999.0)))
            fail("a 422 read as a saved adjustment")
        } catch (e: ApiException) {
            assertEquals(JamWriteFailure.Invalid, jamWriteFailureOf(e))
        }
    }

    @Test
    fun `editing a song is a PATCH, and clearing the artist sends an explicit null`() = runTest {
        answers += Answer(200, songAnswer)
        assertEquals("Lithium", client().updateJamSong("s", SongPatch(title = "Lithium")).title)
        val title = received.take()
        assertEquals("PATCH /api/jam-songs/s", "${title.method} ${title.path}")
        assertEquals("""{"title":"Lithium"}""", title.body)
        answers += Answer(200, songAnswer)
        client().updateJamSong("s", SongPatch(setArtist = true, artist = null))
        assertEquals("""{"artist":null}""", received.take().body)
        answers += Answer(200, songAnswer)
        client().updateJamSong("s", SongPatch(title = "Lithium", setArtist = true, artist = "Nirvana"))
        assertEquals("""{"title":"Lithium","artist":"Nirvana"}""", received.take().body)
    }

    @Test
    fun `a cover is a ticket for exactly these bytes, then a claim by upload id, and removal is a DELETE`() = runTest {
        answers += Answer(201, """{"uploadId":"11111111-1111-4111-8111-111111111111","uploadUrl":"http://127.0.0.1/put","expiresAt":"2026-11-01T10:00:00.000Z"}""")
        val ticket = client().jamCoverTicket("s", JamCover.SEND_TYPE, 123456)
        assertEquals("11111111-1111-4111-8111-111111111111", ticket.uploadId)
        val asked = received.take()
        assertEquals("POST /api/jam-songs/s/uploads", "${asked.method} ${asked.path}")
        assertEquals("""{"kind":"cover","contentType":"image/jpeg","byteSize":123456}""", asked.body)
        answers += Answer(200, """{"song":{"id":"s","channelId":"c","title":"x","coverUrl":"http://x/c.jpg?sig=1"}}""")
        assertEquals("http://x/c.jpg?sig=1", client().setJamCover("s", ticket.uploadId).coverUrl)
        val claim = received.take()
        assertEquals("PUT /api/jam-songs/s/cover", "${claim.method} ${claim.path}")
        assertEquals("""{"uploadId":"11111111-1111-4111-8111-111111111111"}""", claim.body)
        answers += Answer(200, songAnswer)
        assertNull(client().removeJamCover("s").coverUrl)
        val removal = received.take()
        assertEquals("DELETE /api/jam-songs/s/cover", "${removal.method} ${removal.path}")
    }

    @Test
    fun `the bytes go to the bucket with exactly the signed type and length`() = runTest {
        answers += Answer(200, "")
        val jpeg = ByteArray(40_000) { it.toByte() }
        val progress = mutableListOf<Float>()
        putJamCover(ApiClient.defaultHttpClient(), "$baseUrl/bucket/cover", jpeg, progress::add)
        val request = received.take()
        assertEquals("PUT /bucket/cover", "${request.method} ${request.path}")
        assertEquals(1f, progress.last(), 0f)
        assertTrue(progress.zipWithNext().all { (a, b) -> b >= a })
        assertEquals("image/jpeg", lastContentType)
        assertEquals(jpeg.size.toLong(), lastContentLength)
    }

    @Test
    fun `a config that cannot be read is off, so an unflagged server never gets a row that may 404`() = runTest {
        answers += Answer(500, """{"error":"boom"}""")
        assertFalse(client().jamConfig("srv").enabled)
        answers += Answer(200, """{"enabled":true,"uploads":true}""")
        assertTrue(client().jamConfig("srv").enabled)
    }
}
