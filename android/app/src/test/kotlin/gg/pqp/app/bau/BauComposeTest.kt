package gg.pqp.app.bau

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Who is offered the composer, what a draft needs, and what the server's
 * refusals turn into. All pure: the requests themselves are in
 * [BauPostApiTest].
 */
class BauComposeTest {

    private val on = CommunityHomeConfig(enabled = true, vipEnabled = false, mediaEnabled = true)

    private fun snapshot(bits: Long) = PermissionsSnapshot(server = bits.toString())

    // --- gating ---

    @Test
    fun `manage server is offered the composer`() {
        assertTrue(BauComposeGate.canPost(on, snapshot(Permission.MANAGE_SERVER)))
    }

    @Test
    fun `an owner or administrator arrives with every bit and is offered it too`() {
        assertTrue(BauComposeGate.canPost(on, snapshot(-1L)))
    }

    @Test
    fun `a member without manage server is not, whatever else they hold`() {
        assertFalse(BauComposeGate.canPost(on, snapshot(Permission.START_WATCH_PARTY)))
        assertFalse(BauComposeGate.canPost(on, snapshot(0L)))
        // The neighbouring bits are different permissions, not near misses.
        assertFalse(BauComposeGate.canPost(on, snapshot((1L shl 4) or (1L shl 6))))
    }

    @Test
    fun `a snapshot that never arrived fails closed`() {
        assertFalse(BauComposeGate.canPost(on, null))
    }

    @Test
    fun `an unreadable bitfield fails closed`() {
        assertFalse(BauComposeGate.canPost(on, PermissionsSnapshot(server = "nope")))
    }

    @Test
    fun `nothing is offered while the Baú is off, even to staff`() {
        assertFalse(BauComposeGate.canPost(CommunityHomeConfig(), snapshot(Permission.MANAGE_SERVER)))
    }

    @Test
    fun `files need storage and links do not`() {
        assertTrue(BauComposeGate.canAttachFiles(on))
        assertFalse(BauComposeGate.canAttachFiles(on.copy(mediaEnabled = false)))
    }

    // --- the draft ---

    private val file = BauPickedMedia("clip.mp4", "video/mp4", 1_000, isVideo = true, uploadId = "up-1")

    @Test
    fun `a post needs a title`() {
        assertEquals(BauComposeProblem.NeedsTitle, BauComposeDraft(body = "hi").problem())
        assertEquals(BauComposeProblem.NeedsTitle, BauComposeDraft(title = "   ", body = "hi").problem())
    }

    @Test
    fun `a title alone is not a post`() {
        assertEquals(BauComposeProblem.NeedsContent, BauComposeDraft(title = "Hello").problem())
    }

    @Test
    fun `text, a file, or a link each make a post`() {
        assertNull(BauComposeDraft(title = "t", body = "words").problem())
        assertNull(BauComposeDraft(title = "t", media = file).problem())
        assertNull(BauComposeDraft(title = "t", link = "https://youtu.be/dQw4w9WgXcQ").problem())
    }

    @Test
    fun `the limits are the servers, counted on the untrimmed text`() {
        assertNull(BauComposeDraft(title = "a".repeat(BAU_TITLE_MAX), body = "x").problem())
        assertEquals(
            BauComposeProblem.TitleTooLong,
            BauComposeDraft(title = "a".repeat(BAU_TITLE_MAX + 1), body = "x").problem(),
        )
        assertEquals(
            BauComposeProblem.BodyTooLong,
            BauComposeDraft(title = "t", body = "a".repeat(BAU_BODY_MAX + 1)).problem(),
        )
    }

    @Test
    fun `a file and a link together are refused before the server has to`() {
        val draft = BauComposeDraft(title = "t", link = "https://youtu.be/dQw4w9WgXcQ", media = file)
        assertEquals(BauComposeProblem.OneMediaSource, draft.problem())
        assertNull(draft.toRequest())
    }

    @Test
    fun `a link that is plainly not one of the four providers is refused`() {
        assertEquals(BauComposeProblem.BadLink, BauComposeDraft(title = "t", link = "hello there").problem())
        assertEquals(BauComposeProblem.BadLink, BauComposeDraft(title = "t", link = "https://example.com/x").problem())
        assertEquals(BauComposeProblem.BadLink, BauComposeDraft(title = "t", link = "javascript:alert(1)").problem())
    }

