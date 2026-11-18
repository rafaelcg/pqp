package gg.pqp.app.jam.record

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Test and calibration signals, and the two ways to find a sound in a
 * recording, as plain float arrays (ported from `client/src/lib/jam/signals.ts`
 * and `xcorr.ts`). No Android type, so the calibration's arithmetic is tested
 * on the JVM against synthetic recordings with a known latency.
 */
object JamSignals {
    /**
     * A Hann-windowed exponential sweep, 8 kHz down to 1 kHz in 10 ms: its
     * autocorrelation is one sharp peak a sample wide, which is what makes it a
     * good thing to find in a recording. A phone's speaker and microphone colour
     * it; they do not move its peak.
     */
    fun sweep(sampleRate: Int, durationMs: Double = 10.0, amplitude: Float = 0.5f): FloatArray {
        val n = max(16, (durationMs / 1000.0 * sampleRate).toInt())
        val high = min(8000.0, sampleRate * 0.4)
        val low = min(1000.0, high / 4)
        val total = n.toDouble() / sampleRate
        val k = ln(low / high)
        val out = FloatArray(n)
        for (i in 0 until n) {
            val t = i.toDouble() / sampleRate
            val phase = 2 * PI * high * total / k * (exp(t * k / total) - 1)
            val window = 0.5 - 0.5 * cos(2 * PI * i / (n - 1))
            out[i] = (amplitude * window * sin(phase)).toFloat()
        }
        return out
    }

    /** A metronome click: a short decaying sine, higher and louder on the first beat of a bar. */
    fun click(sampleRate: Int, accent: Boolean): FloatArray {
        val freq = if (accent) 1760.0 else 1320.0
        val n = (0.03 * sampleRate).toInt()
        val amp = if (accent) 0.6 else 0.4
        val attack = max(1, (0.001 * sampleRate).toInt())
        val out = FloatArray(n)
        for (i in 0 until n) {
            val env = if (i < attack) i.toDouble() / attack else exp(-(i - attack) / (0.006 * sampleRate))
            out[i] = (amp * env * sin(2 * PI * freq * i / sampleRate)).toFloat()
        }
        return out
    }

    /** [pulse] laid into a silent buffer at each frame in [at]. */
    fun pulseTrain(length: Int, pulse: FloatArray, at: List<Int>): FloatArray {
        val out = FloatArray(length)
        for (start in at) {
            for (i in pulse.indices) {
                val j = start + i
                if (j in 0 until length) out[j] += pulse[i]
            }
        }
        return out
    }
}

/** Where a known pulse sits in a recording, with a sub-sample part, and how well it matched (0..1). */
data class PulseMatch(val position: Double, val quality: Double)

