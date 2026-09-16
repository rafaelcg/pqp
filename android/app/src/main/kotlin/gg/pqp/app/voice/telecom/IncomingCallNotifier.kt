package gg.pqp.app.voice.telecom

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import gg.pqp.app.MainActivity
import gg.pqp.app.R

/**
 * The system-style incoming-call notification: a `CallStyle` full-screen
 * card with Answer and Decline, drawn from [PqpConnection.onShowIncomingCallUi] —
 * Telecom's own request that this app show *its* incoming-call UI, which is
 * how a self-managed `ConnectionService` gets a lock-screen presence at all.
 *
 * This is in addition to, not instead of, the in-app `IncomingCallBanner`:
 * that banner is what's on screen the moment the app is foregrounded by this
 * notification's tap or full-screen intent, and it is also what a device with
 * no Telecom (or a refused registration) falls back to entirely.
 *
 * Answer and Decline do not call into `android.telecom` at all. They call the
 * same [gg.pqp.app.voice.CallController] methods the in-app banner's own
 * buttons call, through [CallActionReceiver], and `TelecomController` is what
 * keeps the Telecom connection in sync with whatever `CallController` decides
 * — one path for both surfaces, so they cannot disagree.
 */
object IncomingCallNotifier {

    private const val CHANNEL_ID = "calls"

    fun show(context: Context, roomId: String, displayName: String) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        ensureChannel(context)

        val fullScreen = PendingIntent.getActivity(
            context,
            notificationId(roomId),
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val answer = PendingIntent.getBroadcast(
            context,
            notificationId(roomId) * 2,
            CallActionReceiver.intent(context, CallActionReceiver.ACTION_ANSWER, roomId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val decline = PendingIntent.getBroadcast(
            context,
            notificationId(roomId) * 2 + 1,
            CallActionReceiver.intent(context, CallActionReceiver.ACTION_DECLINE, roomId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val person = Person.Builder().setName(displayName).build()
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentText(displayName)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
            .addPerson(person)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setFullScreenIntent(fullScreen, true)
            .setContentIntent(fullScreen)
            .setOngoing(true)
            .setAutoCancel(false)
            .build()

        runCatching { NotificationManagerCompat.from(context).notify(notificationId(roomId), notification) }
    }

    fun cancel(context: Context, roomId: String) {
        runCatching { NotificationManagerCompat.from(context).cancel(notificationId(roomId)) }
    }

    private fun notificationId(roomId: String): Int = roomId.hashCode()

    private fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.telecom_channel_calls),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.telecom_channel_calls_description)
                setShowBadge(false)
                enableVibration(true)
            },
        )
    }
}
