package gg.pqp.app.attachments

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * One file the picker handed back, already in memory and already described.
 *
 * In memory rather than streamed, and deliberately: the presigned PUT signs
 * `Content-Length`, so the exact byte count has to be known *before* the URL is
 * minted, and a `content://` provider is under no obligation to report a size
 * or to give the same one twice. Reading it once and sending that array is the
 * only way the number in the signature and the number on the wire cannot
 * disagree. The cap is 10 MiB, so the cost is bounded by the same rule that
 * makes the upload legal at all.
 */
data class LocalAttachment(
    val filename: String,
    val contentType: String?,
    val bytes: ByteArray,
    val width: Int? = null,
    val height: Int? = null,
) {
    // Data classes with an array field get identity equality unless this is
    // written out, which is a footgun rather than a design here: nothing
    // compares these, and a generated `equals` that silently means `===` is
    // worse than one that says so.
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

/**
 * Reading a picked file, behind an interface so the composer above it can be
 * tested without a device.
 */
fun interface AttachmentFiles {
    /** Null when the URI cannot be opened, which is a refusal, not a crash. */
    suspend fun read(uri: String, maxBytes: Long): LocalAttachment?
}

/**
 * The real one: `ContentResolver`, on the IO dispatcher.
 *
 * A `content://` URI is not a file. It is a call into another app, which may
 * have died, may have revoked the grant, or may never have had the file at all,
 * so every step here is allowed to fail and none of them may throw into a
 * composable. The refusal the caller gets is [AttachmentRefusal.Unreadable] and
 * it says so on screen, because a picture that vanishes silently between the
 * picker and the message is indistinguishable from a broken app.
 */
class ContentAttachmentFiles(context: Context) : AttachmentFiles {
    private val resolver = context.applicationContext.contentResolver

    override suspend fun read(uri: String, maxBytes: Long): LocalAttachment? =
        withContext(Dispatchers.IO) {
            runCatching {
                val parsed = Uri.parse(uri)
                val reported = resolver.getType(parsed)
                val filename = sanitizeAttachmentFilename(displayName(parsed) ?: parsed.lastPathSegment)

                // One byte past the cap is enough to know it is over it, and
                // stops a wrong-sized pick from being read into memory whole.
                val bytes = resolver.openInputStream(parsed)?.use { stream ->
                    stream.readBytesUpTo(maxBytes + 1)
                } ?: return@runCatching null

                val type = attachmentContentTypeFor(reported, filename)
                val size = measureImage(bytes, type)

                LocalAttachment(
                    filename = filename,
                    contentType = type,
                    bytes = bytes,
                    width = size?.first,
                    height = size?.second,
                )
            }.getOrNull()
        }

    private fun displayName(uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (column >= 0 && cursor.moveToFirst()) cursor.getString(column) else null
        }
    }.getOrNull()

    /**
     * Width and height for an image, so the message can reserve the right box
     * instead of reflowing when the picture decodes.
     *
     * `inJustDecodeBounds` reads the header only, so this costs nothing and
     * never allocates the bitmap. Display-only hints: a failure here loses a
     * placeholder size and nothing else, which is why it is allowed to be null.
     */
    private fun measureImage(bytes: ByteArray, contentType: String?): Pair<Int, Int>? {
        if (contentType == null || !contentType.startsWith("image/")) return null
        return runCatching {
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            val width = options.outWidth
            val height = options.outHeight
            if (width > 0 && height > 0 && width <= ATTACHMENT_MAX_DIMENSION &&
                height <= ATTACHMENT_MAX_DIMENSION
            ) {
                width to height
            } else {
                null
            }
        }.getOrNull()
    }
}

/** Ceiling the server puts on a declared dimension. See `attachments.ts`. */
const val ATTACHMENT_MAX_DIMENSION = 65535

/**
 * Read at most [limit] bytes.
 *
 * `readBytes()` would read whatever is there, which is exactly what an
 * unbounded read of somebody else's content provider must not do on a phone:
 * the cap is 10 MiB and the provider is free to hand over a 4 GB video.
 */
private fun java.io.InputStream.readBytesUpTo(limit: Long): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (total < limit) {
        val read = read(buffer, 0, minOf(buffer.size.toLong(), limit - total).toInt())
        if (read <= 0) break
        out.write(buffer, 0, read)
        total += read
    }
    return out.toByteArray()
}
