package gg.pqp.app.stories.ui

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import gg.pqp.app.R
import gg.pqp.app.stories.TrimRules
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val THUMBS = 8

/**
 * "Escolhe os 30 segundos": a picked video longer than the story limit, with a
 * 30 s window to slide along a strip of its frames. The clip loops inside the
 * window while it moves, so what is kept is what is heard and seen.
 *
 * The window has a fixed length (30 s, or the whole clip when shorter), so
 * there is one thing to drag, not two handles. Dragging ticks the phone
 * lightly at each end of the clip. A screen reader gets the range as a state
 * and "start 1 second earlier / later" as actions.
 */
@Composable
fun StoryTrimScreen(
    uri: Uri,
    durationMs: Long,
    onConfirm: (startMs: Long, endMs: Long) -> Unit,
    onCancel: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val window = TrimRules.windowMs(durationMs)
    var startMs by remember { mutableLongStateOf(0L) }
    val endMs = startMs + window
    val range = TrimRules.rangeLabel(startMs, endMs)

    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .statusBarsPadding()
                .navigationBarsPadding()
                .testTag("stories.trim"),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(Spacing.sm)) {
                IconButton(onClick = onCancel, modifier = Modifier.testTag("stories.trim.close")) {
                    Icon(PqpIcons.Close, contentDescription = stringResource(R.string.stories_viewer_close), tint = Color.White)
                }
                Text(
                    stringResource(R.string.stories_trim_title),
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
            }

            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = Spacing.gutter),
                contentAlignment = Alignment.Center,
            ) {
                StoryVideoSurface(
                    uri = uri,
                    muted = false,
                    startMs = startMs,
                    endMs = endMs,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(vertical = Spacing.sm),
                )
            }

            Text(
                stringResource(R.string.stories_trim_body, TrimRules.clock(durationMs)),
                color = Color.White.copy(alpha = 0.75f),
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Spacing.xl, vertical = Spacing.sm),
            )

            TrimStrip(
                uri = uri,
                durationMs = durationMs,
                startMs = startMs,
                range = range,
                onStart = { next ->
                    if (next != startMs) {
                        val atEdge = next == 0L || next == TrimRules.clampStart(Long.MAX_VALUE / 2, durationMs)
                        if (atEdge) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                        startMs = next
                    }
                },
                modifier = Modifier.padding(horizontal = Spacing.gutter),
            )

            Text(
                "$range  ·  ${(window / 1000)} s",
                color = Color.White,
                style = MaterialTheme.typography.labelLarge,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = Spacing.sm)
                    .testTag("stories.trim.range"),
            )

            Button(
                onClick = { onConfirm(startMs, endMs) },
                shape = MaterialTheme.shapes.small,
                colors = ButtonDefaults.buttonColors(containerColor = Palette.Signal, contentColor = Palette.Ink),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
                    .testTag("stories.trim.use"),
            ) { Text(stringResource(R.string.stories_trim_use)) }
        }
    }
}

