package gg.pqp.app.voicenotes

import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The peak normaliser and the small formatters around it.
 *
 * The normaliser is the only thing that decides what a recorded note looks
 * like on every other client, and the server accepts exactly 64 bytes of it,
 * so both the length and the shape are pinned.
 */
class VoiceNoteSpecTest {

    private fun unsigned(bytes: ByteArray): List<Int> = bytes.map { it.toInt() and 0xFF }

    @Test
    fun `always exactly 64 peaks, whatever the length of the recording`() {
        for (samples in listOf(1, 2, 10, 63, 64, 65, 200, 3_750)) {
            val peaks = PeakNormalizer.peaks(IntArray(samples) { 1000 + it })
            assertEquals("for $samples samples", 64, peaks.size)
        }
    }

    @Test
    fun `the wire form is 88 base64 characters ending in two pads`() {
        // The server's regex: 86 characters of alphabet, then "==".
        val encoded = PeakNormalizer.encode(IntArray(300) { (it * 97) % 32767 })
        assertEquals(88, encoded.length)
        assertTrue(encoded.endsWith("=="))
        assertTrue(Regex("^[A-Za-z0-9+/]{86}==$").matches(encoded))
        assertEquals(64, Base64.getDecoder().decode(encoded).size)
    }

    @Test
    fun `no samples is 64 zero bytes rather than a crash`() {
        assertArrayEquals(ByteArray(64), PeakNormalizer.peaks(IntArray(0)))
    }

    @Test
    fun `the loudest sample of the recording becomes the full-height bar`() {
        val samples = IntArray(128) { 4_000 }
        samples[50] = 20_000
        val peaks = unsigned(PeakNormalizer.peaks(samples))
        assertEquals(255, peaks.max())
        // Louder than the rest, and the rest is still visible.
        assertTrue(peaks.filter { it != 255 }.all { it in 1..254 })
    }

    @Test
    fun `a quiet recording is not stretched to look loud`() {
        // Everything under the quiet floor: the bars must stay short instead of
        // being scaled up to fill the card, which would say "loud" about a note
        // that was not.
        val peaks = unsigned(PeakNormalizer.peaks(IntArray(64) { 300 }))
        assertTrue("peaks were $peaks", peaks.all { it < 128 })
    }

    @Test
    fun `silence stays silent`() {
        assertEquals(List(64) { 0 }, unsigned(PeakNormalizer.peaks(IntArray(100))))
    }

    @Test
    fun `a bar is the loudest sample in its slice, not the average`() {
        // 128 samples into 64 bars is two samples a bar. One spike in an
        // otherwise quiet pair must survive.
        val samples = IntArray(128) { 100 }
        samples[11] = 30_000 // belongs to bar 5 (samples 10 and 11)
        val peaks = unsigned(PeakNormalizer.peaks(samples))
        assertEquals(255, peaks[5])
        assertTrue(peaks[4] < 60)
        assertTrue(peaks[6] < 60)
    }

    @Test
    fun `fewer samples than bars stretch across the card instead of leaving a gap`() {
        val peaks = unsigned(PeakNormalizer.peaks(intArrayOf(10_000, 10_000, 10_000, 10_000)))
        assertTrue("right-hand bars were empty: $peaks", peaks.all { it > 0 })
    }

    @Test
    fun `out of range input is clamped, never wrapped`() {
        val peaks = unsigned(PeakNormalizer.peaks(intArrayOf(-5, 99_999, 32_767)))
        assertTrue(peaks.all { it in 0..255 })
        assertEquals(255, peaks.max())
    }

    @Test
    fun `order is preserved so the shape of speech survives`() {
        val rising = IntArray(640) { it * 50 }
        val peaks = unsigned(PeakNormalizer.peaks(rising))
        assertEquals(peaks.sorted(), peaks)
    }

    @Test
    fun `decoding another client's waveform tolerates bad input`() {
        assertEquals(64, decodeWaveform(null).size)
        assertEquals(64, decodeWaveform("").size)
        assertEquals(64, decodeWaveform("not base64!!").size)
        assertTrue(decodeWaveform("").all { it == FLAT_BAR })
    }

    @Test
    fun `decoding round-trips what this client sends`() {
        val encoded = PeakNormalizer.encode(IntArray(256) { (it * 120) % 32767 })
        val decoded = decodeWaveform(encoded)
        assertEquals(64, decoded.size)
        assertTrue(decoded.all { it in FLAT_BAR..1f })
    }

    @Test
    fun `resampling keeps a loud peak when the card is narrow`() {
        val peaks = FloatArray(64) { 0.1f }
        peaks[33] = 1f
        val narrow = resamplePeaks(peaks, 16)
        assertEquals(1f, narrow.max(), 0f)
        assertEquals(16, narrow.size)
        assertEquals(128, resamplePeaks(peaks, 128).size)
        assertEquals(0, resamplePeaks(peaks, 0).size)
    }

    @Test
    fun `durations read like the web's`() {
        assertEquals("0:01", formatNoteDuration(300))
        assertEquals("0:12", formatNoteDuration(12_000))
        assertEquals("0:12", formatNoteDuration(11_600))
        assertEquals("4:05", formatNoteDuration(245_000))
        assertEquals("5:00", formatNoteDuration(VOICE_NOTE_MAX_DURATION_MS))
    }

    @Test
    fun `the playing clock floors, so it does not run ahead of the audio`() {
        assertEquals("0:00", formatPlaybackClock(999))
        assertEquals("0:01", formatPlaybackClock(1_000))
        assertEquals("1:05", formatPlaybackClock(65_900))
        assertEquals("0:00", formatPlaybackClock(-5))
    }

    @Test
    fun `the byte budget matches the server's`() {
        // 16 KiB a second, rounded up, plus 32 KiB of headers.
        assertEquals(16L * 1024 + 32L * 1024, noteByteBudget(1))
        assertEquals(16L * 1024 * 2 + 32L * 1024, noteByteBudget(1_001))
        assertEquals(16L * 1024 * 300 + 32L * 1024, noteByteBudget(VOICE_NOTE_MAX_DURATION_MS))
        // This recorder runs at 48 kbps, so a full-length note is well inside it.
        val fiveMinutesAt48kbps = 48_000L / 8 * 300
        assertTrue(fiveMinutesAt48kbps < noteByteBudget(VOICE_NOTE_MAX_DURATION_MS))
    }

    @Test
    fun `speeds cycle 1, 1_5, 2 and back`() {
        assertEquals(1.5f, PlaybackSpeeds.next(1f), 0f)
        assertEquals(2f, PlaybackSpeeds.next(1.5f), 0f)
        assertEquals(1f, PlaybackSpeeds.next(2f), 0f)
        assertEquals(1f, PlaybackSpeeds.next(0.75f), 0f)
        assertEquals("1x", PlaybackSpeeds.label(1f))
        assertEquals("1.5x", PlaybackSpeeds.label(1.5f))
        assertEquals("2x", PlaybackSpeeds.label(2f))
    }
}
