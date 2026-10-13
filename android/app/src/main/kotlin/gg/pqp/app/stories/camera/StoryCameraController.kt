package gg.pqp.app.stories.camera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.MirrorMode
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.LifecycleOwner
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * The story camera on CameraX: one preview, one photo path and one video path
 * on a single lens, flipped by re-binding.
 *
 * - **9:16, what you see is what you get.** The three use cases share the
 *   `PreviewView`'s view port, so the photo and the clip are cropped to the
 *   same 9:16 the screen shows, not to the sensor's own shape.
 * - **Front shots are mirrored like the preview.** `ImageCapture` writes the
 *   mirror into the file, and `VideoCapture` mirrors the front lens only, so a
 *   selfie is not flipped on the way into the story.
 * - **Photo + video on legacy hardware.** A device that cannot run all three at
 *   once binds preview and photo only; [canRecord] says so and the shutter
 *   stays a tap.
 * - A recording is bounded by the caller (30 s), not by an animation: see
 *   `CaptureRules`.
 *
 * Everything runs on the main thread, as CameraX wants it.
 */
class StoryCameraController(private val context: Context) {

    sealed interface ClipEvent {
        data object Started : ClipEvent
        data class Finished(val uri: Uri, val durationMs: Long) : ClipEvent
        /** Too short to keep, or the stream ended with nothing in it: say nothing. */
        data object Empty : ClipEvent
        data class Failed(val code: Int) : ClipEvent
    }

    sealed interface PhotoEvent {
        data class Saved(val uri: Uri) : PhotoEvent
        data class Failed(val code: Int) : PhotoEvent
    }

    private val executor = ContextCompat.getMainExecutor(context)

    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var imageCapture: ImageCapture? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null
    private var recordingFile: File? = null
    private var recordingUri: Uri? = null
    private var torchOnForClip = false

    private val _lens = MutableStateFlow(CaptureRules.Lens.Back)
    val lens: StateFlow<CaptureRules.Lens> = _lens.asStateFlow()

    private val _zoom = MutableStateFlow(1f)
    val zoom: StateFlow<Float> = _zoom.asStateFlow()

    private val _zoomRange = MutableStateFlow(1f..1f)
    val zoomRange: StateFlow<ClosedFloatingPointRange<Float>> = _zoomRange.asStateFlow()

    private val _hasFlashUnit = MutableStateFlow(false)
    val hasFlashUnit: StateFlow<Boolean> = _hasFlashUnit.asStateFlow()

    private val _canRecord = MutableStateFlow(false)
    val canRecord: StateFlow<Boolean> = _canRecord.asStateFlow()

    private val _recording = MutableStateFlow(false)
    val isRecording: StateFlow<Boolean> = _recording.asStateFlow()

    private var flash = CaptureRules.Flash.Off

    data class Lenses(val back: Boolean, val front: Boolean)

