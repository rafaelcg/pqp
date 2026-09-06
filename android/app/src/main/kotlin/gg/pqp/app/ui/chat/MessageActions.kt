package gg.pqp.app.ui.chat

import gg.pqp.app.core.Message

/**
 * What the composer is doing with the next send.
 *
 * One value rather than two nullable messages, because replying and editing
 * are exclusive: an edit cannot carry a reply and a reply is a new message.
 * The screen switches its header row on this and the view model switches
 * between `message-create` and `PATCH /api/messages/:id` on it.
 */
sealed interface ComposerTarget {
    data object New : ComposerTarget
    data class Reply(val to: Message) : ComposerTarget
    data class Edit(val message: Message) : ComposerTarget
}

/**
 * Who may do what to a message.
 *
 * The rules are the server's (`server/src/api/index.ts`, the `PATCH`,
 * `DELETE` and `/pin` routes on `/api/messages`), restated so the sheet offers
 * only what will not 403. The server still decides; this is what keeps a plain
 * member from being shown a Pin row that always fails, which is the shape iOS
 * got wrong once (`canManageMessages` in `packages/shared/src/moderation.ts`).
 *
 * [role] is the caller's `ServerSummary.role`, null in a conversation. A
 * conversation has no moderators: anybody in it may pin, and only the author
 * may delete.
 */
object MessagePermissions {

    fun canManage(role: String?): Boolean = role == "owner" || role == "admin"

    /** Only the author, and never a webhook's row: there is no account behind it. */
    fun canEdit(message: Message, meId: String?): Boolean =
        meId != null && message.authorId == meId && !message.isWebhook

    fun canDelete(message: Message, meId: String?, role: String?, isServerChannel: Boolean): Boolean =
        (meId != null && message.authorId == meId) || (isServerChannel && canManage(role))

    fun canPin(role: String?, isServerChannel: Boolean): Boolean =
        !isServerChannel || canManage(role)
}

/**
 * The pinned list, kept in step with the transcript.
 *
 * A pin and an unpin both arrive as `message-update` with `pinnedAt` set or
 * cleared, so this is the one reducer for both. Newest pin first, which is
 * the order `GET /api/channels/:id/pins` answers in.
 */
object PinnedMessages {

    fun apply(pinned: List<Message>, message: Message): List<Message> {
        val without = pinned.filterNot { it.id == message.id }
        if (message.pinnedAt == null) return without
        return (without + message).sortedByDescending { it.pinnedAt }
    }

    fun remove(pinned: List<Message>, messageId: String): List<Message> =
        pinned.filterNot { it.id == messageId }
}
