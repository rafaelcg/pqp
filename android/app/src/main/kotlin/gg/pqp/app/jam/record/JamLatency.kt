package gg.pqp.app.jam.record

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlinx.serialization.Serializable

/*
 * THE CALIBRATION'S PURE HALF: turning what the microphone heard into the
 * route's correction, judging how far to trust it, and choosing which stored
 * measurement to use. The half that plays the sound and records it is
 * `JamDuplex`; the half that stores the answer is `JamLatencyStore`. Ported from
 * the web's `latency.ts`, with the one difference `JamTakePlacement` explains:
 * the web measures a whole round trip, this measures what the platform's own
 * timestamps got wrong (the CORRECTION), in the same frame the take is placed in.
 *
 * Every measurement here is `lag = where the sound WAS in the capture - where
 * the timestamps SAID it would be`, so a HAL that reports every timestamp
 * exactly gives 0 and one that leaves a stage out gives that stage's length.
 *
 * Two ways to measure, best first:
 *
 *  1. LOOPBACK. The microphone can hear the output (the phone's own speaker, or
 *     a headphone cup held against the microphone). Sweeps go out and are found
 *     in the capture by cross-correlation: the path a take travels, to a
 *     fraction of a millisecond.
 *  2. TAP-ALONG. The microphone cannot hear the output (headphones). The person
 *     claps, taps the phone or hits muted strings on every click. The same path
 *     plus the person's own timing habit, which is arguably what should be
 *     compensated, but it is a human: a few milliseconds of spread at best.
 *
 * A third, MANUAL, is a number the person typed (or learned from nudging a
 * take); it beats everything, because somebody who typed a number meant it.
 */

object LatencyMethod {
    const val LOOPBACK = "loopback"
    const val TAP_ALONG = "tap-along"
    const val MANUAL = "manual"

    /** Better first. */
    val RANK = listOf(MANUAL, LOOPBACK, TAP_ALONG)
}

object LatencyConfidence {
    const val HIGH = "high"
    const val MEDIUM = "medium"
    const val LOW = "low"
    const val FAILED = "failed"
}

/** How the two timestamp streams were obtained (`JamDuplex`): a measurement only holds for the same mode. */
object ClockMode {
    /** The platform's own `getTimestamp` for both streams. */
    const val TIMESTAMPS = "timestamps"

    /** At least one stream had no timestamp and was approximated from when its buffers were read and written. */
    const val APPROXIMATE = "approximate"
}

@Serializable
data class LatencyResult(
    val method: String,
    /** What to subtract from a take's offset, ms. NaN when [confidence] is failed. */
    val correctionMs: Double,
    val confidence: String,
    /** Largest deviation of an accepted measurement from the result, ms. */
    val spreadMs: Double = 0.0,
    val accepted: Int = 0,
    val played: Int = 0,
    val at: Long = 0L,
    val clockMode: String = ClockMode.TIMESTAMPS,
) {
    /** Good enough to place a take with. A typed number always is. */
    val usable: Boolean
        get() = correctionMs.isFinite() && abs(correctionMs) <= JamLatency.MAX_CORRECTION_MS &&
            (method == LatencyMethod.MANUAL || confidence == LatencyConfidence.HIGH || confidence == LatencyConfidence.MEDIUM)
}

object JamLatency {
    /** No platform is wrong by more than this; a bigger number is a mismatch of the search, not a measurement. */
    const val MAX_CORRECTION_MS = 600.0

    /** Where in the capture to look for each pulse, relative to where the timestamps predict it, ms. */
    const val SEARCH_BEFORE_MS = 150.0
    const val SEARCH_AFTER_MS = 500.0

    /** The sweeps are further apart than the whole search window, so one can never be taken for its neighbour. */
    const val PULSE_PERIOD_MS = 700.0
    const val LOOPBACK_FIRST_MS = 300.0
    const val LOOPBACK_PULSES = 10

    /** After one strong match, the others are searched this far either side of it (ms), and a match is strong from this quality. */
    private const val NARROW_MS = 15.0
    private const val STRONG = 0.6

    /**
     * Loopback. [expectedFrames] are, for each sweep, the capture frame the
     * timestamps predict it at (output frame mapped through both anchors, with a
     * correction of 0); [captured] is the recording at [rate].
     */
    fun analyseLoopback(
        captured: FloatArray,
        expectedFrames: List<Double>,
        reference: FloatArray,
        rate: Int,
        mode: String = ClockMode.TIMESTAMPS,
        now: Long = System.currentTimeMillis(),
        minQuality: Double = 0.2,
    ): LatencyResult {
        val lags = ArrayList<Double>()
        // The correction is one constant for the route, so once a pulse has been found strongly the others are looked for
        // close to where it was (a direct correlation over the whole 650 ms window is about 150 million multiplies for
        // ten pulses); a pulse not found there is searched for in the whole window as before.
        var known: Double? = null
        for (expected in expectedFrames) {
            // Windows are lags in ms after the prediction: the whole one, or `known` plus or minus a few milliseconds.
            fun search(fromLagMs: Double, toLagMs: Double) = JamXcorr.findPulse(
                captured, reference,
                (expected + fromLagMs / 1000.0 * rate).toInt(), (expected + toLagMs / 1000.0 * rate).toInt(), rate,
            )
            val narrow = known?.let { search(it - NARROW_MS, it + NARROW_MS) }?.takeIf { it.quality >= STRONG }
            val match = narrow ?: search(-SEARCH_BEFORE_MS, SEARCH_AFTER_MS) ?: continue
            if (match.quality >= minQuality) {
                val lag = (match.position - expected) / rate * 1000.0
                lags += lag
                if (known == null && match.quality >= STRONG) known = lag
            }
        }
        return judge(LatencyMethod.LOOPBACK, lags, expectedFrames.size, highSpread = 1.0, mediumSpread = 3.0, outlierMs = 3.0, mode = mode, now = now)
    }

