package gg.pqp.app.watch

/**
 * The live-edge ratios this app shares with iOS (`WatchLiveEdge.swift`) and
 * the web (`hlsLivePlayerConfig()`), expressed as multiples of the
 * playlist's own `#EXT-X-TARGETDURATION` rather than a fixed number of
 * seconds.
 *
 * A prior version of this file hardcoded 6 s / 4 s / 8 s and applied them to
 * the player via an explicit `MediaItem.LiveConfiguration`, assuming the 2 s
 * segments that were true in production the day it shipped.
 * `LIVE_HLS_SEGMENT_SECONDS` is an operator knob (`docs/WATCH_PARTY.md`) and
 * moved to 4 s without a client release, so every one of those constants
 * silently doubled in segment count: an 8 s maximum on a 4 s segment is two
 * segments, not four, which parks the playhead on the segment the next
 * playlist update expires and stalls once per segment.
 *
 * `ui/WatchPane.kt` does not apply these itself and deliberately builds the
 * `MediaItem` with no `setLiveConfiguration` call. Confirmed against the
 * androidx/media source (`HlsMediaPeriod`'s live-offset fallback,
 * https://github.com/androidx/media/pull/8764, and the Media3 live-streaming
 * guide): with no `LiveConfiguration` on the `MediaItem` and no
 * `#EXT-X-SERVER-CONTROL` in the playlist (ours has neither), ExoPlayer
 * resolves `targetLiveOffsetUs` itself as `3 * targetDurationUs`, read off
 * the manifest it is actually playing — the same [TARGET_DURATION_MULTIPLIER]
 * below, computed from the real segment length instead of a guess baked in
 * at build time. That is correct for 2 s segments, 4 s segments, or whatever
 * the operator sets next, with no client change.
 *
 * The ratios stay here, unapplied, as the single documented contract the
 * three clients are meant to agree on, and as what [HlsLiveEdgeTest] pins so
 * a future edit cannot reintroduce a fixed-seconds assumption without a test
 * noticing.
 */
object HlsLiveEdge {
    /** Where a join lands, in target durations. RFC 8216, 6.3.3. */
    const val TARGET_DURATION_MULTIPLIER = 3

    /** Never sit closer to the tip than this many target durations. */
    const val MIN_DURATION_MULTIPLIER = 2

    /** Never sit further from the tip than this many target durations. */
    const val MAX_DURATION_MULTIPLIER = 6

    data class Offsets(val targetMs: Long, val minMs: Long, val maxMs: Long)

    /** The ratios above, applied to one platform's actual segment length. */
    fun offsetsFor(targetDurationMs: Long): Offsets = Offsets(
        targetMs = targetDurationMs * TARGET_DURATION_MULTIPLIER,
        minMs = targetDurationMs * MIN_DURATION_MULTIPLIER,
        maxMs = targetDurationMs * MAX_DURATION_MULTIPLIER,
    )
}
