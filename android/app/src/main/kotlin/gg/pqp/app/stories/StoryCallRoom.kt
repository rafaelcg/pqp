package gg.pqp.app.stories

import gg.pqp.app.core.Channel
import gg.pqp.app.core.VoiceParticipant

/**
 * Which voice room "Chama pra call" starts on, and whether the sticker will be
 * open once posted.
 *
 * The server keeps a call sticker live only while its AUTHOR is in the room
 * ("A call acabou" when the room empties or the author leaves it), so a
 * sticker for a room the author is not in is posted already closed, with no
 * join button for anybody. Web did the same in `call-room.ts`.
 */
object StoryCallRoom {

    /** True when [userId] is seated in [channelId] according to the roster. */
    fun authorIn(
        channelId: String?,
        userId: String?,
        occupancy: Map<String, List<VoiceParticipant>>,
    ): Boolean {
        if (channelId == null || userId == null) return false
        return occupancy[channelId].orEmpty().any { it.userId == userId }
    }

    /** The room the author is in, if any; nothing is picked for them otherwise. */
    fun defaultRoom(
        rooms: List<Channel>,
        userId: String?,
        occupancy: Map<String, List<VoiceParticipant>>,
    ): Channel? = rooms.firstOrNull { authorIn(it.id, userId, occupancy) }
}
