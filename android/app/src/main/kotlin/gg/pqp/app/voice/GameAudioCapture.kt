package gg.pqp.app.voice

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Process
import android.util.Log
import androidx.annotation.RequiresApi
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors

/** Whether this device can carry a game's sound in a screen share at all. */
fun gameAudioSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

/**
 * The sound the phone is playing, captured through the screen share's own
 * `MediaProjection` and added into the microphone's buffers.
 *
 * See [PcmRing] for why it rides the microphone and how the two clocks are
 * reconciled. This class is only the Android half: the recorder, and the
 * conversion between the recorder callback's `ByteBuffer` and the samples
 * [mixPcm16] works on.
 *
 * What is captured is decided by the OTHER app, not by us. From Android 10 an
 * app's `USAGE_MEDIA`, `USAGE_GAME` and `USAGE_UNKNOWN` playback is capturable
 * unless it opts out (`allowAudioPlaybackCapture="false"`, or a capture policy
 * set in code). A game that opts out arrives silent, and nothing on this side
 * can tell a silent game from an opted-out one. Voice calls
 * (`USAGE_VOICE_COMMUNICATION`, which is what this app's own call plays as)
 * are never capturable, so the room does not hear itself back.
 *
 * ### Threads
 *
 * [process] runs on the microphone thread every 10 ms and must never wait on
 * anything slow. The recorder is built from the first buffer's own format
 * (the only reliable statement of what the microphone produces), but on
 * [setup], a thread of its own: building and starting an `AudioRecord` can take
 * longer than a buffer, and doing it inline would put a gap in the presenter's
 * voice. Until it is live, buffers pass through with only the mute applied.
 *
 * [onStatus] is told `true` once the recorder runs and `false` once it has
 * failed for good, so the call bar never claims a sound that is not going out.
 * It is called from the setup thread or the microphone thread; the receiver
 * posts it wherever it needs to go.
 */
