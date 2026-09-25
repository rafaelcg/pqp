package gg.pqp.app.watch

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The camera PiP preference, read back out of whatever DataStore handed it.
 *
 * The whole point of a stored preference is that it outlives the version
 * that wrote it, so the interesting cases here are the ones a future rename
 * or a corrupted store would produce: nothing decodes to the default rather
 * than throwing and losing the choice entirely.
 */
class WatchCameraPipPrefsTest {

    @Test
    fun `nothing stored yet is the default`() {
        assertEquals(CameraPipPref.DEFAULT, decodeCameraPipPref(corner = null, layout = null))
    }

    @Test
    fun `a valid pair round-trips`() {
        assertEquals(
            CameraPipPref(CameraPipCorner.TopLeft, WatchCameraLayout.Side),
            decodeCameraPipPref(corner = "TopLeft", layout = "Side"),
        )
    }

    @Test
    fun `an unrecognised corner falls back to the default corner alone`() {
        assertEquals(
            CameraPipPref(CameraPipPref.DEFAULT.corner, WatchCameraLayout.Camera),
            decodeCameraPipPref(corner = "middle", layout = "Camera"),
        )
    }

    @Test
    fun `an unrecognised layout falls back to the default layout alone`() {
        assertEquals(
            CameraPipPref(CameraPipCorner.TopRight, CameraPipPref.DEFAULT.layout),
            decodeCameraPipPref(corner = "TopRight", layout = "fullscreen"),
        )
    }
}
