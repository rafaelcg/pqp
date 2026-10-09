package gg.pqp.app.voicenotes

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import java.io.File

/**
 * A finished recording, still on disk.
 *
 * [amplitudes] is every `getMaxAmplitude` sample taken while the recorder was
 * running, in order. It is raw on purpose: turning it into 64 bars is
 * [PeakNormalizer]'s job, and keeping the samples means the one place that
 * decides what a waveform looks like is a pure function with a test.
 */
class RecordedNote(
    val file: File,
    val durationMs: Long,
    val amplitudes: IntArray,
)

/**
 * The microphone side of a voice note, behind an interface so the view model
 * that drives it can be exercised by a JVM test with no device.
 *
 * One note at a time. [start] either begins a recording or says it could not,
 * and everything after it is only meaningful between a `true` and the
 * [stop] / [cancel] that ends it.
 */
interface NoteRecorder {

    /** False when the microphone could not be opened (another app has it). */
    fun start(): Boolean

    /**
     * The loudest the input has been since the last call, 0 to 32767, and 0
     * while paused. Also what builds the waveform, so the caller samples on a
     * steady beat for as long as a recording runs.
     */
    fun sample(): Int

    fun pause()

    fun resume()

    /** Milliseconds actually recorded, excluding time spent paused. */
    fun elapsedMs(): Long

    /** Finish and keep the file. Null when there is nothing usable. */
    fun stop(): RecordedNote?

    /** Finish and delete the file. Safe when nothing is recording. */
    fun cancel()
}

/**
 * `MediaRecorder`, configured the way the contract asks for: AAC-LC in MPEG-4,
 * mono, 48 kbps at 24 kHz.
 *
 * ## Why this and not `AudioRecord`
 *
 * `MediaRecorder` hands back a finished `.m4a` that every client plays with no
 * transcode, which is the whole point of recording AAC natively. `AudioRecord`
 * would mean encoding by hand with `MediaCodec` and muxing by hand with
 * `MediaMuxer` to arrive at the same file.
 *
 * ## Why `MIC` and not `VOICE_COMMUNICATION`
 *
 * `VOICE_COMMUNICATION` switches the audio stack into its call routing and
 * echo-cancels against whatever is playing, which is exactly the thing this
 * feature must not do to a call. The caller refuses to record during a call
 * before this class is ever reached; using the plain `MIC` source is the
 * second wall, so that nothing this class does can change how a call sounds.
 *
 * ## Time
 *
 * Duration is measured on the monotonic clock around `start` / `pause` /
 * `resume`, not read back from the file. The card shows `durationMs` and the
 * server cross-checks it against the container, so the two should agree to
 * within an AAC frame, and a clock that the recording itself cannot disagree
 * with is the one thing a progress readout can be built on while recording.
 */
class MediaNoteRecorder(context: Context) : NoteRecorder {

    private val appContext = context.applicationContext
    private val directory = File(appContext.cacheDir, "voice-notes").apply { mkdirs() }

    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private val samples = ArrayList<Int>(MAX_SAMPLES_HINT)

    private var startedAt = 0L
    private var accumulatedMs = 0L
    private var paused = false

    init {
        sweepOldFiles()
    }

    override fun start(): Boolean {
        if (recorder != null) return false
        val target = File(directory, "note-${System.currentTimeMillis()}.m4a")
        val created = newRecorder()
        return try {
            created.setAudioSource(MediaRecorder.AudioSource.MIC)
            created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            created.setAudioChannels(1)
            created.setAudioSamplingRate(SAMPLE_RATE_HZ)
            created.setAudioEncodingBitRate(BIT_RATE)
            // A second line of defence behind the caller's own timer, set two
            // seconds past it so the two never race to stop the same file.
            created.setMaxDuration((VOICE_NOTE_MAX_DURATION_MS + 2_000L).toInt())
            created.setOutputFile(target.absolutePath)
            created.prepare()
            created.start()

            recorder = created
            file = target
            samples.clear()
            accumulatedMs = 0L
            startedAt = SystemClock.elapsedRealtime()
            paused = false
            true
        } catch (failure: Exception) {
            // `start()` throws when another app holds the microphone, and
            // `prepare()` when the output cannot be opened. Both mean "not
            // recording", and neither is worth more than telling the person.
            runCatching { created.release() }
            target.delete()
            false
        }
    }

    override fun sample(): Int {
        val active = recorder ?: return 0
        if (paused) return 0
        val amplitude = runCatching { active.maxAmplitude }.getOrDefault(0)
        samples.add(amplitude)
        return amplitude
    }

    override fun pause() {
        val active = recorder ?: return
        if (paused) return
        runCatching { active.pause() }.onSuccess {
            accumulatedMs += SystemClock.elapsedRealtime() - startedAt
            paused = true
        }
    }

    override fun resume() {
        val active = recorder ?: return
        if (!paused) return
        runCatching { active.resume() }.onSuccess {
            startedAt = SystemClock.elapsedRealtime()
            paused = false
        }
    }

    override fun elapsedMs(): Long {
        if (recorder == null) return 0L
        return accumulatedMs + if (paused) 0L else SystemClock.elapsedRealtime() - startedAt
    }

    override fun stop(): RecordedNote? {
        val active = recorder ?: return null
        val target = file
        val duration = elapsedMs().coerceAtMost(VOICE_NOTE_MAX_DURATION_MS)
        val amplitudes = samples.toIntArray()
        recorder = null
        file = null

        // `stop()` throws RuntimeException when no valid audio data was
        // received, which is what a release inside the first few milliseconds
        // looks like. That is an empty note, not a crash.
        val stopped = runCatching { active.stop() }.isSuccess
        runCatching { active.release() }

        if (!stopped || target == null || !target.isFile || target.length() == 0L) {
            target?.delete()
            return null
        }
        return RecordedNote(target, duration, amplitudes)
    }

    override fun cancel() {
        val active = recorder
        val target = file
        recorder = null
        file = null
        if (active != null) {
            runCatching { active.stop() }
            runCatching { active.release() }
        }
        target?.delete()
    }

    @Suppress("DEPRECATION")
    private fun newRecorder(): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(appContext)
        } else {
            MediaRecorder()
        }

    /**
     * Notes that outlived the app, deleted a day on.
     *
     * A recording is deleted when it is cancelled and when its send is
     * claimed, but a process killed mid-upload leaves its file behind, and a
     * cache directory the system may clear whenever it likes is a poor reason
     * to leave that to chance.
     */
    private fun sweepOldFiles() {
        val cutoff = System.currentTimeMillis() - STALE_AFTER_MS
        directory.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
    }

    companion object {
        /** AAC-LC at 24 kHz mono: speech-grade, and 48 kbps is 360 KB a minute. */
        const val SAMPLE_RATE_HZ = 24_000
        const val BIT_RATE = 48_000

        /** How often the caller should call [sample]. */
        const val SAMPLE_INTERVAL_MS = 80L

        private const val MAX_SAMPLES_HINT = 4_000
        private const val STALE_AFTER_MS = 24L * 60 * 60 * 1000
    }
}
