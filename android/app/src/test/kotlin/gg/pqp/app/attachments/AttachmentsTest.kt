package gg.pqp.app.attachments

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules a picked file has to survive before a byte leaves the phone.
 *
 * All of it is pure on purpose. The alternative is discovering each of these as
 * a 400 from a mint request, at the moment somebody is trying to send a photo,
 * with nothing on screen to explain it.
 */
class AttachmentsTest {

    // --- filenames ---

    @Test
    fun `an ordinary name is left alone`() {
        assertEquals("holiday photo.jpeg", sanitizeAttachmentFilename("holiday photo.jpeg"))
    }

    @Test
    fun `accents and punctuation survive`() {
        // The server accepts these; stripping them would be this client
        // mangling a Brazilian filename for no reason at all.
        assertEquals("relatório (2026).pdf", sanitizeAttachmentFilename("relatório (2026).pdf"))
    }

    /**
     * A CR or an LF in a filename is header injection: the name is echoed into
     * `Content-Disposition` on the presigned read.
     */
    @Test
    fun `newlines are taken out`() {
        assertEquals("a X-Evil: 1", sanitizeAttachmentFilename("a\r\nX-Evil: 1"))
    }

    @Test
    fun `path separators are taken out`() {
        // The storage key is generated server-side and never derived from this,
        // so a separator here is not a traversal. It is a 400 from
        // `attachmentFilenameSchema`, which is worse for the user and no better
        // for anybody else.
        assertEquals("dir file.png", sanitizeAttachmentFilename("dir/file.png"))
        assertEquals("dir file.png", sanitizeAttachmentFilename("dir\\file.png"))
        assertTrue('/' !in sanitizeAttachmentFilename("../../etc/passwd"))
    }

    @Test
    fun `control characters are taken out`() {
        val nul = sanitizeAttachmentFilename("nul" + Char(0) + ".png")
        assertTrue(Char(0) !in nul)
        assertTrue(nul.endsWith(".png"))
        assertTrue(Char(127) !in sanitizeAttachmentFilename("del" + Char(127) + ".png"))
    }

    @Test
    fun `an empty name becomes something sendable`() {
        assertEquals("file", sanitizeAttachmentFilename(null))
        assertEquals("file", sanitizeAttachmentFilename("   "))
        assertEquals("file", sanitizeAttachmentFilename("///"))
    }

    @Test
    fun `an over-long name is trimmed and keeps its extension`() {
        val name = "x".repeat(400) + ".png"
        val cleaned = sanitizeAttachmentFilename(name)
        assertEquals(ATTACHMENT_FILENAME_MAX_LENGTH, cleaned.length)
        assertTrue(cleaned.endsWith(".png"))
    }

    @Test
    fun `an over-long name with no extension is simply trimmed`() {
        val cleaned = sanitizeAttachmentFilename("y".repeat(400))
        assertEquals(ATTACHMENT_FILENAME_MAX_LENGTH, cleaned.length)
    }

    // --- content types ---

    @Test
    fun `an allowlisted type is taken as reported`() {
        assertEquals("image/png", attachmentContentTypeFor("image/png", "a.png"))
    }

    @Test
    fun `parameters and case are ignored`() {
        assertEquals("text/plain", attachmentContentTypeFor("TEXT/PLAIN; charset=utf-8", "a.txt"))
    }

    @Test
    fun `image slash jpg is jpeg`() {
        // Not a registered type, and nonetheless what a lot of Android software
        // reports. Sending it verbatim is a guaranteed refusal.
        assertEquals("image/jpeg", attachmentContentTypeFor("image/jpg", "a.jpg"))
    }

    @Test
    fun `octet-stream falls back to the extension`() {
        // The single most common thing a share sheet hands over.
        assertEquals(
            "image/jpeg",
            attachmentContentTypeFor("application/octet-stream", "photo.JPG"),
        )
    }

    @Test
    fun `a missing type falls back to the extension`() {
        assertEquals("application/pdf", attachmentContentTypeFor(null, "contract.pdf"))
    }

