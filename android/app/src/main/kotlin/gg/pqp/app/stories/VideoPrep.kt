package gg.pqp.app.stories

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import androidx.media3.common.Effect
import androidx.media3.transformer.Composition
import gg.pqp.app.stories.camera.StoryCameraController
import gg.pqp.app.stories.camera.StoryCaptureFiles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Turns a picked video that is not yet a story into one: the 30 s the person
 * chose, at 720p, at a bitrate that keeps 30 s under the size cap. Media3
 * `Transformer`, which re-encodes (the cut rarely lands on a keyframe) and
 * writes MP4 with H.264 and AAC, the pair every viewer plays.
 *
 * The result is a file in the app's cache that `StoryMediaPrep.prepare` then
 * reads like any other clip, so the limits are checked once, in one place.
 */
object VideoPrep {

    /** Needs the main thread's looper, as `Transformer` does; [onProgress] is 0..1. */
    @OptIn(UnstableApi::class)
    suspend fun export(
        context: Context,
        source: Uri,
        startMs: Long,
        endMs: Long,
        width: Int,
        height: Int,
        onProgress: (Float) -> Unit,
    ): Uri = withContext(Dispatchers.Main) {
        val target = StoryCaptureFiles.create(context, "mp4")
        val clip = MediaItem.ClippingConfiguration.Builder()
            .setStartPositionMs(startMs)
            .setEndPositionMs(endMs)
            .build()
        val item = MediaItem.Builder().setUri(source).setClippingConfiguration(clip).build()
        val videoEffects = buildList<Effect> {
            TrimRules.shrinkTarget(width, height)?.let { (w, h) ->
                add(Presentation.createForWidthAndHeight(w, h, Presentation.LAYOUT_SCALE_TO_FIT))
            }
        }
        val edited = EditedMediaItem.Builder(item)
            .setEffects(Effects(emptyList(), videoEffects))
            .build()
        val encoders = DefaultEncoderFactory.Builder(context)
            .setRequestedVideoEncoderSettings(
                VideoEncoderSettings.Builder().setBitrate(StoryCameraController.VIDEO_BITRATE).build(),
            )
            .build()

        val result = CompletableDeferred<Uri>()
        val transformer = Transformer.Builder(context)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoders)
            .addListener(
                object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        result.complete(target.uri)
                    }

                    override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                        target.file.delete()
                        result.completeExceptionally(exportException)
                    }
                },
            )
            .build()
        transformer.start(edited, target.file.absolutePath)
        try {
            coroutineScope {
                // Progress has to be asked for; it is not pushed.
                val poll = launch {
                    val holder = ProgressHolder()
                    while (isActive) {
                        if (transformer.getProgress(holder) != Transformer.PROGRESS_STATE_NOT_STARTED) {
                            onProgress(holder.progress / 100f)
                        }
                        delay(PROGRESS_POLL_MS)
                    }
                }
                try {
                    result.await()
                } finally {
                    poll.cancel()
                }
            }.also { onProgress(1f) }
        } catch (e: CancellationException) {
            // `cancel` has to run on the thread `start` did, which is this one.
            transformer.cancel()
            target.file.delete()
            throw e
        }
    }

    private const val PROGRESS_POLL_MS = 200L
}
