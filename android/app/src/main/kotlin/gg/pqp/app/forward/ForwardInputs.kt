package gg.pqp.app.forward

import gg.pqp.app.core.Channel
import gg.pqp.app.core.Message

/**
 * Builds what the Encaminhar sheet is opened with, from the thing being
 * forwarded. Pure: the preview line's wording is a string resource the caller
 * resolves, this only works out the pieces.
 */
object ForwardInputs {

    private const val PREVIEW_MAX = 80

    /**
     * The first words of a message, for the sheet's header: whitespace
     * collapsed, cut with an ellipsis. A forward card reads as the card's own
     * title or excerpt, since that is what the person is passing on.
     */
    fun messageExcerpt(message: Message): String {
        val text = message.forward?.let { it.title?.takeIf { t -> t.isNotBlank() } ?: it.excerpt }
            ?: message.body
        return cut(text)
    }

    /**
     * [privateChannelServerId] is [privateBoundary]'s answer for the channel the
     * message sits in.
     */
    fun forMessage(
        message: Message,
        previewText: String,
        privateChannelServerId: String? = null,
        knownChannels: Pair<String, List<Channel>>? = null,
    ): ForwardInput =
        ForwardInput(
            source = ForwardSource(kind = FORWARD_KIND_MESSAGE, id = message.id),
            preview = previewText,
            // A forward of a restricted card stays inside the server the card names
            // (`restrictedToServerId ?: sourceServerId`), which is not necessarily the
            // channel it sits in; a message in a private channel stays in that server.
            restrictedToServerId = message.forward?.restrictedBoundary ?: privateChannelServerId,
            knownChannels = knownChannels,
        )

    /**
     * The server a message must not leave, when its channel is not one everybody
     * in the server can read: the channel is private in the loaded channel list,
     * or is not in that list at all (a thread, a forum post, a channel this
     * account cannot list, or a list that failed to load). The same conservative
     * rule the web applies; the server enforces the real one per target. Null for
     * a conversation and for an ordinary public channel.
     */
    fun privateBoundary(serverId: String?, channelId: String, channels: List<Channel>?): String? {
        if (serverId == null) return null
        val channel = channels?.firstOrNull { it.id == channelId } ?: return serverId
        return if (channel.isPrivate) serverId else null
    }

    /** A Baú post is addressed with its server. A members-only post stays in it. */
    fun forBauPost(serverId: String, postId: String, previewText: String, membersOnly: Boolean): ForwardInput =
        ForwardInput(
            source = ForwardSource(kind = FORWARD_KIND_BAU_POST, id = postId, serverId = serverId),
            preview = previewText,
            restrictedToServerId = if (membersOnly) serverId else null,
        )

    private fun cut(text: String): String {
        val flat = text.replace(Regex("\\s+"), " ").trim()
        return if (flat.length > PREVIEW_MAX) flat.take(PREVIEW_MAX - 1).trimEnd() + "…" else flat
    }
}
