package gg.pqp.app.stories

import kotlin.math.roundToLong

/**
 * Cutting a picked video down to a story: which 30 s, how the window moves
 * under a finger, when a clip needs work at all. Pure, so each edge is a JVM
 * test; `VideoPrep` and `StoryTrimScreen` are the Media3 and Compose halves.
 */
object TrimRules {

    /** What a picked video needs before it can be a story, if anything. */
    enum class Work {
        /** Longer than 30 s: the person chooses the 30 s, then it is shrunk too. */
        Trim,

        /** Fits the length but not the size cap, or is sharper than a story needs. */
        Shrink,
    }

    /** The short edge a story video is shrunk to: 720p, as the camera records it. */
    const val SHORT_EDGE = 720

    /**
     * A clip over [StoriesRules.MAX_VIDEO_MS] must be trimmed. One that is the
     * right length but over the byte cap, or with a short edge well past 720,
     * is shrunk. Anything else goes exactly as it is.
     */
    fun work(durationMs: Long, bytes: Long, width: Int, height: Int, maxBytes: Long): Work? = when {
        durationMs > StoriesRules.MAX_VIDEO_MS -> Work.Trim
        bytes > maxBytes -> Work.Shrink
        minOf(width, height) > SHORT_EDGE * 3 / 2 -> Work.Shrink
        else -> null
    }

    /** How long the kept stretch is: 30 s, or the whole clip when it is shorter. */
    fun windowMs(totalMs: Long): Long = minOf(totalMs, StoriesRules.MAX_VIDEO_MS)

    /** The window's start, held inside the clip. */
    fun clampStart(startMs: Long, totalMs: Long): Long =
        startMs.coerceIn(0L, (totalMs - windowMs(totalMs)).coerceAtLeast(0L))

    /** Where the window starts after a drag of [dragPx] across a strip [trackPx] wide. */
    fun startAfterDrag(startMs: Long, dragPx: Float, trackPx: Float, totalMs: Long): Long {
        if (trackPx <= 0f) return clampStart(startMs, totalMs)
        return clampStart(startMs + (dragPx / trackPx * totalMs).roundToLong(), totalMs)
    }

    /** The window's share of the strip, 0..1, for drawing it. */
    fun windowFraction(totalMs: Long): Float =
        if (totalMs <= 0) 1f else (windowMs(totalMs).toFloat() / totalMs).coerceIn(0f, 1f)

    /** The window's left edge as a share of the strip, 0..1. */
    fun startFraction(startMs: Long, totalMs: Long): Float =
        if (totalMs <= 0) 0f else (clampStart(startMs, totalMs).toFloat() / totalMs).coerceIn(0f, 1f)

    /** Where the filmstrip's frames come from: [count] times spread evenly over the clip. */
    fun thumbTimesMs(totalMs: Long, count: Int): List<Long> {
        if (count <= 0 || totalMs <= 0) return emptyList()
        return List(count) { index -> (totalMs * (2 * index + 1) / (2L * count)) }
    }

    /** "0:12 - 0:42": the stretch that will be kept. A hyphen, never a dash. */
    fun rangeLabel(startMs: Long, endMs: Long): String = "${clock(startMs)} - ${clock(endMs)}"

    fun clock(ms: Long): String {
        val seconds = (ms.coerceAtLeast(0) / 1000).toInt()
        return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
    }

    /**
     * Even width and height for a clip whose short edge is brought down to
     * [SHORT_EDGE], aspect kept (encoders want even sizes). Null when it is
     * already no sharper than that.
     */
    fun shrinkTarget(width: Int, height: Int): Pair<Int, Int>? {
        val short = minOf(width, height)
        if (short <= SHORT_EDGE || short <= 0) return null
        val ratio = SHORT_EDGE.toDouble() / short
        fun even(value: Double): Int = maxOf(2, (value.roundToLong().toInt() / 2) * 2)
        return even(width * ratio) to even(height * ratio)
    }

    /** What a keyboard or TalkBack nudge moves the window by. */
    const val NUDGE_MS = 1_000L
}
