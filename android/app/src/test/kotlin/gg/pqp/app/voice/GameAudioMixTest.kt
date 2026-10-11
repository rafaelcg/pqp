package gg.pqp.app.voice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class GameAudioMixTest {

    private fun shorts(vararg values: Int) = ShortArray(values.size) { values[it].toShort() }

    @Test
    fun `the ring hands samples back in order`() {
        val ring = PcmRing(8)
        ring.write(shorts(1, 2, 3), 3)
        ring.write(shorts(4, 5), 2)
        val out = ShortArray(5)
        assertEquals(5, ring.read(out, 5))
        assertArrayEquals(shorts(1, 2, 3, 4, 5), out)
        assertEquals(0, ring.size)
    }

    @Test
    fun `an overflowing ring drops the oldest audio, not the newest`() {
        // Drift between the two clocks must never become a growing delay
        // between the picture and its sound.
        val ring = PcmRing(4)
        ring.write(shorts(1, 2, 3), 3)
        ring.write(shorts(4, 5, 6), 3)
        val out = ShortArray(4)
        assertEquals(4, ring.read(out, 4))
        assertArrayEquals(shorts(3, 4, 5, 6), out)
    }

    @Test
    fun `a write larger than the ring keeps only the newest samples`() {
        val ring = PcmRing(3)
        ring.write(shorts(1, 2, 3, 4, 5), 5)
        val out = ShortArray(3)
        assertEquals(3, ring.read(out, 3))
        assertArrayEquals(shorts(3, 4, 5), out)
    }

    @Test
    fun `the ring wraps around its end`() {
        val ring = PcmRing(4)
        val out = ShortArray(4)
        ring.write(shorts(1, 2, 3), 3)
        ring.read(out, 2)
        ring.write(shorts(4, 5, 6), 3)
        assertEquals(4, ring.read(out, 4))
        assertArrayEquals(shorts(3, 4, 5, 6), out)
    }

    @Test
    fun `an underrun reads what is there and no more`() {
        val ring = PcmRing(8)
        ring.write(shorts(7, 8), 2)
        val out = ShortArray(5)
        assertEquals(2, ring.read(out, 5))
    }

    @Test
    fun `game audio is added to the voice at the game gain`() {
        val mic = shorts(100, -100, 0, 50)
        val game = shorts(1000, 1000, -1000, 0)
        mixPcm16(mic, 4, game, 4, micOn = true, gameGain = 0.5f)
        assertArrayEquals(shorts(600, 400, -500, 50), mic)
    }

    @Test
    fun `a muted presenter sends the game and nothing of the room`() {
        val mic = shorts(12_000, -12_000, 300)
        val game = shorts(10, 20, 30)
        mixPcm16(mic, 3, game, 3, micOn = false, gameGain = 1f)
        assertArrayEquals(shorts(10, 20, 30), mic)
    }

    @Test
    fun `muted with no game audio waiting is silence, not the microphone`() {
        val mic = shorts(5_000, 5_000)
        mixPcm16(mic, 2, ShortArray(0), 0, micOn = false)
        assertArrayEquals(shorts(0, 0), mic)
    }

    @Test
    fun `past the game samples that arrived, the voice is left alone`() {
        val mic = shorts(1, 2, 3, 4)
        val game = shorts(10, 10, 99, 99)
        mixPcm16(mic, 4, game, 2, micOn = true, gameGain = 1f)
        assertArrayEquals(shorts(11, 12, 3, 4), mic)
    }

    @Test
    fun `a loud moment saturates instead of wrapping into noise`() {
        val mic = shorts(30_000, -30_000)
        val game = shorts(30_000, -30_000)
        mixPcm16(mic, 2, game, 2, micOn = true, gameGain = 1f)
        assertArrayEquals(shorts(Short.MAX_VALUE.toInt(), Short.MIN_VALUE.toInt()), mic)
    }

    @Test
    fun `the ring holds 200 ms of the microphone's own format`() {
        assertEquals(9_600, gameAudioRingCapacity(48_000, 1))
        assertEquals(19_200, gameAudioRingCapacity(48_000, 2))
        assertEquals(8_820, gameAudioRingCapacity(44_100, 1))
    }
}
