package gg.pqp.app.jam.record

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import gg.pqp.app.jam.audio.MIX_RATE
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.max

/*
 * THE HARDWARE HALF OF RECORDING: one `AudioTrack` playing a stream
 * ([OutputSource]: the band and the count-in, or a calibration signal) and one
 * `AudioRecord` capturing the microphone to a file, running together on two
 * threads, with every timestamp the platform will give for both streams kept so
 * that `JamTakePlacement` can say where on the song the first captured sample
 * is.
 *
 * Nothing here decides anything about the song. It starts both streams, counts
 * frames, polls `getTimestamp` on each, watches the route and the recording
 * configuration, and hands back what it saw ([DuplexResult]). The arithmetic is
 * pure and tested; what only a phone can say is how good the platform's
 * timestamps are, which is what the per-route calibration measures.
 *
 * The microphone is opened as `UNPROCESSED` where the device supports it and
 * `MIC` otherwise, never `VOICE_COMMUNICATION`: that source switches the stack
 * into its call routing and echo-cancels against the band, which would eat the
 * very notes being recorded and disturb a call's own audio.
 */

/** How a start went wrong. */
enum class DuplexFailure { MicDenied, MicBusy, OutputFailed }

/** Everything the two streams said, after [JamDuplex.stop]. */
class DuplexResult(
    val capturedFrames: Long,
    val outputFrames: Long,
    /** The platform's own timestamps for the output and the input, empty when it gave none. */
    val outputStamps: List<TimestampSample>,
    val captureStamps: List<TimestampSample>,
    /** The fallbacks: when frames were written and read. Used only when the platform's are missing. */
    val outputApprox: List<TimestampSample>,
    val captureApprox: List<TimestampSample>,
    val routeAtStart: JamRoute?,
    val routeAtEnd: JamRoute?,
    /** The output or the input changed under the stream (headphones pulled, Bluetooth joined). */
    val routeChanged: Boolean,
    /** The system silenced the microphone (a call, another app) at some point. */
    val silenced: Boolean,
    /** Times the output ran dry (the hardware wanted a block that was not there yet). */
    val underruns: Int,
) {
    /** The mode these stamps were taken in: both streams stamped by the platform, or approximated. */
    val mode: String get() = if (outputStamps.size >= MIN_STAMPS && captureStamps.size >= MIN_STAMPS) ClockMode.TIMESTAMPS else ClockMode.APPROXIMATE

    /** The output stamps to place with, in the mode [mode]. */
    val outputForPlacement: List<TimestampSample> get() = if (mode == ClockMode.TIMESTAMPS) outputStamps else outputApprox
    val captureForPlacement: List<TimestampSample> get() = if (mode == ClockMode.TIMESTAMPS) captureStamps else captureApprox

    companion object {
        const val MIN_STAMPS = 3
    }
}

interface DuplexEvents {
    /** The route changed or the microphone was silenced while running. Called on the main thread. */
    fun onTrouble(routeChanged: Boolean, silenced: Boolean)

    /** The streams died (a device went away under them). Called on the main thread. */
    fun onDied()
}

