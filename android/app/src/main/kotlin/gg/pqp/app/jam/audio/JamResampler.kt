package gg.pqp.app.jam.audio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.math.sin

/**
 * Brings a decoded stem to the mix rate, offline, with NO delay.
 *
 * A stem recorded and encoded at 44.1 kHz has to land on the same timeline as
 * one at 48 kHz. A streaming resampler (the platform's, `AVAudioMixerNode` on
 * iOS) adds its own group delay, which is how the iOS engine measured a 44.1 kHz
 * impulse 17 frames late. This one is non-causal on purpose: output sample `j`
 * is the band-limited reconstruction of the source at the exact source time
 * `j * srcRate / dstRate`, so an impulse at source sample `n` is at output
 * `n * dstRate / srcRate` to within half a sample, whatever the ratio.
 *
 * Windowed sinc (4-term Blackman-Harris, about -92 dB stop band), 16 source
 * taps each side, the cutoff pulled down to the destination's Nyquist when the
 * rate goes down so nothing folds over.
 *
 * COST. A ten-minute stem is 28.8 million output samples at 36 taps each, so the
 * inner loop has to be a plain multiply-add. For every ratio a recorder produces
 * (44.1 to 48 kHz is 160/147) the source position repeats after `dst / gcd`
 * outputs, so each of those phases has its own weights, computed once: the loop
 * is `window[i] * weights[phase][t]` with no table lookup, no interpolation and
 * no `abs`. A ratio with more than [MAX_PHASES] phases (nothing a recorder
 * makes) falls back to a kernel table with linear interpolation.
 */
object JamResampler {
    private const val HALF_TAPS = 16
    private const val TABLE_RES = 1024

    /** Most distinct source phases the exact polyphase path will hold weights for. */
    private const val MAX_PHASES = 2048

    /** Frames the output has for [srcFrames] at [srcRate] when brought to [dstRate]. */
    fun outputFrames(srcFrames: Long, srcRate: Int, dstRate: Int): Long =
        (srcFrames.toDouble() * dstRate / srcRate).roundToLong()

    /**
     * Resamples [src] and hands the output to [sink] in blocks. [sink] is
     * called with the same array each time (copy it if you keep it).
     */
    fun resample(
        src: PcmSource,
        srcRate: Int,
        dstRate: Int,
        blockFrames: Int = 8192,
        sink: (block: ShortArray, count: Int) -> Unit,
    ) {
        require(srcRate > 0 && dstRate > 0)
        val divisor = gcd(srcRate, dstRate)
        val phases = dstRate / divisor
        if (phases <= MAX_PHASES) {
            polyphase(src, srcRate / divisor, phases, srcRate, dstRate, blockFrames, sink)
        } else {
            tabled(src, srcRate, dstRate, blockFrames, sink)
        }
    }

    private fun gcd(a: Int, b: Int): Int = if (b == 0) a else gcd(b, a % b)

    private fun cutoffOf(srcRate: Int, dstRate: Int) = min(1.0, dstRate.toDouble() / srcRate)

    /** The kernel at distance [d] source samples: windowed sinc, [cutoff] times the Nyquist, [width] samples to a side. */
    private fun kernel(d: Double, cutoff: Double, width: Double): Double {
        val a = kotlin.math.abs(d)
        if (a >= width) return 0.0
        val x = PI * a * cutoff
        val sinc = if (x == 0.0) 1.0 else sin(x) / x
        return cutoff * sinc * blackmanHarris(a / width)
    }

    // --- exact polyphase ---

