package gg.pqp.app.stories

import gg.pqp.app.protocol.RepoSources
import gg.pqp.app.stories.camera.CaptureRules
import gg.pqp.app.stories.camera.CaptureRules.Flash
import gg.pqp.app.stories.camera.CaptureRules.Lens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The story camera's rules (`CaptureRules`) and the video cutter's (`TrimRules`),
 * and the two facts about the source that no unit can see: the recording clock
 * is not an animation, and the manifest lets a phone with no camera install.
 */
class CameraTest {

    // --- the recording ring ---

    @Test
    fun `a clip is bounded by the story limit, the shared one`() {
        val shared = RepoSources.stripComments(RepoSources.read("packages/shared/src/stories.ts"))
        val limit = Regex("""const\s+STORY_MAX_VIDEO_MS\s*=\s*([\d_]+)""").find(shared)!!.groupValues[1].replace("_", "").toLong()
        assertEquals(limit, CaptureRules.MAX_RECORDING_MS)
    }

    @Test
    fun `the ring runs 0 to 1 over 30 s and stops there`() {
        assertEquals(0f, CaptureRules.ringProgress(0), 0f)
        assertEquals(0.5f, CaptureRules.ringProgress(15_000), 0.0001f)
        assertEquals(1f, CaptureRules.ringProgress(30_000), 0f)
        assertEquals(1f, CaptureRules.ringProgress(45_000), 0f)
        assertEquals(0f, CaptureRules.ringProgress(-5), 0f)
        assertFalse(CaptureRules.reachedLimit(29_999))
        assertTrue(CaptureRules.reachedLimit(30_000))
    }

    @Test
    fun `seconds left round up, so the last second says 1 and never 0 while recording`() {
        assertEquals(30, CaptureRules.secondsLeft(0))
        assertEquals(30, CaptureRules.secondsLeft(1))
        assertEquals(29, CaptureRules.secondsLeft(1_000))
        assertEquals(1, CaptureRules.secondsLeft(29_500))
        assertEquals(0, CaptureRules.secondsLeft(30_000))
        assertEquals(0, CaptureRules.secondsLeft(99_000))
    }

    @Test
    fun `the timer chip reads minutes and seconds`() {
        assertEquals("0:00", CaptureRules.clock(0))
        assertEquals("0:07", CaptureRules.clock(7_400))
        assertEquals("0:30", CaptureRules.clock(30_000))
        assertEquals("1:05", CaptureRules.clock(65_000))
        assertEquals("0:00", CaptureRules.clock(-1))
    }

    @Test
    fun `a firm tap is a photo, a hold is a clip, and a clip under 0_6 s is dropped`() {
        assertFalse(CaptureRules.isHold(CaptureRules.HOLD_TO_RECORD_MS - 1))
        assertTrue(CaptureRules.isHold(CaptureRules.HOLD_TO_RECORD_MS))
        assertFalse(CaptureRules.keepClip(CaptureRules.MIN_CLIP_MS - 1))
        assertTrue(CaptureRules.keepClip(CaptureRules.MIN_CLIP_MS))
    }

    // --- lenses and flash ---

    @Test
    fun `it opens on the back lens, or the only one the phone has`() {
        assertEquals(Lens.Back, CaptureRules.startingLens(hasBack = true, hasFront = true))
        assertEquals(Lens.Back, CaptureRules.startingLens(hasBack = true, hasFront = false))
        assertEquals(Lens.Front, CaptureRules.startingLens(hasBack = false, hasFront = true))
        assertNull(CaptureRules.startingLens(hasBack = false, hasFront = false))
        assertEquals(Lens.Front, Lens.Back.other)
        assertEquals(Lens.Back, Lens.Front.other)
    }

    @Test
    fun `flip is offered only with two lenses`() {
        assertTrue(CaptureRules.canFlip(hasBack = true, hasFront = true))
        assertFalse(CaptureRules.canFlip(hasBack = true, hasFront = false))
        assertFalse(CaptureRules.canFlip(hasBack = false, hasFront = true))
    }

