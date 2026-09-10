package gg.pqp.app.watch

import gg.pqp.app.core.Backend
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Reading the two live-HLS frames off the wire.
 *
 * The frames are decoded field by field rather than through a serializer, for
 * the reason the whole client decodes that way: a server that grows a field
 * must not become a channel that cannot be watched. So the interesting cases
 * here are the malformed ones, and each of them has to answer "nothing live"
 * rather than throw, because a throw inside the frame collector would kill
 * every later frame on that socket too.
 */
class WatchModelsTest {

    private fun frame(json: String): JsonObject =
        Json.parseToJsonElement(json) as JsonObject

    private val good = """
        {
          "type": "channel-live",
          "channelId": "c1",
          "watching": 41,
          "stream": {
            "hlsUrl": "/api/voice/hls-playlist/c1/1757000000000?t=abc",
            "startedAt": 1757000000000,
            "presenterPeerId": "p9",
            "delaySeconds": 10
          }
        }
    """

    @Test
    fun `a live frame yields a playable absolute URL`() {
        val stream = decodeLiveStream(frame(good))!!
        assertEquals(
            "${Backend.apiUrl}/api/voice/hls-playlist/c1/1757000000000?t=abc",
            stream.hlsUrl,
        )
        assertEquals(1757000000000L, stream.startedAt)
        assertEquals("p9", stream.presenterPeerId)
        assertEquals(10, stream.delaySeconds)
        assertEquals(41, decodeWatching(frame(good)))
        assertEquals("c1", channelIdOf(frame(good)))
    }

    /**
     * `LIVE_HLS_SIGNED_URLS=false`, or a raw public bucket base. The server
     * hands out a full URL and passes it through unstamped, so nothing here may
     * prefix it with our own origin.
     */
    @Test
    fun `an absolute URL from the server is left alone`() {
        val stream = decodeLiveStream(
            frame(
                """
                {"type":"voice-stream","channelId":"c1","stream":{
                  "hlsUrl":"https://cdn.example.test/live/c1/17.m3u8",
                  "startedAt":17,"presenterPeerId":"p1"}}
                """,
            ),
        )!!
        assertEquals("https://cdn.example.test/live/c1/17.m3u8", stream.hlsUrl)
        assertNull(stream.delaySeconds)
    }

    @Test
    fun `a stop is null, not an empty stream`() {
        assertNull(
            decodeLiveStream(frame("""{"type":"voice-stream","channelId":"c1","stream":null}""")),
        )
        assertNull(decodeLiveStream(frame("""{"type":"voice-stream","channelId":"c1"}""")))
    }

    @Test
    fun `a frame missing a required field is nothing live rather than a throw`() {
        val cases = listOf(
            """{"stream":{"startedAt":1,"presenterPeerId":"p"}}""",
            """{"stream":{"hlsUrl":"/x","presenterPeerId":"p"}}""",
            """{"stream":{"hlsUrl":"/x","startedAt":1}}""",
            """{"stream":{"hlsUrl":"","startedAt":1,"presenterPeerId":"p"}}""",
            """{"stream":"not an object"}""",
            """{"stream":[1,2]}""",
        )
        for (case in cases) {
            assertNull("expected nothing live for $case", decodeLiveStream(frame(case)))
        }
    }

    /**
     * Absent is zero, never a guess. A `voice-stream` carries no count at all,
     * and inventing one there would overwrite what the audience frame said.
     */
    @Test
    fun `a missing watching count reads zero`() {
        assertEquals(0, decodeWatching(frame("""{"type":"voice-stream","channelId":"c1"}""")))
        assertEquals(0, decodeWatching(frame("""{"watching":"seven"}""")))
    }

    @Test
    fun `a frame with no channel id is not about any channel`() {
        assertNull(channelIdOf(frame("""{"type":"channel-live"}""")))
    }

    @Test
    fun `the HTTP seed resolves the same way the frame does`() {
        val payload = LiveStreamPayload(
            hlsUrl = "/api/voice/hls-playlist/c1/9?t=zz",
            startedAt = 9,
            presenterPeerId = "p1",
        )
        assertEquals("${Backend.apiUrl}/api/voice/hls-playlist/c1/9?t=zz", payload.resolve()!!.hlsUrl)
        assertNull(payload.copy(hlsUrl = "").resolve())
    }
}
