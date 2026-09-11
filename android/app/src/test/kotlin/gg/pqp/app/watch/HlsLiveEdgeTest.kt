package gg.pqp.app.watch

import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live-window numbers, without an ExoPlayer.
 *
 * Four segments of a five-segment playlist is the stall: the playhead sits
 * on the row the next `#EXTINF` expires. These constants have to refuse that
 * the same way the iOS `WatchPlayerItemTuning` and the web `hlsLivePlayerConfig`
 * do.
 */
class HlsLiveEdgeTest {

    @Test
    fun `sits 6s behind live, inside a 10s playlist`() {
        assertEquals(6_000L, HlsLiveEdge.TARGET_OFFSET_MS)
        assertEquals(4_000L, HlsLiveEdge.MIN_OFFSET_MS)
        assertEquals(8_000L, HlsLiveEdge.MAX_OFFSET_MS)
        assertTrue(HlsLiveEdge.sitsInsideWindow())
    }

    @Test
    fun `refuses the old 8s-of-10s join`() {
        assertFalse(
            HlsLiveEdge.sitsInsideWindow(
                targetMs = 8_000,
                minMs = 4_000,
                maxMs = 10_000,
            ),
        )
    }

    @Test
    fun `the pane writes the live configuration before prepare`() {
        val pane = RepoSources.androidSources.getValue("WatchPane.kt")
        assertTrue(pane.contains("setLiveConfiguration"))
        assertTrue(pane.contains("HlsLiveEdge.TARGET_OFFSET_MS"))
        assertTrue(pane.contains("HlsLiveEdge.MAX_OFFSET_MS"))
    }
}
