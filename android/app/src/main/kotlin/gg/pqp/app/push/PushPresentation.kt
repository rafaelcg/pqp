package gg.pqp.app.push

/**
 * Which channel is on screen right now, or null when none is.
 *
 * "On screen" means both halves: a [gg.pqp.app.ui.screens.ChatScreen] is
 * composed **and** the app is at least STARTED. A ViewModel alone cannot answer
 * this, it survives the app being backgrounded, so a chat that is merely still
 * in the back stack would look open while the phone is in somebody's pocket,
 * which is precisely when a notification is wanted most. `ChatScreen` therefore
 * reports through a lifecycle-scoped effect that enters on START and leaves on
 * STOP.
 *
 * `@Volatile` because it is written from the main thread and read from
 * whichever background thread FCM chose for `onMessageReceived`.
 */
object VisibleChannel {
    @Volatile
    var id: String? = null
        private set

    fun enter(channelId: String) {
        id = channelId
    }

    /**
     * Scoped by id: two chat screens overlapping across a navigation means the
     * outgoing one's STOP can arrive after the incoming one's START, and an
     * unconditional clear there would blank the channel that is actually open.
     */
    fun leave(channelId: String) {
        if (id == channelId) id = null
    }

    /** Sign-out, and anything else that ends the session's claim on the screen. */
    fun clear() {
        id = null
    }
}

/**
 * Whether a push that has arrived deserves to be drawn on the tray.
 *
 * PURE, AND TESTED, BECAUSE THIS IS THE BUG. The web client shipped phantom
 * "1 nova mensagem" banners for channels the reader had open (#79), and the
 * shape of that mistake was not the comparison, it was the *input*: the client
 * threw away the server id the frame carried and tried to recover the context
 * by looking the channel up in a directory that only ever held one server's
 * channels. Everything downstream then reasoned from nulls.
 *
 * The defence here is the same one iOS uses in `PushPresentation.shouldInterrupt`
 * and it has two parts:
 *
 *  1. **The frame is self-describing.** The channel id comes from the push's own
 *     `path` (or its `tag`), parsed with no reference to app state. A push about
 *     a server this app has never opened resolves exactly as well as one about
 *     the server on screen.
 *  2. **The comparison is against what is genuinely visible**, which requires
 *     the app to be foregrounded as well as parked on that channel.
 *
 * WHAT IS DELIBERATELY NOT HERE: any opinion about whether the push should have
 * been *sent*. Mute, notification level and do-not-disturb are decided
 * server-side at send time, in `shouldPush`, for the good reason that the client
 * which would normally suppress an interruption is by definition not running.
 * Re-deciding any of it here would only produce a second opinion that disagrees
 * with the first, which is how a muted server keeps buzzing one client and not
 * another. The one decision this file makes is narrower and genuinely local:
 * is the person already looking at the thing being announced.
 */
object PushPresentation {

    /**
     * @param message the push as it arrived
     * @param visibleChannelId [VisibleChannel.id]
     * @param appInForeground whether any of this app's activities is started
     */
    fun shouldNotify(
        message: PushMessage,
        visibleChannelId: String?,
        appInForeground: Boolean,
    ): Boolean {
        // Backgrounded: nothing is being read, so nothing is redundant. The
        // visible-channel value is not even consulted, because a stale one is
        // exactly the way this check turns into the bug it exists to prevent.
        if (!appInForeground) return true

        val visible = visibleChannelId ?: return true
        val about = message.channelId ?: return true

        // A push with no channel in it (an invite, a malformed path) always
        // draws: there is no conversation it could be redundant with.
        return about != visible
    }
}
