package gg.pqp.app.ui.media

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * A picture over the whole screen, the thing tapping an image opens.
 *
 * Before this file there was no such thing on Android: an image attachment was
 * a cropped frame at most 260dp tall with no click handler, so a tall
 * screenshot or a portrait photo could only ever be seen as its middle strip,
 * and a tap on it did nothing at all. The web has a lightbox and iOS a
 * fullscreen cover for exactly this; this is the same object.
 *
 * In-app rather than an `ACTION_VIEW` hand-off for the reasons
 * [VideoPlayerDialog] gives: the URL is a presigned credential that expires,
 * and a re-mint is something only this process can do.
 *
 * [url] is what the API handed out, absolute or API-relative. [remint] returns
 * a fresh signed URL after the first load failure, or is null for a picture
 * that is not ours to sign (a GIF pasted as a link).
 */
@Composable
fun ImageViewerDialog(
    url: String,
    contentDescription: String?,
    remint: (suspend () -> String?)?,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val retry = remember(url) { RemintOnce(remint) }

    var current by remember(url) { mutableStateOf(url) }
    var loading by remember(url) { mutableStateOf(true) }
    var failed by remember(url) { mutableStateOf(false) }
    var zoom by remember(url) { mutableStateOf(ImageZoom()) }
    // The decoded picture's own size, for the pan bound. Zero until it loads.
    var imageWidth by remember(url) { mutableFloatStateOf(0f) }
    var imageHeight by remember(url) { mutableFloatStateOf(0f) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .testTag("image-viewer")
                .fillMaxSize()
                // Black in both themes, for the same reason the video player is:
                // a picture is framed by its own surround.
                .background(Color.Black)
                .pointerInput(Unit) {
                    detectTapGestures(onDoubleTap = { zoom = zoom.doubleTap() })
                }
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, gestureZoom, _ ->
                        val viewport = size.width.toFloat() to size.height.toFloat()
                        zoom = zoom.transform(
                            zoom = gestureZoom,
                            panX = pan.x,
                            panY = pan.y,
                            viewport = viewport,
                            content = fittedSize(imageWidth, imageHeight, viewport.first, viewport.second),
                        )
                    }
                },
        ) {
            AsyncImage(
                model = Backend.absolute(current),
                contentDescription = contentDescription,
                contentScale = ContentScale.Fit,
                onSuccess = { state ->
                    imageWidth = state.result.image.width.toFloat()
                    imageHeight = state.result.image.height.toFloat()
                    loading = false
                    failed = false
                },
                onError = {
                    scope.launch {
                        val fresh = retry.next()
                        if (fresh == null) {
                            loading = false
                            failed = true
                        } else {
                            current = fresh
                        }
                    }
                },
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = zoom.scale
                        scaleY = zoom.scale
                        translationX = zoom.offsetX
                        translationY = zoom.offsetY
                    },
            )

            if (loading && !failed) {
                CircularProgressIndicator(
                    color = Color.White,
                    modifier = Modifier.align(Alignment.Center),
                )
            }

            if (failed) {
                Text(
                    text = stringResource(R.string.attachment_image_failed),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White,
                    modifier = Modifier
                        .align(Alignment.Center)
                        .padding(Spacing.xl),
                )
            }

            IconButton(
                onClick = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .safeDrawingPadding()
                    .padding(Spacing.sm),
            ) {
                Icon(
                    imageVector = PqpIcons.Close,
                    contentDescription = stringResource(R.string.attachment_video_close),
                    tint = Color.White,
                )
            }
        }
    }
}
