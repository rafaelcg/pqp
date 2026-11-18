package gg.pqp.app.jam.record

import java.util.Random
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The calibration's measurement, against recordings made here with a known
 * delay in them: where it finds a sound, how it ignores a room's echo and a
 * reversed microphone, how it judges a result, and which stored result wins.
 */
class JamLatencyTest {
    private val rate = 48_000
    private val ref = JamSignals.sweep(rate, amplitude = 0.7f)

    /** A recording of [seconds] with [ref] heard at each of [frames] (capture frames), plus noise. */
    private fun heard(frames: List<Int>, seconds: Double = 8.0, noise: Double = 0.003, gain: Float = 0.4f, seed: Long = 1): FloatArray {
        val r = Random(seed)
        val out = FloatArray((seconds * rate).toInt()) { (r.nextGaussian() * noise).toFloat() }
        for (f in frames) for (i in ref.indices) if (f + i < out.size) out[f + i] += ref[i] * gain
        return out
    }

    private fun predicted(count: Int = 10, first: Int = 14_400, period: Int = 33_600) = List(count) { first + it * period }

    @Test
    fun `a sweep heard some milliseconds after the platform said it would be is found to the sample`() {
        val expected = predicted()
        for (lagMs in listOf(0.0, 3.0, 21.5, 87.25, 240.0, -40.0)) {
            val lagFrames = Math.round(lagMs * rate / 1000).toInt()
            val rec = heard(expected.map { it + lagFrames })
            val r = JamLatency.analyseLoopback(rec, expected.map { it.toDouble() }, ref, rate, ClockMode.TIMESTAMPS, 1L)
            println("RESULT loopback lag $lagMs ms: found ${r.correctionMs} ms, ${r.confidence}, spread ${r.spreadMs}")
            assertTrue("$lagMs ms: $r", r.usable)
            assertEquals(lagMs, r.correctionMs, 0.03)
        }
    }

    @Test
    fun `a microphone that inverts the signal is found the same`() {
        val expected = predicted()
        val rec = heard(expected.map { it + 1000 }, gain = -0.4f)
        val r = JamLatency.analyseLoopback(rec, expected.map { it.toDouble() }, ref, rate, ClockMode.TIMESTAMPS, 1L)
        assertEquals(1000.0 * 1000 / rate, r.correctionMs, 0.03)
    }

    @Test
    fun `a wall's louder echo a few milliseconds later does not move the answer`() {
        val expected = predicted()
        val direct = expected.map { it + 960 }
        val rec = heard(direct, gain = 0.3f)
        // The same sound again 6 ms later and twice as loud, as a hard wall gives.
        for (f in direct) for (i in ref.indices) rec[f + 288 + i] += ref[i] * 0.6f
        val r = JamLatency.analyseLoopback(rec, expected.map { it.toDouble() }, ref, rate, ClockMode.TIMESTAMPS, 1L)
        assertEquals("the DIRECT sound, not the loudest copy", 20.0, r.correctionMs, 0.05)
    }

    @Test
    fun `a microphone that cannot hear the speaker fails and says so rather than inventing a number`() {
        val expected = predicted()
        val rec = heard(emptyList(), noise = 0.02)
        val r = JamLatency.analyseLoopback(rec, expected.map { it.toDouble() }, ref, rate, ClockMode.TIMESTAMPS, 1L)
        println("RESULT silent microphone: ${r.confidence}, accepted ${r.accepted} of ${r.played}")
        assertEquals(LatencyConfidence.FAILED, r.confidence)
        assertFalse(r.usable)
        assertTrue(r.correctionMs.isNaN())
    }

    @Test
    fun `a few pulses found among many that were lost is low confidence and is not used`() {
        val expected = predicted()
        val rec = heard(expected.take(4).map { it + 1200 })
        val r = JamLatency.analyseLoopback(rec, expected.map { it.toDouble() }, ref, rate, ClockMode.TIMESTAMPS, 1L)
        assertEquals(LatencyConfidence.LOW, r.confidence)
        assertFalse("a measurement that found 4 of 10 must not place a take", r.usable)
    }

