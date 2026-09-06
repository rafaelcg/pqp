package gg.pqp.app.voice

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

/**
 * The noise an incoming call makes while the app is open.
 *
 * The phone's own ringtone, on the ringtone stream, so the volume rocker's
 * "ring" setting and the silent switch both apply exactly as they would to a
 * phone call. Which of sound, vibration or nothing to produce is decided by
 * [ringBehaviourFor] from the ringer mode and Do Not Disturb, read at the
 * moment the ring starts; the card on screen appears regardless.
 *
 * Foreground only. A ring with the app closed needs a push that wakes the
 * process, which is the FCM server leg `docs/ANDROID.md` says does not exist.
 */
class Ringer(private val context: Context) {

    private val audioManager =
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val notifications =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private var ringtone: Ringtone? = null
    private var vibrating = false

    fun start() {
        stop()
        val behaviour = ringBehaviourFor(ringerMode(), doNotDisturb())
        if (behaviour == RingBehaviour.Silent) return

        if (behaviour == RingBehaviour.Full) {
            ringtone = runCatching {
                val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                RingtoneManager.getRingtone(context, uri)?.apply {
                    audioAttributes = AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                    // Below 28 the tone plays once and stops. Acceptable: the
                    // card is still up and the vibration keeps going.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
                    play()
                }
            }.onFailure { Log.w(TAG, "ringtone failed: ${it.message}") }.getOrNull()
        }

        runCatching {
            vibrator()?.vibrate(VibrationEffect.createWaveform(PATTERN, 0))
            vibrating = true
        }.onFailure { Log.w(TAG, "vibration failed: ${it.message}") }
    }

    fun stop() {
        runCatching { ringtone?.stop() }
        ringtone = null
        if (vibrating) {
            runCatching { vibrator()?.cancel() }
            vibrating = false
        }
    }

    private fun ringerMode(): RingerMode = when (audioManager.ringerMode) {
        AudioManager.RINGER_MODE_SILENT -> RingerMode.Silent
        AudioManager.RINGER_MODE_VIBRATE -> RingerMode.Vibrate
        else -> RingerMode.Normal
    }

    private fun doNotDisturb(): Boolean {
        val filter = notifications.currentInterruptionFilter
        return filter != NotificationManager.INTERRUPTION_FILTER_ALL &&
            filter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN
    }

    private fun vibrator(): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)
                ?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    companion object {
        private const val TAG = "pqp.call"

        /** Buzz, pause, repeat: the shape of a phone ringing, not a notification. */
        private val PATTERN = longArrayOf(0, 700, 1300)
    }
}
