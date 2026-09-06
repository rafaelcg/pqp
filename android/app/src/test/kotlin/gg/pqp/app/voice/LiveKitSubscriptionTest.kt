package gg.pqp.app.voice

import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoQuality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
 * a 1080p screen into a room a phone is in, and, since cameras were admitted,
 * the twenty faces that can be in the room with it. Both are wanted now, so
 * the rest of the bill is the two layer ceilings, [screenReceiveLayerFor] and
 * [cameraReceiveLayerFor], neither of which ever asks for the top layer.
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

    /**
     * The gap this closed. A phone in the 5 Sep watch party saw the film and
     * not one of the faces, because this returned false.
     */
    @Test
    fun `a camera is subscribed to`() {
        assertTrue(
            "a room where every face is missing on Android alone is the bug",
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

    /**
     * Video is admitted by source, so an unlabelled or unknown video stays out.
     *
     * Written as the whole accepted set rather than as a refusal per source, so
     * that a source added to the SDK is refused by default and this test is
     * what says so: admitting one nothing can draw is bytes on somebody's bill
     * for a picture that reaches no screen.
     */
    @Test
    fun `video of any other source is refused`() {
        val accepted = Track.Source.entries.filter { livekitSubscribesTo(Track.Kind.VIDEO, it) }
        assertEquals(
            setOf(Track.Source.SCREEN_SHARE, Track.Source.CAMERA),
            accepted.toSet(),
        )
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

    // --- cameras -----------------------------------------------------------

    /**
     * A tile is about a hundred dp wide and there can be several at once, so
     * the strip takes the bottom layer whatever the link is. This is the
     * difference between a room of six cameras costing about what one share
     * does and costing six times it.
     */
    @Test
    fun `a rail tile asks for the bottom layer, metered or not`() {
        assertEquals(VideoQuality.LOW, cameraReceiveLayerFor(false, CameraSurface.Tile))
        assertEquals(VideoQuality.LOW, cameraReceiveLayerFor(true, CameraSurface.Tile))
    }

    @Test
    fun `the full-screen viewer asks for 360p on wifi`() {
        assertEquals(VideoQuality.MEDIUM, cameraReceiveLayerFor(false, CameraSurface.Fullscreen))
    }

    /** Mobile data is a fact about the bill, not about the screen's size. */
    @Test
    fun `a metered link stays at the bottom layer even full screen`() {
        assertEquals(VideoQuality.LOW, cameraReceiveLayerFor(true, CameraSurface.Fullscreen))
    }

    @Test
    fun `a phone never asks for the top layer of a camera either`() {
        CameraSurface.entries.forEach { surface ->
            listOf(true, false).forEach { metered ->
                assertTrue(
                    "$surface on metered=$metered asked for HIGH",
                    cameraReceiveLayerFor(metered, surface) != VideoQuality.HIGH,
                )
            }
        }
    }

    /**
     * Opening the viewer has to be able to *raise* the layer, or the tile's
     * ceiling would follow the picture onto the full screen and a face would
     * be drawn at rail resolution across a phone.
     */
    @Test
    fun `the viewer is never a smaller layer than the tile`() {
        listOf(true, false).forEach { metered ->
            val tile = cameraReceiveLayerFor(metered, CameraSurface.Tile)
            val full = cameraReceiveLayerFor(metered, CameraSurface.Fullscreen)
            assertTrue(full.ordinal >= tile.ordinal)
        }
    }
}

/**
 * What the SFU is actually told about one camera.
 *
 * [cameraReceiveLayerFor] above answers "how big"; this answers the prior
 * question, "at all", and the two together are the whole message the engine
 * sends. It is tested apart from the engine because the engine cannot be
 * tested here at all, and a rule that lives only inside it is a rule nothing on
 * this machine can check.
 */
class CameraDeliveryTest {

    @Test
    fun `nobody drawing it means paused, and says nothing about the layer`() {
        val delivery = cameraDeliveryFor(surface = null, muted = false, metered = false)
        assertFalse(delivery.enabled)
        assertNull(
            "a layer for a stream that is stopping is a second message that changes nothing",
            delivery.quality,
        )
    }

    @Test
    fun `a tile on screen is delivered at the tile layer`() {
        val delivery = cameraDeliveryFor(CameraSurface.Tile, muted = false, metered = false)
        assertTrue(delivery.enabled)
        assertEquals(VideoQuality.LOW, delivery.quality)
    }

    @Test
    fun `the viewer is delivered at the viewer's layer`() {
        val delivery = cameraDeliveryFor(CameraSurface.Fullscreen, muted = false, metered = false)
        assertTrue(delivery.enabled)
        assertEquals(VideoQuality.MEDIUM, delivery.quality)
    }

    @Test
    fun `a metered link caps the viewer too`() {
        val delivery = cameraDeliveryFor(CameraSurface.Fullscreen, muted = false, metered = true)
        assertTrue(delivery.enabled)
        assertEquals(VideoQuality.LOW, delivery.quality)
    }

    /**
     * A muted camera has no frames to send, and its tile is already down. Asking
     * for it anyway is a subscription paying for keepalives, and, worse, would
     * hold a stale picture on screen if the tile ever came back before the
     * unmute did.
     */
    @Test
    fun `a muted camera is never delivered, not even to an open viewer`() {
        CameraSurface.entries.forEach { surface ->
            listOf(true, false).forEach { metered ->
                val delivery = cameraDeliveryFor(surface, muted = true, metered = metered)
                assertFalse("$surface on metered=$metered was delivered while muted", delivery.enabled)
            }
        }
    }

    /** Every reachable answer is either paused with no layer, or on with one. */
    @Test
    fun `an enabled delivery always names a layer and a paused one never does`() {
        val surfaces = listOf<CameraSurface?>(null) + CameraSurface.entries
        surfaces.forEach { surface ->
            listOf(true, false).forEach { muted ->
                listOf(true, false).forEach { metered ->
                    val delivery = cameraDeliveryFor(surface, muted, metered)
                    assertEquals(
                        "surface=$surface muted=$muted metered=$metered",
                        delivery.enabled,
                        delivery.quality != null,
                    )
                    assertTrue(delivery.quality != VideoQuality.HIGH)
                }
            }
        }
    }
}
