package gg.pqp.app.jam.record

import java.io.File
import java.util.Random
import kotlin.math.PI
import kotlin.math.sin
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The encoder against an independent reading of the format: a small FLAC
 * decoder written here from RFC 9639 that checks every CRC and returns the
 * samples. A lossless codec has one thing to prove, that every sample comes back
 * exactly, so each case compares the whole array.
 *
 * (The same files are also read by `ffmpeg` and by the platform's own FLAC
 * decoder through `JamDecoder` in `JamCodecAlignmentTest`; this test writes one
 * to the temp directory so the former can be run by hand.)
 */
class JamFlacTest {

    private class Decoded(val sampleRate: Int, val totalSamples: Long, val samples: ShortArray)

    private class Bits(val data: ByteArray, var pos: Int = 0) {
        var bit = 0
        fun read(n: Int): Int {
            var v = 0
            repeat(n) {
                val b = (data[pos].toInt() shr (7 - bit)) and 1
                v = (v shl 1) or b
                bit++
                if (bit == 8) {
                    bit = 0
                    pos++
                }
            }
            return v
        }

        fun unary(): Int {
            var q = 0
            while (read(1) == 0) q++
            return q
        }

        fun align() {
            if (bit != 0) {
                bit = 0
                pos++
            }
        }
    }

    private fun decode(file: ByteArray): Decoded {
        assertEquals("fLaC", String(file, 0, 4))
        val b = Bits(file, 4)
        assertEquals("last metadata block, STREAMINFO", 0x80, b.read(8))
        assertEquals(34, b.read(24))
        b.read(16)
        b.read(16)
        b.read(24)
        b.read(24)
        val rate = b.read(20)
        assertEquals("mono", 0, b.read(3))
        assertEquals("16 bits", 15, b.read(5))
        val total = (b.read(4).toLong() shl 32) or (b.read(16).toLong() shl 16) or b.read(16).toLong()
        repeat(16) { b.read(8) }
        val out = ShortArray(total.toInt())
        var written = 0
        while (written < total) {
            val frameStart = b.pos
            assertEquals("sync", 0b11111111111110, b.read(14))
            b.read(1)
            assertEquals("fixed block size", 0, b.read(1))
            val bsCode = b.read(4)
            b.read(4) // sample rate code
            assertEquals("one channel", 0, b.read(4))
            assertEquals("16 bits", 0b100, b.read(3))
            b.read(1)
            // UTF-8 style frame number.
            val first = b.read(8)
            if (first >= 0x80) {
                var extra = 0
                var mask = 0x80
                while (first and mask != 0) {
                    extra++
                    mask = mask shr 1
                }
                repeat(extra - 1) { b.read(8) }
            }
            val n = when (bsCode) {
                0b1100 -> 4096
                0b0110 -> b.read(8) + 1
                0b0111 -> b.read(16) + 1
                else -> error("block size code $bsCode")
            }
            val headerEnd = b.pos
            assertEquals("CRC-8", JamFlac.crc8(file, frameStart, headerEnd), b.read(8))
            // One subframe.
            b.read(1)
            val type = b.read(6)
            assertEquals("no wasted bits", 0, b.read(1))
            val x = IntArray(n)
            when {
                type == 0 -> {
                    val v = b.read(16).toShort().toInt()
                    for (i in 0 until n) x[i] = v
                }
                type == 1 -> for (i in 0 until n) x[i] = b.read(16).toShort().toInt()
                type in 8..12 -> {
                    val order = type - 8
                    for (i in 0 until order) x[i] = b.read(16).toShort().toInt()
                    val method = b.read(2)
                    val partitionOrder = b.read(4)
                    val parts = 1 shl partitionOrder
                    var at = order
                    for (p in 0 until parts) {
                        val k = b.read(if (method == 0) 4 else 5)
                        val count = (n shr partitionOrder) - (if (p == 0) order else 0)
                        repeat(count) {
                            val q = b.unary()
                            val u = (q shl k) or (if (k > 0) b.read(k) else 0)
                            val r = if (u and 1 == 0) u shr 1 else -((u + 1) shr 1)
                            x[at] = r + when (order) {
                                0 -> 0
                                1 -> x[at - 1]
                                2 -> 2 * x[at - 1] - x[at - 2]
                                3 -> 3 * x[at - 1] - 3 * x[at - 2] + x[at - 3]
                                else -> 4 * x[at - 1] - 6 * x[at - 2] + 4 * x[at - 3] - x[at - 4]
                            }
                            at++
                        }
                    }
                }
                else -> error("subframe type $type")
            }
            b.align()
            val frameEnd = b.pos
            assertEquals("CRC-16", JamFlac.crc16(file, frameStart, frameEnd), b.read(16))
            for (i in 0 until n) out[written + i] = x[i].toShort()
            written += n
        }
        assertEquals("the file ends with the last frame", file.size, b.pos)
        return Decoded(rate, total, out)
    }

