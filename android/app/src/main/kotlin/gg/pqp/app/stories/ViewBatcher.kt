package gg.pqp.app.stories

/**
 * The story views waiting to go to `POST /api/stories/views`.
 *
 * A batch that fails goes back in the queue and is tried again on the next
 * flush, so a dropped connection does not leave the author's viewer list one
 * person short. Each id gets a few attempts and is then let go: a view is a
 * courtesy to the author, not something worth retrying forever on a phone
 * that is offline. The server ignores duplicates, so a retry after a lost
 * answer is harmless.
 *
 * Pure and not thread safe; the store touches it from the main thread only.
 */
class ViewBatcher(
    private val maxBatch: Int = 50,
    private val maxAttempts: Int = 4,
) {
    private val pending = linkedSetOf<String>()
    private val attempts = mutableMapOf<String, Int>()

    val isEmpty: Boolean get() = pending.isEmpty()
    val size: Int get() = pending.size

    fun add(storyId: String) {
        pending += storyId
    }

    /** The next batch to send, oldest first, at most [maxBatch] ids. */
    fun take(): List<String> {
        val batch = pending.take(maxBatch)
        pending.removeAll(batch.toSet())
        return batch
    }

    fun succeeded(batch: List<String>) {
        batch.forEach(attempts::remove)
    }

    /** Puts a failed batch back, minus ids that have used up their attempts. */
    fun failed(batch: List<String>) {
        batch.forEach { id ->
            val tries = (attempts[id] ?: 0) + 1
            if (tries < maxAttempts) {
                attempts[id] = tries
                pending += id
            } else {
                attempts.remove(id)
            }
        }
    }

    fun clear() {
        pending.clear()
        attempts.clear()
    }

    companion object {
        /** Wait before the next try after a failure: 2 s, 4 s, 8 s, capped at 30 s. */
        fun backoffMs(failures: Int): Long = (2_000L shl (failures - 1).coerceIn(0, 4)).coerceAtMost(30_000L)
    }
}
