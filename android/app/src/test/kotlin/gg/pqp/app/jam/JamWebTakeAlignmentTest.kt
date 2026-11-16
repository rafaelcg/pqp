package gg.pqp.app.jam

import gg.pqp.app.jam.audio.JamAlignment
import gg.pqp.app.jam.audio.JamMixer
import gg.pqp.app.jam.audio.JamPlacement
import gg.pqp.app.jam.audio.JamResampler
import gg.pqp.app.jam.audio.JamStemSpec
import gg.pqp.app.jam.audio.MIX_RATE
import gg.pqp.app.jam.audio.PcmSource
import gg.pqp.app.jam.audio.ShortArrayPcm
import kotlin.math.abs
import kotlin.math.roundToLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * TAKES SHAPED THE WAY THE WEB RECORDER UPLOADS THEM, played by the real
 * placement arithmetic and the real mixer.
 *
 * The rule every stored take follows (`client/src/lib/jam/timeline.ts`,
 * `docs/JAM_ENGINE.md` "Mapping onto the server's track"): `offsetMs` is the
 * song time of the stored file's FIRST sample, and a trim hides audio without
 * moving it. A take recorded with a one-bar count-in is uploaded
 * `offsetMs -2023, trimStartMs 2023`: the count-in stays in the file, hidden,
 * and the first sound you hear is at song time 0.
 *
 * Each take below is silence with one-sample clicks at known SONG times, the
 * same three the iOS suite (`JamWebTakeAlignmentTests`) plays:
 *
 *   guitar  48 kHz   offset -2023  trimStart 2023  trimEnd 0     (count-in)
 *   bass    48 kHz   offset -137   trimStart 637   trimEnd 1000  (camera take trimmed in the editor)
 *   keys    44.1 kHz offset -2050  trimStart 2050  trimEnd 0     (count-in, resampled to the mix rate)
 *
 * A click at song time `s` is stored at file frame `(s - offsetMs) * rate / 1000`
 * and has to come out of the mixer at output frame `(s - origin) * 48`, where the
 * transport's zero (`origin`) is the earliest HEARD sample: song time 0 here.
 * The test reads the mixer's OUTPUT, never the placement, so it is the product's
 * answer that is compared with the web's.
 */
class JamWebTakeAlignmentTest {

    private class Take(
        val id: String,
        val rate: Int,
        val offsetMs: Double,
        val trimStartMs: Double,
        val trimEndMs: Double,
        /** Click song times, ms. Clicks under a trim exist in the file and must never be heard. */
        val clicks: List<Double>,
        val amplitude: Short,
    ) {
        val spec get() = JamStemSpec(id, offsetMs, trimStartMs, trimEndMs)

        /** The heard slice on the song timeline: [offset + trimStart, end - trimEnd). */
        val heardFromMs get() = offsetMs + trimStartMs
        val heardToMs get() = SONG_END_MS - trimEndMs
    }

    private fun everySecond(plus: Double) = (0 until SECONDS).map { it * 1000.0 + plus }

    private val guitar = Take("guitar", 48_000, -2023.0, 2023.0, 0.0, listOf(-1000.0) + everySecond(0.0), 16_000)
    private val bass = Take("bass", 48_000, -137.0, 637.0, 1000.0, everySecond(250.0), 12_000)
    private val keys = Take("keys", 44_100, -2050.0, 2050.0, 0.0, everySecond(500.0), 9_000)
    private val takes = listOf(guitar, bass, keys)

    /** The stored file of a take, at its own rate: silence to the song's end, with its clicks. */
    private fun stored(take: Take): ShortArray {
        val frames = ((SONG_END_MS - take.offsetMs) * take.rate / 1000.0).roundToLong().toInt()
        val samples = ShortArray(frames)
        for (click in take.clicks) {
            samples[((click - take.offsetMs) * take.rate / 1000.0).roundToLong().toInt()] = take.amplitude
        }
        return samples
    }

