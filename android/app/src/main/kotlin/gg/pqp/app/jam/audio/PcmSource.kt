package gg.pqp.app.jam.audio

import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteOrder
import java.nio.ShortBuffer
import java.nio.channels.FileChannel

/**
 * Mono 16-bit samples at [MIX_RATE], readable at any position. The mixer reads
 * its stems through this, so a stem can live in an array (the tests) or in a
 * memory-mapped file (the app: a ten minute stem is 57 MB, and eight of them
 * would not be on the Java heap, only in the page cache).
 */
interface PcmSource : Closeable {
    val frames: Long

    /** Copies up to [count] samples from [from] into [out] at [outOffset]; samples past the end read as silence. */
    fun read(from: Long, out: ShortArray, outOffset: Int, count: Int)

    override fun close() = Unit
}

class ShortArrayPcm(private val samples: ShortArray) : PcmSource {
    override val frames: Long get() = samples.size.toLong()

    override fun read(from: Long, out: ShortArray, outOffset: Int, count: Int) {
        for (i in 0 until count) {
            val at = from + i
            out[outOffset + i] = if (at in 0 until frames) samples[at.toInt()] else 0
        }
    }
}

/** A raw little-endian 16-bit mono file, mapped read-only. */
class MappedPcm(private val file: File) : PcmSource {
    private val raf = RandomAccessFile(file, "r")
    private val buffer: ShortBuffer = run {
        val length = raf.length()
        if (length < 2) {
            ShortBuffer.allocate(0)
        } else {
            raf.channel.map(FileChannel.MapMode.READ_ONLY, 0, length - length % 2)
                .order(ByteOrder.LITTLE_ENDIAN)
                .asShortBuffer()
        }
    }

    override val frames: Long get() = buffer.limit().toLong()

    override fun read(from: Long, out: ShortArray, outOffset: Int, count: Int) {
        var i = 0
        // Whatever is in range comes out in one bulk get; the rest is silence.
        val start = from.coerceAtLeast(0)
        val lead = (start - from).coerceAtMost(count.toLong()).toInt()
        while (i < lead) out[outOffset + i++] = 0
        if (start < frames && i < count) {
            val n = minOf(count - i, (frames - start).toInt())
            val view = buffer.duplicate()
            view.position(start.toInt())
            view.get(out, outOffset + i, n)
            i += n
        }
        while (i < count) out[outOffset + i++] = 0
    }

    override fun close() {
        raf.close()
    }
}
