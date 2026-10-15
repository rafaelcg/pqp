package gg.pqp.app.ui.chat

import gg.pqp.app.core.Attachment
import gg.pqp.app.core.Message
import gg.pqp.app.core.VoiceNote
import gg.pqp.app.forward.FORWARD_KIND_BAU_POST
import gg.pqp.app.forward.FORWARD_KIND_MESSAGE
import gg.pqp.app.forward.ForwardInputs
import gg.pqp.app.forward.MessageForward
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** When a message offers Encaminhar, and what the sheet is opened with. */
class ForwardActionTest {

    private fun message(
        body: String = "hello",
        attachments: List<Attachment> = emptyList(),
        systemKind: String? = null,
        blocked: Boolean = false,
        forward: MessageForward? = null,
    ) = Message(
        id = "m1", channelId = "c1", authorId = "u1", authorName = "Ana", body = body,
        createdAt = "2026-10-15T12:00:00.000Z", attachments = attachments, systemKind = systemKind,
        blocked = blocked, forward = forward,
    )

    private fun attachment(type: String, voice: VoiceNote? = null) = Attachment(
        id = "a", filename = "f", contentType = type, url = "https://x/y", voice = voice,
    )

    private fun card(
        restricted: Boolean = false,
        title: String? = "Sessao",
        excerpt: String = "texto",
        restrictedTo: String? = null,
    ) = MessageForward(
        v = 1, kind = FORWARD_KIND_BAU_POST, sourceServerId = "s", sourceServerName = "QG",
        sourceId = "p", title = title, excerpt = excerpt, url = "https://pqp.gg/x", restricted = restricted,
        restrictedToServerId = restrictedTo,
    )

    @Test
    fun `a message in a server channel offers it`() {
        assertTrue(MessagePermissions.canForward(message(), isServerChannel = true))
    }

    @Test
    fun `a conversation never offers it, the server refuses a dm as a source`() {
        assertFalse(MessagePermissions.canForward(message(), isServerChannel = false))
    }

    @Test
    fun `a nudge and a blocked author's row do not offer it`() {
        assertFalse(MessagePermissions.canForward(message(systemKind = "nudge", body = "📳"), isServerChannel = true))
        assertFalse(MessagePermissions.canForward(message(blocked = true), isServerChannel = true))
    }

    @Test
    fun `a picture or a video is enough to forward, words are not needed`() {
        assertTrue(MessagePermissions.canForward(message(body = "", attachments = listOf(attachment("image/png"))), true))
        assertTrue(MessagePermissions.canForward(message(body = " ", attachments = listOf(attachment("video/mp4"))), true))
    }

    @Test
    fun `a voice note or a document alone has nothing to show`() {
        assertFalse(MessagePermissions.canForward(message(body = "", attachments = listOf(attachment("audio/webm", VoiceNote()))), true))
        assertFalse(MessagePermissions.canForward(message(body = "", attachments = listOf(attachment("application/pdf"))), true))
        assertFalse(MessagePermissions.canForward(message(body = "  "), true))
    }

    @Test
    fun `a message that is itself a forward can be forwarded on`() {
        assertTrue(MessagePermissions.canForward(message(body = "", forward = card()), true))
    }

    // ---- ForwardInputs

    @Test
    fun `a message source carries its id and no server`() {
        val input = ForwardInputs.forMessage(message(), "Mensagem de Ana: hello")
        assertEquals(FORWARD_KIND_MESSAGE, input.source.kind)
        assertEquals("m1", input.source.id)
        assertNull(input.source.serverId)
        assertNull(input.restrictedToServerId)
        assertEquals("Mensagem de Ana: hello", input.preview)
    }

    @Test
    fun `forwarding on a restricted card keeps it in the server the card names`() {
        // A members-only post's card: its own server.
        assertEquals("s", ForwardInputs.forMessage(message(forward = card(restricted = true)), "p").restrictedToServerId)
        // Stamped in a private channel of ANOTHER server: that one, not the source's.
        assertEquals(
            "other",
            ForwardInputs.forMessage(message(forward = card(restricted = true, restrictedTo = "other")), "p")
                .restrictedToServerId,
        )
        // An unrestricted card, even one that names a server, is free to go anywhere.
        assertNull(
            ForwardInputs.forMessage(message(forward = card(restricted = false, restrictedTo = "other")), "p")
                .restrictedToServerId,
        )
        assertNull(ForwardInputs.forMessage(message(), "p").restrictedToServerId)
    }

    private fun channelRow(id: String, isPrivate: Boolean) =
        gg.pqp.app.core.Channel(id = id, serverId = "s", name = "n", type = "text", isPrivate = isPrivate)

    @Test
    fun `a private channel's message cannot leave its server`() {
        val list = listOf(channelRow("pub", false), channelRow("priv", true))
        assertEquals("s", ForwardInputs.privateBoundary("s", "priv", list))
        assertNull(ForwardInputs.privateBoundary("s", "pub", list))
    }

    @Test
    fun `a channel this client cannot place is treated as private`() {
        // A thread or a forum post is not in the channel list; so is anything when the list failed.
        assertEquals("s", ForwardInputs.privateBoundary("s", "thread", listOf(channelRow("pub", false))))
        assertEquals("s", ForwardInputs.privateBoundary("s", "pub", null))
    }

    @Test
    fun `a conversation has no server to keep it in`() {
        assertNull(ForwardInputs.privateBoundary(null, "dm", emptyList()))
        assertNull(ForwardInputs.privateBoundary(null, "dm", null))
    }

    @Test
    fun `the private channel boundary rides on the picker input, a restricted card's own wins`() {
        assertEquals("s", ForwardInputs.forMessage(message(), "p", privateChannelServerId = "s").restrictedToServerId)
        assertEquals(
            "other",
            ForwardInputs.forMessage(
                message(forward = card(restricted = true, restrictedTo = "other")), "p", privateChannelServerId = "s",
            ).restrictedToServerId,
        )
        assertNull(ForwardInputs.forMessage(message(), "p").restrictedToServerId)
    }

    @Test
    fun `a post source is addressed with its server and a members-only one stays in it`() {
        val free = ForwardInputs.forBauPost("s", "p", "preview", membersOnly = false)
        assertEquals(FORWARD_KIND_BAU_POST, free.source.kind)
        assertEquals("s", free.source.serverId)
        assertEquals("p", free.source.id)
        assertNull(free.restrictedToServerId)
        assertEquals("s", ForwardInputs.forBauPost("s", "p", "preview", membersOnly = true).restrictedToServerId)
    }

    @Test
    fun `the preview words are flattened and cut`() {
        assertEquals("a b c", ForwardInputs.messageExcerpt(message(body = "  a\n\n b   c ")))
        val long = ForwardInputs.messageExcerpt(message(body = "x".repeat(200)))
        assertEquals(80, long.length)
        assertTrue(long.endsWith("…"))
        // A forward card reads as its own title, then its excerpt.
        assertEquals("Sessao", ForwardInputs.messageExcerpt(message(body = "Encaminhado: ...", forward = card())))
        assertEquals("texto", ForwardInputs.messageExcerpt(message(forward = card(title = null))))
    }
}
