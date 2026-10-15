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

    private fun card(restricted: Boolean = false, title: String? = "Sessao", excerpt: String = "texto") = MessageForward(
        v = 1, kind = FORWARD_KIND_BAU_POST, sourceServerId = "s", sourceServerName = "QG",
        sourceId = "p", title = title, excerpt = excerpt, url = "https://pqp.gg/x", restricted = restricted,
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
        val input = ForwardInputs.forMessage(message(), "Mensagem de Ana: hello", channelServerId = "s")
        assertEquals(FORWARD_KIND_MESSAGE, input.source.kind)
        assertEquals("m1", input.source.id)
        assertNull(input.source.serverId)
        assertNull(input.restrictedToServerId)
        assertEquals("Mensagem de Ana: hello", input.preview)
    }

    @Test
    fun `forwarding on a restricted card keeps it in that server`() {
        val input = ForwardInputs.forMessage(message(forward = card(restricted = true)), "p", channelServerId = "srv")
        assertEquals("srv", input.restrictedToServerId)
        assertNull(ForwardInputs.forMessage(message(forward = card(restricted = false)), "p", "srv").restrictedToServerId)
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
