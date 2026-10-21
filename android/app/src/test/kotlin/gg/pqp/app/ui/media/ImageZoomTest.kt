package gg.pqp.app.ui.media

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageZoomTest {

    private val screen = 1000f to 2000f

    @Test
    fun `an unzoomed picture does not pan`() {
        val moved = ImageZoom().transform(zoom = 1f, panX = 300f, panY = -300f, viewport = screen)
        assertEquals(ImageZoom(), moved)
    }

    @Test
    fun `a pinch is clamped between one and the ceiling`() {
        assertEquals(IMAGE_MIN_SCALE, ImageZoom().transform(0.2f, 0f, 0f, screen).scale, 0.0001f)
        assertEquals(IMAGE_MAX_SCALE, ImageZoom(scale = 4f).transform(10f, 0f, 0f, screen).scale, 0.0001f)
    }

    @Test
    fun `pinching back out resets the pan`() {
        val zoomed = ImageZoom(scale = 2f, offsetX = 400f, offsetY = 900f)
        assertEquals(ImageZoom(), zoomed.transform(zoom = 0.1f, panX = 0f, panY = 0f, viewport = screen))
    }

    @Test
    fun `pan stops at the picture's edge`() {
        // A picture that fills the screen, at 2x, overhangs by half its own
        // size on each side: the centre may move 500 across and 1000 down.
        val panned = ImageZoom(scale = 2f).transform(1f, 10_000f, -10_000f, screen)
        assertEquals(500f, panned.offsetX, 0.0001f)
        assertEquals(-1000f, panned.offsetY, 0.0001f)
        assertEquals(0f, clampPan(123f, 1f, 1000f, 1000f), 0.0001f)
    }

    @Test
    fun `a landscape photo on a portrait screen does not pan off vertically`() {
        // 4000x3000 fitted into 1000x2000 is 1000x750. At the double-tap
        // scale it is 1875 tall, still shorter than the 2000 screen, so it
        // may not move up or down at all; across it overhangs by 1500.
        val fitted = fittedSize(4000f, 3000f, screen.first, screen.second)
        assertEquals(1000f, fitted.first, 0.0001f)
        assertEquals(750f, fitted.second, 0.0001f)
        val panned = ImageZoom(scale = IMAGE_DOUBLE_TAP_SCALE)
            .transform(1f, 10_000f, 10_000f, viewport = screen, content = fitted)
        assertEquals(750f, panned.offsetX, 0.0001f)
        assertEquals(0f, panned.offsetY, 0.0001f)
    }

    @Test
    fun `an unknown picture size falls back to the screen`() {
        assertEquals(screen, fittedSize(0f, 0f, screen.first, screen.second))
    }

    @Test
    fun `double tap zooms in and back out`() {
        val inside = ImageZoom().doubleTap()
        assertTrue(inside.zoomed)
        assertEquals(IMAGE_DOUBLE_TAP_SCALE, inside.scale, 0.0001f)
        assertFalse(inside.copy(offsetX = 40f).doubleTap().zoomed)
        assertEquals(0f, inside.copy(offsetX = 40f).doubleTap().offsetX, 0.0001f)
    }

    @Test
    fun `an expired url is re-minted exactly once`() = runTest {
        var calls = 0
        val remint = RemintOnce { calls += 1; "https://storage.example/fresh?sig=y" }
        assertEquals("https://storage.example/fresh?sig=y", remint.next())
        assertNull(remint.next())
        assertEquals(1, calls)
    }

    @Test
    fun `a failing or missing mint gives up quietly`() = runTest {
        assertNull(RemintOnce(null).next())
        assertNull(RemintOnce { throw IllegalStateException("401") }.next())
        assertNull(RemintOnce { " " }.next())
    }
}