    private fun roundTrip(samples: ShortArray, rate: Int = 48_000): ByteArray {
        val bytes = JamFlac.encode(samples, rate)
        val back = decode(bytes)
        assertEquals(rate, back.sampleRate)
        assertEquals(samples.size.toLong(), back.totalSamples)
        assertArrayEquals("every sample comes back exactly", samples, back.samples)
        return bytes
    }

    @Test
    fun `a tone with noise comes back sample for sample and is smaller than the raw samples`() {
        val r = Random(3)
        val s = ShortArray(48_000 * 3 + 123) { (9000 * sin(2 * PI * 440 * it / 48_000) + r.nextGaussian() * 300).toInt().toShort() }
        val bytes = roundTrip(s)
        println("RESULT flac: ${s.size * 2} raw bytes -> ${bytes.size} (${"%.0f".format(bytes.size * 100.0 / (s.size * 2))} %)")
        assertTrue(bytes.size < s.size * 2)
    }

    @Test
    fun `silence costs a few bytes a block`() {
        val bytes = roundTrip(ShortArray(48_000 * 10))
        println("RESULT flac: ten seconds of silence is ${bytes.size} bytes")
        assertTrue(bytes.size < 4_000)
    }

    @Test
    fun `full scale noise falls back to verbatim and still comes back exactly`() {
        val r = Random(9)
        roundTrip(ShortArray(20_000) { r.nextInt(65536).toShort() })
    }

    @Test
    fun `extremes of the 16 bit range are not mangled`() {
        roundTrip(ShortArray(9_000) { if (it % 2 == 0) Short.MAX_VALUE else Short.MIN_VALUE })
        roundTrip(ShortArray(9_000) { Short.MIN_VALUE })
        roundTrip(ShortArray(9_000) { (it % 300 - 150).toShort() })
    }

    @Test
    fun `lengths around a block boundary, a short take and a one sample take`() {
        for (n in listOf(1, 2, 15, 16, 255, 256, 257, 4095, 4096, 4097, 8192, 8193, 12_345)) {
            roundTrip(ShortArray(n) { (it * 37 % 2000 - 1000).toShort() })
        }
    }

    @Test
    fun `an impulse train keeps every impulse on its sample`() {
        val s = ShortArray(48_000 * 2)
        for (k in listOf(0, 1, 4095, 4096, 4097, 47_999, 95_999)) s[k] = 20_000
        roundTrip(s)
    }

    @Test
    fun `44 point 1 kilohertz is declared as such`() {
        roundTrip(ShortArray(10_000) { (it % 100).toShort() }, 44_100)
    }

    @Test
    fun `writes a file for ffmpeg to check by hand`() {
        val r = Random(5)
        val s = ShortArray(48_000 * 5 + 77) { (7000 * sin(2 * PI * 330 * it / 48_000) + r.nextGaussian() * 500).toInt().toShort() }
        val dir = File(System.getProperty("java.io.tmpdir"), "pqp-jam-flac").also { it.mkdirs() }
        File(dir, "sample.flac").writeBytes(JamFlac.encode(s, 48_000))
        val raw = java.nio.ByteBuffer.allocate(s.size * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        s.forEach { raw.putShort(it) }
        File(dir, "sample.s16le").writeBytes(raw.array())
    }
}
