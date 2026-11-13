package gg.pqp.app.jam.record

import gg.pqp.app.jam.audio.PcmSource
import java.io.OutputStream

/*
 * A small FLAC encoder, a port of the web's (`client/src/lib/jam/flac.ts`).
 *
 * WHY FLAC, AND WHY HAND-WRITTEN. The jam's stems must come back from the
 * server without one sample moving, on every client: the web, iOS (which cannot
 * open WebM or Ogg at all) and this app. FLAC is lossless, so a take placed
 * `offsetMs` early or late stays exactly there on every player; every lossy
 * codec moves the audio by a codec- and platform-dependent amount
 * (`docs/JAM_ENGINE.md`). The platform offers no FLAC muxer (`MediaMuxer` writes
 * MP4, WebM and Ogg only) and a libFLAC binding is a native dependency for the
 * easy 90 % of the format, so this writes the subset every decoder reads:
 * CONSTANT subframes (silence costs a few bytes a block), FIXED predictors of
 * order 0..4 with partitioned Rice residuals, and VERBATIM when nothing beats
 * raw. No LPC, so it is a few percent bigger than `flac -5`.
 *
 * Mono 16-bit only, which is what a take is. Streams from a [PcmSource] one
 * block at a time, so a ten minute take (28.8 million samples) is never
 * copied. The MD5 in STREAMINFO is left zero ("not computed", legal) and the
 * min and max frame sizes are written as 0 ("unknown", legal) because the
 * header goes out before the first frame does; every frame carries its own
 * CRC-8 and CRC-16.
 *
 * Format reference: RFC 9639.
 */
object JamFlac {
    const val BITS_PER_SAMPLE = 16
    const val BLOCK_SIZE = 4096

    /** The bytes, for a short take or a test. */
    fun encode(samples: ShortArray, sampleRate: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        encode(ShortArrayPcmView(samples), 0, samples.size.toLong(), sampleRate, out)
        return out.toByteArray()
    }

    /** Streams [count] samples of [source] from [from] to [out]. The caller closes [out]. */
    fun encode(source: PcmSource, from: Long, count: Long, sampleRate: Int, out: OutputStream) {
        require(count >= 0) { "negative length" }
        require(sampleRate in 1 until (1 shl 20)) { "unsupported sample rate" }
        val header = BitWriter(64)
        for (c in "fLaC") header.bits(c.code, 8)
        header.bits(0x80, 8) // last metadata block, STREAMINFO
        header.bits(34, 24)
        val declared = BLOCK_SIZE.coerceAtMost(count.coerceAtLeast(16).toInt())
        header.bits(declared, 16)
        header.bits(declared, 16)
        header.bits(0, 24) // min frame size: unknown
        header.bits(0, 24) // max frame size: unknown
        header.bits(sampleRate, 20)
        header.bits(0, 3) // one channel
        header.bits(BITS_PER_SAMPLE - 1, 5)
        // 36-bit total samples, high four bits then 32.
        header.bits((count ushr 32).toInt() and 0xF, 4)
        header.bits(((count ushr 16) and 0xFFFF).toInt(), 16)
        header.bits((count and 0xFFFF).toInt(), 16)
        repeat(16) { header.bits(0, 8) } // MD5: not computed
        out.write(header.buf, 0, header.len)

        val block = ShortArray(BLOCK_SIZE)
        val x = IntArray(BLOCK_SIZE)
        val frame = BitWriter(BLOCK_SIZE * 3)
        var done = 0L
        var number = 0L
        val srCode = SAMPLE_RATE_CODES[sampleRate] ?: 0
        while (done < count) {
            val n = minOf(BLOCK_SIZE.toLong(), count - done).toInt()
            source.read(from + done, block, 0, n)
            for (i in 0 until n) x[i] = block[i].toInt()
            frame.reset()
            frame.bits(0b11111111111110, 14)
            frame.bits(0, 1)
            frame.bits(0, 1) // fixed block size stream
            val bsCode = when {
                n == 4096 -> 0b1100
                n <= 256 -> 0b0110
                else -> 0b0111
            }
            frame.bits(bsCode, 4)
            frame.bits(srCode, 4)
            frame.bits(0, 4) // one channel, independent
            frame.bits(0b100, 3) // 16 bits per sample
            frame.bits(0, 1)
            writeFrameNumber(frame, number)
            if (bsCode == 0b0110) frame.bits(n - 1, 8) else if (bsCode == 0b0111) frame.bits(n - 1, 16)
            frame.bits(crc8(frame.buf, 0, frame.len), 8)
            encodeSubframe(frame, x, n)
            frame.align()
            frame.bits(crc16(frame.buf, 0, frame.len), 16)
            out.write(frame.buf, 0, frame.len)
            done += n
            number += 1
        }
        out.flush()
    }

