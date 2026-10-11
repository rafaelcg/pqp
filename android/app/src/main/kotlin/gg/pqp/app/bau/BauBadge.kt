package gg.pqp.app.bau

/**
 * What the lime Baú badge says.
 *
 * A new Baú post used to be a quiet grey number on the Baú row and nothing at
 * all on the server list, which made the feature the product leads with look
 * like the least eventful thing on the screen. It is lime now, the brand
 * signal, on the row and on the server's icon in the list, and capped at
 * "9+" on an icon (the web rail does the same): a small badge has no room for
 * a third digit.
 *
 * Nothing here knows about mentions. Neither list this app draws a server in
 * carries a mention count, so there is no corner to share and no ring variant.
 */
object BauBadge {
    /** The icon badge stops counting here. */
    const val CAP = 9

    /** The text on the badge, or null when there is nothing to show. */
    fun label(count: Int): String? = when {
        count <= 0 -> null
        count > CAP -> "$CAP+"
        else -> count.toString()
    }

    /** One server's unread count out of the aggregate read; 0 when absent. */
    fun unreadFor(serverId: String, unread: Map<String, Int>): Int =
        (unread[serverId] ?: 0).coerceAtLeast(0)
}
