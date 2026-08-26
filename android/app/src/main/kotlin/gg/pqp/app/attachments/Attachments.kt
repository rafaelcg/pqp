package gg.pqp.app.attachments

/**
 * What may be uploaded, and what a file has to be turned into before it can be.
 *
 * Every value here is a hand-copy of `packages/shared/src/attachments.ts`, in
 * the same way the rest of this client hand-copies the wire contract, and
 * `AttachmentContractTest` reads that file off disk to check the copies still
 * match. Getting one wrong is not a compile error on either side: it is a 400
 * from a server the user cannot see, at the moment they try to send a holiday
 * photo.
 *
 * Nothing here touches Android. The picker hands back a display name and a MIME
 * type that the platform is under no obligation to get right, and turning those
 * two strings into something the server will sign is the part worth pinning.
 */

/**
 * Content types the server will sign an upload for.
 *
 * An allowlist, not a denylist, and notably without `image/svg+xml` and
 * `text/html`: those are documents that execute script, not media.
 */
val ATTACHMENT_MIME_ALLOWLIST: List<String> = listOf(
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "application/pdf",
    "text/plain",
)

/** Attachments one message may carry. Matches Discord, and the server. */
const val MAX_ATTACHMENTS_PER_MESSAGE = 10

const val ATTACHMENT_FILENAME_MAX_LENGTH = 255

/**
 * The ceiling `createAttachmentSchema` enforces before the deployment's own
 * `MAX_ATTACHMENT_BYTES` is ever consulted. A deployment may lower the limit;
 * it cannot raise it past this without a rebuild of the server.
 */
const val DEFAULT_MAX_ATTACHMENT_BYTES: Long = 10L * 1024 * 1024

/**
 * Why a file cannot be sent, in terms a sentence can be written about.
 *
 * An enum rather than a message, because the message is a localised resource
 * and this layer has no business holding one. The refusal happens before a
 * single byte leaves the phone: the server would refuse the same file with a
 * 400 the user never sees, and "nothing happened" is the worst possible answer
 * to "why did my picture not send".
 */
enum class AttachmentRefusal {
    /** Past this deployment's cap. */
    TooLarge,

    /** Not on the allowlist, whatever the picker called it. */
    UnsupportedType,

    /** The message already carries [MAX_ATTACHMENTS_PER_MESSAGE]. */
    TooMany,

    /** The content URI could not be opened or read at all. */
    Unreadable,
}

/**
 * A control character or a path separator in a filename is not a display
 * problem.
 *
 * The name is echoed into a `Content-Disposition` header on the presigned read,
 * where a CR or an LF is header injection, and `\` is both a Windows path
 * separator and the escape character inside a quoted filename. The server
 * rejects all of them (`attachmentFilenameSchema`); this client strips them so
 * that a file the platform happened to name badly still sends, rather than
 * failing with a 400 nobody can act on.
 *
 * A run collapses to one space rather than one space each, because a CRLF is
 * one break and `"a  b"` is a name nobody typed.
 */
private val FILENAME_FORBIDDEN = Regex("[\\u0000-\\u001F\\u007F/\\\\]+")

/**
 * Turn whatever the picker called this file into a name the server will accept.
 *
 * Never empty and never longer than the limit, because both are refusals rather
 * than truncations on the far side. The extension is preserved when trimming,
 * since it is the only part of a long name anybody reads.
 */
fun sanitizeAttachmentFilename(raw: String?): String {
    val cleaned = FILENAME_FORBIDDEN.replace(raw.orEmpty(), " ").trim()
    if (cleaned.isEmpty()) return "file"
    if (cleaned.length <= ATTACHMENT_FILENAME_MAX_LENGTH) return cleaned

    val dot = cleaned.lastIndexOf('.')
    // A "." three hundred characters in is not an extension, it is prose.
    val extension = if (dot > 0 && cleaned.length - dot <= 16) cleaned.substring(dot) else ""
    val room = ATTACHMENT_FILENAME_MAX_LENGTH - extension.length
    return cleaned.take(room) + extension
}