    @Test
    fun `a front shot is mirrored into the file so it matches the preview`() {
        assertTrue(CaptureRules.mirrorsCapture(Lens.Front))
        assertFalse(CaptureRules.mirrorsCapture(Lens.Back))
    }

    @Test
    fun `flash offers what the lens can do`() {
        // Back with a flash unit: all three.
        assertEquals(listOf(Flash.Off, Flash.Auto, Flash.On), CaptureRules.flashChoices(Lens.Back, hasFlashUnit = true))
        // Front with no unit: the screen lights up, so on and off, never auto.
        assertEquals(listOf(Flash.Off, Flash.On), CaptureRules.flashChoices(Lens.Front, hasFlashUnit = false))
        // Back with no unit: no flash at all, so no button.
        assertTrue(CaptureRules.flashChoices(Lens.Back, hasFlashUnit = false).isEmpty())
    }

    @Test
    fun `the flash button cycles and falls back when a mode is no longer offered`() {
        val all = listOf(Flash.Off, Flash.Auto, Flash.On)
        assertEquals(Flash.Auto, CaptureRules.nextFlash(Flash.Off, all))
        assertEquals(Flash.On, CaptureRules.nextFlash(Flash.Auto, all))
        assertEquals(Flash.Off, CaptureRules.nextFlash(Flash.On, all))
        // Flipping to the front lens while on Auto: Auto is gone, start over.
        assertEquals(Flash.Off, CaptureRules.nextFlash(Flash.Auto, listOf(Flash.Off, Flash.On)))
        assertEquals(Flash.Off, CaptureRules.nextFlash(Flash.On, emptyList()))
    }

    @Test
    fun `the torch lights only while filming, only with a unit, only when flash is on`() {
        assertTrue(CaptureRules.torchDuringVideo(Flash.On, hasFlashUnit = true))
        assertFalse(CaptureRules.torchDuringVideo(Flash.Auto, hasFlashUnit = true))
        assertFalse(CaptureRules.torchDuringVideo(Flash.Off, hasFlashUnit = true))
        assertFalse(CaptureRules.torchDuringVideo(Flash.On, hasFlashUnit = false))
    }

    // --- zoom ---

    @Test
    fun `a pinch multiplies the zoom and stays inside the lens`() {
        assertEquals(2f, CaptureRules.pinchZoom(1f, 2f, 1f, 8f), 0.0001f)
        assertEquals(8f, CaptureRules.pinchZoom(4f, 3f, 1f, 8f), 0.0001f)
        assertEquals(1f, CaptureRules.pinchZoom(1.2f, 0.5f, 1f, 8f), 0.0001f)
    }

    @Test
    fun `sliding up while holding runs the whole range, exponentially`() {
        // No travel: where it started.
        assertEquals(1f, CaptureRules.dragZoom(1f, 0f, 300f, 1f, 8f), 0.0001f)
        // A full travel up: the top of the range.
        assertEquals(8f, CaptureRules.dragZoom(1f, 300f, 300f, 1f, 8f), 0.001f)
        // Half way is the geometric middle (sqrt(8)), not the arithmetic one (4.5).
        assertEquals(Math.sqrt(8.0).toFloat(), CaptureRules.dragZoom(1f, 150f, 300f, 1f, 8f), 0.001f)
        // Sliding back down past the start never goes under the lens minimum.
        assertEquals(1f, CaptureRules.dragZoom(1f, -300f, 300f, 1f, 8f), 0.0001f)
        // Over-travel is clamped.
        assertEquals(8f, CaptureRules.dragZoom(1f, 900f, 300f, 1f, 8f), 0.001f)
        // A lens that cannot zoom stays put.
        assertEquals(1f, CaptureRules.dragZoom(1f, 200f, 300f, 1f, 1f), 0.0001f)
    }

