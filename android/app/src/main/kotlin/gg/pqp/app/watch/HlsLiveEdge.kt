package gg.pqp.app.watch

/**
 * How far behind live the watch player sits.
 *
 * LiveKit's sliding playlist is five 2 s segments = 10 s. Sitting 8 s back
 * (four segments) parks the playhead on the segment the next playlist update
 * expires — that is the stall web just left. Sit 6 s back, skip forward at
 * 8 s, never ask for a buffer as wide as the whole window.
 */
object HlsLiveEdge {
    const val SEGMENT_MS = 2_000L
    const val WINDOW_MS = 10_000L

    /** Three segments. Same as `HLS_LIVE_SYNC_DURATION_COUNT * 2 s`. */
    const val TARGET_OFFSET_MS = 6_000L

    /** Two segments: do not sit on the tip waiting for a segment not written. */
    const val MIN_OFFSET_MS = 4_000L

    /** Four segments. Strictly inside the 10 s playlist, not equal to it. */
    const val MAX_OFFSET_MS = 8_000L

    /** Catch up without sounding like a fast-forward. Web `maxLiveSyncPlaybackRate`. */
    const val MAX_PLAYBACK_SPEED = 1.5f

    fun sitsInsideWindow(
        targetMs: Long = TARGET_OFFSET_MS,
        minMs: Long = MIN_OFFSET_MS,
        maxMs: Long = MAX_OFFSET_MS,
    ): Boolean {
        return targetMs < WINDOW_MS - SEGMENT_MS &&
            maxMs < WINDOW_MS &&
            maxMs > targetMs &&
            minMs < targetMs &&
            minMs >= SEGMENT_MS
    }
}
