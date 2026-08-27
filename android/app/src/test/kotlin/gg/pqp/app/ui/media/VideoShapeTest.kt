package gg.pqp.app.ui.media

import gg.pqp.app.core.Attachment
import org.junit.Assert.assertEquals
import org.junit.Test

class VideoShapeTest {

    private fun clip(width: Int? = null, height: Int? = null) = Attachment(
        id = "att_1",
        filename = "clip.mp4",
        contentType = "video/mp4",
        byteSize = 1_234_567,
        width = width,
        height = height,
        url = "https://storage.example/clip.mp4?sig=x",
    )

    @Test
    fun `no stored dimensions falls back to sixteen by nine`() {
        assertEquals(DEFAULT_VIDEO_ASPECT, videoAspect(clip()), 0.0001f)
        assertEquals(DEFAULT_VIDEO_ASPECT, videoAspect(clip(width = 1920)), 0.0001f)
        assertEquals(DEFAULT_VIDEO_ASPECT, videoAspect(clip(height = 1080)), 0.0001f)
    }

    @Test
    fun `believable dimensions are used`() {
        assertEquals(16f / 9f, videoAspect(clip(1920, 1080)), 0.0001f)
        // Portrait, which is most video anybody records on a phone.
        assertEquals(9f / 16f, videoAspect(clip(1080, 1920)), 0.0001f)
        assertEquals(1f, videoAspect(clip(720, 720)), 0.0001f)
    }

    @Test
    fun `zero or negative dimensions fall back rather than dividing`() {
        assertEquals(DEFAULT_VIDEO_ASPECT, videoAspect(clip(0, 1080)), 0.0001f)
        assertEquals(DEFAULT_VIDEO_ASPECT, videoAspect(clip(1920, 0)), 0.0001f)
        assertEquals(DEFAULT_VIDEO_ASPECT, videoAspect(clip(-1, -1)), 0.0001f)
    }

    @Test
    fun `an absurd ratio is treated as absent`() {
        // Width and height are a client claim bounded at 20000 by
        // `createAttachmentSchema`, not something the server measured, so
        // "20000 by 1" is a shape this can genuinely be handed. Drawn
        // faithfully it is a hairline nobody can press.
        assertEquals(DEFAULT_VIDEO_ASPECT, videoAspect(clip(20000, 1)), 0.0001f)
        assertEquals(DEFAULT_VIDEO_ASPECT, videoAspect(clip(1, 20000)), 0.0001f)
    }

    @Test
    fun `the edges of the believable window are kept`() {
        assertEquals(MAX_VIDEO_ASPECT, videoAspect(clip(400, 100)), 0.0001f)
        assertEquals(MIN_VIDEO_ASPECT, videoAspect(clip(300, 1000)), 0.0001f)
    }
}
