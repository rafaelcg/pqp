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
 * playlist update expires and stalls once per segment. #498 (2026-09-12)
 * answered that by dropping `setLiveConfiguration` entirely and trusting
 * Media3's own manifest-driven fallback (`3 * targetDurationUs`, no min/max),
 * which is correct at any segment length but is also Media3's own hardcoded
 * default: a fixed 3 target-durations of cushion (12 s at 4 s segments) with
 * no configurable floor or ceiling. Reported back the same day: "better, but
 * still too close a buffer... pauses every now and then."
 *
 * So `ui/WatchPane.kt` now DOES apply an explicit `LiveConfiguration` again —
 * a deeper one, [TARGET_DURATION_MULTIPLIER] = 5 target durations (20 s at
 * 4 s) instead of Media3's built-in 3 — but never as a millisecond constant
 * baked in at build time. The manifest's real `#EXT-X-TARGETDURATION` is not
 * known until the first playlist load, so the pane attaches with no
 * `LiveConfiguration` (the same manifest-driven fallback #498 shipped) and
 * then, as soon as `player.currentManifest as? HlsManifest` reports a real
 * `targetDurationUs`, corrects it to these ratios via `player.replaceMediaItem`
 * — same URI, so Media3 keeps the existing period rather than restarting the
 * load — which lands within a couple of ticks of attach, well before the
 * player has actually buffered anywhere near a 12-to-20 s cushion, so there
 * is nothing yet on screen to visibly interrupt. That is the fix for the
 * *class* of bug #498's incident is about: a ratio computed from whatever
 * segment length is actually live can never go stale the way a millisecond
 * guess did, at 2 s, 4 s, or whatever `LIVE_HLS_SEGMENT_SECONDS` moves to
 * next, with no client release required either time.
 *
 * [MAX_PLAYBACK_SPEED] and [MIN_PLAYBACK_SPEED] are the other half of a
 * `LiveConfiguration`: how fast `DefaultLivePlaybackSpeedControl` may nudge
 * playback to hold the target offset. Farol's review of #498 flagged that
 * dropping the explicit configuration also dropped its `1.5f` catch-up cap.
 * 1.5x is audible pitch-correction on every catch-up, which is the wrong
 * trade for a deep, resilience-first cushion: 1.05x/0.97x nudge the playback
 * position back toward the target over tens of seconds, inaudibly, which is
 * the point of carrying 20 s of slack in the first place rather than racing
 * to refill it.
 *
 * The ratios and speeds stay here as the single documented contract the
 * three clients are meant to agree on (only Android applies them as of this
 * change; iOS and web have their own equivalents), and as what
 * [HlsLiveEdgeTest] pins so a future edit cannot reintroduce a fixed-seconds
 * assumption without a test noticing.
 */
object HlsLiveEdge {
    /**
     * Where a join lands, in target durations. RFC 8216 6.3.3 (and Media3's
     * own fallback, see above) both use 3; this app deliberately runs deeper
     * per the 2026-09-12 "still too close" report.
     */
    const val TARGET_DURATION_MULTIPLIER = 5

    /** Never sit closer to the tip than this many target durations. */
    const val MIN_DURATION_MULTIPLIER = 3

    /**
     * Never sit further from the tip than this many target durations. 10 x
     * 4 s = 40 s, comfortably inside the 60 s playlist window
     * (`server/src/voice/hls-live-window.ts`) so a max-offset seek can never
     * land on a segment the window has already dropped.
     */
    const val MAX_DURATION_MULTIPLIER = 10

    /**
     * Gentle catch-up only. NOT the `1.5f` #498 dropped: at a 20 s target
     * cushion, closing a lag is a minutes-long nudge, not a sprint, and 1.5x
     * is audibly pitch-shifted speech.
     */
    const val MAX_PLAYBACK_SPEED = 1.05f

    /** The matching slow-down, so a runaway-ahead player eases back too. */
    const val MIN_PLAYBACK_SPEED = 0.97f

    /**
     * `DefaultLoadControl.Builder.setBufferDurationsMs` arguments for the
     * watch player, so the numbers live beside the target they exist to
     * support and a test can assert them without an ExoPlayer.
     *
     * The buffer has to be at least as deep as [TARGET_DURATION_MULTIPLIER]'s
     * cushion (20 s at 4 s segments) or the player reaches the target offset
     * and immediately empties the buffer back out. [MAX_BUFFER_MS] stays
     * under the 60 s playlist window (`server/src/voice/hls-live-window.ts`)
     * so this never asks the proxy for more than it can serve.
     */
    const val MIN_BUFFER_MS = 20_000

    /** Never asks for more than the 60 s window actually holds. */
    const val MAX_BUFFER_MS = 60_000

    /** About one segment buffered before the very first frame. */
    const val BUFFER_FOR_PLAYBACK_MS = 4_000

    /**
     * About two segments refilled before resuming from a stall, rather than
     * Media3's default one segment, so a resume does not immediately
     * re-stall on the next tick of jitter.
     *
     * [HlsWatchdog]'s `stallMs` has a matching comment: it must clear this
     * number with real margin, or a legitimate refill and a "give up and
     * reconnect" verdict race each other.
     */
    const val BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS = 8_000

    data class Offsets(val targetMs: Long, val minMs: Long, val maxMs: Long)

    /** The ratios above, applied to one platform's actual segment length. */
    fun offsetsFor(targetDurationMs: Long): Offsets = Offsets(
        targetMs = targetDurationMs * TARGET_DURATION_MULTIPLIER,
        minMs = targetDurationMs * MIN_DURATION_MULTIPLIER,
        maxMs = targetDurationMs * MAX_DURATION_MULTIPLIER,
    )
}
