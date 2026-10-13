package gg.pqp.app.stories.camera

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Observer
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pqp.app.R
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

private enum class CameraPhase { Starting, Live, Busy, NoCamera }

private fun Context.activity(): Activity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}

private fun Context.has(permission: String): Boolean =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

/**
 * The story camera, full screen: a 9:16 live preview, a shutter that takes a
 * photo on a tap and records a clip while it is held (a ring fills over 30 s),
 * a flip between the front and back lens (the button or a double tap), flash,
 * pinch to zoom, tap to focus.
 *
 * It owns the camera permission states (asking, denied, blocked in settings)
 * and hands the finished file to [onCaptured] as a FileProvider URI. The
 * photo picker is one tap away through [onGallery], and is also what a phone
 * with no camera, or a person who says no, is left with.
 *
 * Time is never an animation here: the recording clock reads the wall clock,
 * so it runs to 30 s with "Remove animations" on.
 */
@Composable
fun StoryCameraScreen(
    videoEnabled: Boolean,
    /** A picked or captured file is being prepared; the camera waits. */
    busy: Boolean,
    /** A refusal from the last pick (too big, wrong type), drawn over the shutter. */
    message: String?,
    onClose: () -> Unit,
    onGallery: () -> Unit,
    onCaptured: (Uri) -> Unit,
    modeTabs: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val haptics = LocalHapticFeedback.current
    val controller = remember { StoryCameraController(context.applicationContext) }
    val onCapturedNow by rememberUpdatedState(onCaptured)
    var alive by remember { mutableStateOf(true) }

    DisposableEffect(Unit) {
        StoryCaptureFiles.sweep(context)
        onDispose {
            alive = false
            controller.unbind()
        }
    }

    // --- permissions ---

    var camGranted by remember { mutableStateOf(context.has(Manifest.permission.CAMERA)) }
    var micGranted by remember { mutableStateOf(context.has(Manifest.permission.RECORD_AUDIO)) }
    var asked by rememberSaveable { mutableStateOf(false) }
    // Whether the system will still show its dialog. It is only knowable after
    // an answer, and it is state, not a value read while drawing: a denial
    // changes nothing else on screen, so nothing would redraw to re-read it.
    var canAskAgain by remember { mutableStateOf(true) }
    val askAgainPossible = {
        context.activity()?.let { ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.CAMERA) } == true
    }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        camGranted = context.has(Manifest.permission.CAMERA)
        micGranted = context.has(Manifest.permission.RECORD_AUDIO)
        canAskAgain = askAgainPossible()
    }
    LaunchedEffect(Unit) {
        if (!asked && (!camGranted || !micGranted)) {
            asked = true
            permissions.launch(
                listOfNotNull(
                    Manifest.permission.CAMERA.takeUnless { camGranted },
                    Manifest.permission.RECORD_AUDIO.takeUnless { micGranted },
                ).toTypedArray(),
            )
        }
    }
    // Back from the system settings with the permission turned on.
    LifecycleResumeEffect(Unit) {
        camGranted = context.has(Manifest.permission.CAMERA)
        micGranted = context.has(Manifest.permission.RECORD_AUDIO)
        if (asked) canAskAgain = askAgainPossible()
        onPauseOrDispose { }
    }

    // --- camera ---

    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            context.activity()?.window?.let { setScreenFlashWindow(it) }
        }
    }
    var phase by remember { mutableStateOf(CameraPhase.Starting) }
    var lens by remember { mutableStateOf<CaptureRules.Lens?>(null) }
    var lenses by remember { mutableStateOf(StoryCameraController.Lenses(back = false, front = false)) }
    var attempt by remember { mutableStateOf(0) }
    var frozen by remember { mutableStateOf<ImageBitmap?>(null) }
    var flash by remember { mutableStateOf(CaptureRules.Flash.Off) }
    var failure by remember { mutableStateOf<String?>(null) }
    // The zoom the moment a hold began, so sliding up zooms from where it started.
    var holdStartZoom by remember { mutableFloatStateOf(1f) }
    // "Tap for a photo, hold for a video" is said once per visit, not on every flip.
    var hintSeen by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(camGranted, lens, attempt) {
        if (!camGranted) return@LaunchedEffect
        // A flip rebinds while the old picture is still up; only a first open shows the spinner.
        if (phase != CameraPhase.Live) phase = CameraPhase.Starting
        val found = runCatching { controller.lenses() }.getOrNull()
        if (found == null) {
            phase = CameraPhase.Busy
            return@LaunchedEffect
        }
        lenses = found
        val want = lens ?: CaptureRules.startingLens(found.back, found.front)
        if (want == null) {
            phase = CameraPhase.NoCamera
            return@LaunchedEffect
        }
        // The view port is only known once the preview has a size.
        while (previewView.width == 0 || previewView.height == 0) androidx.compose.runtime.withFrameNanos { }
        runCatching { controller.bind(lifecycleOwner, previewView, want) }
            .onSuccess {
                lens = want
                phase = CameraPhase.Live
                controller.setFlash(flash)
            }
            .onFailure { phase = CameraPhase.Busy }
    }

    // The still of the old lens stays up until the new one has a frame.
    DisposableEffect(previewView, lifecycleOwner) {
        val observer = Observer<PreviewView.StreamState> { state ->
            if (state == PreviewView.StreamState.STREAMING) frozen = null
        }
        previewView.previewStreamState.observe(lifecycleOwner, observer)
        onDispose { previewView.previewStreamState.removeObserver(observer) }
    }
    LaunchedEffect(frozen) {
        // A lens that never streams must not leave the still up for good.
        if (frozen != null) {
            delay(1_500)
            frozen = null
        }
    }

    val currentLens by controller.lens.collectAsState()
    val zoom by controller.zoom.collectAsState()
    val zoomRange by controller.zoomRange.collectAsState()
    val hasFlashUnit by controller.hasFlashUnit.collectAsState()
    val canRecord by controller.canRecord.collectAsState()
    val recording by controller.isRecording.collectAsState()
    val flashChoices = CaptureRules.flashChoices(currentLens, hasFlashUnit)
    val canFlip = CaptureRules.canFlip(lenses.back, lenses.front)

    // --- the recording clock: wall time, never an animation ---

    var elapsedMs by remember { mutableLongStateOf(0L) }
    LaunchedEffect(recording) {
        if (!recording) {
            elapsedMs = 0
            return@LaunchedEffect
        }
        val startedAt = SystemClock.elapsedRealtime()
        while (true) {
            androidx.compose.runtime.withFrameNanos { }
            elapsedMs = SystemClock.elapsedRealtime() - startedAt
            if (CaptureRules.reachedLimit(elapsedMs)) {
                controller.stopRecording()
                break
            }
        }
    }

    // --- actions ---

    var capturing by remember { mutableStateOf(false) }
    var shutterBlink by remember { mutableStateOf(false) }
    val photoFailed = stringResource(R.string.stories_camera_photo_failed)
    val clipFailed = stringResource(R.string.stories_camera_clip_failed)

    val takePhoto: () -> Unit = {
        if (!capturing && phase == CameraPhase.Live && !busy) {
            capturing = true
            shutterBlink = true
            haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
            controller.takePhoto { event ->
                capturing = false
                shutterBlink = false
                if (!alive) return@takePhoto
                when (event) {
                    is StoryCameraController.PhotoEvent.Saved -> onCapturedNow(event.uri)
                    is StoryCameraController.PhotoEvent.Failed -> failure = photoFailed
                }
            }
        }
    }
    val startClip: () -> Unit = {
        failure = null
        val started = controller.startRecording { event ->
            if (!alive) return@startRecording
            when (event) {
                is StoryCameraController.ClipEvent.Finished ->
                    if (CaptureRules.keepClip(event.durationMs)) onCapturedNow(event.uri)
                is StoryCameraController.ClipEvent.Failed -> failure = clipFailed
                else -> Unit
            }
        }
        if (started) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    }
    val stopClip: () -> Unit = {
        if (recording) {
            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            controller.stopRecording()
        }
    }
    val flip: () -> Unit = {
        if (canFlip && !recording && phase == CameraPhase.Live) {
            frozen = controller.snapshot(previewView)?.asImageBitmap()
            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
            controller.setZoom(1f)
            lens = currentLens.other
        }
    }

    // --- layout ---

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .testTag("stories.camera"),
    ) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            // The canvas is 9:16. On a taller phone the bars above and below hold the controls.
            val width = minOf(maxWidth, maxHeight * 9f / 16f)
            val height = width * 16f / 9f
            val rounded = maxHeight - height > 24.dp
            var focusPoint by remember { mutableStateOf<Offset?>(null) }
            var zoomVisibleUntil by remember { mutableLongStateOf(0L) }
            Box(
                Modifier
                    .align(Alignment.Center)
                    .size(width, height)
                    .clip(if (rounded) RoundedCornerShape(20.dp) else RoundedCornerShape(0.dp)),
            ) {
                AndroidView(
                    factory = { previewView },
                    modifier = Modifier.fillMaxSize(),
                )
                // Gestures on the glass: tap to focus, double tap to flip, pinch to zoom.
                Box(
                    Modifier
                        .fillMaxSize()
                        .pointerInput(canFlip, phase) {
                            detectTapGestures(
                                onTap = { at ->
                                    if (phase == CameraPhase.Live) {
                                        controller.focusAt(previewView, at.x, at.y)
                                        focusPoint = at
                                    }
                                },
                                onDoubleTap = { flip() },
                            )
                        }
                        .pointerInput(phase, zoomRange) {
                            detectTransformGestures { _, _, factor, _ ->
                                if (phase == CameraPhase.Live && factor != 1f) {
                                    controller.setZoom(
                                        CaptureRules.pinchZoom(controller.zoom.value, factor, zoomRange.start, zoomRange.endInclusive),
                                    )
                                    zoomVisibleUntil = SystemClock.elapsedRealtime() + 1_200
                                }
                            }
                        },
                )
                FocusRing(focusPoint) { focusPoint = null }
                FrozenFrame(frozen)
                AnimatedVisibility(
                    visible = shutterBlink,
                    enter = fadeIn(tween(30)),
                    exit = fadeOut(tween(200)),
                ) {
                    Box(Modifier.fillMaxSize().background(Color.White.copy(alpha = 0.7f)))
                }
                ZoomChip(
                    zoom = zoom,
                    visibleUntil = zoomVisibleUntil,
                    recording = recording,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 156.dp),
                )
            }
        }

        // The permission and fallback states sit over the black.
        when {
            !camGranted -> PermissionState(
                canAskAgain = canAskAgain,
                onAllow = { permissions.launch(arrayOf(Manifest.permission.CAMERA)) },
                onSettings = { openAppSettings(context) },
                onGallery = onGallery,
                modifier = Modifier.align(Alignment.Center),
            )
            phase == CameraPhase.Busy -> CameraNotice(
                text = stringResource(R.string.stories_camera_busy),
                action = stringResource(R.string.connection_retry),
                onAction = { attempt += 1 },
                onGallery = onGallery,
                modifier = Modifier.align(Alignment.Center),
            )
            phase == CameraPhase.NoCamera -> CameraNotice(
                text = stringResource(R.string.stories_camera_none),
                action = null,
                onAction = {},
                onGallery = onGallery,
                modifier = Modifier.align(Alignment.Center),
            )
            phase == CameraPhase.Starting -> CircularProgressIndicator(
                color = Color.White.copy(alpha = 0.7f),
                strokeWidth = 2.dp,
                modifier = Modifier.align(Alignment.Center).size(28.dp),
            )
        }

        // Top bar.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = Spacing.sm, vertical = Spacing.sm),
        ) {
            if (!recording) {
                CameraButton(
                    onClick = onClose,
                    label = stringResource(R.string.stories_camera_close),
                    modifier = Modifier.testTag("stories.camera.close"),
                ) { Icon(PqpIcons.Close, contentDescription = null, tint = Color.White) }
            } else {
                Spacer(Modifier.size(48.dp))
            }
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                if (recording) RecordingChip(elapsedMs)
            }
            if (flashChoices.isNotEmpty() && phase == CameraPhase.Live) {
                FlashButton(
                    flash = flash,
                    onClick = {
                        flash = CaptureRules.nextFlash(flash, flashChoices)
                        controller.setFlash(flash)
                        haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    },
                )
            } else {
                Spacer(Modifier.size(48.dp))
            }
        }

        // Bottom controls.
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = Spacing.sm),
        ) {
            val notice = failure ?: message
            if (notice != null) {
                Text(
                    notice,
                    color = Color.White,
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .padding(horizontal = Spacing.xl, vertical = Spacing.xs)
                        .clip(MaterialTheme.shapes.small)
                        .background(Color.Black.copy(alpha = 0.55f))
                        .padding(horizontal = Spacing.md, vertical = Spacing.sm)
                        .testTag("stories.camera.notice"),
                )
            } else if (camGranted && !micGranted && videoEnabled && !recording && phase == CameraPhase.Live) {
                Text(
                    stringResource(R.string.stories_camera_mic_off),
                    color = Color.White.copy(alpha = 0.85f),
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .padding(horizontal = Spacing.xl, vertical = Spacing.xs)
                        .testTag("stories.camera.micOff"),
                )
            } else if (videoEnabled && canRecord && !recording && phase == CameraPhase.Live && !hintSeen) {
                HintLine(onShown = { hintSeen = true })
            }
            // No shutter over a state that has no camera to shoot: the permission and
            // fallback cards carry their own gallery button.
            if (camGranted && (phase == CameraPhase.Starting || phase == CameraPhase.Live)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Spacing.xl, vertical = Spacing.sm),
                ) {
                    Box(Modifier.size(56.dp), contentAlignment = Alignment.Center) {
                        if (!recording && !busy) {
                            CameraButton(
                                onClick = onGallery,
                                label = stringResource(R.string.stories_camera_gallery),
                                modifier = Modifier.testTag("stories.camera.gallery"),
                            ) { Icon(PqpIcons.Image, contentDescription = null, tint = Color.White) }
                        }
                    }
                    Box(contentAlignment = Alignment.Center) {
                        ShutterButton(
                            enabled = phase == CameraPhase.Live && !busy,
                            recordable = videoEnabled && canRecord,
                            recording = recording,
                            progress = CaptureRules.ringProgress(elapsedMs),
                            secondsLeft = CaptureRules.secondsLeft(elapsedMs),
                            onTap = takePhoto,
                            onHoldStart = startClip,
                            onHoldEnd = stopClip,
                            onHoldDrag = { upwardPx, travelPx ->
                                controller.setZoom(
                                    CaptureRules.dragZoom(
                                        startRatio = holdStartZoom,
                                        upwardPx = upwardPx,
                                        travelPx = travelPx,
                                        min = zoomRange.start,
                                        max = zoomRange.endInclusive,
                                    ),
                                )
                            },
                            onHoldBegan = { holdStartZoom = controller.zoom.value },
                        )
                        if (busy) {
                            CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(28.dp))
                        }
                    }
                    Box(Modifier.size(56.dp), contentAlignment = Alignment.Center) {
                        if (canFlip && !recording && !busy) {
                            val spin by animateFloatAsState(
                                if (currentLens == CaptureRules.Lens.Front) 180f else 0f,
                                spring(stiffness = Spring.StiffnessMediumLow),
                                label = "flip",
                            )
                            CameraButton(
                                onClick = flip,
                                label = stringResource(R.string.stories_camera_flip),
                                modifier = Modifier.testTag("stories.camera.flip"),
                            ) {
                                Icon(
                                    PqpIcons.FlipCamera,
                                    contentDescription = null,
                                    tint = Color.White,
                                    modifier = Modifier.rotate(spin),
                                )
                            }
                        }
                    }
                }
            } else {
                Spacer(Modifier.height(112.dp))
            }
            if (!recording) modeTabs()
        }
    }
}

