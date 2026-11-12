package gg.pqp.app.jam.record

import gg.pqp.app.jam.audio.MIX_RATE
import java.io.File
import java.util.Random
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * A phone, as far as the recording arithmetic can tell: an output that presents
 * what it is given [outputLatencyMs] late, an input that delivers what the
 * microphone heard [inputLatencyMs] late, two streams that start [startSkewMs]
 * apart, and a platform whose timestamps are WRONG by a constant on each stream
 * ([outputStampErrorMs], [inputStampErrorMs]): the very thing the calibration
 * exists to find. Stamps also jitter, as polls do.
 *
 * Wall time is nanoseconds from [t0]; the output stream's frame 0 is presented
 * at `t0 + outputLatency`, and the input stream's frame 0 was captured at
 * `t0 - startSkew - inputLatency` (the microphone started first).
 *
 * A sound the person PLAYS ALONG to (the take) reaches the microphone at the
 * instant they hear it, so `capture[C] = output[C - D]` with
 * `D = (startSkew + inputLatency + outputLatency) * rate`; a sound that comes
 * out of the phone's own speaker (the calibration) also has [acousticMs] to
 * travel, so it lands that much later.
 */
class SimulatedWorld(
    val outputLatencyMs: Double = 21.0,
    val inputLatencyMs: Double = 9.0,
    val startSkewMs: Double = 12.0,
    val outputStampErrorMs: Double = 4.0,
    val inputStampErrorMs: Double = -17.0,
    val acousticMs: Double = 0.5,
    val jitterMs: Double = 0.3,
    seed: Long = 7,
) {
    private val random = Random(seed)
    val rate = MIX_RATE
    val t0 = 5_000_000_000_000L

    /** What the calibration should find: where the stamps are wrong, plus the sound's trip to the microphone. */
    val trueCorrectionMs: Double get() = inputStampErrorMs - outputStampErrorMs + acousticMs

    private fun ms(value: Double) = (value * 1e6).roundToLong()
    private fun jitter() = ms((random.nextDouble() * 2 - 1) * jitterMs)

    /** Frames between a sound leaving the output and being in the capture, for a player ([acoustic] false) or the speaker (true). */
    fun delayFrames(acoustic: Boolean): Int =
        ((startSkewMs + inputLatencyMs + outputLatencyMs + (if (acoustic) acousticMs else 0.0)) * rate / 1000.0).roundToInt()

    fun outputStamps(frames: Long, every: Long = 4800): List<TimestampSample> =
        (every until frames step every).map { p ->
            TimestampSample(p, t0 + ms(outputLatencyMs + outputStampErrorMs) + p * 1_000_000_000L / rate + jitter())
        }

    fun captureStamps(frames: Long, every: Long = 4800): List<TimestampSample> =
        (every until frames step every).map { c ->
            TimestampSample(c, t0 - ms(startSkewMs + inputLatencyMs) + ms(inputStampErrorMs) + c * 1_000_000_000L / rate + jitter())
        }

    /** The capture of a stream: the output (left channel) delayed, as an array of [captureFrames]. */
    fun capture(output: ShortArray, captureFrames: Int, acoustic: Boolean): ShortArray {
        val d = delayFrames(acoustic)
        return ShortArray(captureFrames) { c -> output.getOrElse(c - d) { 0 } }
    }

    /** Renders [source] for [frames] stream frames and returns its left channel. */
    fun render(source: OutputSource, frames: Int): ShortArray {
        val out = ShortArray(frames)
        val block = ShortArray(JamTakeRenderer.CHUNK * 2)
        var at = 0
        while (at < frames) {
            val n = minOf(JamTakeRenderer.CHUNK, frames - at)
            source.render(at.toLong(), block, n)
            for (i in 0 until n) out[at + i] = block[2 * i]
            at += n
        }
        return out
    }

    fun result(source: OutputSource, capture: File, streamFrames: Int, captureFrames: Int, route: JamRoute?): DuplexResult {
        val out = render(source, streamFrames)
        val cap = capture(out, captureFrames, acoustic = source is SignalSource)
        val bytes = java.nio.ByteBuffer.allocate(cap.size * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        cap.forEach { bytes.putShort(it) }
        capture.writeBytes(bytes.array())
        return DuplexResult(
            capturedFrames = captureFrames.toLong(),
            outputFrames = streamFrames.toLong(),
            outputStamps = outputStamps(streamFrames.toLong()),
            captureStamps = captureStamps(captureFrames.toLong()),
            outputApprox = emptyList(),
            captureApprox = emptyList(),
            routeAtStart = route,
            routeAtEnd = route,
            routeChanged = false,
            silenced = false,
            underruns = 0,
        )
    }
}

/** A [Duplex] that runs the world instead of the hardware: the whole stream is rendered at start, the capture is its echo. */
class FakeDuplex(
    private val world: SimulatedWorld,
    private val route: JamRoute?,
    /** How many frames of stream and capture one run produces. */
    private val streamFrames: Int,
    private val captureFrames: Int = streamFrames,
) : Duplex {
    var started = false
    var stopped = false
    var cancelled = false
    var failure: DuplexFailure? = null
    var lastCapture: File? = null
    private var source: OutputSource? = null
    private var captureFile: File? = null

    override fun start(source: OutputSource, capture: File, limitFrames: Long, outputEnds: Long): DuplexFailure? {
        if (failure != null) return failure
        started = true
        this.source = source
        captureFile = capture
        lastCapture = capture
        return null
    }

    override fun stop(): DuplexResult {
        stopped = true
        return world.result(source!!, captureFile!!, streamFrames, captureFrames, route)
    }

    override fun cancel(capture: File) {
        cancelled = true
        capture.delete()
    }

    override val level: Float get() = 0f
    override val captured: Long get() = if (started) captureFrames.toLong() else 0L
    override fun livePeaks(): List<Float> = emptyList()
    override fun presentedOutputFrame(): Long? = if (started) streamFrames.toLong() else null
    override fun currentRoute(): JamRoute? = route
}
