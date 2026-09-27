package gg.pqp.app.watch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The presenter's camera, laid out over the film.
 *
 * A port of `client/src/lib/watch-camera-pip.test.ts`'s cases, kept to the
 * same four layouts so a bug in one is a bug in the mirrored rule too.
 */
class WatchCameraLayoutTest {

    // --- corners -----------------------------------------------------

    @Test
    fun `the corner cycles clockwise and wraps after four`() {
        var corner = CameraPipCorner.TopLeft
        val seen = mutableListOf(corner)
        repeat(4) {
            corner = nextCameraPipCorner(corner)
            seen += corner
        }
        assertEquals(
            listOf(
                CameraPipCorner.TopLeft,
                CameraPipCorner.TopRight,
                CameraPipCorner.BottomRight,
                CameraPipCorner.BottomLeft,
                CameraPipCorner.TopLeft,
            ),
            seen,
        )
    }

    // --- whether the picker (and the picture) is offered at all -------

    @Test
    fun `no camera playlist offers nothing`() {
        assertFalse(cameraLayoutOffered(cameraSrc = null, cameraHasVideo = true))
    }

    @Test
    fun `a voice-only camera offers no layout picker`() {
        assertFalse(cameraLayoutOffered(cameraSrc = "https://x/cam.m3u8", cameraHasVideo = false))
    }

    @Test
    fun `a real camera picture offers the picker`() {
        assertTrue(cameraLayoutOffered(cameraSrc = "https://x/cam.m3u8", cameraHasVideo = true))
    }

    // --- the layout actually in force ---------------------------------

    @Test
    fun `the viewer's layout applies only while there is a picture`() {
        val pref = CameraPipPref(CameraPipCorner.TopLeft, WatchCameraLayout.Side)
        assertEquals(WatchCameraLayout.Side, effectiveCameraLayout(pref, cameraHasVideo = true))
        assertEquals(WatchCameraLayout.Pip, effectiveCameraLayout(pref, cameraHasVideo = false))
    }

    // --- whether the player is mounted at all --------------------------

    @Test
    fun `nothing is mounted with no camera source`() {
        assertFalse(cameraPipMounted(null, WatchCameraLayout.Pip, hasVoiceAudio = false))
    }

    @Test
    fun `hide-webcam unmounts the player unless it carries the voice`() {
        assertFalse(cameraPipMounted("https://x/cam.m3u8", WatchCameraLayout.Stream, hasVoiceAudio = false))
        assertTrue(cameraPipMounted("https://x/cam.m3u8", WatchCameraLayout.Stream, hasVoiceAudio = true))
    }

    @Test
    fun `every other layout stays mounted`() {
        for (layout in listOf(WatchCameraLayout.Pip, WatchCameraLayout.Side, WatchCameraLayout.Camera)) {
            assertTrue(cameraPipMounted("https://x/cam.m3u8", layout, hasVoiceAudio = false))
        }
    }

    // --- the placement itself -------------------------------------------

    @Test
    fun `not mounted is the film alone, full stage`() {
        val placement = watchStagePlacement(
            mounted = false,
            hasFrame = false,
            hasVideo = true,
            pref = CameraPipPref.DEFAULT,
            layout = WatchCameraLayout.Pip,
        )
        assertEquals(StageSlot.Full, placement.film)
        assertEquals(null, placement.camera)
        assertEquals(null, placement.corner)
    }

    @Test
    fun `mounted but no frame yet is invisible, not a black rectangle`() {
        val placement = watchStagePlacement(
            mounted = true,
            hasFrame = false,
            hasVideo = true,
            pref = CameraPipPref.DEFAULT,
            layout = WatchCameraLayout.Pip,
        )
        assertEquals(StageSlot.Full, placement.film)
        assertEquals(StageSlot.Hidden, placement.camera)
        assertTrue(placement.cameraLoading)
        assertEquals(CameraPipPref.DEFAULT.corner, placement.corner)
    }

