package gg.pqp.app.push

import gg.pqp.app.core.Channel
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushOpensChatTest {
    private fun channel(type: String, id: String = "c1", name: String = "x") = Channel(id = id, name = name, type = type)

    @Test
    fun `text voice and watch party open a chat`() {
        assertTrue(pushOpensChat(channel("text")))
        assertTrue(pushOpensChat(channel("voice")))
        assertTrue(pushOpensChat(channel("watch_party")))
    }

    @Test
    fun `a forum is not a chat, and an unknown type stays on the channel list`() {
        assertFalse(pushOpensChat(channel("forum")))
        assertFalse(pushOpensChat(channel("category")))
        assertFalse(pushOpensChat(channel("something-new")))
    }

    @Test
    fun `a channel missing from the list still opens (threads, failed fetch)`() {
        assertTrue(pushOpensChat(null))
    }

    @Test
    fun `a forum push opens the forum, and never asks the server about a post`() = runTest {
        var asked = false
        val route = channelPushRoute(channel("forum"), null) { asked = true; PostLookup.NotAPost }
        assertEquals(ChannelPushRoute.Forum, route)
        assertFalse(asked)
    }

    @Test
    fun `an id missing from the list is a post when the server says so`() = runTest {
        val forum = channel("forum", id = "f1", name = "ajuda")
        assertEquals(
            ChannelPushRoute.Post("f1", "ajuda"),
            channelPushRoute(null, listOf(forum)) { PostLookup.Post("f1") },
        )
        // A thread opens its chat, as it always did.
        assertEquals(ChannelPushRoute.Chat, channelPushRoute(null, listOf(forum)) { PostLookup.NotAPost })
        // An unknown answer never opens a chat on what may be a post's id.
        assertEquals(ChannelPushRoute.Stay, channelPushRoute(null, listOf(forum)) { PostLookup.Failed })
    }

    @Test
    fun `text opens a chat, an unknown type stays`() = runTest {
        assertEquals(ChannelPushRoute.Chat, channelPushRoute(channel("text"), null) { error("not asked") })
        assertEquals(ChannelPushRoute.Stay, channelPushRoute(channel("something-new"), null) { error("not asked") })
    }
}
