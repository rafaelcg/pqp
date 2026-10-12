package gg.pqp.app.voice

import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.VoiceParticipant
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Who sits in every visible room, for the channel list. */
class VoiceRoomsTest {

    private fun p(peer: String, user: String = peer, muted: Boolean = false) =
        VoiceParticipant(peerId = peer, userId = user, displayName = user, muted = muted)

    @Test
    fun `a snapshot fills a room and an empty one removes it`() {
        val rooms = VoiceRoomOccupancy()
        assertTrue(rooms.snapshot("lobby", listOf(p("a"), p("b")), seq = 4))
        assertEquals(listOf("a", "b"), rooms.current()["lobby"]?.map { it.peerId })
        assertTrue(rooms.snapshot("lobby", emptyList(), seq = null))
        assertFalse("lobby" in rooms.current())
    }

    @Test
    fun `each room keeps its own sequence`() {
        val rooms = VoiceRoomOccupancy()
        rooms.snapshot("lobby", listOf(p("a")), seq = 7)
        rooms.snapshot("ranked", listOf(p("x")), seq = 2)
        assertTrue(rooms.delta("lobby", seq = 8, size = 2, joined = listOf(p("b"))))
        assertTrue(rooms.delta("ranked", seq = 3, size = 2, joined = listOf(p("y"))))
        assertEquals(listOf("a", "b"), rooms.current()["lobby"]?.map { it.peerId })
        assertEquals(listOf("x", "y"), rooms.current()["ranked"]?.map { it.peerId })
    }

    @Test
    fun `a gap is refused and changes nothing, and the last one out empties the room`() {
        val rooms = VoiceRoomOccupancy()
        rooms.snapshot("lobby", listOf(p("a"), p("b")), seq = 1)
        assertFalse(rooms.delta("lobby", seq = 5, size = 3, joined = listOf(p("c"))))
        assertEquals(2, rooms.current()["lobby"]?.size)
        assertTrue(rooms.delta("lobby", seq = 2, size = 0, left = listOf("a", "b")))
        assertFalse("lobby" in rooms.current())
    }

    @Test
    fun `the first delta of a fresh call needs no snapshot`() {
        val rooms = VoiceRoomOccupancy()
        assertTrue(rooms.delta("new", seq = 1, size = 1, joined = listOf(p("a"))))
        assertEquals(listOf("a"), rooms.current()["new"]?.map { it.peerId })
    }

    @Test
    fun `clear forgets every room`() {
        val rooms = VoiceRoomOccupancy()
        rooms.snapshot("lobby", listOf(p("a")), seq = 1)
        assertTrue(rooms.clear())
        assertTrue(rooms.current().isEmpty())
        assertFalse(rooms.clear())
    }

    private fun frame(json: String): JsonObject = PqpJson.parseToJsonElement(json).jsonObject

    @Test
    fun `the store reads both frame types off the socket and drops everything on a disconnect`() = runTest(UnconfinedTestDispatcher()) {
        val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 16)
        val state = MutableStateFlow(RealtimeState.Ready)
        val store = VoiceRoomsStore(frames, state, backgroundScope)

        frames.emit(
            frame(
                """{"type":"voice-roster","voiceChannelId":"lobby","seq":3,"participants":[
                    {"peerId":"a","userId":"ana","displayName":"Ana"}]}""",
            ),
        )
        frames.emit(
            frame(
                """{"type":"voice-roster-delta","voiceChannelId":"lobby","seq":4,"size":2,
                    "joined":[{"peerId":"b","userId":"bia","displayName":"Bia","muted":true}]}""",
            ),
        )
        frames.emit(frame("""{"type":"message","channelId":"x"}"""))
        val lobby = store.rooms.value["lobby"].orEmpty()
        assertEquals(listOf("Ana", "Bia"), lobby.map { it.displayName })
        assertTrue(lobby[1].muted)

        state.value = RealtimeState.Reconnecting
        assertTrue(store.rooms.value.isEmpty())
    }
}
