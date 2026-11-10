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
 * rate goes down so nothing folds over. The kernel is a table with linear
 * interpolation between entries, so a fractional position costs a multiply, not
 * a `sin`.
 */
object JamResampler {
    private const val HALF_TAPS = 16
    private const val TABLE_RES = 1024

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
        val total = outputFrames(src.frames, srcRate, dstRate)
        val ratio = srcRate.toDouble() / dstRate
        val cutoff = min(1.0, dstRate.toDouble() / srcRate)
        // How many source samples reach each side: the half width grows when the cutoff drops.
        val reach = (HALF_TAPS / cutoff).toInt() + 1
        val table = kernelTable(cutoff, HALF_TAPS / cutoff)
        val tableScale = TABLE_RES.toDouble()

        val out = ShortArray(blockFrames)
        val window = ShortArray(Math.ceil(blockFrames * ratio).toInt() + 2 * reach + 4)
        var produced = 0L
        while (produced < total) {
            val count = min(blockFrames.toLong(), total - produced).toInt()
            // The source span this block touches.
            val firstPos = produced * ratio
            val lastPos = (produced + count - 1) * ratio
            val base = firstPos.toLong() - reach
            val span = (lastPos.toLong() + reach + 1 - base + 1).toInt()
            src.read(base, window, 0, min(span, window.size))
            if (span > window.size) error("resampler window too small")
            for (j in 0 until count) {
                val pos = (produced + j) * ratio
                val center = pos.toLong()
                var sum = 0.0
                for (k in -reach..reach + 1) {
                    // Distance from the sample to the wanted instant, in source samples.
                    val d = (center + k) - pos
                    val index = Math.abs(d) * tableScale
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

    /** The kernel at distance `i / TABLE_RES` source samples, for `i` in 0..width*TABLE_RES. */
    private fun kernelTable(cutoff: Double, width: Double): DoubleArray {
        val size = (width * TABLE_RES).toInt() + 2
        return DoubleArray(size) { i ->
            val d = i.toDouble() / TABLE_RES
            if (d >= width) {
                0.0
            } else {
                val x = PI * d * cutoff
                val sinc = if (x == 0.0) 1.0 else sin(x) / x
                cutoff * sinc * blackmanHarris(d / width)
            }
        }
    }

    /** 4-term Blackman-Harris, 1 at the centre and 0 at +-1. [t] is the distance as a fraction of the half width. */
    private fun blackmanHarris(t: Double): Double {
        val x = PI * (1.0 + t)
        return 0.35875 - 0.48829 * cos(x) + 0.14128 * cos(2 * x) - 0.01168 * cos(3 * x)
    }
}
