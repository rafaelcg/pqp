package gg.pqp.app.voice

import io.livekit.android.room.track.Track
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What this client asks the SFU to send it.
 *
 * The room is joined with `autoSubscribe = false`, so every byte that arrives
 * over the LiveKit leg arrives because [livekitSubscribesTo] said yes. Nothing
 * here can build a `Room`, so this is the whole of the subscription path a JVM
 * test can reach; the wiring that calls it is verified by reading.
 *
 * The case that matters is the one that costs money: a web participant sharing
 * a 1080p screen into a room a phone is in. With auto-subscribe that stream was
 * received and decoded on mobile data and then dropped on the floor.
 */
class LiveKitSubscriptionTest {

    @Test
    fun `audio is subscribed to`() {
        assertTrue(livekitSubscribesTo(Track.Kind.AUDIO))
    }

    @Test
    fun `video is never subscribed to`() {
        assertFalse(
            "a camera or a screen share is not ours to decode",
            livekitSubscribesTo(Track.Kind.VIDEO),
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
        assertFalse(livekitSubscribesTo(Track.Kind.UNRECOGNIZED))
    }

    /** Every kind that exists is decided, so a new one cannot slip through as audio. */
    @Test
    fun `only audio is accepted, across every kind the sdk defines`() {
        val accepted = Track.Kind.entries.filter { livekitSubscribesTo(it) }
        assertTrue("expected audio alone, got $accepted", accepted == listOf(Track.Kind.AUDIO))
    }
}