/** The filmstrip with the draggable window over it. */
@Composable
private fun TrimStrip(
    uri: Uri,
    durationMs: Long,
    startMs: Long,
    range: String,
    onStart: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var thumbs by remember(uri) { mutableStateOf<List<ImageBitmap?>>(List(THUMBS) { null }) }
    LaunchedEffect(uri, durationMs) {
        val frames = withContext(Dispatchers.IO) {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(context, uri)
                TrimRules.thumbTimesMs(durationMs, THUMBS).map { at ->
                    runCatching { frameAt(retriever, at) }.getOrNull()?.asImageBitmap()
                }
            } catch (_: Exception) {
                List<ImageBitmap?>(THUMBS) { null }
            } finally {
                runCatching { retriever.release() }
            }
        }
        thumbs = frames
    }

    val density = LocalDensity.current
    val windowLabel = stringResource(R.string.stories_trim_window, range)
    val earlier = stringResource(R.string.stories_trim_earlier)
    val later = stringResource(R.string.stories_trim_later)
    val currentStart by rememberUpdatedState(startMs)

    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .height(68.dp)
            .clip(RoundedCornerShape(8.dp)),
    ) {
        val trackPx = with(density) { maxWidth.toPx() }
        val windowFraction = TrimRules.windowFraction(durationMs)
        val leftPx = TrimRules.startFraction(startMs, durationMs) * trackPx
        val windowPx = windowFraction * trackPx

        Row(Modifier.fillMaxSize()) {
            thumbs.forEach { bitmap ->
                Box(Modifier.weight(1f).fillMaxHeight().background(Palette.SurfaceRaised)) {
                    if (bitmap != null) {
                        Image(
                            bitmap = bitmap,
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
        // Dim what is left out, ring what is kept.
        Canvas(Modifier.fillMaxSize()) {
            val dim = Color.Black.copy(alpha = 0.6f)
            drawRect(dim, Offset.Zero, Size(leftPx, size.height))
            drawRect(dim, Offset(leftPx + windowPx, 0f), Size((size.width - leftPx - windowPx).coerceAtLeast(0f), size.height))
            drawRoundRect(
                Palette.Signal,
                Offset(leftPx, 0f),
                Size(windowPx, size.height),
                CornerRadius(8.dp.toPx()),
                Stroke(width = 3.dp.toPx()),
            )
        }
        // The whole strip is the handle: drag anywhere, or tap to put the window there.
        Box(
            Modifier
                .fillMaxSize()
                .semantics {
                    contentDescription = windowLabel
                    stateDescription = range
                    customActions = listOf(
                        CustomAccessibilityAction(earlier) {
                            onStart(TrimRules.clampStart(currentStart - TrimRules.NUDGE_MS, durationMs))
                            true
                        },
                        CustomAccessibilityAction(later) {
                            onStart(TrimRules.clampStart(currentStart + TrimRules.NUDGE_MS, durationMs))
                            true
                        },
                    )
                }
                .testTag("stories.trim.strip")
                .pointerInput(durationMs, trackPx) {
                    detectHorizontalDragGestures { change, dragAmount ->
                        change.consume()
                        onStart(TrimRules.startAfterDrag(currentStart, dragAmount, trackPx, durationMs))
                    }
                }
                .pointerInput(durationMs, trackPx) {
                    detectTapGestures { at ->
                        val centre = (at.x / trackPx * durationMs).toLong()
                        onStart(TrimRules.clampStart(centre - TrimRules.windowMs(durationMs) / 2, durationMs))
                    }
                },
        )
    }
}

private const val THUMB_EDGE = 160

private fun frameAt(retriever: MediaMetadataRetriever, atMs: Long): Bitmap? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        retriever.getScaledFrameAtTime(atMs * 1000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, THUMB_EDGE, THUMB_EDGE)
    } else {
        // API 26 has no scaled read: the frame comes back at the video's own size
        // (a 4K clip is 33 MB a frame, and the strip holds eight), so shrink it
        // here and let the full one go before the next is read.
        retriever.getFrameAtTime(atMs * 1000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)?.let { full ->
            val long = maxOf(full.width, full.height)
            if (long <= THUMB_EDGE) {
                full
            } else {
                val ratio = THUMB_EDGE.toFloat() / long
                Bitmap.createScaledBitmap(
                    full,
                    maxOf(1, (full.width * ratio).toInt()),
                    maxOf(1, (full.height * ratio).toInt()),
                    true,
                ).also { if (it !== full) full.recycle() }
            }
        }
    }

/** The "getting your video ready" card shown while Media3 cuts and shrinks. */
@Composable
fun StoryVideoWorking(progress: Float, onCancel: () -> Unit) {
    Dialog(
        onDismissRequest = {},
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = false, dismissOnClickOutside = false),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Spacing.md),
            modifier = Modifier
                .clip(MaterialTheme.shapes.medium)
                .background(Palette.SurfaceRaised)
                .padding(Spacing.xl)
                .width(260.dp)
                .testTag("stories.trim.working"),
        ) {
            Box(contentAlignment = Alignment.Center) {
                CircularProgressIndicator(
                    progress = { progress.coerceIn(0f, 1f) },
                    color = Palette.Signal,
                    trackColor = Color.White.copy(alpha = 0.15f),
                    modifier = Modifier.size(56.dp),
                )
            }
            Text(
                stringResource(R.string.stories_trim_working),
                color = Color.White,
                style = MaterialTheme.typography.titleSmall,
                textAlign = TextAlign.Center,
            )
            Text(
                stringResource(R.string.stories_trim_progress, (progress.coerceIn(0f, 1f) * 100).toInt()),
                color = Color.White.copy(alpha = 0.75f),
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(
                onClick = onCancel,
                shape = MaterialTheme.shapes.small,
                border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.45f)),
                modifier = Modifier.testTag("stories.trim.cancel"),
            ) { Text(stringResource(R.string.cancel), color = Color.White) }
        }
    }
}
