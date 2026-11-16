package gg.pqp.app.jam.record

import gg.pqp.app.jam.JamLimits
import gg.pqp.app.jam.audio.PcmSource
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * What the studio reads off a take's samples: the waveform that is sent with
 * it, and whether the part that will be heard is a flat line. The web's
 * `peaks.ts` and `jam-take-silence.ts`, over a [PcmSource] so a ten minute take
 * (a mapped file) is read in blocks and never held in memory.
 */
object JamTakeAudio {
    /**
     * At most [count] numbers in 0..1, each the loudest absolute sample in its
     * slice of the WHOLE take, trims included (so a trim change needs no new
     * peaks). Absolute, not normalised: a quiet part looks quiet next to a loud
     * one. Rounded to three decimals so the JSON stays small.
     */
    fun peaks(source: PcmSource, from: Long, frames: Long, count: Int = JamLimits.PEAKS_MAX): List<Double> {
        val buckets = max(0L, min(min(count.toLong(), JamLimits.PEAKS_MAX.toLong()), frames)).toInt()
        if (buckets == 0) return emptyList()
        val out = ArrayList<Double>(buckets)
        val block = ShortArray(BLOCK)
        for (b in 0 until buckets) {
            val start = frames * b / buckets
            val end = frames * (b + 1) / buckets
            out += Math.round(peak(source, from + start, end - start, block) * 1000) / 1000.0
        }
        return out
    }

    /** The loudest absolute sample in [frames] frames from [from], 0..1. */
    fun peak(source: PcmSource, from: Long, frames: Long, block: ShortArray = ShortArray(BLOCK)): Double {
        var loudest = 0
        var done = 0L
        while (done < frames) {
            val n = min(block.size.toLong(), frames - done).toInt()
            source.read(from + done, block, 0, n)
            for (i in 0 until n) {
                val a = abs(block[i].toInt())
                if (a > loudest) loudest = a
            }
            done += n
        }
        return min(1.0, loudest / 32768.0)
    }

    /**
     * Whether a take picked up nothing at all, so a person can be told before
     * they send a minute of silence to the band. A peak under 0.01 (about
     * -40 dBFS) over the part that would be heard is a flat line: a muted or
     * unplugged input. Quiet playing is nowhere near it. The count-in and the
     * hidden head are not measured: the clicks leak into a microphone and would
     * make a silent take look alive.
     */
    fun isSilent(source: PcmSource, from: Long, frames: Long, heardFromFrame: Long): Boolean {
        val start = from + min(heardFromFrame, frames)
        return peak(source, start, max(0L, frames - heardFromFrame)) < SILENT_PEAK
    }

    const val SILENT_PEAK = 0.01
    private const val BLOCK = 8192
}

/** A [PcmSource] that starts [skip] samples into another: the take after its leading samples are dropped. */
class OffsetPcm(private val inner: PcmSource, private val skip: Long) : PcmSource {
    override val frames: Long get() = max(0L, inner.frames - skip)
    override fun read(from: Long, out: ShortArray, outOffset: Int, count: Int) = inner.read(from + skip, out, outOffset, count)
    override fun close() = inner.close()
}