    // ---------------------------------------------------------------- bits

    internal class BitWriter(capacity: Int) {
        var buf = ByteArray(maxOf(64, capacity))
        var len = 0
        private var cur = 0
        private var free = 8

        fun reset() {
            len = 0
            cur = 0
            free = 8
        }

        private fun push(byte: Int) {
            if (len == buf.size) buf = buf.copyOf(buf.size * 2)
            buf[len++] = byte.toByte()
        }

        /** The low [n] bits of [v] (n <= 31), most significant first. */
        fun bits(v: Int, n: Int) {
            var left = n
            while (left > 0) {
                val take = if (left < free) left else free
                val shift = left - take
                val chunk = (v ushr shift) and ((1 shl take) - 1)
                cur = cur or (chunk shl (free - take))
                free -= take
                left -= take
                if (free == 0) {
                    push(cur)
                    cur = 0
                    free = 8
                }
            }
        }

        /** [q] zeros and a one. */
        fun unary(q: Int) {
            var left = q
            while (left > 0) {
                val take = if (left < free) left else free
                free -= take
                left -= take
                if (free == 0) {
                    push(cur)
                    cur = 0
                    free = 8
                }
            }
            bits(1, 1)
        }

        fun align() {
            if (free != 8) {
                push(cur)
                cur = 0
                free = 8
            }
        }
    }

    private val CRC8 = IntArray(256).also { table ->
        for (i in 0 until 256) {
            var c = i
            repeat(8) { c = if (c and 0x80 != 0) ((c shl 1) xor 0x07) and 0xFF else (c shl 1) and 0xFF }
            table[i] = c
        }
    }
    private val CRC16 = IntArray(256).also { table ->
        for (i in 0 until 256) {
            var d = i shl 8
            repeat(8) { d = if (d and 0x8000 != 0) ((d shl 1) xor 0x8005) and 0xFFFF else (d shl 1) and 0xFFFF }
            table[i] = d
        }
    }

    internal fun crc8(bytes: ByteArray, start: Int, end: Int): Int {
        var c = 0
        for (i in start until end) c = CRC8[c xor (bytes[i].toInt() and 0xFF)]
        return c
    }

    internal fun crc16(bytes: ByteArray, start: Int, end: Int): Int {
        var c = 0
        for (i in start until end) c = ((c shl 8) and 0xFFFF) xor CRC16[(c shr 8) xor (bytes[i].toInt() and 0xFF)]
        return c
    }

    private val SAMPLE_RATE_CODES = mapOf(
        88200 to 0b0001,
        176400 to 0b0010,
        192000 to 0b0011,
        8000 to 0b0100,
        16000 to 0b0101,
        22050 to 0b0110,
        24000 to 0b0111,
        32000 to 0b1000,
        44100 to 0b1001,
        48000 to 0b1010,
        96000 to 0b1011,
    )

    /** FLAC's UTF-8 style frame number. */
    private fun writeFrameNumber(w: BitWriter, n: Long) {
        if (n < 0x80) {
            w.bits(n.toInt(), 8)
            return
        }
        val lead = when {
            n < 0x800 -> 2
            n < 0x10000 -> 3
            n < 0x200000 -> 4
            n < 0x4000000 -> 5
            else -> 6
        }
        val tail = IntArray(lead - 1)
        var v = n
        for (i in lead - 2 downTo 0) {
            tail[i] = 0x80 or (v and 0x3F).toInt()
            v = v ushr 6
        }
        val prefix = (0xFF shl (8 - lead)) and 0xFF
        w.bits(prefix or v.toInt(), 8)
        for (b in tail) w.bits(b, 8)
    }

    // ----------------------------------------------------------- subframes

