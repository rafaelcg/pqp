package gg.pqp.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The arithmetic that decides what a viewer actually sees.
 *
 * Worth pinning because the failure it guards against is silent: a capture
 * whose aspect ratio drifts from the display's letterboxes the share, and an
 * odd dimension is refused by some hardware encoders in a way that presents as
 * "sharing started and nothing arrived". Neither shows up until somebody is
 * watching.
 */
class ScreenCaptureTest {

    @Test
    fun `a portrait phone is scaled on its short side`() {
        // The Pixel 10 Pro this was written against.
        val profile = screenCaptureProfileFor(1280, 2856)
        assertEquals(720, profile.width)
        assertEquals(1606, profile.height)
    }

    @Test
    fun `the aspect ratio survives the scaling`() {
        val profile = screenCaptureProfileFor(1280, 2856)
        val before = 1280.0 / 2856.0
        val after = profile.width.toDouble() / profile.height.toDouble()
        // Within a pixel of rounding. Anything looser is a letterbox.
        assertTrue(kotlin.math.abs(before - after) < 0.002)
    }

    @Test
    fun `landscape is scaled on its short side too`() {
        val profile = screenCaptureProfileFor(2856, 1280)
        assertEquals(720, profile.height)
        assertEquals(1606, profile.width)
    }

    @Test
    fun `a display below the target is never upscaled`() {
        val profile = screenCaptureProfileFor(480, 800)
        assertEquals(480, profile.width)
        assertEquals(800, profile.height)
    }

    @Test
    fun `both dimensions are even`() {
        for (width in listOf(1079, 1081, 1439, 721, 999)) {
            for (height in listOf(2001, 2399, 1801)) {
                val profile = screenCaptureProfileFor(width, height)
                assertEquals(0, profile.width % 2)
                assertEquals(0, profile.height % 2)
            }
        }
    }

    @Test
    fun `a nonsense display size does not produce a nonsense capture`() {
        val profile = screenCaptureProfileFor(0, 0)
        assertTrue(profile.width > 0)
        assertTrue(profile.height > 0)
    }

    @Test
    fun `the upload budget is split across the mesh`() {
        // One viewer gets the per-sender cap, not the whole budget.
        assertEquals(2_000_000, meshScreenBitrate(1))
        // Four viewers each cost a full copy of the same screen.
        assertTrue(meshScreenBitrate(4) < meshScreenBitrate(2))
    }

    @Test
    fun `a crowded room still leaves a usable floor`() {
        // Divided far enough the share would become unwatchable rather than
        // cheap, so the split stops at a floor.
        assertEquals(500_000, meshScreenBitrate(20))
    }

    @Test
    fun `an empty room does not divide by zero`() {
        assertEquals(2_000_000, meshScreenBitrate(0))
    }
}
