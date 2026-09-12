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
 * that has to be kept in sync with the operator's segment length by hand.
 * The manifest's real `#EXT-X-TARGETDURATION` is not known until the first
 * playlist load, so the pane attaches on [ASSUMED_TARGET_DURATION_MS] (see
 * its own doc for why the join itself, not just the later correction, has
 * to start at the real target) and then, as soon as
 * `player.currentManifest as? HlsManifest` reports a real `targetDurationUs`
 * that DIFFERS from the assumption, corrects it to these ratios via
 * `player.replaceMediaItem` — same URI, so Media3 keeps the existing period
 * rather than restarting the load. That is the fix for the *class* of bug
 * #498's incident is about: a ratio computed from whatever segment length
 * is actually live can never go stale the way a millisecond guess did, at
 * 2 s, 4 s, or whatever `LIVE_HLS_SEGMENT_SECONDS` moves to next, with no
 * client release required either time — the assumption only has to be
 * *plausible* at attach, never correct, because the poll fixes it the
 * moment it is wrong, and never gives up: it keeps checking for as long as
 * this attach is the one on screen.
 *
 * [offsetsFor] clamps all three numbers to [LIVE_WINDOW_MS] rather than
 * applying the multipliers unconditionally, because the multipliers were
 * chosen for a 4 s segment and stop being sane on their own past roughly a
 * 6 s one: 10x a 6 s target is exactly the 60 s window, and 10x anything
 * longer is asking to seek onto a segment the proxy has already dropped.
 * The clamp keeps every result inside the window at any target duration a
 * `Long` can hold, but it is only a safety net, not a design target: the
 * *fixed* `DefaultLoadControl` numbers below (sized once, off
 * [ASSUMED_TARGET_DURATION_MS], because they exist before any manifest
 * does) stop being deep enough for a clamped live-edge target as soon as
 * the real segment length runs longer than the assumption — see
 * [MIN_BUFFER_MS]'s own doc for exactly where that boundary sits, and
 * [HlsLiveEdgeTest] for where both it and the window clamp are pinned. An
 * operator who moves `LIVE_HLS_SEGMENT_SECONDS` past
 * [ASSUMED_TARGET_DURATION_MS] should treat that as needing a client
 * release, not just a config change.
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
     * per the 2026-09-12 "still too close" report. [offsetsFor] clamps the
     * result actually applied; this is the un-clamped ratio.
     */
    const val TARGET_DURATION_MULTIPLIER = 5

    /**
     * Never sit closer to the tip than this many target durations, before
     * [offsetsFor]'s clamp.
     */
    const val MIN_DURATION_MULTIPLIER = 3

    /**
     * Never sit further from the tip than this many target durations,
     * before [offsetsFor]'s clamp. 10 x 4 s = 40 s, comfortably inside the
     * 60 s playlist window (`server/src/voice/hls-live-window.ts`) so a
     * max-offset seek can never land on a segment the window has already
     * dropped.
     */
    const val MAX_DURATION_MULTIPLIER = 10

    /**
     * The live window this app's playlist proxy actually serves, in
     * milliseconds: a hand-copy of `DEFAULT_LIVE_WINDOW_SEGMENTS` (15) times
     * the 4 s `LIVE_HLS_SEGMENT_SECONDS` production runs today, both in
     * `server/src/voice/hls-live-window.ts`. Android has no way to read
     * server source at build time, so this is a mirror, not a reference — if
     * either number moves there, this needs a matching edit here.
     * [offsetsFor] clamps against this so a max-offset seek can never target
     * a segment the window has already dropped, and the `DefaultLoadControl`
     * section below never asks the proxy to buffer more than it can serve.
     */
    const val LIVE_WINDOW_MS = 60_000L

    /**
     * Gentle catch-up only. NOT the `1.5f` #498 dropped: at a 20 s target
     * cushion, closing a lag is a minutes-long nudge, not a sprint, and 1.5x
     * is audibly pitch-shifted speech.
     */
    const val MAX_PLAYBACK_SPEED = 1.05f

    /** The matching slow-down, so a runaway-ahead player eases back too. */
    const val MIN_PLAYBACK_SPEED = 0.97f

    /**
     * The first guess `ui/WatchPane.kt` attaches with, before any manifest
     * has loaded: production's `LIVE_HLS_SEGMENT_SECONDS` today. Applying
     * these ratios against this guess *at attach* — rather than attaching
     * with no `LiveConfiguration` and waiting for the manifest to correct
     * one in later — matters because `DefaultLivePlaybackSpeedControl` only
     * closes a gap between the current offset and the target at
     * [MAX_PLAYBACK_SPEED]: joining at Media3's own 3x fallback (12 s) and
     * later raising the target to 20 s would take the control roughly four
     * and a half minutes to open the last 8 s of cushion, all of it spent on
     * the OLD, shallow buffer the "still too close" report was about.
     * Attaching on this guess starts the join at the real 20 s target
     * immediately; the manifest poll only replaces the item if the loaded
     * playlist's actual target duration turns out to differ from this guess
     * (an operator change to `LIVE_HLS_SEGMENT_SECONDS`), so the common case
     * never pays for a needless `replaceMediaItem` at all.
     *
     * The `DefaultLoadControl` numbers below are sized off this same
     * assumption, once, because the load control is built before the player
     * exists to have a manifest at all — unlike [offsetsFor], it never
     * re-reads the real target duration for the rest of the session.
     */
    const val ASSUMED_TARGET_DURATION_MS = 4_000L

    /**
     * `DefaultLoadControl.Builder.setBufferDurationsMs` arguments for the
     * watch player, so the numbers live beside the target they exist to
     * support and a test can assert them without an ExoPlayer. Expressed as
     * segment multiples of [ASSUMED_TARGET_DURATION_MS] — the same number
     * the initial join uses — rather than independent milliseconds, so the
     * two cannot drift apart:
     *
     * - [BUFFER_FOR_PLAYBACK_MS]: one assumed segment before the first frame.
     * - [BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS]: two assumed segments
     *   refilled before resuming from a stall, rather than Media3's default
     *   one, so a resume does not immediately re-stall on the next tick of
     *   jitter. [HlsWatchdog]'s `stallMs` has a matching comment: it must
     *   clear this number with real margin, or a legitimate refill and a
     *   "give up and reconnect" verdict race each other.
     * - [MIN_BUFFER_MS]: [TARGET_DURATION_MULTIPLIER] assumed segments — the
     *   same ratio the live-edge target uses, so the buffer that has to hold
     *   the cushion is sized off the same number that sizes the cushion.
     *   Otherwise the player reaches the target offset and immediately
     *   empties the buffer it just arrived with.
     * - [MAX_BUFFER_MS]: [LIVE_WINDOW_MS], the hard ceiling — never buffer
     *   more than the playlist can list.
     *
     * Because this is sized once off an ASSUMPTION rather than re-read from
     * the manifest, it stops being a full match the moment the real segment
     * length is longer than the assumption: [MIN_BUFFER_MS] only actually
     * covers [offsetsFor]'s clamped live-edge target while
     * `targetDurationMs <= ASSUMED_TARGET_DURATION_MS` — past that a real
     * `LiveConfiguration` correction (which does react to the manifest) can
     * ask for more cushion than this fixed buffer holds.
     * [MAX_DURATION_MULTIPLIER]'s own window clamp is the more forgiving
     * one and stays meaningful up to about a 6 s segment (past that, 10x
     * the target would exceed [LIVE_WINDOW_MS] on its own and the clamp is
     * doing all the work rather than some of it) — but the buffer-floor
     * relationship above is the tighter constraint, and [HlsLiveEdgeTest]
     * pins both boundaries rather than just the more generous one. Any
     * operator move of `LIVE_HLS_SEGMENT_SECONDS` past
     * [ASSUMED_TARGET_DURATION_MS] should be treated as needing a client
     * release alongside it (a new assumption AND a rebuilt `LoadControl`),
     * not just a config change.
     */
    val BUFFER_FOR_PLAYBACK_MS: Int = ASSUMED_TARGET_DURATION_MS.toInt()

    /** See [BUFFER_FOR_PLAYBACK_MS]'s doc: two assumed segments. */
    val BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS: Int = (ASSUMED_TARGET_DURATION_MS * 2).toInt()

    /** See [BUFFER_FOR_PLAYBACK_MS]'s doc: [TARGET_DURATION_MULTIPLIER] assumed segments. */
    val MIN_BUFFER_MS: Int = (ASSUMED_TARGET_DURATION_MS * TARGET_DURATION_MULTIPLIER).toInt()

    /** See [BUFFER_FOR_PLAYBACK_MS]'s doc: the window ceiling, [LIVE_WINDOW_MS]. */
    val MAX_BUFFER_MS: Int = LIVE_WINDOW_MS.toInt()

    data class Offsets(val targetMs: Long, val minMs: Long, val maxMs: Long)

    /**
     * The ratios above, applied to one platform's actual segment length and
     * clamped inside [LIVE_WINDOW_MS] — see the class doc for why the
     * clamp exists and where it stops being just a safety net.
     */
    fun offsetsFor(targetDurationMs: Long): Offsets {
        val rawTargetMs = targetDurationMs * TARGET_DURATION_MULTIPLIER
        // Never ask for more than half the window: past that a target this
        // deep would leave less than half the window for the max-offset
        // slack below it to live in.
        val targetMs = minOf(rawTargetMs, LIVE_WINDOW_MS / 2)

        val rawMaxMs = targetDurationMs * MAX_DURATION_MULTIPLIER
        // Never target a max offset the window itself could drop: at least
        // two segments of the window (one to join on, one for the playlist
        // to still be growing into) have to sit in front of it. Floored at
        // targetMs so an aggressive clamp can never invert max below target.
        val maxMs = maxOf(minOf(rawMaxMs, LIVE_WINDOW_MS - 2 * targetDurationMs), targetMs)

        val rawMinMs = targetDurationMs * MIN_DURATION_MULTIPLIER
        // Never sit at or past the (possibly clamped) target itself.
        val minMs = minOf(rawMinMs, targetMs - targetDurationMs).coerceAtLeast(0L)

        return Offsets(targetMs = targetMs, minMs = minMs, maxMs = maxMs)
    }
}