private fun openAppSettings(context: Context) {
    runCatching {
        context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

// --- pieces ---

@Composable
private fun CameraButton(
    onClick: () -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(48.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.35f))
            .semantics {
                role = Role.Button
                contentDescription = label
            }
            .clickable(onClick = onClick),
    ) { content() }
}

@Composable
private fun FlashButton(flash: CaptureRules.Flash, onClick: () -> Unit) {
    val label = stringResource(
        when (flash) {
            CaptureRules.Flash.Off -> R.string.stories_camera_flash_off
            CaptureRules.Flash.Auto -> R.string.stories_camera_flash_auto
            CaptureRules.Flash.On -> R.string.stories_camera_flash_on
        },
    )
    CameraButton(onClick = onClick, label = label, modifier = Modifier.testTag("stories.camera.flash")) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                if (flash == CaptureRules.Flash.Off) PqpIcons.FlashOff else PqpIcons.Flash,
                contentDescription = null,
                tint = if (flash == CaptureRules.Flash.On) Palette.Signal else Color.White,
            )
            if (flash == CaptureRules.Flash.Auto) {
                Text(
                    "A",
                    color = Color.White,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.align(Alignment.BottomEnd).offset(x = 2.dp, y = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun RecordingChip(elapsedMs: Long) {
    val left = CaptureRules.secondsLeft(elapsedMs)
    val label = stringResource(R.string.stories_camera_recording, left)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(Color.Black.copy(alpha = 0.5f))
            .padding(horizontal = Spacing.md, vertical = Spacing.xs)
            .semantics { contentDescription = label }
            .testTag("stories.camera.recordingChip"),
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(Palette.Danger))
        Spacer(Modifier.width(Spacing.sm))
        Text(CaptureRules.clock(elapsedMs), color = Color.White, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun ZoomChip(zoom: Float, visibleUntil: Long, recording: Boolean, modifier: Modifier) {
    var show by remember { mutableStateOf(false) }
    LaunchedEffect(zoom, visibleUntil) {
        if (visibleUntil > SystemClock.elapsedRealtime() || recording) {
            show = true
            delay(1_200)
            show = false
        }
    }
    AnimatedVisibility(visible = show, enter = fadeIn(tween(80)), exit = fadeOut(tween(300)), modifier = modifier) {
        val label = stringResource(R.string.stories_camera_zoom, CaptureRules.zoomLabel(zoom))
        Text(
            CaptureRules.zoomLabel(zoom),
            color = Color.White,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(Color.Black.copy(alpha = 0.5f))
                .padding(horizontal = Spacing.md, vertical = Spacing.xs)
                .semantics { contentDescription = label }
                .testTag("stories.camera.zoom"),
        )
    }
}

@Composable
private fun HintLine(onShown: () -> Unit) {
    var show by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        delay(4_000)
        show = false
        delay(400)
        onShown()
    }
    AnimatedVisibility(visible = show, enter = fadeIn(tween(150)), exit = fadeOut(tween(400))) {
        Text(
            stringResource(R.string.stories_camera_hint),
            color = Color.White.copy(alpha = 0.85f),
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(vertical = Spacing.xs).testTag("stories.camera.hint"),
        )
    }
}

/** The ring that lands where a tap asked the lens to focus, then fades. */
@Composable
private fun FocusRing(point: Offset?, onDone: () -> Unit) {
    if (point == null) return
    val density = LocalDensity.current
    val scale = remember(point) { androidx.compose.animation.core.Animatable(1.4f) }
    val alpha = remember(point) { androidx.compose.animation.core.Animatable(1f) }
    LaunchedEffect(point) {
        scale.animateTo(1f, tween(160))
        delay(500)
        alpha.animateTo(0f, tween(250))
        onDone()
    }
    val radius = with(density) { 34.dp.toPx() }
    Box(
        Modifier
            .offset { IntOffset((point.x - radius).roundToInt(), (point.y - radius).roundToInt()) }
            .size(68.dp)
            .scale(scale.value)
            .alpha(alpha.value)
            .border(2.dp, Color.White, CircleShape),
    )
}

/** A blurred still of the lens that was just left, covering the swap. */
@Composable
private fun FrozenFrame(frame: ImageBitmap?) {
    var last by remember { mutableStateOf<ImageBitmap?>(null) }
    if (frame != null) last = frame
    AnimatedVisibility(visible = frame != null, enter = fadeIn(tween(60)), exit = fadeOut(tween(240))) {
        last?.let {
            Box(Modifier.fillMaxSize()) {
                androidx.compose.foundation.Image(
                    bitmap = it,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize().then(if (Build.VERSION.SDK_INT >= 31) Modifier.blur(24.dp) else Modifier),
                )
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)))
            }
        }
    }
}