    /** What the app plays: the stored file at the mix rate (the decoder and the resampler do this in the app). */
    private fun atMixRate(take: Take): ShortArray {
        val file = stored(take)
        if (take.rate == MIX_RATE) return file
        val out = ShortArray(JamResampler.outputFrames(file.size.toLong(), take.rate, MIX_RATE).toInt())
        var at = 0
        JamResampler.resample(ShortArrayPcm(file), take.rate, MIX_RATE) { block, count ->
            block.copyInto(out, at, 0, count)
            at += count
        }
        assertEquals(out.size, at)
        return out
    }

    private val pcm: Map<String, ShortArray> by lazy { takes.associate { it.id to atMixRate(it) } }

    private class Loaded(val origin: Double, val placements: List<JamPlacement>) {
        val durationFrames get() = JamAlignment.durationFrames(placements).toInt()
    }

    /** Place the three takes the way `JamSongViewModel` does: one origin from every spec, one placement each. */
    private fun load(): Loaded {
        val origin = JamAlignment.originMs(takes.map { it.spec })
        return Loaded(origin, takes.map { checkNotNull(JamAlignment.place(it.spec, pcm.getValue(it.id).size.toLong(), origin)) })
    }

    /** A mixer holding only [chosen] of the placed takes. */
    private fun mixer(loaded: Loaded, chosen: List<Take>): JamMixer {
        val mixer = JamMixer()
        mixer.setStems(
            takes.indices.filter { takes[it] in chosen }
                .map { loaded.placements[it] to (ShortArrayPcm(pcm.getValue(takes[it].id)) as PcmSource) },
        )
        return mixer
    }

    /** Output frames from output frame [from], in blocks of [chunk] as the audio thread asks for them. */
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

    /**
     * The output frame of each click, counted from the transport's zero. A click that went through the resampler
     * rings a little either side of its peak (the kernel's side lobes stay under 4000 of the 9000 it started with),
     * so a click is the loudest frame of each run of frames above the threshold.
     */
    private fun heard(mixer: JamMixer, loaded: Loaded, from: Long, chunk: Int = 1024): List<Long> {
        val out = render(mixer, from, loaded.durationFrames + 100 - from.toInt(), chunk)
        val clicks = ArrayList<Long>()
        var best = -1
        var last = -1
        for (i in out.indices) {
            if (abs(out[i].toInt()) < THRESHOLD) continue
            if (best >= 0 && i - last > 8) {
                clicks += best + from
                best = -1
            }
            last = i
            if (best < 0 || abs(out[i].toInt()) > abs(out[best].toInt())) best = i
        }
        if (best >= 0) clicks += best + from
        return clicks
    }

    /** Where the web plays the clicks that are heard, as output frames: `round((s - origin) * 48)`. */
    private fun expected(take: Take, origin: Double): List<Long> =
        take.clicks.filter { it >= take.heardFromMs && it < take.heardToMs }
            .map { ((it - origin) * MIX_RATE / 1000.0).roundToLong() }

    private val seek = (31.237 * MIX_RATE).roundToLong()

    /** One stem alone, rendered from [from]. Null when every click it should make lands, else what went wrong. */
    private fun soloProblem(take: Take, from: Long, slackFrames: Long): String? {
        val loaded = load()
        val got = heard(mixer(loaded, listOf(take)), loaded, from)
        val want = expected(take, loaded.origin).filter { it >= from }
        val firstMs = if (got.isEmpty() || want.isEmpty()) Double.NaN else (got.first() - want.first()) * 1000.0 / MIX_RATE
        println("RESULT ${take.id} from frame $from: first click ${"%.3f".format(firstMs)} ms from the web's; ${got.size} heard, ${want.size} expected")
        if (got.size != want.size) return "${take.id}: ${got.size} clicks heard, ${want.size} expected"
        val off = got.zip(want).firstOrNull { (g, w) -> abs(g - w) > slackFrames } ?: return null
        return "${take.id}: the click at frame ${off.second} came out at ${off.first}"
    }

    /** Every stem alone from [from]: all three are measured and printed before any is judged. */
    private fun assertEverySolo(from: Long) {
        // 48 kHz stems land on the frame; the 44.1 kHz one went through the resampler: a fraction of a frame of
        // rounding, never more than one.
        val problems = listOf(soloProblem(guitar, from, 0), soloProblem(bass, from, 0), soloProblem(keys, from, 1))
        assertTrue(problems.filterNotNull().joinToString("; "), problems.all { it == null })
    }

