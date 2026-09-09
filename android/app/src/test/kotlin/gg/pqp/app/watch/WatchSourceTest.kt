package gg.pqp.app.watch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rule that decides whether the player throws its buffer away.
 *
 * The failure this guards against has no error anywhere: the audience keyframe
 * restamps the viewer token every thirty seconds, so `hlsUrl` is a different
 * string twice a minute for a stream nobody touched. A player that re-attached
 * on that would rebuffer for the whole party and look like a bad connection.
 */
class WatchSourceTest {

    private fun stream(startedAt: Long, token: String) = LiveStream(
        hlsUrl = "https://api.test/api/voice/hls-playlist/c1/$startedAt?t=$token",
        startedAt = startedAt,
        presenterPeerId = "p1",
        delaySeconds = 10,
    )

    @Test
    fun `a restamped token is not a new source`() {
        assertFalse(watchSourceChanged(stream(100, "aaa"), stream(100, "bbb")))
    }

    @Test
    fun `a new egress session is a new source`() {
        assertTrue(watchSourceChanged(stream(100, "aaa"), stream(200, "aaa")))
    }

    @Test
    fun `arriving and leaving are both changes`() {
        assertTrue(watchSourceChanged(null, stream(100, "a")))
        assertTrue(watchSourceChanged(stream(100, "a"), null))
        assertFalse(watchSourceChanged(null, null))
    }

    @Test
    fun `nothing live and never was says nothing at all`() {
        assertEquals(
            WatchPhase.Idle,
            watchPhaseOf(live = false, everPlayed = false, hasFrame = false, dead = false, reconnecting = false),
        )
    }

    /**
     * A stream that the server says is over is not a failure this phone can
     * retry, so it must not be offered a button that cannot work. `ended`
     * therefore outranks both of the trouble states.
     */
    @Test
    fun `a stream that went away is ended, whatever the player thought`() {
        assertEquals(
            WatchPhase.Ended,
            watchPhaseOf(live = false, everPlayed = true, hasFrame = false, dead = true, reconnecting = true),
        )
    }

    @Test
    fun `dead outranks reconnecting`() {
        assertEquals(
            WatchPhase.Dead,
            watchPhaseOf(live = true, everPlayed = true, hasFrame = false, dead = true, reconnecting = true),
        )
    }

    @Test
    fun `live with no frame yet is opening, not broken`() {
        assertEquals(
            WatchPhase.Opening,
            watchPhaseOf(live = true, everPlayed = false, hasFrame = false, dead = false, reconnecting = false),
        )
    }

    @Test
    fun `a frame is playing`() {
        assertEquals(
            WatchPhase.Playing,
            watchPhaseOf(live = true, everPlayed = true, hasFrame = true, dead = false, reconnecting = false),
        )
    }
}
