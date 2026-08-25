package gg.pqp.app.push

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The phantom-notification guard.
 *
 * These are the tests that would fail if this client reintroduced the web
 * client's #79 bug: a "1 nova mensagem" for a channel the reader has open, and
 * its mirror image, a notification suppressed for a channel nobody is looking
 * at.
 */
class PushPresentationTest {

    private fun push(path: String?, tag: String? = null) =
        PushMessage(title = "t", body = "b", path = path, tag = tag)

    // ---------------------------------------------------- the redundant case

    @Test
    fun `no banner for the server channel already on screen`() {
        assertFalse(
            PushPresentation.shouldNotify(
                message = push("/app/server/srv-1/channel/chan-2"),
                visibleChannelId = "chan-2",
                appInForeground = true,
            ),
        )
    }

    @Test
    fun `no banner for the conversation already on screen`() {
        assertFalse(
            PushPresentation.shouldNotify(
                message = push("/app/dm/chan-9"),
                visibleChannelId = "chan-9",
                appInForeground = true,
            ),
        )
    }

    /**
     * The tag is the fallback identity. A payload whose path the client cannot
     * parse, for a channel that is open, still must not draw.
     */
    @Test
    fun `an unparseable path falls back to the tag`() {
        assertFalse(
            PushPresentation.shouldNotify(
                message = push(path = "/app/somewhere/new", tag = "chan-2"),
                visibleChannelId = "chan-2",
                appInForeground = true,
            ),
        )
    }

    // -------------------------------------------------------- the wanted case

    @Test
    fun `a different channel still notifies`() {
        assertTrue(
            PushPresentation.shouldNotify(
                message = push("/app/server/srv-1/channel/chan-3"),
                visibleChannelId = "chan-2",
                appInForeground = true,
            ),
        )
    }

    /**
     * THE ONE THAT MATTERS MOST. A stale "visible channel" plus a backgrounded
     * app is how this guard turns into silence at exactly the moment a
     * notification is the entire point. Backgrounded means notify, full stop:
     * the visible channel is not even consulted.
     */
    @Test
    fun `backgrounded always notifies even for the channel last on screen`() {
        assertTrue(
            PushPresentation.shouldNotify(
                message = push("/app/server/srv-1/channel/chan-2"),
                visibleChannelId = "chan-2",
                appInForeground = false,
            ),
        )
    }

    @Test
    fun `foreground with no chat open notifies`() {
        assertTrue(
            PushPresentation.shouldNotify(
                message = push("/app/server/srv-1/channel/chan-2"),
                visibleChannelId = null,
                appInForeground = true,
            ),
        )
    }

    @Test
    fun `a push with no channel in it always notifies`() {
        assertTrue(
            PushPresentation.shouldNotify(
                message = push(path = null, tag = null).copy(body = "Incoming call"),
                visibleChannelId = "chan-2",
                appInForeground = true,
            ),
        )
    }

    // ------------------------------------------------------------- the frame

    /**
     * The frame has to be self-describing, because nothing else in the process
     * can help: `onMessageReceived` may run with no session, no channel list
     * and no Activity. Both ids come out of the payload alone.
     */
    @Test
    fun `the frame carries its own context`() {
        val message = PushMessage.from(
            mapOf(
                "title" to "#geral in pqp",
                "body" to "Rafael mentioned you",
                "path" to "/app/server/srv-1/channel/chan-2",
                "tag" to "chan-2",
            ),
        )
        requireNotNull(message)
        assertEquals("chan-2", message.channelId)
        assertEquals(DeepLinkTarget.Channel("srv-1", "chan-2"), message.target)
    }

    @Test
    fun `an empty data map is not a push`() {
        assertNull(PushMessage.from(emptyMap()))
        assertNull(PushMessage.from(mapOf("title" to "pqp")))
        assertNull(PushMessage.from(mapOf("body" to "", "path" to "")))
    }

    @Test
    fun `a push with a body and no route is still a push`() {
        val message = PushMessage.from(mapOf("body" to "New direct message"))
        requireNotNull(message)
        assertNull(message.channelId)
    }

    // --------------------------------------------------------- visible channel

    @Test
    fun `leaving a channel that is no longer the visible one does not blank it`() {
        // Navigating A to B delivers B's START before A's STOP. An
        // unconditional clear on STOP would blank the channel actually open.
        VisibleChannel.enter("chan-a")
        VisibleChannel.enter("chan-b")
        VisibleChannel.leave("chan-a")
        assertEquals("chan-b", VisibleChannel.id)
        VisibleChannel.leave("chan-b")
        assertNull(VisibleChannel.id)
    }
}
