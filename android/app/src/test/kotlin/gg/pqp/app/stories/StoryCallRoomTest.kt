package gg.pqp.app.stories

import gg.pqp.app.core.Channel
import gg.pqp.app.core.VoiceParticipant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** "Chama pra call" starts on the author's room and knows when it is not theirs. */
class StoryCallRoomTest {

    private val me = "me"

    private fun room(id: String) = Channel(id = id, serverId = "s", name = id, type = "voice")

    private fun person(user: String) = VoiceParticipant(peerId = "peer-$user", userId = user, displayName = user)

    private val occupancy = mapOf(
        "busy" to listOf(person("a"), person("b"), person("c")),
        "lobby" to listOf(person(me)),
    )

    @Test
    fun `starts on the room the author is in, even when another one is busier`() {
        val rooms = listOf(room("busy"), room("lobby"), room("empty"))
        assertEquals("lobby", StoryCallRoom.defaultRoom(rooms, me, occupancy)?.id)
    }

    @Test
    fun `picks nothing when the author is in no room`() {
        assertNull(StoryCallRoom.defaultRoom(listOf(room("busy"), room("empty")), me, occupancy))
        assertNull(StoryCallRoom.defaultRoom(emptyList(), me, occupancy))
    }

    @Test
    fun `author in room reads the occupants`() {
        assertTrue(StoryCallRoom.authorIn("lobby", me, occupancy))
        assertFalse(StoryCallRoom.authorIn("busy", me, occupancy))
        assertFalse(StoryCallRoom.authorIn("empty", me, occupancy))
        assertFalse(StoryCallRoom.authorIn("lobby", null, occupancy))
        assertFalse(StoryCallRoom.authorIn(null, me, occupancy))
    }
}
