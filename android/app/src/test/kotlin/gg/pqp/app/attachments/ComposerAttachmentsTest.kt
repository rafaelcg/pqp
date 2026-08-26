package gg.pqp.app.attachments

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * When the composer may send, which is the rule with the quietest failure in
 * this whole feature.
 *
 * Sending while an upload is still running produces a `message-create` naming
 * rows whose objects are not in the bucket yet. The server HEADs each one
 * before the claim transaction opens and drops the ones that are not there, so
 * nothing errors anywhere: the message simply arrives without the picture, on
 * every screen, permanently. A failed upload reaches the same place by a
 * different road.
 */
class ComposerAttachmentsTest {

    private fun pending(
        id: String = "a",
        attachmentId: String? = null,
        failed: Boolean = false,
    ) = PendingAttachment(
        localId = id,
        uri = "content://x/$id",
        filename = "$id.png",
        contentType = "image/png",
        byteSize = 1024,
        attachmentId = attachmentId,
        failed = failed,
    )

    @Test
    fun `an empty composer cannot send`() {
        assertEquals(ComposerReadiness.Empty, composerReadiness("", emptyList()))
        assertEquals(ComposerReadiness.Empty, composerReadiness("   ", emptyList()))
    }

    @Test
    fun `text alone can send`() {
        assertEquals(ComposerReadiness.Ready, composerReadiness("hi", emptyList()))
    }

    /** A message may be text, attachments, or both, never neither. */
    @Test
    fun `an uploaded attachment alone can send`() {
        assertEquals(
            ComposerReadiness.Ready,
            composerReadiness("", listOf(pending(attachmentId = "id-1"))),
        )
    }

    @Test
    fun `an upload in flight blocks the send, even with text`() {
        assertEquals(
            ComposerReadiness.Uploading,
            composerReadiness("look at this", listOf(pending())),
        )
    }

    @Test
    fun `one upload in flight among finished ones still blocks`() {
        assertEquals(
            ComposerReadiness.Uploading,
            composerReadiness(
                "",
                listOf(pending("a", attachmentId = "id-1"), pending("b")),
            ),
        )
    }

    /**
     * A failed attachment is not dropped on the floor. Silently sending the
     * other nine is how somebody finds out a week later that the one picture
     * that mattered never arrived.
     */
    @Test
    fun `a failed upload blocks the send until it is removed or retried`() {
        assertEquals(
            ComposerReadiness.Failed,
            composerReadiness("hi", listOf(pending("a", failed = true))),
        )
        assertEquals(
            ComposerReadiness.Ready,
            composerReadiness("hi", emptyList()),
        )
    }

    @Test
    fun `an upload still running outranks a failed one`() {
        // Both are blocking, but "still going" is the truthful thing to say
        // while one is: the failure may yet be joined by another.
        assertEquals(
            ComposerReadiness.Uploading,
            composerReadiness("", listOf(pending("a", failed = true), pending("b"))),
        )
    }

    // --- ids ---

    @Test
    fun `only uploaded attachments contribute ids, in the order attached`() {
        val attachments = listOf(
            pending("a", attachmentId = "id-a"),
            pending("b"),
            pending("c", attachmentId = "id-c"),
        )
        assertEquals(listOf("id-a", "id-c"), attachmentIdsFor(attachments))
    }

    @Test
    fun `nothing attached is no ids rather than an empty-string id`() {
        assertEquals(emptyList<String>(), attachmentIdsFor(emptyList()))
    }

    // --- what draws as a picture ---

    @Test
    fun `images draw inline and documents do not`() {
        for (type in listOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif")) {
            assertEquals(type, true, pending().copy(contentType = type).isImage)
        }
        for (type in listOf("application/pdf", "video/mp4", "audio/mpeg", "text/plain")) {
            assertEquals(type, false, pending().copy(contentType = type).isImage)
        }
    }

    /**
     * `image/svg+xml` is a document that runs script. It is not on the upload
     * allowlist, and this list must not be what changes if it ever is.
     */
    @Test
    fun `svg never draws inline`() {
        assertEquals(false, pending().copy(contentType = "image/svg+xml").isImage)
    }
}