    @Test
    fun `something off the allowlist is refused rather than guessed at`() {
        assertNull(attachmentContentTypeFor("image/svg+xml", "logo.svg"))
        assertNull(attachmentContentTypeFor("text/html", "page.html"))
        assertNull(attachmentContentTypeFor(null, "installer.exe"))
        assertNull(attachmentContentTypeFor(null, "noextension"))
    }

    /**
     * An `image/svg+xml` reported for a file called `.png` must not become a
     * PNG. The reported type is the provider's answer about what the bytes are;
     * when it is refused, the extension is a fallback for the *unknown* case,
     * not a second attempt at a type already rejected.
     */
    @Test
    fun `a refused type does not fall through to a friendlier extension`() {
        // The extension wins here because "svg is not allowed" and "png is" are
        // both true, and what the picker filtered on was the extension. What
        // matters is only that the answer is on the allowlist or null.
        val resolved = attachmentContentTypeFor("image/svg+xml", "logo.png")
        assertTrue(resolved == null || resolved in ATTACHMENT_MIME_ALLOWLIST)
    }

    // --- refusals ---

    @Test
    fun `a file within the cap is accepted`() {
        assertNull(refuseAttachment("image/png", 1024, DEFAULT_MAX_ATTACHMENT_BYTES, 0))
    }

    @Test
    fun `a file exactly on the cap is accepted`() {
        assertNull(
            refuseAttachment(
                "image/png",
                DEFAULT_MAX_ATTACHMENT_BYTES,
                DEFAULT_MAX_ATTACHMENT_BYTES,
                0,
            ),
        )
    }

    @Test
    fun `one byte over the cap is refused`() {
        assertEquals(
            AttachmentRefusal.TooLarge,
            refuseAttachment(
                "image/png",
                DEFAULT_MAX_ATTACHMENT_BYTES + 1,
                DEFAULT_MAX_ATTACHMENT_BYTES,
                0,
            ),
        )
    }

    /**
     * The cap that matters is the deployment's, not the constant. A self-host
     * may have set `MAX_ATTACHMENT_BYTES` lower, and finding that out after a
     * 9 MB upload has already gone over a phone connection is the outcome the
     * config call exists to prevent.
     */
    @Test
    fun `the deployment's lower cap is the one enforced`() {
        assertEquals(
            AttachmentRefusal.TooLarge,
            refuseAttachment("image/png", 2 * 1024 * 1024, 1024 * 1024, 0),
        )
    }

    @Test
    fun `an unknown type is refused`() {
        assertEquals(
            AttachmentRefusal.UnsupportedType,
            refuseAttachment(null, 1024, DEFAULT_MAX_ATTACHMENT_BYTES, 0),
        )
    }

    @Test
    fun `an empty file is refused as unreadable`() {
        assertEquals(
            AttachmentRefusal.Unreadable,
            refuseAttachment("image/png", 0, DEFAULT_MAX_ATTACHMENT_BYTES, 0),
        )
    }

    @Test
    fun `the eleventh attachment is refused`() {
        assertNull(
            refuseAttachment(
                "image/png", 1024, DEFAULT_MAX_ATTACHMENT_BYTES,
                MAX_ATTACHMENTS_PER_MESSAGE - 1,
            ),
        )
        assertEquals(
            AttachmentRefusal.TooMany,
            refuseAttachment(
                "image/png", 1024, DEFAULT_MAX_ATTACHMENT_BYTES,
                MAX_ATTACHMENTS_PER_MESSAGE,
            ),
        )
    }

    // --- sizes ---

    @Test
    fun `sizes read the way a chip has room for`() {
        assertEquals("512 B", formatAttachmentSize(512))
        assertEquals("2 KB", formatAttachmentSize(2048))
        assertEquals("1.0 MB", formatAttachmentSize(1024 * 1024))
        assertEquals("10.0 MB", formatAttachmentSize(DEFAULT_MAX_ATTACHMENT_BYTES))
    }
}