@Composable
private fun PermissionState(
    canAskAgain: Boolean,
    onAllow: () -> Unit,
    onSettings: () -> Unit,
    onGallery: () -> Unit,
    modifier: Modifier,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
        modifier = modifier
            .padding(horizontal = Spacing.xl)
            .testTag("stories.camera.permission"),
    ) {
        Icon(PqpIcons.Camera, contentDescription = null, tint = Color.White.copy(alpha = 0.8f), modifier = Modifier.size(44.dp))
        Text(
            stringResource(R.string.stories_camera_perm_title),
            color = Color.White,
            style = MaterialTheme.typography.titleLarge,
            textAlign = TextAlign.Center,
        )
        Text(
            stringResource(if (canAskAgain) R.string.stories_camera_perm_body else R.string.stories_camera_perm_settings_hint),
            color = Color.White.copy(alpha = 0.75f),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        Button(
            onClick = if (canAskAgain) onAllow else onSettings,
            shape = MaterialTheme.shapes.small,
            colors = ButtonDefaults.buttonColors(containerColor = Palette.Signal, contentColor = Palette.Ink),
            modifier = Modifier.fillMaxWidth().testTag("stories.camera.permission.primary"),
        ) {
            Text(stringResource(if (canAskAgain) R.string.stories_camera_perm_allow else R.string.stories_camera_perm_settings))
        }
        OutlinedButton(
            onClick = onGallery,
            shape = MaterialTheme.shapes.small,
            border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.45f)),
            modifier = Modifier.fillMaxWidth().testTag("stories.camera.permission.gallery"),
        ) { Text(stringResource(R.string.stories_compose_gallery), color = Color.White) }
    }
}

