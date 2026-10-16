package gg.pqp.app.forward

import gg.pqp.app.bau.BauShare

/**
 * Where a tap on a forward card goes.
 *
 * The card's `url` is an absolute link on the instance that wrote it: a Baú post
 * (`<origin>/app/server/<sid>/bau/<postId>`) or the message jump link
 * (`<origin>/app/server/<sid>/channel/<cid>/message/<mid>`). A URL on THIS
 * instance opens inside the app; anything else, and any path this build does
 * not know, goes to the browser (a Custom Tab), so a card is never a way to
 * make the app navigate to something it cannot draw.
 *
 * Pure, so the rule is pinned by a JVM test: `android.net.Uri` is a stub there.
 */
sealed interface ForwardOpen {
    /** A Baú post, opened on that server's Baú with the post brought into view. */
    data class BauPost(val serverId: String, val postId: String) : ForwardOpen

    /** A message in a channel, opened on the channel with the message in view. */
    data class Message(val serverId: String, val channelId: String, val messageId: String) : ForwardOpen

    /** Anything else: the URL as the card carries it, for the browser. */
    data class External(val url: String) : ForwardOpen
}

object ForwardLinks {

    private const val UUID =
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

    private val MESSAGE_PATH =
        Regex("^/app/server/($UUID)/channel/($UUID)/message/($UUID)/?$")

    /** The message jump link's path, relative. The twin of `forwardMessagePath`. */
    fun messagePath(serverId: String, channelId: String, messageId: String): String =
        "/app/server/$serverId/channel/$channelId/message/$messageId"

    fun resolve(forward: MessageForward, appOrigin: String? = BauShare.ownOrigin()): ForwardOpen {
        val url = forward.url.trim()
        val (origin, path) = BauShare.splitUrl(url) ?: return ForwardOpen.External(url)
        if (!BauShare.isOwnInstanceOrigin(origin, appOrigin)) return ForwardOpen.External(url)

        BauShare.parsePath(path)?.let { return ForwardOpen.BauPost(it.serverId, it.postId) }
        MESSAGE_PATH.matchEntire(path)?.let {
            return ForwardOpen.Message(
                it.groupValues[1].lowercase(),
                it.groupValues[2].lowercase(),
                it.groupValues[3].lowercase(),
            )
        }
        return ForwardOpen.External(url)
    }

    /**
     * Only `http` and `https` reach a browser. A snapshot is server-written, but
     * an `intent:` or `javascript:` URL in one would still be handed to the
     * system, so the scheme is checked at the point of opening, not trusted.
     */
    fun isBrowsable(url: String): Boolean {
        val lower = url.trim().lowercase()
        return lower.startsWith("https://") || lower.startsWith("http://")
    }
}
