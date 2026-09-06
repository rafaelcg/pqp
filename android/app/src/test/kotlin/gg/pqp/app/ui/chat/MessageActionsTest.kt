package gg.pqp.app.ui.chat

import gg.pqp.app.core.Message
import gg.pqp.app.protocol.RepoSources
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Who is offered what, and what the pin list does when a row changes.
 *
 * The rules belong to the server (`PATCH`, `DELETE` and `/pin` on
 * `/api/messages/:id`); these restate them so the sheet offers only what will
 * not 403. Getting that wrong is not cosmetic: iOS shipped it wrong in both
 * directions at once, an owner who could not delete anything and a plain
 * member handed a Pin button that always failed, which is why
 * `canManageMessages` exists in `packages/shared/src/moderation.ts` at all.
 */
class MessageActionsTest {

    private val ME = "11111111-1111-1111-1111-111111111111"
    private val THEM = "22222222-2222-2222-2222-222222222222"

    private fun message(
        id: String = "m1",
        authorId: String = ME,
        pinnedAt: String? = null,
        isWebhook: Boolean = false,
    ) = Message(
        id = id,
        channelId = "c1",
        authorId = authorId,
        authorName = "Someone",
        body = "hello",
        createdAt = "2026-09-06T12:00:00.000Z",
        pinnedAt = pinnedAt,
        isWebhook = isWebhook,
    )

    // --- editing ---

    @Test
    fun `only the author may edit`() {
        assertTrue(MessagePermissions.canEdit(message(authorId = ME), ME))
        assertFalse(MessagePermissions.canEdit(message(authorId = THEM), ME))
    }

    @Test
    fun `a moderator may not edit somebody else's words`() {
        // Deliberately not gated on the role: the server refuses it outright,
        // and rewriting what somebody said is not a moderation action.
        assertFalse(MessagePermissions.canEdit(message(authorId = THEM), ME))
    }

    @Test
    fun `a webhook row has no author to be`() {
        assertFalse(MessagePermissions.canEdit(message(authorId = ME, isWebhook = true), ME))
    }

    @Test
    fun `signed out edits nothing`() {
        assertFalse(MessagePermissions.canEdit(message(), null))
    }

    // --- deleting ---

    @Test
    fun `an author deletes their own anywhere`() {
        assertTrue(
            MessagePermissions.canDelete(message(authorId = ME), ME, null, isServerChannel = false),
        )
        assertTrue(
            MessagePermissions.canDelete(message(authorId = ME), ME, "member", isServerChannel = true),
        )
    }

    @Test
    fun `a moderator deletes anyone's in a server channel`() {
        assertTrue(
            MessagePermissions.canDelete(message(authorId = THEM), ME, "admin", isServerChannel = true),
        )
        assertTrue(
            MessagePermissions.canDelete(message(authorId = THEM), ME, "owner", isServerChannel = true),
        )
        assertFalse(
            MessagePermissions.canDelete(message(authorId = THEM), ME, "member", isServerChannel = true),
        )
    }

    @Test
    fun `a conversation has no moderators, whatever role the caller holds elsewhere`() {
        // `server_id` being null is the answer, not a missing lookup: the
        // server's own delete route stops there rather than falling through.
        assertFalse(
            MessagePermissions.canDelete(message(authorId = THEM), ME, "owner", isServerChannel = false),
        )
    }

    // --- pinning ---

    @Test
    fun `anybody in a conversation may pin, only a manager in a server channel`() {
        assertTrue(MessagePermissions.canPin(null, isServerChannel = false))
        assertFalse(MessagePermissions.canPin("member", isServerChannel = true))
        assertTrue(MessagePermissions.canPin("admin", isServerChannel = true))
        assertTrue(MessagePermissions.canPin("owner", isServerChannel = true))
    }

    @Test
    fun `owner and admin are the same answer, and nothing else is`() {
        assertTrue(MessagePermissions.canManage("owner"))
        assertTrue(MessagePermissions.canManage("admin"))
        assertFalse(MessagePermissions.canManage("member"))
        assertFalse(MessagePermissions.canManage(null))
    }

    /**
     * `canManageMessages` in shared is the flat manager check both other
     * clients use. A rule change there that this file did not follow is a
     * sheet offering a button that always 403s, which is invisible until
     * somebody taps it.
     */
    @Test
    fun `the manager rule still matches the shared one`() {
        val shared = File(RepoSources.root, "packages/shared/src/moderation.ts").readText()
        val body = Regex("""canManageMessages\([^)]*\)[^{]*\{([^}]*)}""").find(shared)
        assertTrue("canManageMessages not found in shared", body != null)
        val roles = Regex(""""(owner|admin|member)"""").findAll(body!!.groupValues[1])
            .map { it.groupValues[1] }
            .toSet()
        assertEquals(
            "The shared manager rule changed. MessagePermissions.canManage is a hand-copy.",
            setOf("owner", "admin"),
            roles,
        )
    }

    // --- the pin list ---

    @Test
    fun `a pin lands newest first`() {
        val older = message(id = "a", pinnedAt = "2026-09-01T00:00:00.000Z")
        val newer = message(id = "b", pinnedAt = "2026-09-05T00:00:00.000Z")
        val pinned = PinnedMessages.apply(PinnedMessages.apply(emptyList(), older), newer)
        assertEquals(listOf("b", "a"), pinned.map { it.id })
    }

    @Test
    fun `an unpin arrives as the same update with pinnedAt cleared`() {
        val pinned = PinnedMessages.apply(emptyList(), message(id = "a", pinnedAt = "2026-09-01T00:00:00.000Z"))
        assertEquals(emptyList<Message>(), PinnedMessages.apply(pinned, message(id = "a", pinnedAt = null)))
    }

    @Test
    fun `an edit of a pinned message replaces it rather than duplicating it`() {
        val at = "2026-09-01T00:00:00.000Z"
        val pinned = PinnedMessages.apply(emptyList(), message(id = "a", pinnedAt = at))
        val edited = message(id = "a", pinnedAt = at).copy(body = "hello, again")
        val after = PinnedMessages.apply(pinned, edited)
        assertEquals(1, after.size)
        assertEquals("hello, again", after.single().body)
    }

    @Test
    fun `deleting a pinned message takes it out of the list`() {
        val pinned = PinnedMessages.apply(emptyList(), message(id = "a", pinnedAt = "2026-09-01T00:00:00.000Z"))
        assertEquals(emptyList<Message>(), PinnedMessages.remove(pinned, "a"))
        // A delete for something never pinned is a no-op, not a crash.
        assertEquals(pinned, PinnedMessages.remove(pinned, "somebody-else"))
    }

    // --- what the composer is doing ---

    @Test
    fun `replying and editing are exclusive`() {
        val reply: ComposerTarget = ComposerTarget.Reply(message())
        val edit: ComposerTarget = ComposerTarget.Edit(message())
        assertTrue(reply is ComposerTarget.Reply)
        assertTrue(edit is ComposerTarget.Edit)
        assertFalse(reply == edit)
    }
}
