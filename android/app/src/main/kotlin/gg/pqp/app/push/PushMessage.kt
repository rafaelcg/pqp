package gg.pqp.app.push

/**
 * One push, as it comes off the wire.
 *
 * The four keys are the ones `buildPushPayload` produces server-side and the
 * ones `buildApnsBody` already carries to iOS under exactly these names. They
 * are read as named constants rather than poked at with string literals so a
 * server-side rename is one edit here, the same arrangement as
 * `PushPayloadKeys` in `ios/pqp/Sources/Core/PushNotifications.swift`.
 *
 * WHY THE PAYLOAD MUST BE DATA-ONLY. FCM has two shapes: a `notification`
 * message, which Android's own SDK draws on the tray without waking the app,
 * and a `data` message, which is handed to [PqpMessagingService] to do
 * something with. Only the second lets this client decide *not* to draw one,
 * and deciding not to is a requirement: a notification for the channel already
 * open on screen is the "1 nova mensagem with nothing to look at" bug in
 * another costume. The FCM leg on the server must therefore send `data` and
 * never `notification`.
 *
 * The price, stated plainly: a data message is not delivered to an app the user
 * has force-stopped, and some OEM battery managers delay it. A `notification`
 * message would survive both. That trade is taken deliberately, because the
 * failure it buys (a late notification) is smaller than the one it avoids (a
 * notification that is simply wrong).
 *
 * NO MESSAGE TEXT IS EVER IN HERE. The server builds the payload from ids and
 * display names only; the fan-out it rides on does not carry message content.
 */
data class PushMessage(
    val title: String?,
    val body: String?,
    /** The web-client route, and the only routing input. */
    val path: String?,
    /**
     * The conversation id, which is also the collapse key. Not the routing
     * input, but the fallback identity when a path is missing or unparseable,
     * and what makes one live notification per channel instead of a stack.
     */
    val tag: String?,
) {
    val target: DeepLinkTarget? get() = DeepLink.target(path)

    /**
     * The channel this push is about.
     *
     * `path` first because it is the authority, `tag` second because the server
     * sets it to the same channel id and a payload whose path failed to parse
     * can still be recognised as "the thing already on screen".
     */
    val channelId: String? get() = target?.channelId ?: tag?.takeIf { it.isNotBlank() }

    companion object {
        const val KEY_TITLE = "title"
        const val KEY_BODY = "body"
        const val KEY_PATH = "path"
        const val KEY_TAG = "tag"

        /**
         * Reads the frame out of an FCM `data` map.
         *
         * Returns null for a frame with neither a body nor a path, which is not
         * a push this app can render or route and is more likely a probe than a
         * message.
         */
        fun from(data: Map<String, String>): PushMessage? {
            val message = PushMessage(
                title = data[KEY_TITLE]?.takeIf { it.isNotBlank() },
                body = data[KEY_BODY]?.takeIf { it.isNotBlank() },
                path = data[KEY_PATH]?.takeIf { it.isNotBlank() },
                tag = data[KEY_TAG]?.takeIf { it.isNotBlank() },
            )
            if (message.body == null && message.path == null) return null
            return message
        }
    }
}
