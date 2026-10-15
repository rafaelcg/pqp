package gg.pqp.app.forward

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

    fun forMessage(message: Message, previewText: String, channelServerId: String?): ForwardInput =
        ForwardInput(
            source = ForwardSource(kind = FORWARD_KIND_MESSAGE, id = message.id),
            preview = previewText,
            // A forward of a restricted card stays in the server it was sent
            // in, as the server enforces. A private channel is not knowable
            // here; the server's per-target answer says so.
            restrictedToServerId = if (message.forward?.restricted == true) channelServerId else null,
        )

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
