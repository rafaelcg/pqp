package gg.pqp.app.jam.record

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import gg.pqp.app.jam.audio.JamAudioFocus
import gg.pqp.app.jam.audio.JamFocusPolicy
import gg.pqp.app.jam.audio.MIX_RATE
import java.io.File

/*
 * The studio's hardware seams. Each is a few lines of interface the view model
 * is written against and a platform class that carries it out, so the whole
 * state machine (call in the way, microphone denied, route changed, focus lost,
 * process killed between "parar" and "mandar") runs on the JVM against fakes
 * (`JamStudioViewModelTest`) and only the parts that need a phone are left for
 * a phone.
 */

/** The two streams. [JamDuplex] is the real one. */
interface Duplex {
    fun start(source: OutputSource, capture: File, limitFrames: Long, outputEnds: Long = 0L): DuplexFailure?
    fun stop(): DuplexResult
    fun cancel(capture: File)
    val level: Float
    val captured: Long
    fun livePeaks(): LivePeaks
    fun presentedOutputFrame(): Long?
    fun currentRoute(): JamRoute?
}

/** Which devices the system would use, before anything plays, and a way to hear that they changed. */
interface JamRouteProbe {
    fun preview(): JamRoute

    /** Calls [onChange] (main thread) when a device is plugged in or out. The returned function stops listening. */
    fun watch(onChange: () -> Unit): () -> Unit
}

class AudioRouteProbe(context: Context) : JamRouteProbe {
    private val audio = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    override fun preview(): JamRoute {
        val outputs = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).mapNotNull { JamRoutes.device(it) }
        val inputs = audio.getDevices(AudioManager.GET_DEVICES_INPUTS).mapNotNull { JamRoutes.device(it) }
        // Android 13 can say what media would use right now; older versions get the ranking in `JamRoutes`.
        val asked = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            runCatching {
                audio.getAudioDevicesForAttributes(
                    android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build(),
                ).firstOrNull()
            }.getOrNull()
        } else {
            null
        }
        val out = JamRoutes.device(asked) ?: JamRoutes.likelyOutput(outputs)
        return JamRoute(JamRoutes.likelyInput(inputs, out), out, MIX_RATE)
    }

    override fun watch(onChange: () -> Unit): () -> Unit {
        val callback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = onChange()
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = onChange()
        }
        audio.registerAudioDeviceCallback(callback, Handler(Looper.getMainLooper()))
        return { runCatching { audio.unregisterAudioDeviceCallback(callback) } }
    }
}

/** Audio focus for the studio: one request, the system's changes and the headphones coming out reported to the model. */
interface StudioFocus {
    fun acquire(): Boolean
    fun release()
}

class AndroidStudioFocus(
    context: Context,
    onChange: (JamFocusPolicy.Change) -> Unit,
    onBecomingNoisy: () -> Unit,
) : StudioFocus {
    private val focus = JamAudioFocus(context, onChange, onBecomingNoisy)
    override fun acquire() = focus.acquire()
    override fun release() = focus.release()
}