    @Test
    fun `the transport zero is the earliest heard sample`() {
        val origin = JamAlignment.originMs(takes.map { it.spec })
        println("RESULT origin $origin ms (the web's song zero is 0)")
        assertEquals(0.0, origin, 0.0)
    }

    @Test
    fun `each stem alone plays every click where the web plays it, from the top`() {
        assertEverySolo(0)
    }

    @Test
    fun `each stem alone plays where the web plays it after a seek`() {
        assertEverySolo(seek)
    }

    @Test
    fun `the three together land where the web plays them, from the top and after a seek`() {
        val loaded = load()
        val all = mixer(loaded, takes)
        val want = takes.flatMap { expected(it, loaded.origin) }.sorted()
        for (from in listOf(0L, seek)) {
            val got = heard(all, loaded, from, chunk = 777)
            val wanted = want.filter { it >= from }
            println("RESULT mix from frame $from: ${got.size} clicks heard of ${wanted.size} expected; first ${got.firstOrNull()} vs ${wanted.firstOrNull()}")
            assertEquals("clicks heard from frame $from", wanted.size, got.size)
            for ((g, w) in got.zip(wanted)) assertTrue("the click at frame $w came out at $g", abs(g - w) <= 1)
        }
    }

    @Test
    fun `the mix runs from the earliest heard sample to the latest`() {
        val loaded = load()
        val ms = JamAlignment.durationMs(loaded.placements)
        println("RESULT mix duration $ms ms (the web's: $SONG_END_MS)")
        // Guitar and keys end at 60 s, the bass at 59 s (its tail trim); the earliest heard sample is song time 0.
        assertEquals(SONG_END_MS, ms, 0.05)
    }

    @Test
    fun `a track's lane and waveform read the same rule`() {
        val duration = SONG_END_MS + 2023.0
        val track = JamTrack(
            id = "t", songId = "s", authorId = "u", offsetMs = -2023.0, trimStartMs = 2023.0, trimEndMs = 0.0,
            durationMs = duration, peaks = List(400) { if (it < 200) 0.25 else 0.75 },
        )
        // It starts at the first HEARD sample (file start plus the head trim) and ends at the file's end less the tail trim.
        assertEquals(0.0, track.startMs, 0.0)
        assertEquals(SONG_END_MS, track.endMs, 1e-9)
        assertEquals(SONG_END_MS, track.playedMs, 1e-9)
        // Peaks run across the whole recording from song time `offsetMs`: song time s is file time s - offsetMs.
        val half = duration / 2 + track.offsetMs
        assertEquals(0.25, track.peakAt(half - 1.0), 0.0)
        assertEquals(0.75, track.peakAt(half + 1.0), 0.0)
        assertEquals(0.0, track.peakAt(-1.0), 0.0)
        assertEquals(0.0, track.peakAt(SONG_END_MS), 0.0)
    }

    @Test
    fun `a video's file time is song time minus the offset`() {
        // The web's `attachVideo`: the camera file's frame 0 is the audio file's frame 0.
        assertEquals(2023.0, JamAlignment.videoFileMs(0.0, -2023.0, 2023.0, 0.0, SONG_END_MS + 2023.0), 0.0)
        assertEquals(2023.0 + 12_345.0, JamAlignment.videoFileMs(12_345.0, -2023.0, 2023.0, 0.0, SONG_END_MS + 2023.0), 0.0)
        // Never into the hidden head, never past the tail trim.
        assertEquals(637.0, JamAlignment.videoFileMs(0.0, -137.0, 637.0, 1000.0, 60_137.0), 0.0)
        assertEquals(60_137.0 - 1000.0, JamAlignment.videoFileMs(70_000.0, -137.0, 637.0, 1000.0, 60_137.0), 0.0)
    }

    @Test
    fun `a stem that is entirely trimmed away is not placed`() {
        assertNull(JamAlignment.place(JamStemSpec("x", -2000.0, 48_000.0, 0.0), 48_000, 0.0))
    }

    private companion object {
        const val THRESHOLD = 4_000
        const val SECONDS = 60
        const val SONG_END_MS = 60_000.0
    }
}
