package gg.pqp.app.jam.record

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/*
 * WHERE A RECORDED TAKE LANDS ON THE SONG. Pure arithmetic, no Android type:
 * this is the formula the whole feature exists for, so it lives alone and is
 * tested alone (`JamTakePlacementTest`), the way the web's `placement.ts` is.
 *
 * THE LATENCY MODEL. The web has one AudioContext, so the backing and the
 * capture are stamped in one unit and only the round trip has to be guessed.
 * A phone has two streams (an `AudioTrack` playing the band, an `AudioRecord`
 * hearing the person) on two clocks, so the relation between them is MEASURED
 * rather than assumed:
 *
 *   - `AudioTrack.getTimestamp` says at what `System.nanoTime()` a stream
 *     frame of the OUTPUT is presented (leaves the speaker or the jack);
 *   - `AudioRecord.getTimestamp` says at what `System.nanoTime()` a frame of the
 *     INPUT was captured at the microphone;
 *   - both are the same monotonic clock, so a note the person plays the moment
 *     they hear song time S is captured at the nanosecond the song's frame S
 *     is presented.
 *
 * Each stream's timestamps are folded into one number, the nanosecond its
 * frame 0 sits at ([anchorNs]): frame `f` is then at `anchor + f / rate`. The
 * band's transport frame 0 (song time `fromMs`) is output stream frame `p0`
 * (after the count-in), and the take's first captured sample is capture frame
 * 0, so it sits at song time
 *
 *     fromMs + (captureAnchor - playbackAnchor) - p0 / rate  -  correction
 *
 * `correction` is the one thing a platform gets wrong and cannot be asked:
 * some audio HALs report a capture timestamp that leaves out a stage of the
 * input path, or an output timestamp that leaves out the DAC, by a constant
 * amount that is stable on one route (this phone, these headphones) and
 * different on another. It is MEASURED, once per route, by playing a sound out
 * and finding it in the capture ([JamLatency]), and it is applied here, never
 * anywhere else. Nothing about the phone's own reported latency is used.
 */

/** One `getTimestamp` answer: stream frame `frame` was at monotonic time `nanos`. */
data class TimestampSample(val frame: Long, val nanos: Long)

object JamTakePlacement {
    /**
     * The monotonic nanosecond at which frame 0 of a stream sits, from its
     * timestamps: the median of `nanos - frame / rate` over the [near] samples
     * closest to [aroundFrame] (the frame the answer is needed at). A median so
     * that one late poll does not move it, and the nearest ones so that a stream
     * which stuttered earlier (an under-run does not advance the counters)
     * cannot drag a point it never reached. Null with no samples.
     */
    fun anchorNs(samples: List<TimestampSample>, rate: Int, aroundFrame: Long, near: Int = 9): Double? {
        if (samples.isEmpty()) return null
        val chosen = samples.sortedBy { abs(it.frame - aroundFrame) }.take(near)
        return median(chosen.map { it.nanos - it.frame * 1e9 / rate })
    }

    /**
     * How far two anchors drift apart, in parts per million, from samples taken
     * at the start and at the end: the capture clock and the playback clock are
     * not guaranteed to be one crystal. Reported, never corrected.
     */
    fun driftPpm(early: Double?, late: Double?, spanSeconds: Double): Double? {
        if (early == null || late == null || spanSeconds < 5.0) return null
        return (late - early) / 1e9 / spanSeconds * 1e6
    }

    /**
     * Song time, in milliseconds and unrounded, of the take's first captured sample.
     *
     * @param fromMs song time at the band's transport frame 0
     * @param p0 output stream frame at which that transport frame 0 plays
     * @param playbackAnchorNs [anchorNs] of the output stream
     * @param captureAnchorNs [anchorNs] of the input stream
     * @param correctionMs the route's measured correction, see the header
     */
    fun rawOffsetMs(
        fromMs: Double,
        p0: Long,
        playbackAnchorNs: Double,
        captureAnchorNs: Double,
        correctionMs: Double,
        rate: Int,
    ): Double = fromMs + (captureAnchorNs - playbackAnchorNs) / 1e6 - p0 * 1000.0 / rate - correctionMs

    /**
     * Make the offset a whole number of milliseconds by dropping a few leading
     * samples (fewer than one millisecond's worth), the web's `wholeMillisecondOffset`:
     * the server may store `offset_ms` as an integer, and this way rounding it
     * moves nothing.
     */
    fun wholeMillisecond(offsetMs: Double, rate: Int): Pair<Int, Int> {
        val target = ceil(offsetMs - 1e-9).toInt()
        val drop = (((target - offsetMs) / 1000.0) * rate).roundToInt()
        return target to drop
    }

    /**
     * The take as the server stores it. `offsetMs` is the song time of the stored
     * file's FIRST sample (a count-in is before the song's zero and stays in the
     * file); the head the band was not yet playing for ([fromMs] less the offset)
     * is hidden by `trimStartMs`, which hides audio and never moves it. The web's
     * `recorder.ts` writes `trimStartMs = clamp(fromMs - offsetMs, 0, durationMs)`.
     */
    fun finish(
        capturedFrames: Long,
        fromMs: Double,
        rawOffsetMs: Double,
        rate: Int,
    ): PlacedTake {
        val (offset, drop) = wholeMillisecond(rawOffsetMs, rate)
        val kept = max(0L, capturedFrames - drop)
        val durationMs = kept * 1000.0 / rate
        val trimStart = min(max(0.0, fromMs - offset), durationMs)
        return PlacedTake(
            offsetMs = offset.toDouble(),
            dropFrames = drop,
            frames = kept,
            durationMs = durationMs,
            trimStartMs = trimStart,
        )
    }

    private fun median(values: List<Double>): Double {
        val s = values.sorted()
        val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2
    }
}

/** A take after placement: what is stored, before any of the person's edits. */
data class PlacedTake(
    /** Song time of stored sample 0, whole milliseconds. */
    val offsetMs: Double,
    /** Leading captured samples dropped so the offset is whole (fewer than one millisecond's worth). */
    val dropFrames: Int,
    val frames: Long,
    val durationMs: Double,
    val trimStartMs: Double,
)

/**
 * The optional edits between stopping and sending, ported from the web's
 * `jam-take-edit.ts`: nudge the whole take earlier or later, nothing else on a
 * phone. A nudge moves ALL of the audio (the offset), a trim only hides.
 */
object JamTakeEdit {
    /** How far a nudge may go either way, ms. */
    const val NUDGE_LIMIT_MS = 500

    /** One tap, and how far a repeat goes by how long the button has been held (the web's steps). */
    fun stepFor(heldMs: Long): Int = if (heldMs >= 1500) 100 else if (heldMs >= 600) 50 else 10

    fun clampNudge(ms: Int): Int = ms.coerceIn(-NUDGE_LIMIT_MS, NUDGE_LIMIT_MS)

    /** "+1.5 s" / "-0.3 s" / "0 s" for anything that rounds to a signed zero; the web's `signedSeconds`. */
    fun signedMs(ms: Int): String = if (ms == 0) "0 ms" else (if (ms > 0) "+" else "-") + abs(ms) + " ms"
}
