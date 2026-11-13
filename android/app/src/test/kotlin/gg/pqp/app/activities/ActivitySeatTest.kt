package gg.pqp.app.activities

import gg.pqp.app.activities.bridge.ActivityTransport
import gg.pqp.app.activities.bridge.ActivityTransportError
import gg.pqp.app.activities.bridge.SeatSnapshot
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private const val SESSION = "00000000-0000-4000-8000-000000000001"
private const val OTHER = "00000000-0000-4000-8000-000000000002"
private const val USER = "11111111-1111-4111-8111-111111111111"

/**
 * The seat against the frames of `packages/shared/src/apps/frames.ts`: the join that
 * is answered by a snapshot or an `app-error`, a state write that is answered by the
 * next `app-state`, and the resume when the socket comes back.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ActivitySeatTest {

    private class Rig(scope: CoroutineScope, val sendOk: Boolean = true) {
        val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 64)
        val state = MutableStateFlow(RealtimeState.Ready)
        val sent = mutableListOf<JsonObject>()
        var endResult: suspend () -> Boolean = { true }
        var sendAccepts = sendOk
        val seat = ActivitySeat(
            sessionId = SESSION,
            scope = scope,
            frames = frames,
            connection = state,
            send = { sent += it; sendAccepts },
            endCall = { endResult() },
        )
        val connections = mutableListOf<Boolean>()
        val sessions = mutableListOf<SeatSnapshot>()
        val states = mutableListOf<Pair<Long, JsonElement>>()
        val endings = mutableListOf<ActivityEndReason>()

        init {
            seat.subscribe(
                object : ActivityTransport.Handlers {
                    override fun onSession(snapshot: SeatSnapshot) { sessions += snapshot }
                    override fun onState(rev: Long, value: JsonElement) { states += rev to value }
                    override fun onEvent(fromSeatId: String, name: String, data: JsonElement) = Unit
                    override fun onConnection(online: Boolean) { connections += online }
                    override fun onEnded(reason: ActivityEndReason) { endings += reason }
                },
            )
        }

        fun emit(json: String) = frames.tryEmit(Json.parseToJsonElement(json).jsonObject)
        fun types() = sent.map { it["type"]!!.jsonPrimitive.content }
    }

    private fun TestScope.rig(): Rig = Rig(backgroundScope)

    private fun snapshotFrame(sessionId: String = SESSION, host: Boolean = true) = """
        {"type":"app-session","sessionId":"$sessionId","seatId":"seatAAAAAAAAAAAAAAAA","role":"player","isHost":$host,
         "state":{"rev":2,"value":{"n":1}},
         "participants":[{"seatId":"seatAAAAAAAAAAAAAAAA","userId":"$USER","role":"player","isHost":$host,"connection":"present"}]}
    """.trimIndent()

    @Test
    fun `a join is answered by the snapshot and keeps the seat for the screen`() = runTest {
        val r = rig()
        val joining = backgroundScope.async { r.seat.join(false) }
        runCurrent()
        assertEquals(listOf("app-join"), r.types())
        assertFalse(r.sent.single().containsKey("asSpectator"))
        r.emit(snapshotFrame())
        runCurrent()
        val snapshot = joining.await()
        assertEquals("seatAAAAAAAAAAAAAAAA", snapshot.seatId)
        assertEquals(2L, snapshot.stateRev)
        assertEquals(1, snapshot.participants.size)
        assertEquals(snapshot, r.seat.snapshot.value)
        assertEquals(1, r.sessions.size)
    }

    @Test
    fun `a spectator join says so`() = runTest {
        val r = rig()
        backgroundScope.async { runCatching { r.seat.join(true) } }
        runCurrent()
        assertEquals(true, r.sent.single()["asSpectator"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `an app-error for the join refuses it with the server's code`() = runTest {
        val r = rig()
        val joining = backgroundScope.async { runCatching { r.seat.join(false) } }
        runCurrent()
        r.emit("""{"type":"app-error","sessionId":"$SESSION","op":"join","code":"full"}""")
        runCurrent()
        val error = joining.await().exceptionOrNull() as ActivityTransportError
        assertEquals("full", error.code)
    }

    @Test
    fun `a join nobody answers is unavailable after eight seconds, not a hang`() = runTest {
        val r = rig()
        val joining = backgroundScope.async { runCatching { r.seat.join(false) } }
        runCurrent()
        advanceTimeBy(ActivitySeat.JOIN_TIMEOUT_MS + 1)
        runCurrent()
        assertEquals("unavailable", (joining.await().exceptionOrNull() as ActivityTransportError).code)
    }

    @Test
    fun `a join with the socket down is unavailable at once`() = runTest {
        val r = rig()
        r.state.value = RealtimeState.Reconnecting
        runCurrent()
        try {
            r.seat.join(false)
            fail("a join on a dead link must not be sent")
        } catch (e: ActivityTransportError) {
            assertEquals("unavailable", e.code)
        }
        assertTrue(r.sent.isEmpty())
    }

    @Test
    fun `frames for another session are not ours`() = runTest {
        val r = rig()
        val joining = backgroundScope.async { runCatching { r.seat.join(false) } }
        runCurrent()
        r.emit(snapshotFrame(sessionId = OTHER))
        r.emit("""{"type":"app-ended","sessionId":"$OTHER","channelId":"$OTHER","reason":"host","summary":{"participants":1,"durationSeconds":2}}""")
        runCurrent()
        assertFalse(joining.isCompleted)
        assertTrue(r.sessions.isEmpty())
        assertTrue(r.endings.isEmpty())
    }

    private suspend fun TestScope.seated(r: Rig) {
        val joining = backgroundScope.async { r.seat.join(false) }
        runCurrent()
        r.emit(snapshotFrame())
        runCurrent()
        joining.await()
        r.sent.clear()
    }

    @Test
    fun `a state write is answered by the next app-state`() = runTest {
        val r = rig()
        seated(r)
        val write = backgroundScope.async { r.seat.patchState(buildJsonObject { put("n", 2) }, 2L) }
        runCurrent()
        assertEquals(listOf("app-state-patch"), r.types())
        assertEquals(2L, r.sent.single()["baseRev"]!!.jsonPrimitive.content.toLong())
        r.emit("""{"type":"app-state","sessionId":"$SESSION","rev":3,"value":{"n":2}}""")
        runCurrent()
        assertEquals(3L, write.await())
        assertEquals(3L, r.states.last().first)
    }

    @Test
    fun `a refused write fails with the server's code and an unanswered one times out`() = runTest {
        val r = rig()
        seated(r)
        val refused = backgroundScope.async { runCatching { r.seat.patchState(JsonNull, null) } }
        runCurrent()
        r.emit("""{"type":"app-error","sessionId":"$SESSION","op":"state","code":"stale-rev"}""")
        runCurrent()
        assertEquals("stale-rev", (refused.await().exceptionOrNull() as ActivityTransportError).code)

        val silent = backgroundScope.async { runCatching { r.seat.patchState(JsonNull, null) } }
        runCurrent()
        advanceTimeBy(ActivitySeat.PATCH_TIMEOUT_MS + 1)
        runCurrent()
        assertEquals("unavailable", (silent.await().exceptionOrNull() as ActivityTransportError).code)
    }

    @Test
    fun `an event is sent only from a seat, and never acknowledged`() = runTest {
        val r = rig()
        r.seat.sendEvent("ping", JsonNull)
        assertTrue("no seat, no frame", r.sent.isEmpty())
        seated(r)
        r.seat.sendEvent("ping", buildJsonObject { put("a", 1) })
        assertEquals(listOf("app-event-send"), r.types())
        assertEquals("ping", r.sent.single()["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun `leaving sends app-leave once and a second leave sends nothing`() = runTest {
        val r = rig()
        seated(r)
        r.seat.leave()
        r.seat.leave()
        assertEquals(listOf("app-leave"), r.types())
    }

    @Test
    fun `losing the socket holds the seat, and its return asks for the same one back`() = runTest {
        val r = rig()
        seated(r)
        r.state.value = RealtimeState.Reconnecting
        runCurrent()
        assertEquals(listOf(false), r.connections)
        assertFalse(r.seat.linkUp.value)
        val write = backgroundScope.async { runCatching { r.seat.patchState(JsonNull, null) } }
        runCurrent()
        assertEquals("unavailable", (write.await().exceptionOrNull() as ActivityTransportError).code)

        r.state.value = RealtimeState.Ready
        runCurrent()
        assertEquals("the same seat is asked for again", listOf("app-join"), r.types())
        assertEquals("until the snapshot says it is back", listOf(false), r.connections)
        r.emit(snapshotFrame())
        runCurrent()
        assertEquals(listOf(false, true), r.connections)
        assertTrue(r.seat.linkUp.value)
    }

    @Test
    fun `a resume that finds the session over, or the seat gone, ends it`() = runTest {
        val gone = rig()
        seated(gone)
        gone.emit("""{"type":"app-error","sessionId":"$SESSION","op":"join","code":"ended"}""")
        runCurrent()
        assertEquals(listOf(ActivitySeat.ENDED_WHILE_AWAY), gone.endings)

        val refused = rig()
        seated(refused)
        refused.emit("""{"type":"app-error","sessionId":"$SESSION","op":"join","code":"not-allowed"}""")
        runCurrent()
        assertEquals(1, refused.endings.size)
    }

    @Test
    fun `an app-ended frame finishes the seat with the reason and later joins say ended`() = runTest {
        val r = rig()
        seated(r)
        r.emit("""{"type":"app-ended","sessionId":"$SESSION","channelId":"$OTHER","reason":"moderator","summary":{"participants":2,"durationSeconds":90}}""")
        runCurrent()
        assertEquals(listOf(ActivityEndReason.Moderator), r.endings)
        try {
            r.seat.join(false)
            fail()
        } catch (e: ActivityTransportError) {
            assertEquals("ended", e.code)
        }
    }

    @Test
    fun `ending maps a refusal to the code the bridge answers with`() = runTest {
        val r = rig()
        r.endResult = { throw ApiException(403, "cannot_end") }
        try {
            r.seat.end()
            fail()
        } catch (e: ActivityTransportError) {
            assertEquals("not-allowed", e.code)
        }
        r.endResult = { throw java.io.IOException("offline") }
        try {
            r.seat.end()
            fail()
        } catch (e: ActivityTransportError) {
            assertEquals("unavailable", e.code)
        }
        r.endResult = { false } // already over: not a failure
        r.seat.end()
        assertNull(r.endings.firstOrNull())
    }

    @Test
    fun `a send the socket refuses is unavailable for a join and for a write`() = runTest {
        val r = rig()
        r.sendAccepts = false
        try {
            r.seat.join(false)
            fail()
        } catch (e: ActivityTransportError) {
            assertEquals("unavailable", e.code)
        }
        r.sendAccepts = true
        seated(r)
        r.sendAccepts = false
        try {
            r.seat.patchState(JsonNull, null)
            fail()
        } catch (e: ActivityTransportError) {
            assertEquals("unavailable", e.code)
        }
        advanceUntilIdle()
    }

    @Test
    fun `two writes are sent one at a time, each answered by its own state`() = runTest {
        val r = rig()
        seated(r)
        val first = backgroundScope.async { r.seat.patchState(buildJsonObject { put("n", 1) }, null) }
        val second = backgroundScope.async { r.seat.patchState(buildJsonObject { put("n", 2) }, null) }
        runCurrent()
        assertEquals("the second waits for the first", listOf("app-state-patch"), r.types())
        r.emit("""{"type":"app-state","sessionId":"$SESSION","rev":3,"value":{"n":1}}""")
        runCurrent()
        assertEquals(3L, first.await())
        assertEquals(listOf("app-state-patch", "app-state-patch"), r.types())
        r.emit("""{"type":"app-state","sessionId":"$SESSION","rev":4,"value":{"n":2}}""")
        runCurrent()
        assertEquals(4L, second.await())
    }

    @Test
    fun `a cancelled write leaves no waiter to steal the next answer`() = runTest {
        val r = rig()
        seated(r)
        val cancelled = backgroundScope.async { r.seat.patchState(JsonNull, null) }
        runCurrent()
        cancelled.cancel()
        runCurrent()
        val next = backgroundScope.async { r.seat.patchState(JsonNull, null) }
        runCurrent()
        r.emit("""{"type":"app-state","sessionId":"$SESSION","rev":9,"value":null}""")
        runCurrent()
        assertEquals(9L, next.await())
    }

    @Test
    fun `a resume the socket refuses is asked again until the seat answers`() = runTest {
        val r = rig()
        seated(r)
        r.state.value = RealtimeState.Reconnecting
        runCurrent()
        r.sendAccepts = false
        r.state.value = RealtimeState.Ready
        runCurrent()
        assertEquals(listOf("app-join"), r.types())
        r.sendAccepts = true
        advanceTimeBy(ActivitySeat.RESUME_RETRY_MS + 1)
        runCurrent()
        assertEquals("asked again", listOf("app-join", "app-join"), r.types())
        r.emit(snapshotFrame())
        runCurrent()
        advanceTimeBy(ActivitySeat.RESUME_RETRY_MS * 3)
        runCurrent()
        assertEquals("and no more once the snapshot is back", 2, r.types().size)
    }

    @Test
    fun `the resume keeps asking, slower, for as long as the socket is up and no snapshot came`() = runTest {
        val r = rig()
        seated(r)
        r.state.value = RealtimeState.Reconnecting
        runCurrent()
        r.state.value = RealtimeState.Ready
        runCurrent()
        advanceTimeBy(ActivitySeat.RESUME_RETRY_MAX_MS * 12)
        runCurrent()
        assertTrue("still asking well past the old five tries (${r.types().size})", r.types().size > 8)
        r.emit(snapshotFrame())
        runCurrent()
        val settled = r.types().size
        advanceTimeBy(ActivitySeat.RESUME_RETRY_MAX_MS * 3)
        runCurrent()
        assertEquals(settled, r.types().size)
    }
}
