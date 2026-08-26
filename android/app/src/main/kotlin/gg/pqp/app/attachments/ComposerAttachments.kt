package gg.pqp.app.attachments

/**
 * One file sitting in the composer, on its way to a message.
 *
 * It exists on screen from the moment the picker returns, before anything has
 * been uploaded, because that is when the person expects to see it. The upload
 * is what fills in [attachmentId], and that id is the only thing the
 * `message-create` frame ever carries: filename, type and size are re-read
 * server-side from the row and from the object itself, so nothing here is
 * trusted past the mint.
 */
data class PendingAttachment(
    /** Local, not the server's. The row does not exist yet when this is made. */
    val localId: String,
    val uri: String,
    val filename: String,
    val contentType: String,
    val byteSize: Long,
    /** Set once the PUT has landed and the row can be claimed. */
    val attachmentId: String? = null,
    /** The mint or the upload refused. Shown, never swallowed. */
    val failed: Boolean = false,
) {
    val uploading: Boolean get() = attachmentId == null && !failed
    val isImage: Boolean get() = contentType in INLINE_IMAGE_TYPES
}

/**
 * Types this client will draw as a picture rather than as a chip.
 *
 * Enumerated rather than tested with an `image/` prefix, for the same reason
 * `isImageContentType` in `packages/shared` is: the prefix also matches
 * `image/svg+xml`, which is a document that runs script. It is not on the
 * upload allowlist today and this list must not be what changes if it ever is.
 */
private val INLINE_IMAGE_TYPES = setOf(
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
)

/**
 * Whether the composer may send, and if not, what is stopping it.
 *
 * A separate value per reason because each needs a different button state and a
 * different sentence, and because two of them are the ones that go wrong
 * quietly:
 *
 *  - **Uploading.** Sending now would send a `message-create` naming rows whose
 *    objects do not exist yet. The server HEADs each one at claim time and
 *    drops the ones that are not there, so the message arrives with the picture
 *    missing and nothing anywhere saying why.
 *  - **Failed.** Dropping a failed attachment silently is the same outcome
 *    reached by a different route. The chip stays, marked, and the person
 *    decides whether to retry it or take it off.
 */
enum class ComposerReadiness { Empty, Uploading, Failed, Ready }

fun composerReadiness(body: String, attachments: List<PendingAttachment>): ComposerReadiness = when {
    attachments.any { it.uploading } -> ComposerReadiness.Uploading
    attachments.any { it.failed } -> ComposerReadiness.Failed
    body.isNotBlank() || attachments.any { it.attachmentId != null } -> ComposerReadiness.Ready
    else -> ComposerReadiness.Empty
}

/**
 * The ids to put on the frame, in the order they were attached.
 *
 * The order is the sender's, and the server records it at claim time precisely
 * because it is not the mint order: mints are issued concurrently and an image
 * waits on a decode before it mints, so dropping a photo and then a clip
 * routinely mints the clip first. See the note above `sort_order` in
 * `server/src/schema.sql`.
 */
fun attachmentIdsFor(attachments: List<PendingAttachment>): List<String> =
    attachments.mapNotNull { it.attachmentId }