    @Test
    fun `the zoom chip uses a point and one decimal`() {
        assertEquals("1.0x", CaptureRules.zoomLabel(1f))
        assertEquals("2.5x", CaptureRules.zoomLabel(2.5f))
        assertEquals("10.0x", CaptureRules.zoomLabel(9.96f))
    }

    // --- cutting a picked video ---

    private val cap = StoriesRules.MAX_BYTES

    @Test
    fun `a clip that fits goes as it is, a long one is trimmed, a fat one is shrunk`() {
        assertNull(TrimRules.work(10_000, 5_000_000, 720, 1280, cap))
        assertNull(TrimRules.work(30_000, 5_000_000, 1080, 1920, cap))
        assertEquals(TrimRules.Work.Trim, TrimRules.work(30_001, 1_000_000, 720, 1280, cap))
        // Over the length wins even when it is also over the size.
        assertEquals(TrimRules.Work.Trim, TrimRules.work(90_000, 80_000_000, 2160, 3840, cap))
        assertEquals(TrimRules.Work.Shrink, TrimRules.work(20_000, cap + 1, 1080, 1920, cap))
        // 4K at 20 s is under the size cap here but sharper than a story needs.
        assertEquals(TrimRules.Work.Shrink, TrimRules.work(20_000, 10_000_000, 2160, 3840, cap))
    }

    @Test
    fun `the window is 30 s, or the whole clip when shorter, and never leaves the clip`() {
        assertEquals(30_000, TrimRules.windowMs(95_000))
        assertEquals(12_000, TrimRules.windowMs(12_000))
        assertEquals(0, TrimRules.clampStart(-4_000, 95_000))
        assertEquals(65_000, TrimRules.clampStart(80_000, 95_000))
        assertEquals(0, TrimRules.clampStart(5_000, 12_000))
    }

    @Test
    fun `dragging across the strip moves the window by the clip's own time`() {
        // A 100 s clip on a 1000 px strip: 100 px is 10 s.
        assertEquals(20_000, TrimRules.startAfterDrag(10_000, 100f, 1000f, 100_000))
        assertEquals(0, TrimRules.startAfterDrag(10_000, -500f, 1000f, 100_000))
        assertEquals(70_000, TrimRules.startAfterDrag(60_000, 900f, 1000f, 100_000))
        // No width yet: held where it is.
        assertEquals(10_000, TrimRules.startAfterDrag(10_000, 100f, 0f, 100_000))
    }

    @Test
    fun `the window draws as a share of the strip`() {
        assertEquals(0.3f, TrimRules.windowFraction(100_000), 0.0001f)
        assertEquals(1f, TrimRules.windowFraction(20_000), 0f)
        assertEquals(0.5f, TrimRules.startFraction(50_000, 100_000), 0.0001f)
        // Past the last legal start it is drawn at the last legal start.
        assertEquals(0.7f, TrimRules.startFraction(99_000, 100_000), 0.0001f)
    }

    @Test
    fun `the filmstrip samples the middle of each slice`() {
        assertEquals(listOf(5_000L, 15_000L, 25_000L, 35_000L), TrimRules.thumbTimesMs(40_000, 4))
        assertTrue(TrimRules.thumbTimesMs(0, 4).isEmpty())
        assertTrue(TrimRules.thumbTimesMs(40_000, 0).isEmpty())
    }

    @Test
    fun `the range reads with a hyphen, never a dash`() {
        val label = TrimRules.rangeLabel(12_000, 42_000)
        assertEquals("0:12 - 0:42", label)
        assertFalse(label.contains('—') || label.contains('–'))
    }

    @Test
    fun `a sharp clip is shrunk to 720 on the short edge with even sides`() {
        assertEquals(720 to 1280, TrimRules.shrinkTarget(1080, 1920))
        assertEquals(1280 to 720, TrimRules.shrinkTarget(1920, 1080))
        assertEquals(720 to 1280, TrimRules.shrinkTarget(2160, 3840))
        assertNull(TrimRules.shrinkTarget(720, 1280))
        assertNull(TrimRules.shrinkTarget(480, 854))
        val (w, h) = TrimRules.shrinkTarget(1081, 1919)!!
        assertEquals(0, w % 2)
        assertEquals(0, h % 2)
    }

