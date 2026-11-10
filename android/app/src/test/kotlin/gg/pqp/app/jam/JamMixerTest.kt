package gg.pqp.app.jam

import gg.pqp.app.jam.audio.JamAlignment
import gg.pqp.app.jam.audio.JamMixer
import gg.pqp.app.jam.audio.JamResampler
import gg.pqp.app.jam.audio.JamStemSpec
import gg.pqp.app.jam.audio.MIX_RATE
import gg.pqp.app.jam.audio.PcmSource
import gg.pqp.app.jam.audio.ShortArrayPcm
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE ALIGNMENT PROOF. Stems are impulse trains with known positions in the
 * stored file; the real mixer renders them against the real placement
 * arithmetic, and the test reads where each impulse lands in the OUTPUT, in
 * frames, and compares with what the timeline rule (`jam.ts`, "THE TIMELINE":
 * `offsetMs` is the stored file's FIRST sample, a trim hides audio without moving
 * it) says by hand. No hardware: the mixer is pure and the audio thread only
 * writes what it renders. `JamWebTakeAlignmentTest` plays takes shaped like the
 * web recorder's uploads.
 *
 * The cases are the ones that go wrong: a negative `offsetMs` (a count-in), both
 * trims (head and tail, with an impulse just inside and just outside each), a
 * start in the middle of the song, a late stem, and a stem recorded at 44.1 kHz
 * brought to the 48 kHz mix.
 */
class JamMixerTest {

    private val level = 20_000.toShort()

    /** A stored stem of [length] frames with an impulse at each of [at]. */
    private fun stem(length: Int, vararg at: Int): ShortArray =
        ShortArray(length).also { samples -> at.forEach { samples[it] = level } }

    private fun frames(ms: Double) = JamAlignment.frames(ms)

    private fun placed(
        spec: JamStemSpec,
        samples: ShortArray,
        origin: Double,
    ): Pair<gg.pqp.app.jam.audio.JamPlacement, PcmSource> {
        val pcm = ShortArrayPcm(samples)
        return checkNotNull(JamAlignment.place(spec, pcm.frames, origin)) { "no slice" } to pcm
    }

    /** The left channel of [total] frames rendered from [from] in blocks of [chunk]. */
    private fun render(mixer: JamMixer, from: Long, total: Int, chunk: Int = 1024): ShortArray {
        val out = ShortArray(total)
        val block = ShortArray(chunk * 2)
        var done = 0
        while (done < total) {
            val n = minOf(chunk, total - done)
            mixer.render(from + done, block, n, scratch = ShortArray(chunk), acc = FloatArray(chunk))
            for (i in 0 until n) out[done + i] = block[2 * i]
            done += n
        }
        return out
    }

    private fun framesWithSound(samples: ShortArray): List<Int> =
        samples.indices.filter { samples[it].toInt() != 0 }

    /** The four stems at once: A, B (count-in), C (both trims) and a late one. */
    private fun scenario(): Triple<JamMixer, Long, Map<String, ShortArray>> {
        val a = JamStemSpec("a", offsetMs = 0.0, trimStartMs = 0.0, trimEndMs = 0.0)
        val b = JamStemSpec("b", offsetMs = -250.0, trimStartMs = 0.0, trimEndMs = 0.0)
        val c = JamStemSpec("c", offsetMs = 100.0, trimStartMs = 200.0, trimEndMs = 300.0)
        val late = JamStemSpec("late", offsetMs = 837.0, trimStartMs = 0.0, trimEndMs = 0.0)
        val specs = listOf(a, b, c, late)
        val origin = JamAlignment.originMs(specs)
        val files = mapOf(
            "a" to stem(12_000, 0, 11_999),
            "b" to stem(6_000, 0, 5_999),
            // 1.25 s file: head trim 9600 frames, tail trim 14400. Impulses at the first heard sample, one just
            // before it (cut), the last heard sample, and one just after it (cut).
            "c" to stem(60_000, 9_599, 9_600, 45_599, 45_600),
            "late" to stem(4_800, 0),
        )
        val mixer = JamMixer()
        mixer.setStems(specs.map { placed(it, files.getValue(it.id), origin) })
        return Triple(mixer, JamAlignment.durationFrames(specs.map { JamAlignment.place(it, files.getValue(it.id).size.toLong(), origin)!! }), files)
    }