    @Test
    fun `pip is the film full with the camera in its corner`() {
        val placement = watchStagePlacement(
            mounted = true,
            hasFrame = true,
            hasVideo = true,
            pref = CameraPipPref(CameraPipCorner.TopLeft, WatchCameraLayout.Pip),
            layout = WatchCameraLayout.Pip,
        )
        assertEquals(StageSlot.Full, placement.film)
        assertEquals(StageSlot.Hidden, placement.camera)
        assertEquals(CameraPipCorner.TopLeft, placement.corner)
        assertFalse(placement.cameraVoiceOnly)
    }

    @Test
    fun `side puts the film on top and the camera below`() {
        val placement = watchStagePlacement(
            mounted = true,
            hasFrame = true,
            hasVideo = true,
            pref = CameraPipPref.DEFAULT,
            layout = WatchCameraLayout.Side,
        )
        assertEquals(StageSlot.TopHalf, placement.film)
        assertEquals(StageSlot.BottomHalf, placement.camera)
        assertEquals(null, placement.corner)
    }

    @Test
    fun `hide-stream gives the camera the whole stage, film covered behind it`() {
        val placement = watchStagePlacement(
            mounted = true,
            hasFrame = true,
            hasVideo = true,
            pref = CameraPipPref.DEFAULT,
            layout = WatchCameraLayout.Camera,
        )
        assertEquals(StageSlot.CornerBehind, placement.film)
        assertEquals(StageSlot.Full, placement.camera)
    }

    @Test
    fun `hide-webcam mounted only for voice draws the corner muted`() {
        val placement = watchStagePlacement(
            mounted = true,
            hasFrame = true,
            hasVideo = true,
            pref = CameraPipPref.DEFAULT,
            layout = WatchCameraLayout.Stream,
        )
        assertEquals(StageSlot.Full, placement.film)
        assertEquals(StageSlot.Hidden, placement.camera)
        assertTrue(placement.cameraVoiceOnly)
        assertEquals(CameraPipPref.DEFAULT.corner, placement.corner)
    }

    // --- the voice-only camera, reached through the DEFAULT layout too ---
    //
    // `effectiveCameraLayout` forces `Pip` whenever `cameraHasVideo` is
    // false, so a voice-only camera reaches this function with the exact
    // same `layout` a default, video-carrying camera does. Without `hasVideo`
    // read here too, `CameraPipCornerBox` drew a video surface for a stream
    // with no video track: a black tile where the muted mic glyph belonged.

    @Test
    fun `a voice-only camera forced onto Pip still draws as the muted corner, not a black tile`() {
        val placement = watchStagePlacement(
            mounted = true,
            hasFrame = true,
            hasVideo = false,
            pref = CameraPipPref.DEFAULT,
            layout = WatchCameraLayout.Pip,
        )
        assertEquals(StageSlot.Hidden, placement.camera)
        assertEquals(CameraPipPref.DEFAULT.corner, placement.corner)
        assertTrue("a camera with no video must draw the mic glyph, not a video surface", placement.cameraVoiceOnly)
    }

    @Test
    fun `a video camera in the same default corner is not drawn as voice-only`() {
        val placement = watchStagePlacement(
            mounted = true,
            hasFrame = true,
            hasVideo = true,
            pref = CameraPipPref.DEFAULT,
            layout = WatchCameraLayout.Pip,
        )
        assertFalse(placement.cameraVoiceOnly)
    }

    @Test
    fun `a voice-only camera still loading is invisible, not voice-only yet`() {
        // `cameraLoading` already hides the box; `cameraVoiceOnly` is also
        // carried so the corner is ready to draw correctly the instant the
        // audio-only player reaches STATE_READY, without a frame ever having
        // to arrive first (an audio-only stream may never fire one).
        val placement = watchStagePlacement(
            mounted = true,
            hasFrame = false,
            hasVideo = false,
            pref = CameraPipPref.DEFAULT,
            layout = WatchCameraLayout.Pip,
        )
        assertTrue(placement.cameraLoading)
        assertTrue(placement.cameraVoiceOnly)
    }
}
