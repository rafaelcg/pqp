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
 *
 * It does own one piece of *ordering*, though, and that is deliberate. From
 * Android 14 a `MediaProjection` may only be created once a foreground service
 * of type `mediaProjection` is already running, and `startForegroundService`
 * is asynchronous: a caller that starts the service and then immediately builds
 * the projection loses that race and gets a `SecurityException` from inside the
 * capturer, where it reads like a capture failure. So the consent grant travels
 * *into* the service and the capture starts from [onStartCommand], after
 * `startForeground` has returned. There is no way to lose that race.
 */
class VoiceService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val voice = (application as PqpApplication).voice

        if (intent?.action == ACTION_HANG_UP) {
            voice.leave()
            return START_NOT_STICKY
        }

        when (intent?.action) {
            ACTION_START_PROJECTION -> projecting = true
            ACTION_STOP_PROJECTION -> projecting = false
        }

        ensureChannel()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            foregroundTypes(),
        )

        if (intent?.action == ACTION_START_PROJECTION) {
            val permission = intentExtra(intent)
            if (permission == null) {
                projecting = false
            } else {
                // Safe here and nowhere earlier: this service is foreground with
                // the `mediaProjection` type as of the call above.
                voice.beginScreenCapture(permission)
            }
        }

        // Not sticky: a call that the system killed and restarted without its
        // signalling socket is a notification with nothing behind it. Rejoining
        // is the person's decision.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        projecting = false
        super.onDestroy()
    }

    private fun foregroundTypes(): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return 0
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (projecting) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        }
        return types
    }

    @Suppress("DEPRECATION")
    private fun intentExtra(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(EXTRA_PROJECTION_PERMISSION, Intent::class.java)
        } else {
            intent.getParcelableExtra(EXTRA_PROJECTION_PERMISSION)
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

        // Screen capture is stated in the notification as well as in the
        // system's own cast indicator. One of them is the platform telling
        // people what is happening to their device; the other is us admitting
        // it, which is the one that names the app doing it.
        val text = if (projecting) {
            getString(R.string.voice_notification_sharing)
        } else {
            channelName
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.voice_notification_title))
            .setContentText(text)
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
        private const val ACTION_START_PROJECTION = "gg.pqp.app.START_PROJECTION"
        private const val ACTION_STOP_PROJECTION = "gg.pqp.app.STOP_PROJECTION"
        private const val EXTRA_PROJECTION_PERMISSION = "gg.pqp.app.PROJECTION_PERMISSION"

        /**
         * Whether the running service currently declares `mediaProjection`.
         *
         * Static because it describes the *process's* foreground state, which
         * outlives any one `onStartCommand` and has to be re-declared on every
         * `startForeground` call: passing a smaller type set is how the type is
         * dropped again, and forgetting it would leave the app claiming a
         * projection it no longer holds.
         */
        @Volatile private var projecting = false

        fun start(context: Context) {
            context.startForegroundService(Intent(context, VoiceService::class.java))
        }

        /**
         * Take the consent grant into the service and start capturing there.
         *
         * The Intent is the one the system consent dialog returned. It is
         * single use: from Android 15 a fresh grant is required per capture
         * session, so it is passed through rather than stored.
         */
        fun startProjection(context: Context, permission: Intent) {
            context.startForegroundService(
                Intent(context, VoiceService::class.java)
                    .setAction(ACTION_START_PROJECTION)
                    .putExtra(EXTRA_PROJECTION_PERMISSION, permission),
            )
        }

        /** Drop the `mediaProjection` type, keeping the call and its microphone. */
        fun dropProjection(context: Context) {
            if (!projecting) return
            context.startForegroundService(
                Intent(context, VoiceService::class.java).setAction(ACTION_STOP_PROJECTION),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VoiceService::class.java))
        }
    }
}
