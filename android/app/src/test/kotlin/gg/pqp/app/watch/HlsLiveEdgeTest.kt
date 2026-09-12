package gg.pqp.app.watch

import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live-window ratios and playback-speed caps, without an ExoPlayer.
 *
 * These used to be fixed millisecond constants applied to the player via an
 * explicit `MediaItem.LiveConfiguration`, all derived assuming 2 s segments.
 * `LIVE_HLS_SEGMENT_SECONDS` is an operator knob and moved to 4 s in
 * production without a client release, silently halving every one of those
 * constants in segment terms (#480). The fix for that (dropping
 * `setLiveConfiguration` and trusting Media3's own manifest-driven fallback)
 * was itself too shallow a cushion on its own — "still too close a buffer...
 * pauses every now and then" — so `ui/WatchPane.kt` now applies an explicit
 * `LiveConfiguration` again, deeper, but still derived from the manifest's
 * real target duration rather than a millisecond guess. This file pins the
 * RATIOS, which do not move when the operator's segment length does, and a
 * source check that `ui/WatchPane.kt` derives the applied configuration from
 * `HlsLiveEdge.offsetsFor` rather than any other constant.
 */
class HlsLiveEdgeTest {

    @Test
    fun `ratios at 4s segments, the multiplier this app runs deeper than Media3's own 3x fallback`() {
        val offsets = HlsLiveEdge.offsetsFor(targetDurationMs = 4_000)
        assertEquals(20_000L, offsets.targetMs)
        assertEquals(12_000L, offsets.minMs)
        assertEquals(40_000L, offsets.maxMs)
    }

    @Test
    fun `the same ratios scale to 2s segments without a client change`() {
        val offsets = HlsLiveEdge.offsetsFor(targetDurationMs = 2_000)
        assertEquals(10_000L, offsets.targetMs)
        assertEquals(6_000L, offsets.minMs)
        assertEquals(20_000L, offsets.maxMs)
    }

    @Test
    fun `the maximum stays inside the 60s playlist window at 4s segments`() {
        // server/src/voice/hls-live-window.ts serves a 60 s window. A max
        // offset at or past that would ask the player to seek onto a segment
        // the window has already dropped.
        val offsets = HlsLiveEdge.offsetsFor(targetDurationMs = 4_000)
        assertTrue(offsets.maxMs < 60_000L)
    }

    @Test
    fun `refuses the old assumption that a 4s maximum fits a 4s segment`() {
        // #480's MAX_OFFSET_MS was a flat 8_000, two segments at 4 s: the
        // segment the next playlist update expires. The ratio-based maximum
        // is never that close.
        val offsets = HlsLiveEdge.offsetsFor(targetDurationMs = 4_000)
        assertTrue(offsets.maxMs > 8_000L)
    }

    @Test
    fun `catch-up speeds are gentle, not the 1_5x that audibly pitch-shifts`() {
        assertEquals(1.05f, HlsLiveEdge.MAX_PLAYBACK_SPEED, 0.0f)
        assertEquals(0.97f, HlsLiveEdge.MIN_PLAYBACK_SPEED, 0.0f)
    }

    @Test
    fun `load control pre-loads about two segments and refills about two after a stall`() {
        assertEquals(20_000, HlsLiveEdge.MIN_BUFFER_MS)
        assertEquals(60_000, HlsLiveEdge.MAX_BUFFER_MS)
        assertEquals(4_000, HlsLiveEdge.BUFFER_FOR_PLAYBACK_MS)
        assertEquals(8_000, HlsLiveEdge.BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS)
    }

    @Test
    fun `the buffer holds at least as much as the target cushion asks for`() {
        // Otherwise the player reaches the target offset and immediately
        // empties the buffer it just arrived with.
        val offsets = HlsLiveEdge.offsetsFor(targetDurationMs = 4_000)
        assertTrue(HlsLiveEdge.MIN_BUFFER_MS >= offsets.targetMs)
    }

    @Test
    fun `the load control never asks the 60s proxy window for more than it holds`() {
        assertTrue(HlsLiveEdge.MAX_BUFFER_MS <= 60_000)
    }

    @Test
    fun `the pane derives its LiveConfiguration from offsetsFor, not a separate constant`() {
        val pane = RepoSources.androidSources.getValue("WatchPane.kt")
        assertTrue(
            "a hardcoded LiveConfiguration is exactly what desynced from production " +
                "when the segment length changed (#480); it must come from offsetsFor",
            pane.contains("HlsLiveEdge.offsetsFor"),
        )
        assertTrue(
            "the corrected LiveConfiguration must carry the gentle catch-up caps",
            pane.contains("HlsLiveEdge.MAX_PLAYBACK_SPEED") &&
                pane.contains("HlsLiveEdge.MIN_PLAYBACK_SPEED"),
        )
        assertTrue(
            "the LoadControl must read the shared buffer constants, not inlined " +
                "literals that can drift from what HlsWatchdog assumes",
            pane.contains("HlsLiveEdge.MIN_BUFFER_MS") &&
                pane.contains("HlsLiveEdge.MAX_BUFFER_MS") &&
                pane.contains("HlsLiveEdge.BUFFER_FOR_PLAYBACK_MS") &&
                pane.contains("HlsLiveEdge.BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS"),
        )
    }
}