    @Test
    fun `an outlier among good pulses is dropped and the spread is what is left`() {
        val expected = predicted()
        val frames = expected.mapIndexed { i, f -> f + 1200 + if (i == 3) 480 else 0 }
        val r = JamLatency.analyseLoopback(heard(frames), expected.map { it.toDouble() }, ref, rate, ClockMode.TIMESTAMPS, 1L)
        assertEquals(25.0, r.correctionMs, 0.05)
        assertEquals(9, r.accepted)
        assertEquals(LatencyConfidence.HIGH, r.confidence)
    }

    // --- tap-along ---

    /** Claps: a short burst of noise at each frame. */
    private fun claps(at: List<Int>, seconds: Double = 9.0): FloatArray {
        val r = Random(11)
        val out = FloatArray((seconds * rate).toInt()) { (r.nextGaussian() * 0.002).toFloat() }
        for (f in at) for (i in 0 until 480) out[f + i] += (r.nextGaussian() * 0.5 * exp(-i / 120.0)).toFloat() + (0.6 * sin(i * 0.4) * exp(-i / 90.0)).toFloat()
        return out
    }

    @Test
    fun `a person tapping along is measured as the median of how late their taps are`() {
        val expected = List(12) { 24_000 + it * 28_800 }
        val r = Random(2)
        // They tap 35 ms after each click with a few milliseconds of human wobble, and miss the first two (warm-up).
        val taps = expected.map { it + (35 * rate / 1000) + Math.round(r.nextGaussian() * 2.0 * rate / 1000).toInt() }
        val result = JamLatency.analyseTapAlong(claps(taps), expected.map { it.toDouble() }, rate, ClockMode.TIMESTAMPS, 1L)
        println("RESULT tap-along: ${result.correctionMs} ms, ${result.confidence}, spread ${result.spreadMs}, ${result.accepted}/${result.played}")
        assertTrue(result.usable)
        assertEquals(35.0, result.correctionMs, 3.0)
    }

    @Test
    fun `taps that never happen fail`() {
        val expected = List(12) { 24_000 + it * 28_800 }
        val result = JamLatency.analyseTapAlong(FloatArray(9 * rate), expected.map { it.toDouble() }, rate, ClockMode.TIMESTAMPS, 1L)
        assertEquals(LatencyConfidence.FAILED, result.confidence)
    }

    @Test
    fun `a missed tap does not let the next click's tap count twice`() {
        val expected = List(12) { 24_000 + it * 28_800 }
        // Tap every click 40 ms late except click 5, which is skipped.
        val taps = expected.filterIndexed { i, _ -> i != 5 }.map { it + 40 * rate / 1000 }
        val result = JamLatency.analyseTapAlong(claps(taps), expected.map { it.toDouble() }, rate, ClockMode.TIMESTAMPS, 1L)
        assertEquals(40.0, result.correctionMs, 1.0)
        assertEquals(9, result.accepted)
    }

    // --- choosing and keeping ---

    private fun stored(method: String, c: Double, at: Long, mode: String = ClockMode.TIMESTAMPS, confidence: String = LatencyConfidence.HIGH) =
        LatencyResult(method, c, confidence, 0.1, 9, 10, at, mode)

    @Test
    fun `a typed number beats a loopback, a loopback beats a tap-along, the newest of a kind wins`() {
        val list = listOf(
            stored(LatencyMethod.TAP_ALONG, 10.0, 5),
            stored(LatencyMethod.LOOPBACK, 20.0, 1),
            stored(LatencyMethod.LOOPBACK, 21.0, 2),
        )
        assertEquals(21.0, JamLatency.choose(list, ClockMode.TIMESTAMPS)!!.correctionMs, 0.0)
        assertEquals(7.0, JamLatency.choose(list + JamLatency.manual(7.0, now = 3), ClockMode.TIMESTAMPS)!!.correctionMs, 0.0)
        assertEquals(10.0, JamLatency.choose(listOf(stored(LatencyMethod.TAP_ALONG, 10.0, 5)), ClockMode.TIMESTAMPS)!!.correctionMs, 0.0)
    }