    /** Which lenses this phone has. Cheap once the provider is up. */
    suspend fun lenses(): Lenses {
        val p = provider()
        return Lenses(
            back = p.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA),
            front = p.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA),
        )
    }

    private suspend fun provider(): ProcessCameraProvider =
        provider ?: suspendCancellableCoroutine<ProcessCameraProvider> { continuation ->
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener(
                {
                    try {
                        continuation.resume(future.get())
                    } catch (e: Exception) {
                        continuation.resumeWithException(e)
                    }
                },
                executor,
            )
        }.also { provider = it }

    /**
     * Opens [lens] on [owner] and draws it into [view]. Throws when the camera
     * cannot be opened (in use by a call, or no such lens); the caller shows
     * that as a state, not a crash.
     */
    suspend fun bind(owner: LifecycleOwner, view: PreviewView, lens: CaptureRules.Lens) {
        val p = provider()
        val selector = CameraSelector.Builder()
            .requireLensFacing(
                if (lens == CaptureRules.Lens.Front) CameraSelector.LENS_FACING_FRONT else CameraSelector.LENS_FACING_BACK,
            )
            .build()
        require(p.hasCamera(selector)) { "No ${lens.name} camera" }

        val resolution = ResolutionSelector.Builder()
            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
            .build()
        val preview = Preview.Builder().setResolutionSelector(resolution).build()
            .also { it.surfaceProvider = view.surfaceProvider }
        val photo = ImageCapture.Builder()
            .setResolutionSelector(resolution)
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build()
        view.screenFlash.let { photo.screenFlash = it }
        val recorder = Recorder.Builder()
            .setQualitySelector(
                QualitySelector.fromOrderedList(
                    listOf(Quality.HD, Quality.FHD, Quality.SD),
                    FallbackStrategy.lowerQualityOrHigherThan(Quality.SD),
                ),
            )
            // 720p at 5 Mbit/s is about 19 MB for 30 s, inside the 25 MB cap.
            .setTargetVideoEncodingBitRate(VIDEO_BITRATE)
            .build()
        val video = VideoCapture.Builder(recorder)
            .setMirrorMode(MirrorMode.MIRROR_MODE_ON_FRONT_ONLY)
            .build()

        p.unbindAll()
        recording = null
        _recording.value = false
        val viewPort = view.viewPort
        fun group(withVideo: Boolean) = UseCaseGroup.Builder()
            .addUseCase(preview)
            .addUseCase(photo)
            .apply {
                if (withVideo) addUseCase(video)
                viewPort?.let { setViewPort(it) }
            }
            .build()
        val bound = try {
            p.bindToLifecycle(owner, selector, group(withVideo = true)).also { _canRecord.value = true }
        } catch (_: IllegalArgumentException) {
            // Preview + photo + video is more than a legacy-level camera can run.
            _canRecord.value = false
            p.unbindAll()
            p.bindToLifecycle(owner, selector, group(withVideo = false))
        }
        camera = bound
        imageCapture = photo
        videoCapture = if (_canRecord.value) video else null
        _lens.value = lens
        _hasFlashUnit.value = bound.cameraInfo.hasFlashUnit()
        bound.cameraInfo.zoomState.observe(owner) { state ->
            _zoom.value = state.zoomRatio
            _zoomRange.value = state.minZoomRatio..state.maxZoomRatio
        }
        applyFlash()
    }

    fun unbind() {
        runCatching { recording?.stop() }
        recording = null
        _recording.value = false
        runCatching { provider?.unbindAll() }
        camera = null
        imageCapture = null
        videoCapture = null
    }

    fun setFlash(mode: CaptureRules.Flash) {
        flash = mode
        applyFlash()
    }

    /** Back lens: the flash unit. Front lens: the screen lights up (no unit to fire). */
    private fun applyFlash() {
        val capture = imageCapture ?: return
        capture.flashMode = when {
            flash == CaptureRules.Flash.Off -> ImageCapture.FLASH_MODE_OFF
            _lens.value == CaptureRules.Lens.Front && !_hasFlashUnit.value ->
                if (flash == CaptureRules.Flash.On) ImageCapture.FLASH_MODE_SCREEN else ImageCapture.FLASH_MODE_OFF
            flash == CaptureRules.Flash.Auto -> ImageCapture.FLASH_MODE_AUTO
            else -> ImageCapture.FLASH_MODE_ON
        }
    }

    fun setZoom(ratio: Float) {
        val range = _zoomRange.value
        val target = ratio.coerceIn(range.start, range.endInclusive)
        camera?.cameraControl?.setZoomRatio(target)
        _zoom.value = target
    }

    /** Focus and meter on a point of the preview, in the view's own pixels. */
    fun focusAt(view: PreviewView, x: Float, y: Float) {
        val control = camera?.cameraControl ?: return
        val point = view.meteringPointFactory.createPoint(x, y)
        control.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
    }

    fun takePhoto(onEvent: (PhotoEvent) -> Unit) {
        val capture = imageCapture ?: return onEvent(PhotoEvent.Failed(ImageCapture.ERROR_CAMERA_CLOSED))
        val target = StoryCaptureFiles.create(context, "jpg")
        val metadata = ImageCapture.Metadata().apply {
            isReversedHorizontal = CaptureRules.mirrorsCapture(_lens.value)
        }
        val options = ImageCapture.OutputFileOptions.Builder(target.file).setMetadata(metadata).build()
        capture.takePicture(
            options,
            executor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) = onEvent(PhotoEvent.Saved(target.uri))
                override fun onError(exception: ImageCaptureException) = onEvent(PhotoEvent.Failed(exception.imageCaptureError))
            },
        )
    }

    /** Starts a clip. Returns false when this lens cannot record or one is already running. */
    @SuppressLint("MissingPermission")
    fun startRecording(onEvent: (ClipEvent) -> Unit): Boolean {
        val capture = videoCapture ?: return false
        if (recording != null) return false
        val target = StoryCaptureFiles.create(context, "mp4")
        recordingFile = target.file
        recordingUri = target.uri
        val pending = capture.output.prepareRecording(context, FileOutputOptions.Builder(target.file).build())
            .let {
                // No microphone permission records a silent clip rather than none.
                if (hasMicrophone()) it.withAudioEnabled() else it
            }
        torchOnForClip = CaptureRules.torchDuringVideo(flash, _hasFlashUnit.value)
        if (torchOnForClip) camera?.cameraControl?.enableTorch(true)
        _recording.value = true
        recording = pending.start(executor) { event ->
            when (event) {
                is VideoRecordEvent.Start -> onEvent(ClipEvent.Started)
                is VideoRecordEvent.Finalize -> {
                    if (torchOnForClip) camera?.cameraControl?.enableTorch(false)
                    torchOnForClip = false
                    recording = null
                    _recording.value = false
                    val durationMs = event.recordingStats.recordedDurationNanos / 1_000_000
                    when {
                        !event.hasError() -> onEvent(ClipEvent.Finished(target.uri, durationMs))
                        event.error == VideoRecordEvent.Finalize.ERROR_NO_VALID_DATA -> {
                            target.file.delete()
                            onEvent(ClipEvent.Empty)
                        }
                        event.error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED ||
                            event.error == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED ->
                            onEvent(ClipEvent.Finished(target.uri, durationMs))
                        else -> {
                            target.file.delete()
                            onEvent(ClipEvent.Failed(event.error))
                        }
                    }
                }
                else -> Unit
            }
        }
        return true
    }

    fun stopRecording() {
        recording?.stop()
    }

    private fun hasMicrophone(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** A still of whatever the preview shows, for the flip transition. Null before the first frame. */
    fun snapshot(view: PreviewView): Bitmap? = runCatching { view.bitmap }.getOrNull()

    companion object {
        const val VIDEO_BITRATE = 5_000_000
    }
}

/** Where a capture lands: a file in the app's cache plus the FileProvider URI everything else reads it by. */
object StoryCaptureFiles {
    class Target(val file: File, val uri: Uri)

    fun create(context: Context, extension: String): Target {
        val dir = File(context.cacheDir, "stories").apply { mkdirs() }
        val file = File(dir, "capture-${System.currentTimeMillis()}.$extension")
        return Target(file, FileProvider.getUriForFile(context, "${context.packageName}.stories", file))
    }

    /** A fresh file for something the app writes itself (a trimmed clip). */
    fun createUri(context: Context, extension: String): Target = create(context, extension)

    /** Captures older than a day are nobody's story any more. */
    fun sweep(context: Context, nowMs: Long = System.currentTimeMillis()) {
        File(context.cacheDir, "stories").listFiles()?.forEach {
            if (nowMs - it.lastModified() > 24L * 60 * 60 * 1000) it.delete()
        }
    }
}
