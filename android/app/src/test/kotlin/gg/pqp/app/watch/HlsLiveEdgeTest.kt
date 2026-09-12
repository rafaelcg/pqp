package gg.pqp.app.watch

import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The live-window ratios, without an ExoPlayer.
 *
 * These used to be fixed millisecond constants applied to the player via an
 * explicit `MediaItem.LiveConfiguration`, all derived assuming 2 s segments.
 * `LIVE_HLS_SEGMENT_SECONDS` is an operator knob and moved to 4 s in
 * production without a client release, silently halving every one of those
 * constants in segment terms. So this file now pins the RATIOS, which do not
 * move when the operator's segment length does, and a source check that the
 * player trusts Media3's own manifest-driven default instead of a constant
 * that can go stale again.
 */
class HlsLiveEdgeTest {

    @Test
    fun `ratios match what production ran on 2s segments`() {
        val offsets = HlsLiveEdge.offsetsFor(targetDurationMs = 2_000)
        assertEquals(6_000L, offsets.targetMs)
        assertEquals(4_000L, offsets.minMs)
        assertEquals(12_000L, offsets.maxMs)
    }

    @Test
    fun `the same ratios scale to 4s segments without a client change`() {
        val offsets = HlsLiveEdge.offsetsFor(targetDurationMs = 4_000)
        assertEquals(12_000L, offsets.targetMs)
        assertEquals(8_000L, offsets.minMs)
        assertEquals(24_000L, offsets.maxMs)
    }

    @Test
    fun `refuses the old assumption that a 4s maximum fits a 4s segment`() {
        // #480's MAX_OFFSET_MS was a flat 8_000, two segments at 4 s: the
        // segment the next playlist update expires. The ratio-based maximum
        // is never that close.
        val offsets = HlsLiveEdge.offsetsFor(targetDurationMs = 4_000)
        assertEquals(24_000L, offsets.maxMs)
        assert(offsets.maxMs > 8_000L)
    }

    @Test
    fun `the pane trusts Media3's own manifest-driven default, not a fixed offset`() {
        val pane = RepoSources.androidSources.getValue("WatchPane.kt")
        assertFalse(
            "a hardcoded LiveConfiguration override is exactly what desynced from " +
                "production when the segment length changed",
            pane.contains("setLiveConfiguration"),
        )
    }
}