class GameAudioCapture(
    private val projection: MediaProjection,
    private val onStatus: (live: Boolean) -> Unit = {},
) {
    private val lock = Any()
    private val setup = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "pqp-game-audio-setup")
    }

    // Everything below is guarded by [lock].
    private var record: AudioRecord? = null
    private var ring: PcmRing? = null
    /** The format [record] was built for, or is being built for. */
    private var wantedFormat: Pair<Int, Int>? = null
    private var released = false
    private var scratch = ShortArray(0)
    private var mic = ShortArray(0)
    private var game = ShortArray(0)

    /**
     * False once capture can no longer produce anything this share: the
     * platform refused the recorder, or the recorder died. The engines read
     * it to decide whether the microphone track still has a reason to stay on
     * while the person is muted.
     */
    @Volatile var usable: Boolean = true
        private set

    /**
     * The recorder is running and its sound is going into the call. Separate
     * from [usable]: between attach and the first recorder starting the capture
     * is usable (the track may stay on for it) but nothing is live yet, and
     * the call bar must not say "com o som" in that window.
     */
    @Volatile var live: Boolean = false
        private set

    /**
     * Mix whatever game audio is waiting into one microphone buffer, in place.
     *
     * [micOn] false zeroes the microphone half (see [mixPcm16]); that holds
     * even when there is no game audio to add, because the caller keeps the
     * track enabled for as long as this object is attached and usable.
     */
    fun process(
        buffer: ByteBuffer,
        audioFormat: Int,
        channelCount: Int,
        sampleRate: Int,
        bytesRead: Int,
        micOn: Boolean,
    ) {
        if (bytesRead <= 0) return
        if (audioFormat != AudioFormat.ENCODING_PCM_16BIT || !usable) {
            // A format we did not expect (never seen from either build, which
            // record 16-bit) or a capture that has died. Mixing would be
            // noise; the mute still holds.
            if (!micOn) zero(buffer, bytesRead)
            return
        }
        val count = bytesRead / 2
        synchronized(lock) {
            if (released) {
                if (!micOn) zero(buffer, bytesRead)
                return
            }
            requestRecord(sampleRate, channelCount)
            val gameCount = drainInto(count)

            val shorts = buffer.duplicate().apply { position(0) }
                .order(ByteOrder.nativeOrder())
                .asShortBuffer()
            if (mic.size < count) mic = ShortArray(count)
            shorts.get(mic, 0, count)
            mixPcm16(mic, count, game, gameCount, micOn)
            shorts.position(0)
            shorts.put(mic, 0, count)
        }
    }

    /** Stop and hand the recorder back. Safe to call more than once. */
    fun release() {
        val old = synchronized(lock) {
            released = true
            live = false
            ring?.clear()
            record.also { record = null }
        }
        // Stopping a recorder can block; it goes on the setup thread, which
        // also means a build still in flight finishes (and is released by the
        // `released` check) before this runs.
        runCatching {
            setup.execute {
                old?.let(::dispose)
            }
        }.onFailure { old?.let(::dispose) }
        setup.shutdown()
    }

    /**
     * Ask for a recorder in this format, once per format. Caller holds [lock].
     *
     * A format change (a route change can do it) rebuilds rather than mixing
     * samples at the wrong rate; the old recorder keeps feeding nothing in the
     * meantime because [drainInto] only reads a recorder of the wanted format.
     */
    private fun requestRecord(sampleRate: Int, channelCount: Int) {
        val format = sampleRate to channelCount
        if (wantedFormat == format) return
        wantedFormat = format
        val stale = record
        record = null
        ring = null
        runCatching {
            setup.execute { build(format, stale) }
        }.onFailure { stale?.let(::dispose) }
    }

    /** On [setup]. Builds the recorder and publishes it under [lock]. */
    private fun build(format: Pair<Int, Int>, stale: AudioRecord?) {
        stale?.let(::dispose)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // The engines never attach one below 10; this is the guard.
            fail("playback capture needs Android 10")
            return
        }
        val built = createRecord(format.first, format.second)
        if (built == null) {
            // Only the build for the format still wanted decides the outcome.
            // A superseded one failing (the route moved on while it built)
            // must not disable the newer build queued behind it.
            val current = synchronized(lock) { !released && wantedFormat == format }
            if (current) fail("the platform refused the playback capture recorder")
            return
        }
        val published = synchronized(lock) {
            if (released || wantedFormat != format) {
                false
            } else {
                record = built
                ring = PcmRing(gameAudioRingCapacity(format.first, format.second))
                // 20 ms per read: two microphone buffers' worth.
                scratch = ShortArray(maxOf(2, format.first / 50 * maxOf(1, format.second)))
                true
            }
        }
        if (!published) {
            // Released, or the format moved again while this was building.
            dispose(built)
            return
        }
        Log.i(TAG, "game audio capture started at ${format.first}Hz x${format.second}")
        live = true
        onStatus(true)
    }

    /** Pull everything the recorder has into the ring, then take [count] out. */
    private fun drainInto(count: Int): Int {
        val recorder = record ?: return 0
        val queue = ring ?: return 0
        // Bounded: a recorder that kept answering would otherwise hold the
        // microphone thread. Four reads of 20 ms is more than one 10 ms
        // buffer can ever be owed.
        for (attempt in 0 until 4) {
            val read = recorder.read(scratch, 0, scratch.size, AudioRecord.READ_NON_BLOCKING)
            if (read < 0) {
                // ERROR_DEAD_OBJECT and friends: this recorder will never
                // produce again. Hand it back and say so, rather than reading
                // a corpse every 10 ms for the rest of the share.
                Log.w(TAG, "game audio capture died: read returned $read")
                record = null
                ring = null
                runCatching { setup.execute { dispose(recorder) } }
                markFailed()
                return 0
            }
            if (read == 0) break
            queue.write(scratch, read)
            // A short read means the recorder is empty for now.
            if (read < scratch.size) break
        }
        if (game.size < count) game = ShortArray(count)
        return queue.read(game, count)
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @SuppressLint("MissingPermission") // RECORD_AUDIO is held for the call itself.
    private fun createRecord(sampleRate: Int, channelCount: Int): AudioRecord? {
        val channelMask = if (channelCount == 2) {
            AudioFormat.CHANNEL_IN_STEREO
        } else {
            AudioFormat.CHANNEL_IN_MONO
        }
        var candidate: AudioRecord? = null
        return runCatching {
            val config = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                // This app's own media (a watch party playing in it) is not
                // the presenter's game and would be heard twice.
                .excludeUid(Process.myUid())
                .build()
            val minimum = AudioRecord.getMinBufferSize(
                sampleRate,
                channelMask,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            val ringSamples = gameAudioRingCapacity(sampleRate, channelCount)
            val recorder = AudioRecord.Builder()
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .build(),
                )
                .setBufferSizeInBytes(maxOf(minimum, ringSamples * 2))
                .setAudioPlaybackCaptureConfig(config)
                .build()
            candidate = recorder
            check(recorder.state == AudioRecord.STATE_INITIALIZED) {
                "playback capture recorder did not initialise"
            }
            recorder.startRecording()
            check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                "playback capture recorder did not start"
            }
            recorder
        }.getOrElse { error ->
            Log.w(TAG, "game audio capture unavailable: ${error.message}")
            // Built but not started is still native audio resources held.
            candidate?.let(::dispose)
            null
        }
    }

    /**
     * One attempt per share. A recorder that refused once will refuse every
     * time, and the share is worth more silent than retrying in a loop.
     */
    private fun fail(reason: String) {
        Log.w(TAG, "game audio off for this share: $reason")
        markFailed()
    }

    private fun markFailed() {
        if (!usable) return
        usable = false
        live = false
        onStatus(false)
    }

    private fun dispose(recorder: AudioRecord) {
        runCatching { recorder.stop() }
        runCatching { recorder.release() }
    }

    private fun zero(buffer: ByteBuffer, bytes: Int) {
        val view = buffer.duplicate().apply { position(0) }
        for (i in 0 until minOf(bytes, view.capacity())) view.put(i, 0)
    }

    private companion object {
        const val TAG = "GameAudioCapture"
    }
}
