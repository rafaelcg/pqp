package gg.pqp.app.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import gg.pqp.app.MainActivity
import gg.pqp.app.PqpApplication
import gg.pqp.app.R

/**
 * The notification that keeps a call alive.
 *
 * This is not decoration. Android stops an app's threads shortly after it is
 * backgrounded, and the only sanctioned way to say "keep running, the user
 * knows" is a foreground service with a visible notification. Without one a
 * call dies the moment somebody switches apps, which on a phone is most of the
 * time somebody is in one.
 *
 * The service holds no call state. [VoiceController] owns the mesh and lives on
 * the Application, so a service restart cannot desynchronise the two.
 */
class VoiceService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_HANG_UP) {
            (application as PqpApplication).voice.leave()
            return START_NOT_STICKY
        }

        ensureChannel()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                0
            },
        )

        // Not sticky: a call that the system killed and restarted without its
        // signalling socket is a notification with nothing behind it. Rejoining
        // is the person's decision.
        return START_NOT_STICKY
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val hangUp = PendingIntent.getService(
            this,
            1,
            Intent(this, VoiceService::class.java).setAction(ACTION_HANG_UP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val channelName = (application as PqpApplication).voice.state.value.channelName

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.voice_notification_title))
            .setContentText(channelName)
            .setContentIntent(open)
            .addAction(0, getString(R.string.voice_notification_hang_up), hangUp)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.voice_notification_channel),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.voice_notification_channel_description)
                setShowBadge(false)
            },
        )
    }

    companion object {
        private const val CHANNEL_ID = "voice"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_HANG_UP = "gg.pqp.app.HANG_UP"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, VoiceService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VoiceService::class.java))
        }
    }
}