    private fun polyphase(
        src: PcmSource,
        q: Int,
        p: Int,
        srcRate: Int,
        dstRate: Int,
        blockFrames: Int,
        sink: (block: ShortArray, count: Int) -> Unit,
    ) {
        val total = outputFrames(src.frames, srcRate, dstRate)
        val cutoff = cutoffOf(srcRate, dstRate)
        val width = HALF_TAPS / cutoff
        val reach = width.toInt() + 1
        val taps = 2 * reach + 2
        // Output j sits at source position j * q / p: the whole part picks the window, the remainder picks the weights.
        val weights = FloatArray(p * taps)
        for (phase in 0 until p) {
            val frac = phase.toDouble() / p
            for (t in 0 until taps) {
                weights[phase * taps + t] = kernel((t - reach) - frac, cutoff, width).toFloat()
            }
        }

        val out = ShortArray(blockFrames)
        val window = ShortArray((blockFrames.toLong() * q / p).toInt() + taps + 4)
        var produced = 0L
        while (produced < total) {
            val count = min(blockFrames.toLong(), total - produced).toInt()
            val firstCenter = produced * q / p
            val lastCenter = (produced + count - 1) * q / p
            val base = firstCenter - reach
            val span = (lastCenter + reach + 1 - base + 1).toInt()
            check(span <= window.size) { "resampler window too small" }
            src.read(base, window, 0, span)
            for (j in 0 until count) {
                val num = (produced + j) * q
                val center = num / p
                val weightsAt = (num % p).toInt() * taps
                val from = (center - reach - base).toInt()
                var sum = 0f
                for (t in 0 until taps) sum += window[from + t] * weights[weightsAt + t]
                out[j] = Math.round(sum).coerceIn(-32768, 32767).toShort()
            }
            sink(out, count)
            produced += count
        }
    }

    // --- the fallback: any ratio, a kernel table with linear interpolation ---

    private fun tabled(
        src: PcmSource,
        srcRate: Int,
        dstRate: Int,
        blockFrames: Int,
        sink: (block: ShortArray, count: Int) -> Unit,
    ) {
        val total = outputFrames(src.frames, srcRate, dstRate)
        val ratio = srcRate.toDouble() / dstRate
        val cutoff = cutoffOf(srcRate, dstRate)
        val width = HALF_TAPS / cutoff
        // How many source samples reach each side: the half width grows when the cutoff drops.
        val reach = width.toInt() + 1
        val table = DoubleArray((width * TABLE_RES).toInt() + 2) { i -> kernel(i.toDouble() / TABLE_RES, cutoff, width) }
        val tableScale = TABLE_RES.toDouble()

        val out = ShortArray(blockFrames)
        val window = ShortArray(Math.ceil(blockFrames * ratio).toInt() + 2 * reach + 4)
        var produced = 0L
        while (produced < total) {
            val count = min(blockFrames.toLong(), total - produced).toInt()
            val firstPos = produced * ratio
            val lastPos = (produced + count - 1) * ratio
            val base = firstPos.toLong() - reach
            val span = (lastPos.toLong() + reach + 1 - base + 1).toInt()
            check(span <= window.size) { "resampler window too small" }
            src.read(base, window, 0, span)
            for (j in 0 until count) {
                val pos = (produced + j) * ratio
                val center = pos.toLong()
                var sum = 0.0
                for (k in -reach..reach + 1) {
                    // Distance from the sample to the wanted instant, in source samples.
                    val index = Math.abs((center + k) - pos) * tableScale
                    val i0 = index.toInt()
                    if (i0 >= table.size - 1) continue
                    val w = table[i0] + (table[i0 + 1] - table[i0]) * (index - i0)
                    val at = (center + k - base).toInt()
                    if (at < 0 || at >= window.size) continue
                    sum += window[at] * w
                }
                out[j] = max(-32768.0, min(32767.0, Math.rint(sum))).toInt().toShort()
            }
            sink(out, count)
            produced += count
        }
    }

    /** 4-term Blackman-Harris, 1 at the centre and 0 at +-1. [t] is the distance as a fraction of the half width. */
    private fun blackmanHarris(t: Double): Double {
        val x = PI * (1.0 + t)
        return 0.35875 - 0.48829 * cos(x) + 0.14128 * cos(2 * x) - 0.01168 * cos(3 * x)
    }
}