object JamXcorr {
    /**
     * Normalised cross-correlation of [ref] against [signal] for every start in
     * [from]..[to], and the position of the DIRECT sound. A wall a metre away
     * gives a second copy of the click about 6 ms later, sometimes louder at the
     * microphone, so the answer is the EARLIEST local peak that reaches
     * [earliestRatio] of the strongest, not simply the strongest. Polarity is
     * ignored: plenty of microphones invert.
     */
    fun findPulse(
        signal: FloatArray,
        ref: FloatArray,
        from: Int,
        to: Int,
        sampleRate: Int,
        earliestRatio: Double = 0.6,
    ): PulseMatch? {
        val n = ref.size
        val start = max(0, from)
        val end = min(signal.size - n, to)
        if (end < start) return null
        var refEnergy = 0.0
        for (v in ref) refEnergy += v * v
        if (refEnergy == 0.0) return null
        val refNorm = sqrt(refEnergy)
        val count = end - start + 1
        val ncc = FloatArray(count)
        var winEnergy = 0.0
        for (i in 0 until n) winEnergy += signal[start + i] * signal[start + i].toDouble()
        var best = 0.0
        for (k in 0 until count) {
            val p = start + k
            if (k > 0) {
                val out = signal[p - 1].toDouble()
                val inn = signal[p + n - 1].toDouble()
                winEnergy += inn * inn - out * out
                if (winEnergy < 0) winEnergy = 0.0
            }
            var dot = 0.0
            for (i in 0 until n) dot += ref[i] * signal[p + i].toDouble()
            val denom = refNorm * sqrt(winEnergy)
            val v = if (denom > 1e-12) abs(dot) / denom else 0.0
            ncc[k] = v.toFloat()
            if (v > best) best = v
        }
        if (best <= 0) return null
        // A band-limited pulse's correlation rings: with polarity ignored its first side lobes are a fraction of a
        // millisecond away and can reach most of the main peak, so a candidate must be the largest value within
        // `guard` either side. A real reflection arrives later than that (half a millisecond is 17 cm of extra path).
        val guard = max(2, (sampleRate * 0.0005).toInt())
        val threshold = best * earliestRatio
        var peak = -1
        for (k in 0 until count) {
            val v = ncc[k]
            if (v < threshold) continue
            var isMax = true
            for (j in max(0, k - guard)..min(count - 1, k + guard)) {
                if (ncc[j] > v) {
                    isMax = false
                    break
                }
            }
            if (isMax) {
                peak = k
                break
            }
        }
        if (peak < 0) return null
        val frac = if (peak > 0 && peak < count - 1) parabolicOffset(ncc[peak - 1], ncc[peak], ncc[peak + 1]) else 0.0
        return PulseMatch(start + peak + frac, ncc[peak].toDouble())
    }

    /** Vertex of the parabola through three equally spaced points, as an offset from the middle one, in -0.5..0.5. */
    fun parabolicOffset(left: Float, mid: Float, right: Float): Double {
        val denom = left - 2 * mid + right
        if (denom == 0f) return 0.0
        return (0.5 * (left - right) / denom).coerceIn(-0.5, 0.5)
    }

    /**
     * Onsets in a recording: claps, a tapped microphone, a muted string. A
     * first-difference (so rumble and DC do not count) is rectified and averaged
     * over 1 ms; an onset is where that envelope crosses [thresholdRatio] of the
     * loudest hit and has been quiet for [refractoryMs]. The position is the
     * first SAMPLE reaching a third of the local peak, sharper than the 1 ms grid.
     */
    fun detectOnsets(
        signal: FloatArray,
        sampleRate: Int,
        thresholdRatio: Double = 0.3,
        refractoryMs: Double = 120.0,
    ): List<Int> {
        val refractory = (refractoryMs / 1000.0 * sampleRate).toInt()
        val hop = max(1, sampleRate / 1000)
        val frames = (signal.size - 1) / hop
        if (frames <= 0) return emptyList()
        val env = FloatArray(frames)
        var maxEnv = 0f
        for (f in 0 until frames) {
            var s = 0.0
            val base = f * hop + 1
            for (i in 0 until hop) s += abs(signal[base + i] - signal[base + i - 1])
            env[f] = (s / hop).toFloat()
            if (env[f] > maxEnv) maxEnv = env[f]
        }
        if (maxEnv == 0f) return emptyList()
        val threshold = maxEnv * thresholdRatio
        val out = ArrayList<Int>()
        var lastOnset = Int.MIN_VALUE / 2
        for (f in 0 until frames) {
            if (env[f] < threshold) continue
            val at = f * hop
            if (at - lastOnset < refractory) continue
            var localPeak = 0f
            val peakEnd = min(signal.size, at + (0.005 * sampleRate).toInt())
            for (i in max(0, at - hop) until peakEnd) localPeak = max(localPeak, abs(signal[i]))
            var onset = at
            for (i in max(0, at - hop) until peakEnd) {
                if (abs(signal[i]) >= localPeak / 3) {
                    onset = i
                    break
                }
            }
            out += onset
            lastOnset = at
        }
        return out
    }

    fun median(values: List<Double>): Double {
        if (values.isEmpty()) return Double.NaN
        val s = values.sorted()
        val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2
    }
}
