package gg.pqp.app.watch

import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live-window ratios, the window clamp, and the playback-speed caps,
 * without an ExoPlayer.
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
 * RATIOS and the [HlsLiveEdge.LIVE_WINDOW_MS] clamp, which do not move when
 * the operator's segment length does, and a source check that
 * `ui/WatchPane.kt` derives every applied configuration from
 * `HlsLiveEdge.offsetsFor` / the shared constants rather than a raw literal.
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
    fun `offsets stay ordered and inside the 60s window at 2, 4, 6, 8 and 10s targets`() {
        // Not every one of these is a realistic `LIVE_HLS_SEGMENT_SECONDS`;
        // the point is that offsetsFor never hands back an inverted or
        // out-of-window triple, however far the operator pushes the knob.
        for (targetDurationMs in longArrayOf(2_000, 4_000, 6_000, 8_000, 10_000)) {
            val offsets = HlsLiveEdge.offsetsFor(targetDurationMs)
            assertTrue(
                "min must sit below target at ${targetDurationMs}ms, got $offsets",
                offsets.minMs < offsets.targetMs,
            )
            assertTrue(
                "target must sit at or below max at ${targetDurationMs}ms, got $offsets",
                offsets.targetMs <= offsets.maxMs,
            )
            assertTrue(
                "max must stay inside the 60s window at ${targetDurationMs}ms, got $offsets",
                offsets.maxMs <= HlsLiveEdge.LIVE_WINDOW_MS,
            )
        }
    }

    @Test
    fun `the max-offset window clamp only bites once 10x the target would exceed the window`() {
        // 10 x 4s = 40_000, well inside the 60s window: unclamped.
        assertEquals(40_000L, HlsLiveEdge.offsetsFor(4_000).maxMs)
        // 10 x 6s = 60_000, exactly the window: the clamp (window - 2*target)
        // already bites here, landing at 48_000 rather than the raw 60_000.
        assertEquals(48_000L, HlsLiveEdge.offsetsFor(6_000).maxMs)
        // 10 x 8s / 10 x 10s clamp further still.
        assertEquals(44_000L, HlsLiveEdge.offsetsFor(8_000).maxMs)
        assertEquals(40_000L, HlsLiveEdge.offsetsFor(10_000).maxMs)
    }

    @Test
    fun `the fixed load control covers the live-edge target only at the assumed segment length`() {
        // MIN_BUFFER_MS is sized once, off ASSUMED_TARGET_DURATION_MS, and
        // never re-reads the manifest. It matches offsetsFor's target
        // exactly at the assumption itself...
        assertEquals(
            HlsLiveEdge.MIN_BUFFER_MS.toLong(),
            HlsLiveEdge.offsetsFor(HlsLiveEdge.ASSUMED_TARGET_DURATION_MS).targetMs,
        )
        // ...and stops covering it for any real segment length longer than
        // the assumption, which is exactly why an operator move of
        // `LIVE_HLS_SEGMENT_SECONDS` past this needs a client release: a
        // manifest-driven `LiveConfiguration` correction would then ask for
        // more cushion than this fixed buffer holds.
        for (targetDurationMs in longArrayOf(6_000, 8_000, 10_000)) {
            val offsets = HlsLiveEdge.offsetsFor(targetDurationMs)
            assertTrue(
                "MIN_BUFFER_MS should no longer cover the live-edge target at " +
                    "${targetDurationMs}ms, but ${HlsLiveEdge.MIN_BUFFER_MS} >= ${offsets.targetMs}",
                HlsLiveEdge.MIN_BUFFER_MS < offsets.targetMs,
            )
        }
        // Shorter than the assumption is always covered too: the ratio only
        // grows with segment length.
        assertTrue(HlsLiveEdge.MIN_BUFFER_MS >= HlsLiveEdge.offsetsFor(2_000).targetMs)
    }

    @Test
    fun `load control is expressed in assumed-segment multiples, not independent literals`() {
        val assumed = HlsLiveEdge.ASSUMED_TARGET_DURATION_MS
        assertEquals(assumed, HlsLiveEdge.BUFFER_FOR_PLAYBACK_MS.toLong())
        assertEquals(assumed * 2, HlsLiveEdge.BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS.toLong())
        assertEquals(assumed * HlsLiveEdge.TARGET_DURATION_MULTIPLIER, HlsLiveEdge.MIN_BUFFER_MS.toLong())
        assertEquals(HlsLiveEdge.LIVE_WINDOW_MS, HlsLiveEdge.MAX_BUFFER_MS.toLong())
    }

    @Test
    fun `the load control never asks the 60s proxy window for more than it holds`() {
        assertTrue(HlsLiveEdge.MAX_BUFFER_MS <= 60_000)
    }

    @Test
    fun `the pane joins on the assumed target and only corrects it, never with a raw literal`() {
        val pane = RepoSources.androidSources.getValue("WatchPane.kt")
        assertTrue(
            "the initial join must carry a real LiveConfiguration derived from the " +
                "assumed target, not attach bare (Media3's own fallback is too shallow) " +
                "or with a hardcoded ms guess",
            pane.contains("liveMediaItem(url, HlsLiveEdge.ASSUMED_TARGET_DURATION_MS)"),
        )
        assertTrue(
            "the correction must compare against the assumed constant, not a raw literal, " +
                "so it only replaces the item when the manifest actually disagrees",
            pane.contains("targetDurationMs != HlsLiveEdge.ASSUMED_TARGET_DURATION_MS"),
        )
        assertFalse(
            "the manifest poll must not give up after a fixed number of attempts",
            pane.contains("repeat("),
        )
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
