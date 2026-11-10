package gg.pqp.app.jam.ui

import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.os.Build
import android.media.MediaMetadataRetriever
import android.util.LruCache
import android.view.Surface
import android.view.TextureView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.exoplayer.ExoPlayer
import gg.pqp.app.core.Backend
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/**
 * A poster frame for a song with video: one frame out of the first in-mix
 * track's video, read with `MediaMetadataRetriever` straight from its presigned
 * URL (WebM from Chrome and Firefox, MP4 from Safari; the platform opens both).
 *
 * Two at a time, a small in-memory cache, and a miss is simply "no poster": the
 * tile keeps its coloured ground and waveform. Cancelling the composable that
 * asked drops its wait but not a retrieval already running (the framework call
 * is blocking), which is bounded by the two permits.
 */
object JamPosters {
    private val cache = object : LruCache<String, Bitmap>(8 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val permits = Semaphore(2)
    private val failed = HashSet<String>()

    suspend fun get(url: String): Bitmap? {
        cache.get(url)?.let { return it }
        if (synchronized(failed) { url in failed }) return null
        return permits.withPermit {
            cache.get(url)?.let { return@withPermit it }
            val bitmap = withContext(Dispatchers.IO) { read(url) }
            if (bitmap != null) cache.put(url, bitmap) else synchronized(failed) { failed += url }
            bitmap
        }
    }

    private fun read(url: String): Bitmap? {
        val absolute = Backend.absolute(url) ?: return null
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(absolute, HashMap())
            // Half a second in: past the black first frame most phone clips open on.
            // From API 27 the platform scales while it decodes, so a 4K clip never becomes a 33 MB bitmap first.
            val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val scaled = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1 && width > MAX_WIDTH && height > 0
            val targetHeight = if (scaled) height * MAX_WIDTH / width else 0
            fun frameAt(us: Long): Bitmap? =
                if (scaled) {
                    retriever.getScaledFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, MAX_WIDTH, targetHeight)
                } else {
                    retriever.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                }
            val frame = frameAt(500_000) ?: frameAt(0) ?: return null
            if (frame.width <= MAX_WIDTH) {
                frame
            } else {
                val scaled = Bitmap.createScaledBitmap(frame, MAX_WIDTH, frame.height * MAX_WIDTH / frame.width, true)
                if (scaled !== frame) frame.recycle()
                scaled
            }
        } catch (_: Exception) {
            null
        } finally {
            runCatching { retriever.release() }
        }
    }

    private const val MAX_WIDTH = 640
}

@Composable
fun rememberJamPoster(url: String?): ImageBitmap? {
    val bitmap by produceState<ImageBitmap?>(null, url) {
        value = if (url == null) null else JamPosters.get(url)?.asImageBitmap()
    }
    return bitmap
}

/**
 * The picture of one video stem: a `TextureView` an `ExoPlayer` draws into. A
 * texture rather than a surface view because this sits inside a shared element
 * transition and a scrolling column, where a separate window layer tears.
 */
@Composable
fun JamVideoSurface(player: ExoPlayer, modifier: Modifier = Modifier) {
    var texture by remember { mutableStateOf<TextureView?>(null) }
    AndroidView(
        modifier = modifier,
        factory = { context ->
            TextureView(context).also { view ->
                view.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                    override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
                        player.setVideoSurface(Surface(st))
                    }

                    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) = Unit
                    override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                        player.clearVideoSurface()
                        return true
                    }

                    override fun onSurfaceTextureUpdated(st: SurfaceTexture) = Unit
                }
                texture = view
            }
        },
    )
    DisposableEffect(player) {
        onDispose { runCatching { player.clearVideoSurface() } }
    }
}