    @Test
    fun `each stem's first and last played sample land where the timeline rule says`() {
        val (mixer, duration, _) = scenario()
        val out = render(mixer, 0, duration.toInt() + 100)
        val at = framesWithSound(out)

        // Origin is the earliest heard sample, b at -250 ms, so song time t sits at (t + 250) ms = (t + 250) * 48 frames.
        // b: first sample at 0, last (5999) at 5999.
        // a: offset 0 is 12000 frames in; its last sample is 12000 + 11999.
        // c: its FILE starts at (100 + 250) * 48 = 16800 and a trim moves nothing, so file frame j sounds at 16800 + j.
        //    The heard slice is file frames 9600..45599: the first heard sample is at 16800 + 9600 = 26400 and the last
        //    at 16800 + 45599 = 62399. The impulses at 9599 and 45600 are cut by the trims.
        // late: (837 + 250) * 48 = 52176.
        println("alignment (frames): $at")
        assertEquals(listOf(0, 5_999, 12_000, 23_999, 26_400, 62_399, 52_176).sorted(), at)
    }

    @Test
    fun `frames just outside both trims are absent`() {
        val (mixer, duration, _) = scenario()
        val out = render(mixer, 0, duration.toInt() + 100)
        // File frame 9599 would be at 26399, file frame 45600 at 62400.
        assertEquals(0, out[26_399].toInt())
        assertEquals(0, out[62_400].toInt())
        assertEquals(level.toInt(), out[26_400].toInt())
        assertEquals(level.toInt(), out[62_399].toInt())
    }

    @Test
    fun `starting in the middle of the song plays the same frames from there`() {
        val (mixer, duration, _) = scenario()
        val whole = render(mixer, 0, duration.toInt() + 100)
        // Start 0.5 s in, in the middle of c.
        val from = 24_000
        val tail = render(mixer, from.toLong(), duration.toInt() + 100 - from)
        assertEquals(whole.drop(from), tail.toList())
        // c's last heard sample, seen from there.
        assertEquals(level.toInt(), tail[62_399 - from].toInt())
    }

    @Test
    fun `the block size cannot move anything`() {
        val (mixer, duration, _) = scenario()
        val total = duration.toInt() + 100
        val reference = render(mixer, 0, total, chunk = 1024)
        for (chunk in listOf(1, 7, 333, 1000, 4096)) {
            assertEquals("chunk $chunk", reference.toList(), render(mixer, 0, total, chunk = chunk).toList())
        }
    }

    @Test
    fun `a later stem is 37 ms behind an earlier one, to the frame`() {
        val first = JamStemSpec("first", 0.0, 0.0, 0.0)
        val second = JamStemSpec("second", 37.0, 0.0, 0.0)
        val origin = JamAlignment.originMs(listOf(first, second))
        val mixer = JamMixer()
        mixer.setStems(listOf(placed(first, stem(4_800, 0), origin), placed(second, stem(4_800, 0), origin)))
        val at = framesWithSound(render(mixer, 0, 9_000))
        assertEquals(listOf(0, 37 * 48), at)
    }

    @Test
    fun `a stem recorded at 44_1 kHz lands on the same frame as one at 48 kHz`() {
        // Impulse at source frame 22050 of a 44.1 kHz file: 0.5 s, so frame 24000 at 48 kHz.
        val source = ShortArray(44_100).also { it[22_050] = level }
        val resampled = ArrayList<Short>()
        JamResampler.resample(ShortArrayPcm(source), 44_100, MIX_RATE) { block, count ->
            for (i in 0 until count) resampled += block[i]
        }
        assertEquals(48_000, resampled.size)
        val peak = resampled.indices.maxBy { resampled[it].toInt() }
        println("44.1 kHz impulse at source 22050 (expected 24000 at 48 kHz) landed at $peak")
        assertEquals(24_000, peak)

        // And in the mix, beside a native 48 kHz stem with its impulse at 0.5 s.
        val native = JamStemSpec("native", 0.0, 0.0, 0.0)
        val converted = JamStemSpec("converted", 0.0, 0.0, 0.0)
        val mixer = JamMixer()
        val nativeSamples = ShortArray(48_000).also { it[24_000] = level }
        mixer.setStems(
            listOf(
                placed(native, nativeSamples, 0.0),
                placed(converted, resampled.toShortArray(), 0.0),
            ),
        )
        val out = render(mixer, 0, 48_000)
        val loudest = out.indices.maxBy { out[it].toInt() }
        assertEquals(24_000, loudest)
    }