/**
 * Extensions worth guessing from, and only for types already on the allowlist.
 *
 * The guess exists because Android's answer is routinely useless: a file picked
 * out of Downloads or off a share sheet frequently arrives as
 * `application/octet-stream`, and `ContentResolver.getType` may return null
 * outright for a `file://` URI. Sending that to the server is a guaranteed
 * refusal for a file that is plainly a JPEG.
 */
private val EXTENSION_TYPES: Map<String, String> = mapOf(
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "jfif" to "image/jpeg",
    "gif" to "image/gif",
    "webp" to "image/webp",
    "avif" to "image/avif",
    "mp4" to "video/mp4",
    "m4v" to "video/mp4",
    "webm" to "video/webm",
    "mp3" to "audio/mpeg",
    "ogg" to "audio/ogg",
    "oga" to "audio/ogg",
    "wav" to "audio/wav",
    "pdf" to "application/pdf",
    "txt" to "text/plain",
    "log" to "text/plain",
    "md" to "text/plain",
)

/**
 * A few spellings the platform uses that the allowlist does not.
 *
 * `image/jpg` is not a registered type and is nonetheless what a good deal of
 * Android software reports; `audio/mp3` and `audio/x-wav` are the same story.
 * Mapping them is not widening the allowlist, it is agreeing about what the
 * bytes are.
 */
private val TYPE_ALIASES: Map<String, String> = mapOf(
    "image/jpg" to "image/jpeg",
    "image/pjpeg" to "image/jpeg",
    "audio/mp3" to "audio/mpeg",
    "audio/mpeg3" to "audio/mpeg",
    "audio/x-mpeg" to "audio/mpeg",
    "audio/x-wav" to "audio/wav",
    "audio/wave" to "audio/wav",
    "audio/vnd.wave" to "audio/wav",
    "video/quicktime" to "video/mp4",
    "application/x-pdf" to "application/pdf",
)

/**
 * The content type to declare for this file, or null when it is not something
 * this deployment accepts.
 *
 * The reported type wins when it is usable, because it came from whatever
 * actually holds the bytes. The extension is the fallback and not the other way
 * round: an extension is a claim by whoever named the file, and a `.png` that
 * is really a PDF should be sent as what the provider says it is.
 */
fun attachmentContentTypeFor(reported: String?, filename: String): String? {
    val declared = reported
        ?.substringBefore(';')
        ?.trim()
        ?.lowercase()
        ?.takeIf { it.isNotEmpty() }

    val resolved = declared?.let { TYPE_ALIASES[it] ?: it }
    if (resolved != null && resolved in ATTACHMENT_MIME_ALLOWLIST) return resolved

    val extension = filename.substringAfterLast('.', "").lowercase()
    return EXTENSION_TYPES[extension]
}

/**
 * Whether one more file fits, and if not, why.
 *
 * Pure, and separate from the upload, because these are the three refusals a
 * person actually meets and each one needs its own sentence. `maxBytes` is this
 * deployment's cap as reported by `GET /api/attachments/config`, not the
 * constant: a self-host may have lowered it, and discovering that as a 400
 * after a 9 MB upload has already been pushed over a phone connection is the
 * outcome this check exists to avoid.
 */
fun refuseAttachment(
    contentType: String?,
    byteSize: Long,
    maxBytes: Long,
    alreadyAttached: Int,
): AttachmentRefusal? = when {
    alreadyAttached >= MAX_ATTACHMENTS_PER_MESSAGE -> AttachmentRefusal.TooMany
    contentType == null -> AttachmentRefusal.UnsupportedType
    byteSize <= 0 -> AttachmentRefusal.Unreadable
    byteSize > maxBytes -> AttachmentRefusal.TooLarge
    else -> null
}

/** Renders a byte count the way a chip has room for. */
fun formatAttachmentSize(bytes: Long): String = when {
    bytes >= 1024L * 1024 -> String.format(java.util.Locale.US, "%.1f MB", bytes / (1024.0 * 1024))
    bytes >= 1024 -> "${(bytes + 512) / 1024} KB"
    else -> "$bytes B"
}
