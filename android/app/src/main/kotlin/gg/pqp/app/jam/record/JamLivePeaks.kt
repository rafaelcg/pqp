package gg.pqp.app.jam.record

/** The live waveform as the screen draws it: [values] (0..1), each the loudest of [bucketMs] of the capture. */
class LivePeaks(val bucketMs: Int, val values: FloatArray) {
    companion object {
        val Empty = LivePeaks(JamLivePeaks.BASE_MS, FloatArray(0))
    }
}

/**
 * The live waveform's data, bounded: the loudest value per [BASE_MS] of capture, and once there are more than
 * [MAX_BUCKETS] of them neighbours are merged in pairs (the louder of the two) and the bucket doubles, so a ten minute
 * take is never more than a couple of thousand numbers: reading it sixty times a second copies a few kilobytes and
 * drawing it is a bounded number of bars, whatever the length of the take.
 *
 * Written by the capture thread and read by the screen: every method is synchronised.
 */
class JamLivePeaks {
    private val lock = Any()
    private var values = FloatArray(MAX_BUCKETS + 2)
    private var count = 0
    private var bucketMs = BASE_MS

    /** The bucket being filled: the loudest base value so far and how many base values it holds. */
    private var open = 0f
    private var openN = 0

    /** One [BASE_MS] of capture, its loudest sample 0..1. */
    fun add(peak: Float) = synchronized(lock) {
        open = maxOf(open, peak.coerceIn(0f, 1f))
        openN += 1
        if (openN * BASE_MS >= bucketMs) {
            values[count++] = open
            open = 0f
            openN = 0
            if (count > MAX_BUCKETS) merge()
        }
    }

    /** Pairs by max, in place; the bucket doubles. An odd last value stays alone. */
    private fun merge() {
        var w = 0
        var r = 0
        while (r < count) {
            values[w++] = if (r + 1 < count) maxOf(values[r], values[r + 1]) else values[r]
            r += 2
        }
        count = w
        bucketMs *= 2
    }

    /** What has been captured, the bucket still being filled included. */
    fun snapshot(): LivePeaks = synchronized(lock) {
        val out = values.copyOf(count + if (openN > 0) 1 else 0)
        if (openN > 0) out[count] = open
        LivePeaks(bucketMs, out)
    }

    companion object {
        const val BASE_MS = 80
        const val MAX_BUCKETS = 2048
    }
}