    // --- EXIF, now that front shots come in mirrored ---

    @Test
    fun `all eight EXIF orientations know how to be undone`() {
        assertEquals(StoriesRules.ExifTurn(0, false), StoriesRules.exifTurn(1))
        assertEquals(StoriesRules.ExifTurn(0, true), StoriesRules.exifTurn(2))
        assertEquals(StoriesRules.ExifTurn(180, false), StoriesRules.exifTurn(3))
        assertEquals(StoriesRules.ExifTurn(180, true), StoriesRules.exifTurn(4))
        assertEquals(StoriesRules.ExifTurn(270, true), StoriesRules.exifTurn(5))
        assertEquals(StoriesRules.ExifTurn(90, false), StoriesRules.exifTurn(6))
        assertEquals(StoriesRules.ExifTurn(90, true), StoriesRules.exifTurn(7))
        assertEquals(StoriesRules.ExifTurn(270, false), StoriesRules.exifTurn(8))
        // Anything else (0, 9, junk) is left alone.
        assertEquals(StoriesRules.ExifTurn(0, false), StoriesRules.exifTurn(0))
        assertEquals(StoriesRules.ExifTurn(0, false), StoriesRules.exifTurn(99))
    }

    // --- facts about the source ---

    @Test
    fun `the recording clock reads the wall clock, not an animation`() {
        // Compose scales every animateTo by the animator duration scale, so a
        // timer built on one stops at the first frame under "Remove animations"
        // (the story viewer lost its clock that way). The clock that ends a
        // recording has to be the wall clock.
        val screen = RepoSources.read("android/app/src/main/kotlin/gg/pqp/app/stories/camera/StoryCameraScreen.kt")
        val clock = screen.substringAfter("// --- the recording clock").substringBefore("// --- actions ---")
        assertTrue(clock.contains("SystemClock.elapsedRealtime()"))
        assertTrue(clock.contains("reachedLimit"))
        assertFalse("the clock must not animate", clock.contains("animate"))
    }

    @Test
    fun `the manifest declares the camera but does not require one`() {
        val manifest = RepoSources.read("android/app/src/main/AndroidManifest.xml")
        assertTrue(manifest.contains("android.permission.CAMERA"))
        listOf("camera", "camera.front", "camera.autofocus", "camera.flash").forEach { feature ->
            assertTrue(
                "android.hardware.$feature must be optional",
                Regex("""android\.hardware\.${Regex.escape(feature)}"\s+android:required="false"""").containsMatchIn(manifest),
            )
        }
    }

    @Test
    fun `no copy for the camera says voce`() {
        listOf("values", "values-pt-rBR").forEach { dir ->
            val xml = RepoSources.read("android/app/src/main/res/$dir/strings.xml")
            Regex("""<string name="(stories_(?:camera|trim)_[a-z_]+)">([^<]*)</string>""").findAll(xml).forEach { match ->
                val (name, value) = match.destructured
                assertFalse("$dir/$name uses voce", Regex("""\bvoc[eê]\b""", RegexOption.IGNORE_CASE).containsMatchIn(value))
                assertFalse("$dir/$name has an em dash", value.contains('—'))
            }
        }
    }

    @Test
    fun `every camera and trim string exists in both languages`() {
        fun names(dir: String) = Regex("""<string name="(stories_(?:camera|trim)_[a-z_]+)"""")
            .findAll(RepoSources.read("android/app/src/main/res/$dir/strings.xml")).map { it.groupValues[1] }.toSet()
        assertEquals(names("values"), names("values-pt-rBR"))
        assertTrue(names("values").size >= 30)
    }
}