class JamDuplex(context: Context, private val events: DuplexEvents) : Duplex {
    private val appContext = context.applicationContext
    private val audio = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())

    private var track: AudioTrack? = null
    private var record: AudioRecord? = null
    private var outputThread: Thread? = null
    private var captureThread: Thread? = null
    private val running = AtomicBoolean(false)

    // Written by the audio threads, read after they are joined (and the level by the UI): all guarded by [lock] or volatile.
    private val lock = Any()
    private val outputStamps = ArrayList<TimestampSample>()
    private val captureStamps = ArrayList<TimestampSample>()
    private val outputApprox = ArrayList<TimestampSample>()
    private val captureApprox = ArrayList<TimestampSample>()
    private val peaks = JamLivePeaks()

    @Volatile private var capturedFrames = 0L
    @Volatile private var outputFrames = 0L
    @Volatile private var underruns = 0
    @Volatile private var routeChanged = false
    @Volatile private var silenced = false
    @Volatile private var died = false
    @Volatile private var levelNow = 0f
    private var routeAtStart: JamRoute? = null
    private var captureOut: BufferedOutputStream? = null
    private var deviceCallback: AudioDeviceCallback? = null
    private var recordingCallback: AudioManager.AudioRecordingCallback? = null

    override val level: Float get() = levelNow

    /** Frames captured so far: the clock a recording screen reads. */
    override val captured: Long get() = capturedFrames

    /** Loudest value per [PEAK_MS] of the capture so far, 0..1: the live waveform. */
    override fun livePeaks(): LivePeaks = peaks.snapshot()

    /**
     * The song position the person is HEARING now, from the output's own
     * timestamp: output stream frame to be shown against a clock. Null before
     * the platform has stamped anything.
     */
    override fun presentedOutputFrame(): Long? {
        val s = synchronized(lock) { outputStamps.lastOrNull() } ?: return null
        val ahead = (System.nanoTime() - s.nanos).coerceAtLeast(0) * MIX_RATE / 1_000_000_000L
        return s.frame + ahead
    }

    /** The route as it is now: the live streams' routed devices, or null before they are known. */
    override fun currentRoute(): JamRoute? {
        val t = track ?: return null
        val r = record ?: return null
        val out = JamRoutes.device(t.routedDevice)
        val inp = JamRoutes.device(r.routedDevice)
        return if (out == null && inp == null) null else JamRoute(inp, out, MIX_RATE)
    }

    /**
     * Starts both streams. [source] is what the output plays and [capture] the
     * file the microphone is written to (raw little-endian 16-bit mono at
     * [MIX_RATE]). [limitFrames] stops the capture by itself (the ten minute
     * ceiling) and [outputEnds] is the stream frame past which the output has
     * nothing left (a calibration signal); both 0 for none.
     */
    @SuppressLint("MissingPermission")
    override fun start(source: OutputSource, capture: File, limitFrames: Long, outputEnds: Long): DuplexFailure? {
        if (running.get()) return DuplexFailure.OutputFailed
        val rec = buildRecord() ?: return DuplexFailure.MicBusy
        val out = try {
            buildTrack()
        } catch (e: Exception) {
            rec.release()
            return DuplexFailure.OutputFailed
        }
        record = rec
        track = out
        try {
            captureOut = BufferedOutputStream(FileOutputStream(capture), 1 shl 16)
        } catch (e: java.io.IOException) {
            // Storage unavailable: nothing was started, and both native streams are released rather than leaked.
            teardown()
            return DuplexFailure.OutputFailed
        }
        running.set(true)
        try {
            rec.startRecording()
        } catch (e: IllegalStateException) {
            teardown()
            return DuplexFailure.MicBusy
        }
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            teardown()
            return DuplexFailure.MicBusy
        }
        watchRoute(rec)
        val c = Thread({ captureLoop(rec, limitFrames) }, "jam-capture").also { it.isDaemon = true }
        val o = Thread({ outputLoop(out, source, outputEnds) }, "jam-output").also { it.isDaemon = true }
        captureThread = c
        outputThread = o
        c.start()
        o.start()
        return null
    }

    @SuppressLint("MissingPermission")
    private fun buildRecord(): AudioRecord? {
        val min = AudioRecord.getMinBufferSize(MIX_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return null
        val unprocessed = audio.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(MIX_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()
        val bytes = max(min * 2, MIX_RATE / 10 * 2)
        for (source in listOf(if (unprocessed) MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.MIC, MediaRecorder.AudioSource.MIC)) {
            val built = try {
                AudioRecord.Builder().setAudioSource(source).setAudioFormat(format).setBufferSizeInBytes(bytes).build()
            } catch (e: Exception) {
                null
            }
            if (built != null && built.state == AudioRecord.STATE_INITIALIZED) return built
            built?.release()
        }
        return null
    }

    private fun buildTrack(): AudioTrack {
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(MIX_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
            .build()
        val min = AudioTrack.getMinBufferSize(MIX_RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setAudioFormat(format)
            .setBufferSizeInBytes(max(min, OUTPUT_BUFFER_FRAMES * 4))
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }

    // --- the two threads ---

    private fun outputLoop(out: AudioTrack, source: OutputSource, outputEnds: Long) {
        runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO) }
        val block = ShortArray(CHUNK * 2)
        val stamp = AudioTimestamp()
        var frame = 0L
        var lastPoll = 0L
        try {
            // Two blocks in before the stream starts, so it never begins by asking for audio it has not got.
            repeat(2) {
                source.render(frame, block, CHUNK)
                out.write(block, 0, CHUNK * 2, AudioTrack.WRITE_BLOCKING)
                frame += CHUNK
            }
            outputFrames = frame
            out.play()
            while (running.get()) {
                if (outputEnds in 1..frame) {
                    // Nothing left to play: keep the stream alive with silence so the capture and its stamps carry on.
                    java.util.Arrays.fill(block, 0.toShort())
                } else {
                    source.render(frame, block, CHUNK)
                }
                val wrote = out.write(block, 0, CHUNK * 2, AudioTrack.WRITE_BLOCKING)
                if (wrote < 0) {
                    died = true
                    break
                }
                frame += CHUNK
                outputFrames = frame
                val now = System.nanoTime()
                if (now - lastPoll >= POLL_NS) {
                    lastPoll = now
                    if (out.getTimestamp(stamp)) {
                        synchronized(lock) { outputStamps += TimestampSample(stamp.framePosition, stamp.nanoTime) }
                        // The routed devices are not known before the stream has run a moment; the first stamp says it has.
                        if (routeAtStart == null) routeAtStart = currentRoute()
                    }
                    // The fallback: how many frames the hardware has taken, and when we asked.
                    val head = out.playbackHeadPosition.toLong() and 0xFFFFFFFFL
                    synchronized(lock) { outputApprox += TimestampSample(head, now) }
                    val u = out.underrunCount
                    if (u > underruns) underruns = u
                }
            }
        } catch (e: Exception) {
            died = true
        } finally {
            runCatching { out.pause() }
            if (died) main.post { events.onDied() }
        }
    }

    private fun captureLoop(rec: AudioRecord, limitFrames: Long) {
        runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO) }
        val shorts = ShortArray(CHUNK)
        val bytes = ByteBuffer.allocate(CHUNK * 2).order(ByteOrder.LITTLE_ENDIAN)
        val stamp = AudioTimestamp()
        var lastPoll = 0L
        var bucketPeak = 0
        var bucketFrames = 0
        val bucket = MIX_RATE * PEAK_MS / 1000
        try {
            while (running.get()) {
                val n = rec.read(shorts, 0, CHUNK, AudioRecord.READ_BLOCKING)
                if (n < 0) {
                    died = true
                    break
                }
                if (n == 0) continue
                val readAt = System.nanoTime()
                bytes.clear()
                var peak = 0
                for (i in 0 until n) {
                    bytes.putShort(shorts[i])
                    val a = abs(shorts[i].toInt())
                    if (a > peak) peak = a
                }
                captureOut?.write(bytes.array(), 0, n * 2)
                capturedFrames += n
                levelNow = peak / 32768f
                bucketPeak = max(bucketPeak, peak)
                bucketFrames += n
                if (bucketFrames >= bucket) {
                    val v = (bucketPeak / 32768f).coerceIn(0f, 1f)
                    peaks.add(v)
                    bucketPeak = 0
                    bucketFrames = 0
                }
                // The fallback stamp: the last frame of this read was at the microphone about when the read returned.
                synchronized(lock) { captureApprox += TimestampSample(capturedFrames, readAt) }
                if (readAt - lastPoll >= POLL_NS) {
                    lastPoll = readAt
                    if (rec.getTimestamp(stamp, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS) {
                        synchronized(lock) { captureStamps += TimestampSample(stamp.framePosition, stamp.nanoTime) }
                    }
                }
                if (limitFrames in 1..capturedFrames) break
            }
        } catch (e: Exception) {
            died = true
        } finally {
            if (died) main.post { events.onDied() }
        }
    }

    // --- the route, and the system taking the microphone away ---

    private fun watchRoute(rec: AudioRecord) {
        routeAtStart = null
        // Registering reports every device that is already there as "added": that is the starting point, not a change.
        val armedAt = android.os.SystemClock.elapsedRealtime() + ARM_MS
        val callback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = changed()
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = changed()
            private fun changed() {
                if (!running.get() || android.os.SystemClock.elapsedRealtime() < armedAt) return
                routeChanged = true
                events.onTrouble(routeChanged = true, silenced = silenced)
            }
        }
        deviceCallback = callback
        audio.registerAudioDeviceCallback(callback, main)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val recording = object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                    val mine = configs.firstOrNull { it.clientAudioSessionId == rec.audioSessionId } ?: return
                    if (mine.isClientSilenced && !silenced) {
                        silenced = true
                        events.onTrouble(routeChanged = routeChanged, silenced = true)
                    }
                }
            }
            recordingCallback = recording
            audio.registerAudioRecordingCallback(recording, main)
        }
    }

    // --- ending ---

    /** Stops both streams and returns what they said. Safe to call twice (the second answer is empty). */
    override fun stop(): DuplexResult {
        val routeEnd = currentRoute()
        running.set(false)
        captureThread?.join(500)
        outputThread?.join(500)
        val result = DuplexResult(
            capturedFrames = capturedFrames,
            outputFrames = outputFrames,
            outputStamps = synchronized(lock) { ArrayList(outputStamps) },
            captureStamps = synchronized(lock) { ArrayList(captureStamps) },
            outputApprox = synchronized(lock) { ArrayList(outputApprox) },
            captureApprox = synchronized(lock) { ArrayList(captureApprox) },
            routeAtStart = routeAtStart,
            routeAtEnd = routeEnd,
            routeChanged = routeChanged,
            silenced = silenced,
            underruns = underruns,
        )
        teardown()
        return result
    }

    /** Stops and throws away what was captured. */
    override fun cancel(capture: File) {
        running.set(false)
        captureThread?.join(500)
        outputThread?.join(500)
        teardown()
        capture.delete()
    }

    private fun teardown() {
        running.set(false)
        deviceCallback?.let { runCatching { audio.unregisterAudioDeviceCallback(it) } }
        deviceCallback = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            recordingCallback?.let { runCatching { audio.unregisterAudioRecordingCallback(it) } }
        }
        recordingCallback = null
        runCatching { captureOut?.flush() }
        runCatching { captureOut?.close() }
        captureOut = null
        record?.let {
            runCatching { it.stop() }
            it.release()
        }
        record = null
        track?.let {
            runCatching { it.pause() }
            runCatching { it.flush() }
            it.release()
        }
        track = null
    }

    private companion object {
        const val CHUNK = 1024
        const val OUTPUT_BUFFER_FRAMES = 4096
        const val POLL_NS = 40_000_000L
        const val PEAK_MS = 80
        const val ARM_MS = 800L
    }
}