    @Test
    fun `a measurement from another clock mode, a failed one and a low one are not used`() {
        val approx = stored(LatencyMethod.LOOPBACK, 20.0, 1, mode = ClockMode.APPROXIMATE)
        assertNull(JamLatency.choose(listOf(approx), ClockMode.TIMESTAMPS))
        assertEquals(20.0, JamLatency.choose(listOf(approx), ClockMode.APPROXIMATE)!!.correctionMs, 0.0)
        assertNull(JamLatency.choose(listOf(stored(LatencyMethod.LOOPBACK, Double.NaN, 1, confidence = LatencyConfidence.FAILED)), ClockMode.TIMESTAMPS))
        assertNull(JamLatency.choose(listOf(stored(LatencyMethod.LOOPBACK, 20.0, 1, confidence = LatencyConfidence.LOW)), ClockMode.TIMESTAMPS))
        // A correction past any platform's error is a search that went wrong, not a measurement.
        assertNull(JamLatency.choose(listOf(stored(LatencyMethod.LOOPBACK, 900.0, 1)), ClockMode.TIMESTAMPS))
        assertNull(JamLatency.choose(emptyList(), ClockMode.TIMESTAMPS))
    }

    private class MapKv : KeyValue {
        val map = HashMap<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String) {
            map[key] = value
        }

        override fun remove(key: String) {
            map.remove(key)
        }
    }

    @Test
    fun `the store keeps one result per method per route and survives being read again`() {
        val kv = MapKv()
        val store = JamLatencyStore(kv)
        store.save("route-a", stored(LatencyMethod.LOOPBACK, 20.0, 1))
        store.save("route-a", stored(LatencyMethod.LOOPBACK, 22.0, 2))
        store.save("route-a", stored(LatencyMethod.TAP_ALONG, 30.0, 3))
        store.save("route-b", stored(LatencyMethod.LOOPBACK, -5.0, 4))
        // A failed result is never kept, so a bad re-measure cannot replace a good one.
        store.save("route-a", stored(LatencyMethod.LOOPBACK, Double.NaN, 9, confidence = LatencyConfidence.FAILED))
        val again = JamLatencyStore(kv)
        assertEquals(listOf(22.0, 30.0), again.get("route-a").map { it.correctionMs }.sorted())
        assertEquals(listOf(-5.0), again.get("route-b").map { it.correctionMs })
        assertTrue(again.get("route-c").isEmpty())
        again.clear("route-a")
        assertTrue(JamLatencyStore(kv).get("route-a").isEmpty())
        assertEquals(1, JamLatencyStore(kv).get("route-b").size)
    }

    @Test
    fun `a garbled store reads as empty instead of crashing`() {
        val kv = MapKv().also { it.map["latency.v1"] = "{not json" }
        assertTrue(JamLatencyStore(kv).get("anything").isEmpty())
        JamLatencyStore(kv).save("r", stored(LatencyMethod.LOOPBACK, 1.0, 1))
        assertEquals(1, JamLatencyStore(kv).get("r").size)
    }

    @Test
    fun `the onset detector finds each clap once and ignores a steady hum`() {
        val at = listOf(10_000, 40_000, 70_000)
        val hum = FloatArray(110_000) { (0.05 * sin(it * 0.01)).toFloat() }
        val clap = claps(at, 2.3)
        for (i in hum.indices) if (i < clap.size) hum[i] += clap[i]
        val onsets = JamXcorr.detectOnsets(hum, rate)
        assertEquals(3, onsets.size)
        for ((o, w) in onsets.zip(at)) assertTrue("onset $o vs $w", abs(o - w) < 100)
        assertNotEquals(0, onsets.size)
    }

    @Test
    fun `a typed or learned correction applies in either clock mode, a measurement only in its own`() {
        val manual = JamLatency.manual(-12.0, ClockMode.TIMESTAMPS, 1L)
        assertEquals(-12.0, JamLatency.choose(listOf(manual), ClockMode.APPROXIMATE)!!.correctionMs, 0.0)
        assertNull(JamLatency.choose(listOf(stored(LatencyMethod.LOOPBACK, 5.0, 1)), ClockMode.APPROXIMATE))
    }

    @Test
    fun `after one strong pulse the others are searched near it, and a pulse that moved is still found`() {
        val expected = predicted()
        // Nine pulses 20 ms after the prediction and the sixth 90 ms after it (outside the narrow window): the wide search finds it.
        val frames = expected.mapIndexed { i, f -> f + if (i == 5) 4320 else 960 }
        val r = JamLatency.analyseLoopback(heard(frames), expected.map { it.toDouble() }, ref, rate, ClockMode.TIMESTAMPS, 1L)
        assertEquals(20.0, r.correctionMs, 0.05)
        assertEquals("the moved pulse is an outlier, found and dropped", 9, r.accepted)
    }
}
