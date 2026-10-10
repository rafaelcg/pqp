package gg.pqp.app.bau.ui

import android.content.pm.ActivityInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BauVideoPolicyTest {

    @Test
    fun `outside a call the player asks for audio focus`() {
        assertTrue(BauPlaybackPolicy.handleAudioFocus(callActive = false))
    }

    @Test
    fun `during a call the player leaves audio focus to the call`() {
        assertFalse(BauPlaybackPolicy.handleAudioFocus(callActive = true))
    }

    @Test
    fun `picture in picture is armed only for a playing full screen on a capable device`() {
        assertTrue(BauPlaybackPolicy.pipArmed(fullscreen = true, playing = true, supported = true))
        assertFalse(BauPlaybackPolicy.pipArmed(fullscreen = false, playing = true, supported = true))
        assertFalse(BauPlaybackPolicy.pipArmed(fullscreen = true, playing = false, supported = true))
        assertFalse(BauPlaybackPolicy.pipArmed(fullscreen = true, playing = true, supported = false))
    }

    @Test
    fun `a playing inline card pauses when it scrolls away, a full screen one does not`() {
        assertTrue(BauPlaybackPolicy.pauseWhenScrolledAway(fullscreen = false, playing = true))
        assertFalse(BauPlaybackPolicy.pauseWhenScrolledAway(fullscreen = true, playing = true))
        assertFalse(BauPlaybackPolicy.pauseWhenScrolledAway(fullscreen = false, playing = false))
    }

    @Test
    fun `stopping into a picture in picture window does not pause`() {
        assertFalse(BauPlaybackPolicy.pauseOnStop(inPictureInPicture = true))
        assertTrue(BauPlaybackPolicy.pauseOnStop(inPictureInPicture = false))
    }

    @Test
    fun `wide and unknown videos go landscape, portrait ones follow the sensor`() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, fullscreenOrientation(1920, 1080))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, fullscreenOrientation(0, 0))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, fullscreenOrientation(1080, 1080))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_FULL_USER, fullscreenOrientation(1080, 1920))
    }

    @Test
    fun `the picture in picture ratio is clamped to what the system accepts`() {
        assertEquals(16 to 9, BauPip.aspectRatio(0, 0))
        assertEquals(239 to 100, BauPip.aspectRatio(4000, 1000))
        assertEquals(100 to 239, BauPip.aspectRatio(1000, 4000))
        assertEquals(1920 to 1080, BauPip.aspectRatio(1920, 1080))
    }

    @Test
    fun `a second video displaces the first`() {
        val floor = BauActivePlayer()
        assertNull(floor.claim("a"))
        assertEquals("a", floor.claim("b"))
        assertNull(floor.claim("b"))
        assertEquals("b", floor.current)
    }

    @Test
    fun `only the holder can give the floor up`() {
        val floor = BauActivePlayer()
        floor.claim("a")
        floor.claim("b")
        floor.release("a")
        assertEquals("b", floor.current)
        floor.release("b")
        assertNull(floor.current)
    }
}
