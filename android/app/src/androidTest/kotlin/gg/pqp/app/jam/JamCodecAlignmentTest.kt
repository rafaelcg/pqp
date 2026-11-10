package gg.pqp.app.jam

import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import gg.pqp.app.jam.audio.JamDecoder
import gg.pqp.app.jam.audio.MIX_RATE
import gg.pqp.app.jam.audio.MappedPcm
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * WHAT THIS PLATFORM'S DECODERS DO TO TIME, MEASURED.
 *
 * `assets/jam/make-fixtures.sh` encodes one second of silence with a 10 ms,
 * 3 kHz burst at exactly 0.5 s every way the server accepts a stem (FLAC, AAC
 * in M4A and in fragmented MP4, Opus in Ogg and in WebM, MP3, plus WAV), at
 * 48 kHz and 44.1 kHz. Each goes through the real `JamDecoder` (MediaExtractor +
 * MediaCodec, then the zero-delay resampler to the mix rate) and the burst is
 * found by cross-correlation with the original. The number printed under tag
 * `JamCodec` is how many mix frames (48 per millisecond) the decoded burst sits
 * after where it was recorded: 0 is exact, positive is late.
 *
 * The lossless formats are asserted exact. The lossy ones are asserted to
 * within the tolerance documented in `docs/ANDROID.md` ("Jam"), and what the
 * platform actually did is logged so the table there is a measurement.
 */
@RunWith(AndroidJUnit4::class)
class JamCodecAlignmentTest {

    private val context = InstrumentationRegistry.getInstrumentation().context
    private val target = InstrumentationRegistry.getInstrumentation().targetContext

    private fun fixture(name: String): File {
        val out = File(target.cacheDir, "jam-fixture-$name").also { it.delete() }
        context.assets.open("jam/$name").use { input -> out.outputStream().use { input.copyTo(it) } }
        return out
    }

    private fun decode(name: String): ShortArray {
        val pcm = File(target.cacheDir, "jam-decoded-$name.pcm").also { it.delete() }
        val result = JamDecoder.decode(fixture(name), pcm)
        MappedPcm(pcm).use { source ->
            val samples = ShortArray(source.frames.toInt())
            source.read(0, samples, 0, samples.size)
            Log.i(TAG, "$name: mime=${result.mime} sourceRate=${result.sourceRate} ch=${result.sourceChannels} " +
                "delayFrames=${result.delayFrames} decodedFrames=${samples.size}")
            return samples
        }
    }

    /** The lag, in mix frames, at which [decoded] best matches [reference]; positive means the decoded one is late. */
    private fun lagAgainst(decoded: ShortArray, reference: ShortArray): Int {
        val start = reference.indexOfFirst { it.toInt() != 0 }
        val end = reference.indexOfLast { it.toInt() != 0 }
        var best = Long.MIN_VALUE
        var bestLag = 0
        for (lag in -6000..6000) {
            var sum = 0L
            for (n in start..end) {
                val at = n + lag
                if (at < 0 || at >= decoded.size) continue
                sum += decoded[at].toLong() * reference[n].toLong()
            }
            if (sum > best) {
                best = sum
                bestLag = lag
            }
        }
        return bestLag
    }

    private val reference by lazy { decode("burst-48000.wav") }

    private fun measure(name: String): Pair<Int, Int> {
        val decoded = decode(name)
        val lag = lagAgainst(decoded, reference)
        Log.i(TAG, "RESULT $name: lag=$lag frames (${"%.3f".format(lag * 1000.0 / MIX_RATE)} ms), length ${decoded.size} (expected $MIX_RATE)")
        return lag to decoded.size
    }

    @Test
    fun wavIsExact() {
        assertEquals(MIX_RATE, reference.size)
        assertEquals(0, measure("burst-48000.wav").first)
        assertEquals(0, measure("burst-44100.wav").first)
    }

    @Test
    fun flacIsExactAtBothRates() {
        assertEquals(0, measure("burst-48000.flac").first)
        assertEquals(0, measure("burst-44100.flac").first)
    }

    @Test
    fun opusInOggAndWebm() {
        val ogg = measure("burst-48000.ogg").first
        val webm = measure("burst-48000.webm").first
        assertTrue("ogg opus lag $ogg", kotlin.math.abs(ogg) <= TOLERANCE_FRAMES)
        assertTrue("webm opus lag $webm", kotlin.math.abs(webm) <= TOLERANCE_FRAMES)
    }

    @Test
    fun aacInM4aAndFragmentedMp4() {
        val m4a = measure("burst-48000.m4a").first
        val m4a441 = measure("burst-44100.m4a").first
        val fragmented = measure("burst-48000-fragmented.mp4").first
        assertTrue("m4a aac lag $m4a", kotlin.math.abs(m4a) <= TOLERANCE_FRAMES)
        assertTrue("44.1 m4a aac lag $m4a441", kotlin.math.abs(m4a441) <= TOLERANCE_FRAMES)
        assertTrue("fragmented mp4 aac lag $fragmented", kotlin.math.abs(fragmented) <= TOLERANCE_FRAMES)
    }

    @Test
    fun mp3() {
        val mp3 = measure("burst-48000.mp3").first
        val mp3441 = measure("burst-44100.mp3").first
        assertTrue("mp3 lag $mp3", kotlin.math.abs(mp3) <= TOLERANCE_FRAMES)
        assertTrue("44.1 mp3 lag $mp3441", kotlin.math.abs(mp3441) <= TOLERANCE_FRAMES)
    }

    /** A stem the platform cannot decode is an [JamDecoder.UnplayableStem], never a crash: the rest of the mix plays. */
    @Test
    fun garbageIsUnplayableNotACrash() {
        val junk = File(target.cacheDir, "jam-junk.bin").also { it.writeBytes(ByteArray(4096) { (it * 31).toByte() }) }
        try {
            JamDecoder.decode(junk, File(target.cacheDir, "jam-junk.pcm"))
            fail("decoded noise")
        } catch (_: JamDecoder.UnplayableStem) {
        }
        val empty = File(target.cacheDir, "jam-empty.bin").also { it.writeBytes(ByteArray(0)) }
        try {
            JamDecoder.decode(empty, File(target.cacheDir, "jam-empty.pcm"))
            fail("decoded nothing")
        } catch (_: JamDecoder.UnplayableStem) {
        }
    }

    private companion object {
        const val TAG = "JamCodec"

        /** Measured 0 on every format on Android 17 (emulator); two frames of slack for a different decoder build. */
        const val TOLERANCE_FRAMES = 2
    }
}
