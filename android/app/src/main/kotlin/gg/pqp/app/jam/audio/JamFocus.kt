package gg.pqp.app.jam.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper

/**
 * WHO OWNS THE SPEAKER, and what a song does about it.
 *
 * This app is a voice client first. A call holds audio focus as
 * `USAGE_VOICE_COMMUNICATION` (`VoiceController.acquireAudioFocus`) and the
 * microphone and the speaker are in the middle of a conversation. The voice
 * notes player already has the rule (`VoiceNotes`: never request focus while a
 * call is live, and stop for one that connects under it), `VideoPlayerDialog`
 * lets ExoPlayer handle focus so a clip pauses for a ring, and a jam follows
 * the same rule:
 *
 *  - A song does not START while a call is live, and one that is playing when a
 *    call connects is PAUSED (not stopped: the person may come back to it).
 *  - Otherwise it asks for focus as `USAGE_MEDIA` / `CONTENT_TYPE_MUSIC`, a
 *    permanent gain (a band mix is not a three second blip, and music that was
 *    playing should not resume under it).
 *  - Loss: pause, give focus back. Transient loss (a navigation prompt, a
 *    ringing phone): pause and resume on gain, unless a call is live by then.
 *    "May duck": drop the level instead of pausing, and put it back.
 *  - Headphones pulled out (`ACTION_AUDIO_BECOMING_NOISY`): pause, because a
 *    song that jumps to the loudspeaker is not what anybody asked for.
 *
 * The decisions are [JamFocusPolicy], pure and tested (`JamFocusPolicyTest`);
 * [JamAudioFocus] only carries them to the platform.
 */
object JamFocusPolicy {
    enum class Change { Gain, Loss, LossTransient, LossTransientCanDuck }

    enum class Action {
        None,

        /** Pause, and keep focus out of it. */
        Pause,

        /** Pause and remember to resume when focus comes back. */
        PauseUntilGain,
        Resume,
        Duck,
        Unduck,
    }

    /** May a song start (or resume by the person's own tap) right now. */
    fun mayStart(callActive: Boolean): Boolean = !callActive

    data class Decision(val action: Action, val resumeOnGain: Boolean)

    fun onChange(change: Change, playing: Boolean, resumeOnGain: Boolean, callActive: Boolean): Decision =
        when (change) {
            Change.Loss -> Decision(Action.Pause, false)
            Change.LossTransient ->
                if (playing) Decision(Action.PauseUntilGain, true) else Decision(Action.None, resumeOnGain)
            Change.LossTransientCanDuck -> Decision(if (playing) Action.Duck else Action.None, resumeOnGain)
            Change.Gain ->
                if (resumeOnGain && !callActive) {
                    Decision(Action.Resume, false)
                } else {
                    Decision(Action.Unduck, false)
                }
        }

    /** A call connected under a playing song. */
    fun onCallActive(playing: Boolean): Action = if (playing) Action.Pause else Action.None

    /** The output went away from under the song (headphones out, Bluetooth off). */
    fun onBecomingNoisy(playing: Boolean): Action = if (playing) Action.Pause else Action.None

    /** The level a ducked song plays at. */
    const val DUCKED_LEVEL = 0.25f
}

/** The platform half: one focus request, and the unplug broadcast, reported through [onChange]. */
class JamAudioFocus(
    context: Context,
    private val onChange: (JamFocusPolicy.Change) -> Unit,
    private val onBecomingNoisy: () -> Unit,
) {
    private val appContext = context.applicationContext
    private val manager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())
    private var request: AudioFocusRequest? = null
    private var noisyReceiver: android.content.BroadcastReceiver? = null

    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        onChange(
            when (change) {
                AudioManager.AUDIOFOCUS_GAIN -> JamFocusPolicy.Change.Gain
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> JamFocusPolicy.Change.LossTransient
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> JamFocusPolicy.Change.LossTransientCanDuck
                else -> JamFocusPolicy.Change.Loss
            },
        )
    }

    /** Asks for focus and starts listening for an unplug. False when the platform said no. */
    fun acquire(): Boolean {
        if (request != null) return true
        val built = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            // Ducking is ours to do (the mixer's master level), not the platform's.
            .setWillPauseWhenDucked(false)
            .setOnAudioFocusChangeListener(listener, main)
            .build()
        val granted = manager.requestAudioFocus(built) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (!granted) return false
        request = built
        if (noisyReceiver == null) {
            val receiver = object : android.content.BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: android.content.Intent?) {
                    if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) onBecomingNoisy()
                }
            }
            noisyReceiver = receiver
            appContext.registerReceiver(receiver, android.content.IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
        }
        return true
    }

    fun release() {
        request?.let { manager.abandonAudioFocusRequest(it) }
        request = null
        noisyReceiver?.let { runCatching { appContext.unregisterReceiver(it) } }
        noisyReceiver = null
    }
}
