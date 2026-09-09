package gg.pqp.app.watch

import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The audience is seatless, and this is the test that says so.
 *
 * It is the most load-bearing test in the watch package, because getting this
 * wrong is the difference between six hundred viewers and a room that falls
 * over. On 5 September a Twitch watch party sent 212 signups in twenty minutes
 * at a mesh room with a limit of eight, and every one of them was refused. The
 * HLS path exists so that a watcher costs one playlist reader and nothing on
 * the media server.
 *
 * So the assertion is not "watching works". It is **exactly which frames leave
 * the phone**, by type, in order. A regression that quietly joined the call
 * would still play a picture and would still look right on a laptop with two
 * viewers; it would only show up at the event, in front of everybody.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class WatchLiveStoreTest {

    private val sent = mutableListOf<JsonObject>()
    private val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 64)
    private val state = MutableStateFlow(RealtimeState.Ready)
    private var seated: String? = null
    private var seedResponse: ChannelLiveResponse? = null
    private var seedCalls = 0

    private fun store(scope: TestScope) = WatchLiveStore(
        frames = frames,
        realtimeState = state,
        send = { sent += it },
        seatedChannelId = { seated },
        seed = { seedCalls += 1; seedResponse },
        scope = scope,
    )

    private fun types() = sent.map { it["type"]?.jsonPrimitive?.contentOrNull }

    private fun watchFrames() = sent
        .filter { it["type"]?.jsonPrimitive?.contentOrNull == "watch-live" }
        .map {
            it["channelId"]!!.jsonPrimitive.content to it["watching"]!!.jsonPrimitive.booleanOrNull
        }

    private fun frame(json: String): JsonObject = Json.parseToJsonElement(json) as JsonObject

    private fun liveFrame(channelId: String, startedAt: Long, watching: Int) = frame(
        """
        {"type":"channel-live","channelId":"$channelId","watching":$watching,
         "stream":{"hlsUrl":"/api/voice/hls-playlist/$channelId/$startedAt?t=tok$startedAt",
                   "startedAt":$startedAt,"presenterPeerId":"p1","delaySeconds":10}}
        """,
    )

    /**
     * The whole point, stated as an assertion. `watch-live` is the ONLY frame
     * this path sends: no `join-voice-room`, no `set-voice-state`, no
     * `set-sharing-screen`, nothing that would put this phone on a roster.
     */
    @Test
    fun `watching sends one frame and it is not a join`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        store.watch("c1")
        assertEquals(listOf("watch-live"), types())
        assertEquals(listOf("c1" to true), watchFrames())

        store.unwatch("c1")
        assertEquals(listOf("watch-live", "watch-live"), types())
        assertEquals(listOf("c1" to true, "c1" to false), watchFrames())
    }

    @Test
    fun `saying it twice is one viewer`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        store.watch("c1")
        store.watch("c1")
        store.watch("c1")
        assertEquals(listOf("c1" to true), watchFrames())
    }

    @Test
    fun `a second retraction sends nothing`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        store.watch("c1")
        store.unwatch("c1")
        store.unwatch("c1")
        store.unwatch("c2")
        assertEquals(listOf("c1" to true, "c1" to false), watchFrames())
    }

    /** One socket watches one thing. Moving retracts the old one first. */
    @Test
    fun `moving to another channel retracts the first`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        store.watch("c1")
        store.watch("c2")
        assertEquals(listOf("c1" to true, "c1" to false, "c2" to true), watchFrames())
    }

    /**
     * A seat is already on the roster. Announcing a watch as well would be this
     * client asking to be counted twice; the server refuses, but a client whose
     * frames do not mean what they say is how the two halves of a count drift.
     */
    @Test
    fun `a seat in the room does not also announce a watch`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        seated = "c1"
        store.watch("c1")
        assertEquals(emptyList<Pair<String, Boolean?>>(), watchFrames())

        // A seat in a *different* room is still a seatless watcher here.
        store.watch("c2")
        assertEquals(listOf("c2" to true), watchFrames())
    }

    /**
     * The server counts watchers per socket, so a reconnect is a new socket and
     * an unannounced viewer. Without this the host's audience number quietly
     * loses everybody whose connection blinked.
     */
    @Test
    fun `a reconnect re-announces the watch`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        store.watch("c1")
        state.value = RealtimeState.Reconnecting
        state.value = RealtimeState.Ready
        assertEquals(listOf("c1" to true, "c1" to true), watchFrames())
    }

    @Test
    fun `a reconnect with nothing being watched says nothing`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        store(scope)
        state.value = RealtimeState.Reconnecting
        state.value = RealtimeState.Ready
        assertEquals(emptyList<Pair<String, Boolean?>>(), watchFrames())
    }

    @Test
    fun `a channel-live frame becomes playable state`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        frames.emit(liveFrame("c1", 1_000, watching = 41))
        val live = store.live("c1")
        assertTrue(live.live)
        assertEquals(1_000L, live.stream!!.startedAt)
        assertEquals(41, live.watching)
        assertTrue(live.stream!!.hlsUrl.endsWith("/api/voice/hls-playlist/c1/1000?t=tok1000"))
    }

    /**
     * The keyframe restamps the token, and the newest frame has to win: the
     * player's recovery asks this store for a URL, and handing it an expired
     * one is a retry that cannot work.
     */
    @Test
    fun `a restamped URL replaces the old one`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        frames.emit(liveFrame("c1", 1_000, watching = 1))
        frames.emit(
            frame(
                """
                {"type":"channel-live","channelId":"c1","watching":2,
                 "stream":{"hlsUrl":"/api/voice/hls-playlist/c1/1000?t=fresher",
                           "startedAt":1000,"presenterPeerId":"p1"}}
                """,
            ),
        )
        assertTrue(store.live("c1").stream!!.hlsUrl.endsWith("?t=fresher"))
        assertEquals(2, store.live("c1").watching)
    }

    @Test
    fun `a stop clears the stream and leaves the count alone`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        frames.emit(liveFrame("c1", 1_000, watching = 7))
        frames.emit(frame("""{"type":"channel-live","channelId":"c1","watching":7,"stream":null}"""))
        assertNull(store.live("c1").stream)
        assertEquals(7, store.live("c1").watching)
    }

    /**
     * `voice-stream` reaches seats only and carries no count. Reading a zero
     * out of it would wipe the audience number for anybody who is both in the
     * call and looking at the pane, which is the host.
     */
    @Test
    fun `voice-stream updates the picture and not the audience count`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        frames.emit(liveFrame("c1", 1_000, watching = 55))
        frames.emit(
            frame(
                """
                {"type":"voice-stream","channelId":"c1",
                 "stream":{"hlsUrl":"/api/voice/hls-playlist/c1/2000?t=z",
                           "startedAt":2000,"presenterPeerId":"p2"}}
                """,
            ),
        )
        assertEquals(2_000L, store.live("c1").stream!!.startedAt)
        assertEquals(55, store.live("c1").watching)
    }

    @Test
    fun `an unrelated frame changes nothing`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        frames.emit(frame("""{"type":"message-broadcast","channelId":"c1"}"""))
        assertEquals(ChannelLive.NOTHING, store.live("c1"))
    }

    @Test
    fun `the HTTP seed fills the gap and never overwrites a frame`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        seedResponse = ChannelLiveResponse(
            stream = LiveStreamPayload(
                hlsUrl = "/api/voice/hls-playlist/c1/5?t=seed",
                startedAt = 5,
                presenterPeerId = "p1",
            ),
            watching = 3,
        )
        store.seedFromApi("c1")
        assertEquals(5L, store.live("c1").stream!!.startedAt)
        assertEquals(1, seedCalls)

        // A channel the socket has already spoken about is not asked for again,
        // and a late seed cannot overwrite the newer frame.
        store.seedFromApi("c1")
        assertEquals(1, seedCalls)
    }

    @Test
    fun `a seed that finds nothing leaves the channel silent`() = runTest {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val store = store(scope)
        seedResponse = null
        store.seedFromApi("c1")
        assertEquals(ChannelLive.NOTHING, store.live("c1"))
    }
}
