package gg.pqp.app.voice

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Play crash: `IllegalArgumentException: person must have a non-empty a name`
 * from `VoiceService.buildNotification`. The CallStyle `Person` took the
 * channel name as is, and an empty one is not null.
 */
class CallNotificationLineTest {

    private fun line(projecting: Boolean = false, channelName: String?) =
        callNotificationLine(projecting, channelName, sharing = "Sharing", title = "In voice")

    @Test
    fun `a blank channel name falls back to the title`() {
        assertEquals("In voice", line(channelName = ""))
        assertEquals("In voice", line(channelName = "   "))
        assertEquals("In voice", line(channelName = null))
    }

    @Test
    fun `a real channel name is shown`() {
        assertEquals("geral", line(channelName = "geral"))
    }

    @Test
    fun `a share says so whatever the channel is called`() {
        assertEquals("Sharing", line(projecting = true, channelName = ""))
        assertEquals("Sharing", line(projecting = true, channelName = "geral"))
    }
}
