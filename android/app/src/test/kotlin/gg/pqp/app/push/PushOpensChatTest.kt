package gg.pqp.app.push

import gg.pqp.app.core.Channel
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushOpensChatTest {
    private fun channel(type: String) = Channel(id = "c1", name = "x", type = type)

    @Test
    fun `text voice and watch party open a chat`() {
        assertTrue(pushOpensChat(channel("text")))
        assertTrue(pushOpensChat(channel("voice")))
        assertTrue(pushOpensChat(channel("watch_party")))
    }

    @Test
    fun `a forum or unknown type stays on the channel list`() {
        assertFalse(pushOpensChat(channel("forum")))
        assertFalse(pushOpensChat(channel("category")))
        assertFalse(pushOpensChat(channel("something-new")))
    }

    @Test
    fun `a channel missing from the list still opens (threads, failed fetch)`() {
        assertTrue(pushOpensChat(null))
    }
}
