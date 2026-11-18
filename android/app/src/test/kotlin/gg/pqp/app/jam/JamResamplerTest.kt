package gg.pqp.app.jam

import gg.pqp.app.jam.audio.JamResampler
import gg.pqp.app.jam.audio.ShortArrayPcm
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The resampler brings every stem to the mix rate with NO delay (a streaming
 * resampler's group delay is what put the iOS engine's 44.1 kHz impulse 17
 * frames late). An impulse at source sample `n` has to come out at
 * `n * dst / src`, within half a sample, for every ratio a recorder can hand us.
 */
class JamResamplerTest {

    private fun resample(source: ShortArray, from: Int, to: Int): ShortArray {
        val out = ArrayList<Short>()
        JamResampler.resample(ShortArrayPcm(source), from, to, blockFrames = 1000) { block, count ->
            for (i in 0 until count) out += block[i]
        }
        return out.toShortArray()
    }

    private fun impulseAt(length: Int, at: Int) = ShortArray(length).also { it[at] = 20_000 }

    @Test
    fun `an impulse lands where the ratio says, for every rate a recorder can make`() {
        for ((rate, at) in listOf(44_100 to 22_050, 44_100 to 12_345, 22_050 to 11_025, 32_000 to 16_000, 96_000 to 48_000, 88_200 to 44_100, 16_000 to 8_000, 8_000 to 4_000)) {
            val out = resample(impulseAt(rate, at), rate, 48_000)
            val expected = at.toDouble() * 48_000 / rate
            val peak = out.indices.maxBy { out[it].toInt() }
            assertEquals("$rate Hz, impulse $at: the length", 48_000, out.size)
            assertTrue("$rate Hz: expected ${"%.2f".format(expected)}, got $peak", abs(peak - expected) <= 0.5)
        }
    }

    @Test
    fun `a rate with too many phases for the exact path still lands where the ratio says`() {
        // 44101 Hz against 48000 has 48000 phases: the kernel-table fallback.
        val out = resample(impulseAt(44_101, 22_050), 44_101, 48_000)
        val expected = 22_050.0 * 48_000 / 44_101
        val peak = out.indices.maxBy { out[it].toInt() }
        assertTrue("expected ${"%.2f".format(expected)}, got $peak", abs(peak - expected) <= 0.5)
    }

    @Test
    fun `ten minutes of 44_1 kHz stays in the seconds and does not need the stem in memory twice`() {
        // The cost the polyphase path exists for. Not an assertion on speed (CI machines differ), a guard that
        // the 28.8 million outputs of a ten-minute stem come out and the length is right.
        val frames = 44_100 * 60 * 2
        val source = ShortArray(frames) { ((it % 100) * 100 - 5_000).toShort() }
        var produced = 0L
        val started = System.nanoTime()
        JamResampler.resample(ShortArrayPcm(source), 44_100, 48_000) { _, count -> produced += count }
        println("two minutes of 44.1 kHz resampled in ${(System.nanoTime() - started) / 1_000_000} ms on this machine")
        assertEquals(JamResampler.outputFrames(frames.toLong(), 44_100, 48_000), produced)
    }

    @Test
    fun `the same rate is one multiply and not a delay`() {
        val source = impulseAt(10_000, 4_321)
        val out = resample(source, 48_000, 48_000)
        assertEquals(source.toList(), out.toList())
    }

    @Test
    fun `a tone keeps its level and its phase`() {
        // 1 kHz at 44.1 kHz, 0.5 s, amplitude 10000. Compare with the same tone computed at 48 kHz in the middle,
        // where neither edge matters: same phase means the error is small everywhere.
        val src = ShortArray(22_050) { (10_000 * sin(2 * PI * 1000 * it / 44_100)).roundToInt().toShort() }
        val out = resample(src, 44_100, 48_000)
        var worst = 0
        for (i in 2_000 until out.size - 2_000) {
            val ideal = (10_000 * sin(2 * PI * 1000 * i / 48_000)).roundToInt()
            worst = maxOf(worst, abs(out[i] - ideal))
        }
        println("1 kHz tone 44.1 -> 48 kHz, worst error against the ideal: $worst of 10000")
        assertTrue("worst error $worst", worst < 40)
    }

    @Test
    fun `going down does not fold a tone above the new Nyquist back in`() {
        // 30 kHz at 96 kHz is above the 24 kHz Nyquist of 48 kHz: it must be filtered, not aliased to 18 kHz.
        val src = ShortArray(96_000 / 4) { (10_000 * sin(2 * PI * 30_000 * it / 96_000)).roundToInt().toShort() }
        val out = resample(src, 96_000, 48_000)
        val loudest = (1_000 until out.size - 1_000).maxOf { abs(out[it].toInt()) }
        println("30 kHz tone at 96 kHz brought to 48 kHz: loudest remaining sample $loudest of 10000")
        assertTrue("aliased: $loudest", loudest < 300)
    }

    @Test
    fun `an empty stem stays empty`() {
        assertEquals(0, resample(ShortArray(0), 44_100, 48_000).size)
    }
}
