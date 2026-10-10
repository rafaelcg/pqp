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
 * [process] runs on the microphone thread every 10 ms and [release] on the main
 * thread, so both take [lock]. The recorder is built lazily from the first
 * buffer's own format, because that is the only reliable statement of what the
 * microphone is producing (sample rate and channel count differ by device).
 */
class GameAudioCapture(private val projection: MediaProjection) {
    private val lock = Any()
    private var record: AudioRecord? = null
    private var ring: PcmRing? = null
    private var recordFormat: Pair<Int, Int>? = null
    private var failed = false
    private var released = false

    private var scratch = ShortArray(0)
    private var mic = ShortArray(0)
    private var game = ShortArray(0)

    /**
     * Mix whatever game audio is waiting into one microphone buffer, in place.
     *
     * [micOn] false zeroes the microphone half (see [mixPcm16]); that holds
     * even when there is no game audio to add, because the caller keeps the
     * track enabled for as long as this object is attached.
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
        if (audioFormat != AudioFormat.ENCODING_PCM_16BIT) {
            // Never seen from either build, which record 16-bit. Mixing a
            // format we did not expect would be noise; the mute still holds.
            if (!micOn) zero(buffer, bytesRead)
            return
        }
        val count = bytesRead / 2
        synchronized(lock) {
            if (released) {
                if (!micOn) zero(buffer, bytesRead)
                return
            }
            ensureRecord(sampleRate, channelCount)
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
        synchronized(lock) {
            released = true
            record?.let { recorder ->
                runCatching { recorder.stop() }
                runCatching { recorder.release() }
            }
            record = null
            ring?.clear()
        }
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
            if (read <= 0) break
            queue.write(scratch, read)
            // A short read means the recorder is empty for now.
            if (read < scratch.size) break
        }
        if (game.size < count) game = ShortArray(count)
        return queue.read(game, count)
    }

    private fun ensureRecord(sampleRate: Int, channelCount: Int) {
        if (failed) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // The engines never attach one below 10; this is the guard.
            failed = true
            return
        }
        buildRecord(sampleRate, channelCount)
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @SuppressLint("MissingPermission") // RECORD_AUDIO is held for the call itself.
    private fun buildRecord(sampleRate: Int, channelCount: Int) {
        val format = sampleRate to channelCount
        if (record != null && recordFormat == format) return
        // The microphone changed format under us (a route change can do it).
        // Rebuild rather than mix samples at the wrong rate.
        record?.let { old ->
            runCatching { old.stop() }
            runCatching { old.release() }
        }
        record = null

        val channelMask = if (channelCount == 2) {
            AudioFormat.CHANNEL_IN_STEREO
        } else {
            AudioFormat.CHANNEL_IN_MONO
        }
        val built = runCatching {
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
            AudioRecord.Builder()
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
                .also { recorder ->
                    check(recorder.state == AudioRecord.STATE_INITIALIZED) {
                        "playback capture recorder did not initialise"
                    }
                    recorder.startRecording()
                }
        }.getOrElse { error ->
            // One attempt per share. A recorder that refused once will refuse
            // every 10 ms, and the share is worth more silent than spamming.
            Log.w(TAG, "game audio capture unavailable: ${error.message}")
            failed = true
            return
        }

        record = built
        recordFormat = format
        ring = PcmRing(gameAudioRingCapacity(sampleRate, channelCount))
        // 20 ms per read: two microphone buffers' worth.
        scratch = ShortArray(maxOf(2, sampleRate / 50 * maxOf(1, channelCount)))
        Log.i(TAG, "game audio capture started at ${sampleRate}Hz x$channelCount")
    }

    private fun zero(buffer: ByteBuffer, bytes: Int) {
        val view = buffer.duplicate().apply { position(0) }
        for (i in 0 until minOf(bytes, view.capacity())) view.put(i, 0)
    }

    private companion object {
        const val TAG = "GameAudioCapture"
    }
}