    @Test
    fun `a 44_1 kHz stem with a trim and an offset keeps its place`() {
        // Offset 100 ms (the file's first sample), head trim 200 ms hidden from it: heard from song time 300 ms, which
        // is this stem's own origin. Impulse at stored 0.45 s: 250 ms after the cut.
        val source = ShortArray(44_100).also { it[(0.45 * 44_100).toInt()] = level }
        val resampled = ArrayList<Short>()
        JamResampler.resample(ShortArrayPcm(source), 44_100, MIX_RATE) { block, count ->
            for (i in 0 until count) resampled += block[i]
        }
        val spec = JamStemSpec("x", offsetMs = 100.0, trimStartMs = 200.0, trimEndMs = 0.0)
        val mixer = JamMixer()
        mixer.setStems(listOf(placed(spec, resampled.toShortArray(), JamAlignment.originMs(listOf(spec)))))
        val out = render(mixer, 0, 30_000)
        // The heard slice starts at the origin (frame 0). The impulse is 250 ms into it: 12000 frames.
        val peak = out.indices.maxBy { out[it].toInt() }
        println("44.1 kHz stem, offset 100 ms, trim 200 ms: impulse at $peak (expected 12000)")
        assertEquals(12_000, peak)
    }

    @Test
    fun `a stem that trims to nothing is not placed`() {
        assertEquals(null, JamAlignment.place(JamStemSpec("x", 0.0, 600.0, 600.0), 48_000, 0.0))
    }

    @Test
    fun `one stem at unity comes out sample for sample`() {
        val samples = ShortArray(3_000) { ((it * 37) % 30_000 - 15_000).toShort() }
        val spec = JamStemSpec("x", 0.0, 0.0, 0.0)
        val mixer = JamMixer()
        mixer.setStems(listOf(placed(spec, samples, 0.0)))
        assertEquals(samples.toList(), render(mixer, 0, 3_000).toList())
    }

    @Test
    fun `a level of zero is silence and a mute does not click`() {
        val samples = ShortArray(2_048) { 10_000 }
        val spec = JamStemSpec("x", 0.0, 0.0, 0.0)
        val mixer = JamMixer()
        mixer.setStems(listOf(placed(spec, samples, 0.0)))
        mixer.snapLevels()
        mixer.setLevel("x", 0f)
        val out = render(mixer, 0, 2_048, chunk = 1024)
        // The first buffer ramps down across itself, the second is silent.
        assertTrue("ramps", out[0] > out[1_023])
        assertTrue("no jump at the start", out[0] > 9_000)
        assertEquals(0, out[1_024].toInt())
        assertEquals(0, out[2_047].toInt())
    }

    @Test
    fun `two stems sum, and a loud mix saturates instead of wrapping`() {
        val a = ShortArray(100) { 30_000 }
        val b = ShortArray(100) { 30_000 }
        val spec = JamStemSpec("a", 0.0, 0.0, 0.0)
        val mixer = JamMixer()
        mixer.setStems(listOf(placed(spec, a, 0.0), placed(spec.copy(id = "b"), b, 0.0)))
        val out = render(mixer, 0, 100)
        assertTrue(out.all { it > 30_000 && it <= Short.MAX_VALUE })
    }

    @Test
    fun `duration is from the earliest heard sample to the latest`() {
        val (_, duration, _) = scenario()
        // b starts at 0; the latest end is a's 24000, late's 52176 + 4800 = 56976 or c's: its file starts at 16800
        // and 14400 frames of its tail are hidden, so it is heard to 16800 + 60000 - 14400 = 62400.
        assertEquals(62_400L, duration)
    }
}