    /**
     * Tap-along. [expectedClickFrames] are the capture frames the timestamps
     * predict each click at. The first [warmup] taps are the person finding the
     * beat and are ignored.
     */
    fun analyseTapAlong(
        captured: FloatArray,
        expectedClickFrames: List<Double>,
        rate: Int,
        mode: String = ClockMode.TIMESTAMPS,
        now: Long = System.currentTimeMillis(),
        warmup: Int = 2,
        maxLagMs: Double = 500.0,
    ): LatencyResult {
        val maxLag = maxLagMs / 1000.0 * rate
        // A tap can be early: people anticipate a beat by tens of milliseconds.
        val early = 0.08 * rate
        val onsets = JamXcorr.detectOnsets(captured, rate)
        // Each onset belongs to at most one click, the nearest whose window it falls in, so a missed tap cannot let
        // the next click's tap count twice.
        val owner = HashMap<Int, Int>()
        onsets.forEachIndexed { oi, onset ->
            var best = -1
            var bestDist = Double.POSITIVE_INFINITY
            expectedClickFrames.forEachIndexed { ci, click ->
                if (onset < click - early || onset > click + maxLag) return@forEachIndexed
                val dist = abs(onset - click)
                if (dist < bestDist) {
                    bestDist = dist
                    best = ci
                }
            }
            if (best >= 0 && !owner.containsKey(best)) owner[best] = oi
        }
        val lags = ArrayList<Double>()
        expectedClickFrames.forEachIndexed { i, click ->
            val oi = owner[i] ?: return@forEachIndexed
            if (i >= warmup) lags += (onsets[oi] - click) / rate * 1000.0
        }
        // A human: a 6 ms spread is a good drummer, 15 ms an ordinary one.
        return judge(
            LatencyMethod.TAP_ALONG,
            lags,
            max(0, expectedClickFrames.size - warmup),
            highSpread = -1.0,
            mediumSpread = 8.0,
            outlierMs = 25.0,
            mode = mode,
            now = now,
        )
    }

    /** A number the person typed or learned: always usable, and it beats every measurement. */
    fun manual(correctionMs: Double, mode: String = ClockMode.TIMESTAMPS, now: Long = System.currentTimeMillis()) =
        LatencyResult(LatencyMethod.MANUAL, correctionMs, LatencyConfidence.HIGH, 0.0, 1, 1, now, mode)

    internal fun judge(
        method: String,
        lags: List<Double>,
        played: Int,
        highSpread: Double,
        mediumSpread: Double,
        outlierMs: Double,
        mode: String,
        now: Long,
    ): LatencyResult {
        if (lags.size < 3) {
            return LatencyResult(method, Double.NaN, LatencyConfidence.FAILED, Double.NaN, lags.size, played, now, mode)
        }
        val m = JamXcorr.median(lags)
        val inliers = lags.filter { abs(it - m) <= outlierMs }
        val result = JamXcorr.median(inliers)
        val spread = inliers.maxOfOrNull { abs(it - result) } ?: 0.0
        val minAccepted = max(3, ceil(played * 0.5).toInt())
        val confidence = when {
            inliers.size < minAccepted -> LatencyConfidence.LOW
            spread <= highSpread -> LatencyConfidence.HIGH
            spread <= mediumSpread -> LatencyConfidence.MEDIUM
            else -> LatencyConfidence.LOW
        }
        return LatencyResult(
            method = method,
            correctionMs = Math.round(result * 1000) / 1000.0,
            confidence = confidence,
            spreadMs = Math.round(spread * 1000) / 1000.0,
            accepted = inliers.size,
            played = played,
            at = now,
            clockMode = mode,
        )
    }

    /**
     * Which stored measurement to place a take with: the best usable one made
     * in the same clock [mode] (a measurement taken on approximate clocks says
     * nothing about timestamped ones). A manual value beats every measurement,
     * then loopback, then tap-along; the newest of a kind wins. Null means this
     * route has not been calibrated yet, and a take is not recorded.
     */
    fun choose(stored: List<LatencyResult>, mode: String): LatencyResult? =
        stored
            .filter { it.usable && (it.clockMode == mode || it.method == LatencyMethod.MANUAL) }
            .sortedWith(compareBy<LatencyResult> { LatencyMethod.RANK.indexOf(it.method).let { i -> if (i < 0) 99 else i } }.thenByDescending { it.at })
            .firstOrNull()
}