    @Test
    fun `a post never goes out ahead of its file`() {
        assertEquals(
            BauComposeProblem.FileStillUploading,
            BauComposeDraft(title = "t", media = file.copy(uploadId = null, uploading = true)).problem(),
        )
        assertEquals(
            BauComposeProblem.FileFailed,
            BauComposeDraft(title = "t", media = file.copy(uploadId = null, failed = true)).problem(),
        )
    }

    @Test
    fun `the request is published, free, trimmed, and carries one media source`() {
        val withFile = BauComposeDraft(title = "  Hello ", body = " words ", media = file).toRequest()!!
        assertEquals(
            CreateBauPostRequest(
                title = "Hello",
                body = "words",
                mediaUploadId = "up-1",
                youtubeUrl = null,
                status = "published",
                visibility = "free",
                commentsEnabled = true,
            ),
            withFile,
        )

        val withLink = BauComposeDraft(title = "t", link = " https://youtu.be/dQw4w9WgXcQ ").toRequest()!!
        assertNull(withLink.mediaUploadId)
        assertNull(withLink.body)
        assertEquals("https://youtu.be/dQw4w9WgXcQ", withLink.youtubeUrl)
    }

    // --- files and links ---

    @Test
    fun `only the types the Baú signs for pass the picker`() {
        assertEquals("image/jpeg", bauMediaType("image/jpeg", "a.jpg"))
        assertEquals("image/gif", bauMediaType("image/gif", "a.gif"))
        assertEquals("video/mp4", bauMediaType("video/mp4", "a.mp4"))
        // A phone's own wrapper for an MP4 is the same container.
        assertEquals("video/mp4", bauMediaType("video/quicktime", "a.mov"))
        // Allowed in chat, not in the Baú.
        assertNull(bauMediaType("image/avif", "a.avif"))
        assertNull(bauMediaType("audio/mpeg", "a.mp3"))
        assertNull(bauMediaType("application/pdf", "a.pdf"))
        // A provider that reports nothing useful falls back to the extension.
        assertEquals("image/png", bauMediaType("application/octet-stream", "a.png"))
    }

    @Test
    fun `providers are named by host, not by guesswork about paths`() {
        assertEquals(BauLinks.Provider.Youtube, BauLinks.provider("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
        assertEquals(BauLinks.Provider.Youtube, BauLinks.provider("https://youtu.be/dQw4w9WgXcQ"))
        assertEquals(BauLinks.Provider.Twitch, BauLinks.provider("https://www.twitch.tv/somebody"))
        assertEquals(BauLinks.Provider.TikTok, BauLinks.provider("https://www.tiktok.com/@a/video/123"))
        assertEquals(BauLinks.Provider.Instagram, BauLinks.provider("https://www.instagram.com/p/abc/"))
        assertNull(BauLinks.provider("https://notyoutube.com/watch?v=x"))
        assertNull(BauLinks.provider("https://evil.com/youtube.com"))
        assertNull(BauLinks.provider("youtube.com/watch?v=dQw4w9WgXcQ"))
        assertNull(BauLinks.provider(""))
    }

    // --- refusals ---

    @Test
    fun `the status the Baú routes use decides the sentence`() {
        assertEquals(BauRefusal.NotStaff, BauRefusal.from(ApiException(403, "Staff only")))
        assertEquals(BauRefusal.Unavailable, BauRefusal.from(ApiException(404, "Not found")))
        assertEquals(BauRefusal.TooLarge, BauRefusal.from(ApiException(413, "File too large")))
        assertEquals(BauRefusal.SlowDown, BauRefusal.from(ApiException(429, "Slow down")))
        assertEquals(BauRefusal.NoStorage, BauRefusal.from(ApiException(503, "Media uploads are not configured")))
    }

    @Test
    fun `a 400 keeps the servers own words`() {
        assertEquals(
            BauRefusal.Invalid("Title is required to publish"),
            BauRefusal.from(ApiException(400, "Title is required to publish")),
        )
        assertEquals(BauRefusal.Invalid(null), BauRefusal.from(ApiException(400, "  ")))
    }

    @Test
    fun `a dead connection is a network refusal`() {
        assertEquals(BauRefusal.Network, BauRefusal.from(IOException("timeout")))
    }
}