@Composable
private fun CameraNotice(
    text: String,
    action: String?,
    onAction: () -> Unit,
    onGallery: () -> Unit,
    modifier: Modifier,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
        modifier = modifier
            .padding(horizontal = Spacing.xl)
            .testTag("stories.camera.notice.state"),
    ) {
        Icon(PqpIcons.Camera, contentDescription = null, tint = Color.White.copy(alpha = 0.8f), modifier = Modifier.size(44.dp))
        Text(text, color = Color.White, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
        if (action != null) {
            Button(
                onClick = onAction,
                shape = MaterialTheme.shapes.small,
                colors = ButtonDefaults.buttonColors(containerColor = Palette.Signal, contentColor = Palette.Ink),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(action) }
        }
        OutlinedButton(
            onClick = onGallery,
            shape = MaterialTheme.shapes.small,
            border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.45f)),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.stories_compose_gallery), color = Color.White) }
    }
}

/**
 * The shutter. A tap is a photo. A finger held for [CaptureRules.HOLD_TO_RECORD_MS]
 * starts a clip that runs while it stays down, with a ring filling over 30 s,
 * and sliding up while holding zooms. Releasing ends the clip.
 *
 * A screen reader cannot hold, so the same control offers "take a photo" as its
 * click and "record a video" / "stop recording" as actions.
 */
