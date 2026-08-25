package gg.pqp.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import gg.pqp.app.MainActivity
import gg.pqp.app.R

/**
 * Draws a push on the tray, and makes tapping it land somewhere.
 *
 * Nothing here decides *whether* to draw; [PushPresentation] does, and the
 * server decided long before that. This is the last mile only.
 */
class PushNotifier(private val context: Context) {

    fun ensureChannel() {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_MESSAGES) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_MESSAGES,
                context.getString(R.string.push_channel_messages),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.push_channel_messages_description)
                setShowBadge(true)
            },
        )
    }

    /**
     * `MissingPermission` is suppressed because the check lint is looking for
     * is [canPost], on the line below: `areNotificationsEnabled()` is the
     * correct question here (it covers a channel the user switched off, and
     * every API level, not only 33 and up) but lint only recognises
     * `checkSelfPermission`. The runtime check is real; the annotation only
     * keeps `lintRelease` from failing the build over the spelling of it.
     */
    @android.annotation.SuppressLint("MissingPermission")
    fun show(message: PushMessage) {
        // Checked rather than assumed, and checked here rather than trusted
        // from the moment the switch was flipped: POST_NOTIFICATIONS can be
        // revoked in Android settings at any time, and a push may arrive
        // seconds later. Also what stops `lintRelease` failing the build on
        // MissingPermission.
        if (!canPost()) return

        ensureChannel()

        val title = message.title ?: context.getString(R.string.app_name)
        val body = message.body ?: context.getString(R.string.push_fallback_body)

        val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openIntent(message))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        // Belt and braces over the check above: notify() throws on some OEM
        // builds rather than no-opping, and there is nothing to tell the user
        // about a notification they have already refused.
        runCatching {
            NotificationManagerCompat.from(context).notify(
                trayTag(message),
                NOTIFICATION_ID,
                notification,
            )
        }
    }

    /**
     * Whether this app is allowed to draw a notification at all.
     *
     * POST_NOTIFICATIONS is a runtime permission only from Android 13 (API 33);
     * below that it does not exist and notifications are allowed, which is what
     * `NotificationManagerCompat` folds into one answer here.
     */
    private fun canPost(): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** Everything this app posted, dismissed on sign-out. */
    fun clearAll() {
        runCatching { NotificationManagerCompat.from(context).cancelAll() }
    }

    /**
     * One live notification per conversation, replaced rather than stacked.
     *
     * The same collapsing the other two clients get for free: `tag` on the web
     * payload, `apns-collapse-id` plus `thread-id` on iOS. Android spells it as
     * the (tag, id) pair, so the id is constant and the tag carries the
     * identity. A push with no channel gets its own slot rather than
     * overwriting a conversation's.
     */
    private fun trayTag(message: PushMessage): String =
        message.channelId ?: TAG_UNROUTED

    /**
     * The tap.
     *
     * `path` travels as an extra rather than being resolved here, because
     * resolving it needs a NavController that does not exist until the activity
     * is composed, and because a cold start has to be able to route a tap that
     * happened before the process existed.
     *
     * The request code is derived from the tag so that two conversations get two
     * distinct PendingIntents. With one shared request code, FLAG_UPDATE_CURRENT
     * would rewrite the extras of every outstanding notification to the newest
     * one's, and every tap would open the same channel.
     */
    private fun openIntent(message: PushMessage): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_PATH, message.path)
            .putExtra(EXTRA_TAG, message.tag)

        return PendingIntent.getActivity(
            context,
            trayTag(message).hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    companion object {
        /**
         * NOTIFICATION CHANNEL IDS ARE A SHARED SURFACE, so this one is
         * namespaced and says what it carries. `voice` (owned by
         * `VoiceService`, and the ongoing `category=call` notification that
         * keeps a call alive) is the other id in this app; the two must never
         * converge, because they want opposite settings, a call notification
         * is silent, low importance and ongoing, a message notification is
         * none of those. A ringing-call push, when one is wired up, wants a
         * third id of its own rather than either of these.
         */
        const val CHANNEL_MESSAGES = "pqp.messages"

        /** Distinct from VoiceService's 1; the tag carries the real identity. */
        private const val NOTIFICATION_ID = 2

        private const val TAG_UNROUTED = "pqp.unrouted"

        const val EXTRA_PATH = "gg.pqp.app.push.PATH"
        const val EXTRA_TAG = "gg.pqp.app.push.TAG"
    }
}
