package gg.pqp.app.voice

import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoQuality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What this client asks the SFU to send it, and how big.
 *
 * The room is joined with `autoSubscribe = false`, so every byte that arrives
 * over the LiveKit leg arrives because [livekitSubscribesTo] said yes. Nothing
 * here can build a `Room`, so this is the whole of the subscription path a JVM
 * test can reach; the wiring that calls it is verified by reading.
 *
 * The case that matters is the one that costs money: a web participant sharing
 * a 1080p screen into a room a phone is in. That share is now wanted, because
 * it is the watch party, so the second half of the bill is
 * [screenReceiveLayerFor]: the layer a phone asks for is never the 1080p one.
 */
class LiveKitSubscriptionTest {

    @Test
    fun `a microphone is subscribed to`() {
        assertTrue(livekitSubscribesTo(Track.Kind.AUDIO, Track.Source.MICROPHONE))
    }

    @Test
    fun `a share's sound is subscribed to`() {
        assertTrue(livekitSubscribesTo(Track.Kind.AUDIO, Track.Source.SCREEN_SHARE_AUDIO))
    }

    @Test
    fun `a screen share is subscribed to`() {
        assertTrue(livekitSubscribesTo(Track.Kind.VIDEO, Track.Source.SCREEN_SHARE))
    }

    @Test
    fun `a camera is never subscribed to`() {
        assertFalse(
            "this client draws no camera tiles, so a camera is not ours to decode",
            livekitSubscribesTo(Track.Kind.VIDEO, Track.Source.CAMERA),
        )
    }

    /**
     * Refused by default, not admitted by default.
     *
     * `UNRECOGNIZED` is what LiveKit hands back for a track kind this version
     * of the SDK has no name for. Subscribing to an unknown kind would be
     * guessing with somebody's data allowance.
     */
    @Test
    fun `an unrecognised kind is refused`() {
        assertFalse(livekitSubscribesTo(Track.Kind.UNRECOGNIZED, Track.Source.SCREEN_SHARE))
    }

    /** Video is admitted by source, so an unlabelled or unknown video stays out. */
    @Test
    fun `video of any other source is refused`() {
        val accepted = Track.Source.entries.filter { livekitSubscribesTo(Track.Kind.VIDEO, it) }
        assertEquals(listOf(Track.Source.SCREEN_SHARE), accepted)
    }

    @Test
    fun `wifi asks for the 720p layer`() {
        assertEquals(VideoQuality.MEDIUM, screenReceiveLayerFor(metered = false))
    }

    @Test
    fun `a metered link asks for the 360p layer`() {
        assertEquals(VideoQuality.LOW, screenReceiveLayerFor(metered = true))
    }

    /** HIGH means "no ceiling" under adaptive stream: a desktop's default, not a phone's. */
    @Test
    fun `a phone never asks for the top layer by default`() {
        listOf(true, false).forEach { metered ->
            assertTrue(screenReceiveLayerFor(metered) != VideoQuality.HIGH)
        }
    }
}