    private fun fixedResidual(x: IntArray, i: Int, order: Int): Int = when (order) {
        0 -> x[i]
        1 -> x[i] - x[i - 1]
        2 -> x[i] - 2 * x[i - 1] + x[i - 2]
        3 -> x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]
        else -> x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]
    }

    private class RicePlan(val partitionOrder: Int, val params: IntArray, val method: Int)

    /** Cheapest Rice parameter for [count] folded values summing to [sum], and what it costs. */
    private fun riceEstimate(sum: Double, count: Int): Pair<Int, Double> {
        if (count == 0) return 0 to 0.0
        val mean = sum / count
        val k0 = if (mean > 1) (kotlin.math.ln(mean) / kotlin.math.ln(2.0)).toInt() else 0
        var bestK = 0
        var bestBits = Double.POSITIVE_INFINITY
        for (k in maxOf(0, k0 - 1)..minOf(30, k0 + 1)) {
            val q = maxOf(0.0, sum / Math.pow(2.0, k.toDouble()) - (if (k > 0) count / 2.0 else 0.0))
            val bits = count * (k + 1) + q
            if (bits < bestBits) {
                bestK = k
                bestBits = bits
            }
        }
        return bestK to bestBits
    }

    private fun planRice(folded: IntArray, blockSize: Int, order: Int): RicePlan {
        var maxP = 0
        while (maxP < 8 && blockSize % (1 shl (maxP + 1)) == 0 && (blockSize shr (maxP + 1)) > order) maxP++
        val parts = 1 shl maxP
        val plen = blockSize shr maxP
        var sums = DoubleArray(parts)
        var counts = IntArray(parts)
        for (p in 0 until parts) {
            val s = if (p == 0) order else p * plen
            val e = (p + 1) * plen
            var acc = 0.0
            for (i in s until e) acc += (folded[i - order].toLong() and 0xFFFFFFFFL).toDouble()
            sums[p] = acc
            counts[p] = e - s
        }
        var best: RicePlan? = null
        var bestBits = Double.POSITIVE_INFINITY
        for (po in maxP downTo 0) {
            val n = 1 shl po
            if (po < maxP) {
                val ns = DoubleArray(n)
                val nc = IntArray(n)
                for (i in 0 until n) {
                    ns[i] = sums[2 * i] + sums[2 * i + 1]
                    nc[i] = counts[2 * i] + counts[2 * i + 1]
                }
                sums = ns
                counts = nc
            }
            val params = IntArray(n)
            var bits = 6.0
            var needFive = false
            for (i in 0 until n) {
                val (k, cost) = riceEstimate(sums[i], counts[i])
                params[i] = k
                bits += cost
                if (k > 14) needFive = true
            }
            bits += n * (if (needFive) 5 else 4)
            if (best == null || bits < bestBits) {
                best = RicePlan(po, params, if (needFive) 1 else 0)
                bestBits = bits
            }
        }
        return best!!
    }

    private fun encodeSubframe(w: BitWriter, x: IntArray, n: Int) {
        val bps = BITS_PER_SAMPLE
        val mask = (1 shl bps) - 1
        var constant = true
        for (i in 1 until n) {
            if (x[i] != x[0]) {
                constant = false
                break
            }
        }
        if (constant) {
            w.bits(0, 8) // padding, CONSTANT, no wasted bits
            w.bits(x[0] and mask, bps)
            return
        }
        val maxOrder = minOf(4, n - 1)
        var bestOrder = 0
        var bestSum = Long.MAX_VALUE
        for (order in 0..maxOrder) {
            var s = 0L
            for (i in order until n) s += kotlin.math.abs(fixedResidual(x, i, order)).toLong()
            if (s < bestSum) {
                bestSum = s
                bestOrder = order
            }
        }
        val order = bestOrder
        val folded = IntArray(n - order)
        for (i in order until n) {
            val r = fixedResidual(x, i, order)
            folded[i - order] = if (r >= 0) r * 2 else -r * 2 - 1
        }
        val plan = planRice(folded, n, order)
        val plen = n shr plan.partitionOrder
        // The exact cost of that plan, so the verbatim fallback compares like with like.
        var exact = 8L + order * bps + 6 + (1 shl plan.partitionOrder) * (if (plan.method == 1) 5 else 4)
        for (p in 0 until (1 shl plan.partitionOrder)) {
            val k = plan.params[p]
            val s = if (p == 0) order else p * plen
            val e = (p + 1) * plen
            for (i in s until e) exact += (folded[i - order] ushr k) + 1 + k
        }
        if (exact >= 8L + n.toLong() * bps) {
            w.bits(0b00000010, 8) // VERBATIM
            for (i in 0 until n) w.bits(x[i] and mask, bps)
            return
        }
        w.bits(0b00010000 or (order shl 1), 8) // FIXED
        for (i in 0 until order) w.bits(x[i] and mask, bps)
        w.bits(plan.method, 2)
        w.bits(plan.partitionOrder, 4)
        val paramBits = if (plan.method == 1) 5 else 4
        for (p in 0 until (1 shl plan.partitionOrder)) {
            val k = plan.params[p]
            w.bits(k, paramBits)
            val s = if (p == 0) order else p * plen
            val e = (p + 1) * plen
            val low = if (k > 0) (1 shl k) - 1 else 0
            for (i in s until e) {
                val u = folded[i - order]
                w.unary(u ushr k)
                if (k > 0) w.bits(u and low, k)
            }
        }
    }

    private class ShortArrayPcmView(private val samples: ShortArray) : PcmSource {
        override val frames: Long get() = samples.size.toLong()
        override fun read(from: Long, out: ShortArray, outOffset: Int, count: Int) {
            for (i in 0 until count) {
                val at = from + i
                out[outOffset + i] = if (at in 0 until frames) samples[at.toInt()] else 0
            }
        }
    }
}
