package gg.pqp.app.jam.ui

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import gg.pqp.app.jam.JamCover
import gg.pqp.app.jam.PhotoProblem
import java.io.ByteArrayOutputStream

/*
 * A PICKED PHOTO, MADE INTO A COVER. The web crops the photo to a square JPEG of `JAM_COVER_SIZE` pixels in the browser
 * because the API never decodes an image (`client/src/lib/jam-cover.ts`); the phone does the same, with the system's own
 * decoders, and sends exactly that: a centred square, 1024 x 1024, JPEG, under the 4 MiB the server allows.
 *
 *  - looked at BEFORE it is decoded in full: not an image, no size, or a side under 400 px is refused in words;
 *  - decoded at the smallest power-of-two subsample that still keeps the 1024 square, so a 48 MP photo is never held whole;
 *  - upright: a photo carries its rotation in EXIF (`ImageDecoder` applies it, and the older path does by hand);
 *  - flattened onto the near-white of text on a picture, so a transparent PNG is not black in the JPEG.
 *
 * Off the main thread: [prepare] blocks. The numbers it uses are `JamCover` (tested); this is the platform half.
 */
object JamCoverPhoto {
    sealed interface Prepared {
        class Ready(val jpeg: ByteArray) : Prepared
        class Rejected(val problem: PhotoProblem) : Prepared
    }

    /** `--color-on-media`, the colour a transparent part of a picture becomes in the JPEG. */
    private const val FLATTEN = 0xFFF7F6F1.toInt()

    fun prepare(resolver: ContentResolver, uri: Uri): Prepared {
        val type = runCatching { resolver.getType(uri) }.getOrNull()
        if (type != null && !type.startsWith("image/")) return Prepared.Rejected(PhotoProblem.Type)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        val read = runCatching { resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } }
        if (read.isFailure) return Prepared.Rejected(PhotoProblem.Unreadable)
        when (val verdict = JamCover.check(bounds.outWidth, bounds.outHeight)) {
            JamCover.Verdict.Ok -> Unit
            JamCover.Verdict.Unreadable -> return Prepared.Rejected(PhotoProblem.Unreadable)
            is JamCover.Verdict.Small -> return Prepared.Rejected(PhotoProblem.Small(verdict.width, verdict.height))
        }
        return try {
            val source = decode(resolver, uri, bounds.outWidth, bounds.outHeight) ?: return Prepared.Rejected(PhotoProblem.Unreadable)
            val jpeg = try {
                encode(source)
            } finally {
                source.recycle()
            }
            if (jpeg == null) Prepared.Rejected(PhotoProblem.Failed) else Prepared.Ready(jpeg)
        } catch (_: OutOfMemoryError) {
            Prepared.Rejected(PhotoProblem.Failed)
        } catch (_: Exception) {
            Prepared.Rejected(PhotoProblem.Unreadable)
        }
    }

    /** The photo, upright and subsampled, or null when no decoder on this phone can read it. */
    private fun decode(resolver: ContentResolver, uri: Uri, width: Int, height: Int): Bitmap? {
        val sample = JamCover.sampleSize(width, height)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, _, _ ->
                // Software memory: the pixels are read and drawn again below, which a hardware bitmap does not allow.
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.setTargetSampleSize(sample)
            }
        }
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        val bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return null
        val rotation = runCatching {
            resolver.openInputStream(uri)?.use { stream ->
                when (ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                    ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                    ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                    else -> 0f
                }
            }
        }.getOrNull() ?: 0f
        if (rotation == 0f) return bitmap
        val turned = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(rotation) }, true)
        if (turned !== bitmap) bitmap.recycle()
        return turned
    }

    /** The centred square at 1024, as a JPEG, trying lower qualities until it is under the server's ceiling. */
    private fun encode(source: Bitmap): ByteArray? {
        val (left, top, side) = JamCover.centredSquare(source.width, source.height)
        val out = Bitmap.createBitmap(JamCover.SIZE, JamCover.SIZE, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(out)
            canvas.drawColor(FLATTEN)
            canvas.drawBitmap(
                source,
                Rect(left, top, left + side, top + side),
                Rect(0, 0, JamCover.SIZE, JamCover.SIZE),
                Paint(Paint.FILTER_BITMAP_FLAG),
            )
            for (quality in JamCover.QUALITIES) {
                val bytes = ByteArrayOutputStream()
                out.compress(Bitmap.CompressFormat.JPEG, quality, bytes)
                if (bytes.size() <= JamCover.MAX_BYTES) return bytes.toByteArray()
            }
            return null
        } finally {
            out.recycle()
        }
    }
}
