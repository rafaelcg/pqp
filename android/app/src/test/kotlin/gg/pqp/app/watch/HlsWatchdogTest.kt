package gg.pqp.app.watch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * When the player gives up, and when it stops giving up.
 *
 * Every case here is one that actually happens at a watch party, and the two
 * that matter most are the ones a player would get wrong on its own:
 * `STATE_ENDED` is a stopped egress rather than a video that finished, and a
 * playlist whose media sequence has frozen is a dead transcode that still
 * answers 200.
 */
class HlsWatchdogTest {

    @Test
    fun `a healthy stream asks for nothing`() {
        val dog = HlsWatchdog()
        dog.onSourceChanged(0)
        dog.onPlaying()
        var now = 0L
        var sequence = 0L
        repeat(60) {
            now += 1_000
            sequence += 1
            dog.onMediaSequence(sequence, now)
            assertEquals(WatchdogDecision.None, dog.tick(now))
        }
        assertNull(dog.lastReason)
    }

    @Test
    fun `a fatal error reconnects on the next tick`() {
        val dog = HlsWatchdog()
        dog.onSourceChanged(0)
        dog.onError()
        assertEquals(WatchdogDecision.Reconnect, dog.tick(1_000))
        assertEquals(WatchdogReason.Fatal, dog.lastReason)
        // The reconnect cleared it. A single error must not ask twice.
        assertEquals(WatchdogDecision.None, dog.tick(2_000))
    }

    /**
     * `#EXT-X-ENDLIST`. LiveKit writes it when the egress stops, and a reused
     * `live.m3u8` stays that finished VOD until the next share overwrites it.
     * Playing it is a black frame, so it is a source to refetch and never a
     * video that ended.
     */
    @Test
    fun `the end of the playlist is a source to refetch`() {
        val dog = HlsWatchdog()
        dog.onSourceChanged(0)
        dog.onEnded()
        assertEquals(WatchdogDecision.Reconnect, dog.tick(500))
        assertEquals(WatchdogReason.Ended, dog.lastReason)
    }

    @Test
    fun `buffering for less than the stall window is patience, not a stall`() {
        val dog = HlsWatchdog(stallMs = 8_000)
        dog.onSourceChanged(0)
        dog.onBuffering(1_000)
        assertEquals(WatchdogDecision.None, dog.tick(8_000))
        assertEquals(WatchdogDecision.Reconnect, dog.tick(9_000))
        assertEquals(WatchdogReason.Stall, dog.lastReason)
    }

    @Test
    fun `a frame arriving clears the stall clock`() {
        val dog = HlsWatchdog(stallMs = 8_000)
        dog.onSourceChanged(0)
        dog.onBuffering(1_000)
        dog.onPlaying()
        assertEquals(WatchdogDecision.None, dog.tick(60_000))
    }

    @Test
    fun `a playlist that stops advancing is a dead egress`() {
        val dog = HlsWatchdog(sequenceStuckMs = 15_000)
        dog.onSourceChanged(0)
        dog.onMediaSequence(42, 1_000)
        assertEquals(WatchdogDecision.None, dog.tick(15_000))
        assertEquals(WatchdogDecision.Reconnect, dog.tick(16_001))
        assertEquals(WatchdogReason.SequenceStuck, dog.lastReason)
    }

    @Test
    fun `a sequence that keeps moving never trips`() {
        val dog = HlsWatchdog(sequenceStuckMs = 15_000)
        dog.onSourceChanged(0)
        var now = 0L
        repeat(30) { index ->
            now += 2_000
            dog.onMediaSequence(index.toLong(), now)
            assertEquals(WatchdogDecision.None, dog.tick(now))
        }
    }

    @Test
    fun `three reconnects inside the window and the fourth is dead`() {
        val dog = HlsWatchdog(maxReconnects = 3, windowMs = 300_000)
        dog.onSourceChanged(0)
        var now = 0L
        repeat(3) {
            now += 10_000
            dog.onError()
            assertEquals(WatchdogDecision.Reconnect, dog.tick(now))
        }
        now += 10_000
        dog.onError()
        assertEquals(WatchdogDecision.Dead, dog.tick(now))
    }

    /**
     * A party runs for hours. Three failures spread over an evening is a link
     * having a bad minute, not a stream that is gone, and the person must not
     * be shown a retry button because of something that happened at the start.
     */
    @Test
    fun `attempts age out of the window`() {
        val dog = HlsWatchdog(maxReconnects = 3, windowMs = 300_000)
        dog.onSourceChanged(0)
        var now = 0L
        repeat(3) {
            now += 1_000
            dog.onError()
            assertEquals(WatchdogDecision.Reconnect, dog.tick(now))
        }
        now += 300_001
        dog.onError()
        assertEquals(WatchdogDecision.Reconnect, dog.tick(now))
    }

    @Test
    fun `a retry press is a clean slate`() {
        val dog = HlsWatchdog(maxReconnects = 1, windowMs = 300_000)
        dog.onSourceChanged(0)
        dog.onError()
        assertEquals(WatchdogDecision.Reconnect, dog.tick(1_000))
        dog.onError()
        assertEquals(WatchdogDecision.Dead, dog.tick(2_000))

        dog.reset(3_000)
        dog.onError()
        assertEquals(WatchdogDecision.Reconnect, dog.tick(4_000))
    }

    /**
     * The reconnect starts its own clocks. Judging the new attempt from the
     * moment the old one stalled would call it dead before it had loaded a
     * single segment.
     */
    @Test
    fun `a reconnect is judged from its own attach`() {
        val dog = HlsWatchdog(stallMs = 8_000, maxReconnects = 3)
        dog.onSourceChanged(0)
        dog.onBuffering(0)
        assertEquals(WatchdogDecision.Reconnect, dog.tick(9_000))
        // Still buffering as far as the element is concerned, but the clock
        // restarted, so nothing is due until 8 s after the reconnect.
        assertEquals(WatchdogDecision.None, dog.tick(10_000))
        dog.onBuffering(10_000)
        assertEquals(WatchdogDecision.None, dog.tick(17_000))
        assertEquals(WatchdogDecision.Reconnect, dog.tick(18_001))
    }
}