@Composable
private fun ShutterButton(
    enabled: Boolean,
    recordable: Boolean,
    recording: Boolean,
    progress: Float,
    secondsLeft: Int,
    onTap: () -> Unit,
    onHoldStart: () -> Unit,
    onHoldEnd: () -> Unit,
    onHoldDrag: (upwardPx: Float, travelPx: Float) -> Unit,
    onHoldBegan: () -> Unit,
) {
    val density = LocalDensity.current
    val tap by rememberUpdatedState(onTap)
    val holdStart by rememberUpdatedState(onHoldStart)
    val holdEnd by rememberUpdatedState(onHoldEnd)
    val holdDrag by rememberUpdatedState(onHoldDrag)
    val holdBegan by rememberUpdatedState(onHoldBegan)
    var pressed by remember { mutableStateOf(false) }
    val travelPx = with(density) { 320.dp.toPx() }

    val outerScale by animateFloatAsState(
        if (recording) 1.18f else if (pressed) 0.94f else 1f,
        spring(stiffness = Spring.StiffnessMedium),
        label = "shutterScale",
    )
    val innerSize by animateDpAsState(if (recording) 28.dp else 62.dp, tween(160), label = "shutterInner")
    val innerCorner by animateDpAsState(if (recording) 8.dp else 31.dp, tween(160), label = "shutterCorner")

    val photoLabel = stringResource(R.string.stories_camera_shutter_photo)
    val shutterLabel = stringResource(if (recordable) R.string.stories_camera_shutter else R.string.stories_camera_shutter_photo)
    val recordingLabel = stringResource(R.string.stories_camera_recording, secondsLeft)
    val recordAction = stringResource(R.string.stories_camera_record_action)
    val stopAction = stringResource(R.string.stories_camera_stop_action)

    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(96.dp)
            .scale(outerScale)
            .semantics {
                role = Role.Button
                contentDescription = if (recording) recordingLabel else shutterLabel
                if (recording) stateDescription = recordingLabel
                onClick(label = photoLabel) {
                    if (recording) holdEnd() else tap()
                    true
                }
                if (recordable) {
                    customActions = listOf(
                        CustomAccessibilityAction(if (recording) stopAction else recordAction) {
                            if (recording) holdEnd() else holdStart()
                            true
                        },
                    )
                }
            }
            .testTag("stories.camera.shutter")
            .pointerInput(enabled, recordable) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    pressed = true
                    val released = if (recordable) {
                        withTimeoutOrNull(CaptureRules.HOLD_TO_RECORD_MS) { waitForUpOrCancellation() }
                    } else {
                        waitForUpOrCancellation()
                    }
                    if (released != null || !recordable || !currentEvent.changes.any { it.pressed }) {
                        pressed = false
                        // Up inside the hold window (or no video here): a tap, unless it was cancelled.
                        if (released != null) tap()
                        return@awaitEachGesture
                    }
                    // Still down past the threshold: a recording until the finger lifts.
                    holdBegan()
                    holdStart()
                    val startY = down.position.y
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) {
                            change.consume()
                            break
                        }
                        holdDrag((startY - change.position.y), travelPx)
                        change.consume()
                    }
                    pressed = false
                    holdEnd()
                }
            },
    ) {
        Canvas(Modifier.size(88.dp)) {
            val stroke = 5.dp.toPx()
            val inset = stroke / 2
            val arcSize = Size(size.width - stroke, size.height - stroke)
            drawCircle(
                color = Color.White.copy(alpha = if (recording) 0.35f else 1f),
                radius = (size.minDimension - stroke) / 2,
                style = Stroke(width = stroke),
            )
            if (recording) {
                drawArc(
                    color = Palette.Signal,
                    startAngle = -90f,
                    sweepAngle = 360f * progress,
                    useCenter = false,
                    topLeft = Offset(inset, inset),
                    size = arcSize,
                    style = Stroke(width = stroke, cap = StrokeCap.Round),
                )
            }
        }
        Box(
            Modifier
                .size(innerSize)
                .clip(RoundedCornerShape(innerCorner))
                .background(if (recording) Palette.Danger else Color.White),
        )
    }
}
