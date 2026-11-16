package gg.pqp.app.jam.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.os.Process
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Where the mixed samples go. One implementation talks to an [AudioTrack]; the
 * transport test (`JamPlayerTransportTest`) swaps in a fake that "plays"
 * instantly, so the play, pause, seek and end logic is checked without hardware.
 * Every method is called from the player's one audio thread.
 */
interface JamSink {
    /** Non-blocking: how many SAMPLES (interleaved, so two per frame) were taken, or a negative error (the track died). */
    fun write(buffer: ShortArray, offset: Int, length: Int): Int
    fun start()
    fun pause()
    fun flush()

    /** Frames that have left the sink since the last [flush]. */
    fun headFrames(): Long

    /** (frames presented, System.nanoTime() of that moment), or null before the hardware reports one. */
    fun timestamp(): Pair<Long, Long>?
    fun release()
}

class AudioTrackSink : JamSink {
    private val track: AudioTrack
    private val stamp = AudioTimestamp()

    init {
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(MIX_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
            .build()
        val min = AudioTrack.getMinBufferSize(MIX_RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        // About 130 ms: long enough to ride out a scheduling hiccup, short enough that a mute is heard at once.
        val bytes = maxOf(min, BUFFER_FRAMES * 4)
        track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setAudioFormat(format)
            .setBufferSizeInBytes(bytes)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }

    override fun write(buffer: ShortArray, offset: Int, length: Int): Int =
        track.write(buffer, offset, length, AudioTrack.WRITE_NON_BLOCKING)

    override fun start() = track.play()
    override fun pause() = track.pause()
    override fun flush() = track.flush()

    override fun headFrames(): Long = track.playbackHeadPosition.toLong() and 0xFFFFFFFFL

    override fun timestamp(): Pair<Long, Long>? =
        if (track.getTimestamp(stamp)) stamp.framePosition to stamp.nanoTime else null

    override fun release() {
        runCatching { track.pause() }
        runCatching { track.flush() }
        track.release()
    }

    private companion object {
        const val BUFFER_FRAMES = 6144
    }
}

/**
 * The transport: play, pause, seek, and a clock that says what is being HEARD.
 *
 * The sample-accurate part is [JamMixer]; this is the thin shell that feeds it
 * to a [JamSink] from one audio thread and keeps time:
 *
 *  - The mixer is asked for buffers in order, from `writePos`. A seek is not a
 *    re-sync of anything: the sink is flushed and rendering simply continues
 *    from the new frame, so stems cannot come back out of step.
 *  - The position the UI and the video follow is the sink's PRESENTED frame
 *    (`AudioTrack.getTimestamp`, interpolated to now), not the written frame:
 *    what the person hears, with the output's own latency already inside it.
 *  - Every sink call happens on the audio thread (writes are non-blocking), so
 *    there is no flush racing a write; the UI thread only leaves a request.
 *
 * Application code calls [load] with placed stems, then [play] and friends from
 * any thread.
 */
class JamPlayer(
    private val mixer: JamMixer = JamMixer(),
    private val sinkFactory: () -> JamSink = { AudioTrackSink() },
    private val nanoTime: () -> Long = System::nanoTime,
) {
    private val lock = Object()

    private val _playing = MutableStateFlow(false)
    val playing: StateFlow<Boolean> = _playing.asStateFlow()

    private val _durationMs = MutableStateFlow(0.0)
    val durationMs: StateFlow<Double> = _durationMs.asStateFlow()

    private val _ended = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** Emits when playback reached the end; the transport is then paused at zero. */
    val ended: SharedFlow<Unit> = _ended.asSharedFlow()

    private val _failures = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /**
     * Emits when the output died under the song (the track could not be built, or a write came back with an
     * error such as `ERROR_DEAD_OBJECT`). The transport is then paused where it was, and a later [play] builds a
     * fresh sink.
     */
    val failures: SharedFlow<Unit> = _failures.asSharedFlow()

    // Guarded by `lock`.
    private var wantPlay = false
    private var pendingSeek = -1L
    private var released = false
    private var thread: Thread? = null

    // Audio thread only, except where @Volatile.
    private var sink: JamSink? = null
    private var writePos = 0L
    @Volatile private var baseFrame = 0L
    @Volatile private var seekTarget = -1L
    @Volatile private var presentedOnPause = 0L
    @Volatile private var masterLevel = 1f
    @Volatile private var sinkPlaying = false

    /**
     * What the sink's frame counters read right after the last flush. `AudioTrack` does not promise that a flush
     * puts its position back to zero, so the counters are taken relative to this and a seek can never carry the
     * old count into the new position.
     */
    @Volatile private var counterBase = 0L

    /** Replace the stems (a track came, went, or moved). The position is kept, clamped to the new length. */
    fun load(stems: List<Pair<JamPlacement, PcmSource>>) {
        mixer.setStems(stems)
        _durationMs.value = JamAlignment.ms(mixer.durationFrames)
        mixer.snapLevels()
        synchronized(lock) {
            // Re-render from where we are, so the buffer already written (the old mix) is not heard.
            if (thread != null) pendingSeek = currentFrame().coerceIn(0, mixer.durationFrames)
            lock.notifyAll()
        }
    }

    fun setLevel(id: String, level: Float) = mixer.setLevel(id, level)

    fun setMasterLevel(level: Float) {
        masterLevel = level
    }

    fun play() {
        synchronized(lock) {
            if (released || mixer.durationFrames <= 0) return
            wantPlay = true
            // Before the thread starts: one that dies at once (no audio device) then clears it, not the other way round.
            _playing.value = true
            ensureThread()
            lock.notifyAll()
        }
    }

    fun pause() {
        synchronized(lock) {
            wantPlay = false
            lock.notifyAll()
        }
        _playing.value = false
    }

    fun seekTo(ms: Double) {
        val target = JamAlignment.frames(ms).coerceIn(0, mixer.durationFrames)
        seekTarget = target
        synchronized(lock) {
            pendingSeek = target
            if (thread == null && !released) {
                // Not started yet: the position is just a number until play().
                baseFrame = target
                writePos = target
                seekTarget = -1
                pendingSeek = -1
            }
            lock.notifyAll()
        }
    }

    /** The song position being heard, in milliseconds from the transport's zero. */
    fun positionMs(): Double = JamAlignment.ms(currentFrame())

    private fun currentFrame(): Long {
        val held = seekTarget
        if (held >= 0) return held
        val s = sink ?: return baseFrame
        val presented = if (sinkPlaying) {
            val stamp = s.timestamp()
            if (stamp != null) {
                val ahead = (nanoTime() - stamp.second).coerceAtLeast(0) * MIX_RATE / 1_000_000_000L
                stamp.first + ahead - counterBase
            } else {
                s.headFrames() - counterBase
            }
        } else {
            presentedOnPause
        }
        // Never past what has been written, never past the end.
        return (baseFrame + presented).coerceIn(0, minOf(writePos, mixer.durationFrames))
    }

    fun release() {
        val t: Thread?
        synchronized(lock) {
            released = true
            wantPlay = false
            t = thread
            lock.notifyAll()
        }
        t?.join(500)
        _playing.value = false
    }

    private fun ensureThread() {
        if (thread != null) return
        // Assigned before it starts: a thread that dies at once (no audio device) clears its own reference.
        val created = Thread({ run() }, "jam-audio")
        created.isDaemon = true
        thread = created
        created.start()
    }

    // --- the audio thread ---

    private fun run() {
        runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO) }
        val chunk = ShortArray(CHUNK_FRAMES * 2)
        val scratch = ShortArray(CHUNK_FRAMES)
        val acc = FloatArray(CHUNK_FRAMES)
        var chunkOffset = 0
        var chunkLength = 0 // samples still to hand over
        val out = try {
            sinkFactory()
        } catch (e: Throwable) {
            // The track could not be built: say so, and leave the player able to try again.
            fail()
            return
        }
        sink = out
        counterBase = 0
        var running = false
        var failed = false
        try {
            while (true) {
                var seek = -1L
                var play: Boolean
                synchronized(lock) {
                    // Idle only when there is nothing to do AND the sink is already paused: a pause request
                    // while running must reach the sink below, not be waited out here.
                    while (!released && !wantPlay && pendingSeek < 0 && !running) lock.wait()
                    if (released) return
                    seek = pendingSeek
                    pendingSeek = -1
                    play = wantPlay
                }
                if (seek >= 0) {
                    out.pause()
                    out.flush()
                    counterBase = out.headFrames()
                    sinkPlaying = false
                    running = false
                    baseFrame = seek
                    writePos = seek
                    presentedOnPause = 0
                    chunkLength = 0
                    seekTarget = -1
                }
                if (!play) {
                    if (running) {
                        presentedOnPause = out.headFrames() - counterBase
                        sinkPlaying = false
                        out.pause()
                        running = false
                    }
                    continue
                }
                if (!running) {
                    // Pre-roll one buffer before the sink starts so it never begins on silence it has to fill.
                    out.start()
                    sinkPlaying = true
                    running = true
                }
                if (chunkLength == 0 && writePos < mixer.durationFrames) {
                    mixer.render(writePos, chunk, CHUNK_FRAMES, masterLevel, scratch, acc)
                    writePos += CHUNK_FRAMES
                    chunkOffset = 0
                    chunkLength = CHUNK_FRAMES * 2
                }
                if (chunkLength > 0) {
                    val taken = out.write(chunk, chunkOffset, chunkLength)
                    if (taken < 0) {
                        failed = true
                        return
                    }
                    chunkOffset += taken
                    chunkLength -= taken
                    if (taken == 0) sleep(SLEEP_MS)
                    continue
                }
                // Everything is written: wait for it to be heard.
                if (out.headFrames() - counterBase >= mixer.durationFrames - baseFrame) {
                    finish(out)
                    running = false
                    chunkLength = 0
                } else {
                    sleep(SLEEP_MS)
                }
            }
        } finally {
            if (failed) {
                // Keep the place the person was at, so the next play() starts a new sink from there.
                val at = runCatching { currentFrame() }.getOrDefault(baseFrame)
                baseFrame = at
                writePos = at
            }
            sinkPlaying = false
            runCatching { out.release() }
            sink = null
            if (failed) fail()
            synchronized(lock) { if (thread === Thread.currentThread()) thread = null }
        }
    }

    /** The output died: stop, tell the owner, and allow a later [play] to start a new thread and sink. */
    private fun fail() {
        synchronized(lock) {
            wantPlay = false
            if (thread === Thread.currentThread()) thread = null
        }
        _playing.value = false
        _failures.tryEmit(Unit)
    }

    private fun finish(out: JamSink) {
        out.pause()
        out.flush()
        counterBase = out.headFrames()
        sinkPlaying = false
        baseFrame = 0
        writePos = 0
        presentedOnPause = 0
        synchronized(lock) { wantPlay = false }
        _playing.value = false
        _ended.tryEmit(Unit)
    }

    private fun sleep(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
        }
    }

    private companion object {
        const val CHUNK_FRAMES = 1024
        const val SLEEP_MS = 4L
    }
}
