package gg.pqp.app.stories

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Getting a picked or captured file ready to be a story, on the phone,
 * because the bytes never pass the API and this is the only place left to do
 * it.
 *
 * - A photo is decoded and re-encoded as JPEG with its long side at most
 *   1440 px. Re-encoding from pixels is what strips EXIF, location included.
 *   `ImageDecoder` applies the camera's rotation first, so the picture stands
 *   the right way up without the tag that said how.
 * - A video is measured first. A clip that fits (MP4, at most 30 s and 25 MB)
 *   goes as it is, the way the story camera records it. One that does not is
 *   handed back as [PrepResult.NeedsWork], and `VideoPrep` trims it to the 30 s
 *   the person picked and shrinks it to 720p.
 */
data class PreparedMedia(
    val bytes: ByteArray,
    val contentType: String,
    val width: Int,
    val height: Int,
    val durationMs: Long?,
    /** A local preview for the composer: the file itself. */
    val previewUri: Uri,
) {
    val isVideo: Boolean get() = contentType == "video/mp4"

    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

sealed interface PrepResult {
    data class Ready(val media: PreparedMedia) : PrepResult
    data class Refused(val reason: StoriesRules.MediaRefusal, val durationMs: Long? = null) : PrepResult
    data object Unreadable : PrepResult

    /**
     * A video that is a real video but not yet a story: longer than 30 s (the
     * person chooses which 30 s) or a clip that fits the length and is over the
     * size cap or too sharp for it (it is shrunk). `VideoPrep` turns it into a
     * file that is `Ready`.
     */
    data class NeedsWork(
        val uri: Uri,
        val durationMs: Long,
        val width: Int,
        val height: Int,
        val tooLong: Boolean,
    ) : PrepResult
}

object StoryMediaPrep {

    suspend fun prepare(context: Context, uri: Uri, maxBytes: Long): PrepResult = withContext(Dispatchers.IO) {
        val type = context.contentResolver.getType(uri).orEmpty()
        when {
            type.startsWith("video/") -> prepareVideo(context, uri, type, maxBytes)
            type.startsWith("image/") -> prepareImage(context, uri, maxBytes)
            else -> PrepResult.Refused(StoriesRules.MediaRefusal.WrongType)
        }
    }

    private fun prepareImage(context: Context, uri: Uri, maxBytes: Long): PrepResult {
        val bitmap = runCatching { decode(context, uri) }.getOrNull() ?: return PrepResult.Unreadable
        val (width, height) = StoriesRules.scaledSize(bitmap.width, bitmap.height)
        val scaled = if (width != bitmap.width || height != bitmap.height) {
            Bitmap.createScaledBitmap(bitmap, width, height, true)
        } else {
            bitmap
        }
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        val bytes = out.toByteArray()
        // A 1440 px JPEG is far under any real cap, but a deployment may set one lower.
        if (bytes.size > maxBytes) return PrepResult.Refused(StoriesRules.MediaRefusal.TooBig)
        return PrepResult.Ready(PreparedMedia(bytes, "image/jpeg", width, height, null, uri))
    }

    private fun decode(context: Context, uri: Uri): Bitmap? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val source = ImageDecoder.createSource(context.contentResolver, uri)
            ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                // Decode no bigger than needed: a 48 MP photo is 190 MB of pixels.
                val long = maxOf(info.size.width, info.size.height)
                if (long > StoriesRules.IMAGE_MAX_EDGE * 2) {
                    val sample = long / (StoriesRules.IMAGE_MAX_EDGE * 2)
                    decoder.setTargetSampleSize(maxOf(1, sample))
                }
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            decodeLegacy(context, uri)
        }

    /**
     * Android 8.x (API 26 and 27), which has no `ImageDecoder`. Two things
     * `ImageDecoder` does for free have to be done by hand: decode no bigger
     * than needed (bounds first, then a power-of-two sample, so a 48 MP photo
     * never becomes 190 MB of pixels), and stand the picture up from its EXIF
     * orientation, because re-encoding drops the tag that said how to turn it.
     * That includes the mirrored orientations a front-camera shot carries.
     */
    private fun decodeLegacy(context: Context, uri: Uri): Bitmap? {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = StoriesRules.sampleSize(bounds.outWidth, bounds.outHeight)
        }
        val bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return null
        val orientation = runCatching {
            resolver.openInputStream(uri)?.use {
                android.media.ExifInterface(it).getAttributeInt(
                    android.media.ExifInterface.TAG_ORIENTATION,
                    android.media.ExifInterface.ORIENTATION_NORMAL,
                )
            }
        }.getOrNull() ?: android.media.ExifInterface.ORIENTATION_NORMAL
        val (degrees, mirrored) = StoriesRules.exifTurn(orientation)
        if (degrees == 0 && !mirrored) return bitmap
        val turn = android.graphics.Matrix().apply {
            if (mirrored) postScale(-1f, 1f)
            if (degrees != 0) postRotate(degrees.toFloat())
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, turn, true)
            .also { if (it !== bitmap) bitmap.recycle() }
    }

    private fun prepareVideo(context: Context, uri: Uri, type: String, maxBytes: Long): PrepResult {
        val retriever = MediaMetadataRetriever()
        val (durationMs, width, height) = try {
            retriever.setDataSource(context, uri)
            val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
            val w = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val h = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            // A portrait phone clip is stored landscape with a rotation tag;
            // the story is drawn the way it plays.
            if (rotation == 90 || rotation == 270) Triple(duration, h, w) else Triple(duration, w, h)
        } catch (_: Exception) {
            return PrepResult.Unreadable
        } finally {
            runCatching { retriever.release() }
        }
        // A provider that cannot say how long the file is answers -1: count it by
        // reading, rather than treating "unknown" as "small" and letting an
        // oversized clip through to a refusal when it could have been shrunk.
        val size = runCatching {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
        }.getOrNull()?.takeIf { it >= 0 } ?: countBytes(context, uri)
        if (width <= 0 || height <= 0 || durationMs == null || durationMs <= 0) return PrepResult.Unreadable
        // A container Android can read but a story cannot carry (a .mov, a .webm) is
        // not worked on: the type is the refusal.
        if (type != "video/mp4") return PrepResult.Refused(StoriesRules.MediaRefusal.WrongType, durationMs)
        val work = TrimRules.work(durationMs, size.coerceAtLeast(0), width, height, maxBytes)
        if (work != null) return PrepResult.NeedsWork(uri, durationMs, width, height, tooLong = work == TrimRules.Work.Trim)
        StoriesRules.checkMedia(type, size.coerceAtLeast(0), durationMs, maxBytes)?.let {
            return PrepResult.Refused(it, durationMs)
        }
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return PrepResult.Unreadable
        if (bytes.size > maxBytes) return PrepResult.Refused(StoriesRules.MediaRefusal.TooBig)
        return PrepResult.Ready(PreparedMedia(bytes, "video/mp4", width, height, durationMs, uri))
    }

    private fun countBytes(context: Context, uri: Uri): Long = runCatching {
        context.contentResolver.openInputStream(uri)?.use { stream ->
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                total += read
            }
            total
        }
    }.getOrNull() ?: 0L

    private const val JPEG_QUALITY = 85
}
