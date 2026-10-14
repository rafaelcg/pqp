package gg.pqp.app.stories

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * What the own ring on the strip shows while a story is on its way, and how far
 * along it is. Pure, so each rule is a JVM test (`StoryOutboxTest`).
 *
 * The ring is a progress ring: bytes handed to the network over bytes in the
 * whole post, across every file the story has (the base and each photo or
 * drawing layer). It never reads full until the story is live, because the
 * create and publish round trips still follow the last byte.
 */
object StoryOutboxRules {

    /** The ring stops here until the server says the story is live. */
    const val RING_CAP = 0.96f

    enum class Status { Preparing, Uploading, Failed }

    /** One post the phone is still making. */
    data class Entry(
        val id: String,
        val status: Status,
        /** Bytes sent over bytes in all, or null while there is nothing to measure (a card of only words). */
        val fraction: Float?,
    )

    /** What the own bubble draws. */
    sealed interface Bubble {
        data object Idle : Bubble

        /**
         * [fraction] null is indeterminate: a post with no files, or one still being made ready.
         * [id] is the post a tap on the ring may stop.
         */
        data class Posting(val fraction: Float?, val id: String) : Bubble

        data class Failed(val id: String) : Bubble
    }

    /** A failure wins over a post still going: it is the one that needs a finger. */
    fun bubble(entries: List<Entry>): Bubble {
        entries.firstOrNull { it.status == Status.Failed }?.let { return Bubble.Failed(it.id) }
        val going = entries.filter { it.status != Status.Failed }
        if (going.isEmpty()) return Bubble.Idle
        // Several at once (rare): the one furthest behind is the honest number, and a tap stops that same one.
        val unknown = going.firstOrNull { it.fraction == null }
        val behind = unknown ?: going.minBy { it.fraction ?: 0f }
        return Bubble.Posting(behind.fraction, behind.id)
    }

    /** Bytes over total, held under [RING_CAP]; null when there is nothing to send. */
    fun ringFraction(sent: Long, total: Long): Float? {
        if (total <= 0L) return null
        val raw = (sent.toDouble() / total).toFloat().coerceIn(0f, 1f)
        return raw * RING_CAP
    }

    /**
     * Bytes sent across a set of files uploading at once. Each file reports its
     * own running total (not a delta), so a retried file that starts over simply
     * reports from zero again and the ring steps back rather than overshooting.
     */
    class Tally(val total: Long) {
        private val perFile = ConcurrentHashMap<String, AtomicLong>()

        fun report(key: String, sentOfFile: Long) {
            perFile.getOrPut(key) { AtomicLong() }.set(sentOfFile)
        }

        val sent: Long get() = perFile.values.sumOf { it.get() }.coerceAtMost(total)
        val fraction: Float? get() = ringFraction(sent, total)
    }
}
