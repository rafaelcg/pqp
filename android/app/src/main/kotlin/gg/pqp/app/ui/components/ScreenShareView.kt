package gg.pqp.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import gg.pqp.app.R
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * Somebody else's screen, full bleed.
 *
 * The renderer is a plain Android view because there is no Compose equivalent:
 * WebRTC hands out frames to a `VideoSink` and `SurfaceViewRenderer` is the one
 * that draws them on a surface the GPU already owns.
 *
 * Two lifecycle rules, and getting either wrong is a leak that survives the
 * call. The sink has to come *off* the track before the renderer is released,
 * or a frame arrives at a freed surface. And the renderer has to be released at
 * all: it holds an EGL surface, and a phone that opens and closes a share a few
 * times without this runs out of them.
 *
 * `SCALE_ASPECT_FIT` rather than fill, because this is a screen and not a
 * portrait video: cropping a shared screen to a phone's aspect ratio hides
 * whatever the presenter was pointing at.
 *
 * The frame around it is the design pass's only addition here. Aspect-fit
 * letterboxes, so an unframed share is a black rectangle inside a near-black
 * app, which reads as a hole punched in the page rather than as a thing to
 * look at. A hairline of `outline` and the `medium` radius make it an object.
 * The hairline is drawn by Compose *around* the view rather than by clipping
 * it: a `SurfaceView` composites in its own layer and does not take a Compose
 * clip, so the corners are rounded by the line and by the black behind it.
 */
@Composable
fun RemoteScreenView(
    track: VideoTrack,
    eglContext: EglBase.Context,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val renderer = remember(eglContext) {
        SurfaceViewRenderer(context).apply {
            init(eglContext, null)
            setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            setEnableHardwareScaler(true)
        }
    }

    DisposableEffect(track, renderer) {
        track.addSink(renderer)
        onDispose { runCatching { track.removeSink(renderer) } }
    }

    DisposableEffect(renderer) {
        onDispose { runCatching { renderer.release() } }
    }

    val shape = MaterialTheme.shapes.medium
    Box(
        modifier = modifier
            .clip(shape)
            .background(Color.Black, shape)
            .border(Sizes.hairline, MaterialTheme.colorScheme.outline, shape),
    ) {
        AndroidView(factory = { renderer }, modifier = Modifier.fillMaxSize())
    }
}

/**
 * The viewer, as a full-screen dialog rather than a navigation destination.
 *
 * A share starts and stops on somebody else's schedule, so it cannot be a place
 * in the back stack that outlives it: a route left behind after the presenter
 * stops is a screen with nothing on it and a back button that goes somewhere
 * unexpected. A dialog is dismissed by the same gesture and disappears with the
 * track.
 *
 * The controls are laid over the picture on the safe-area inset, and the
 * presenter's name is a chip rather than white text on black: a name printed
 * straight onto the video disappears the moment the presenter opens something
 * pale.
 */
@Composable
fun ScreenShareDialog(
    track: VideoTrack,
    eglContext: EglBase.Context,
    presenter: String,
    onClose: () -> Unit,
) {
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
        ) {
            RemoteScreenView(
                track = track,
                eglContext = eglContext,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(Spacing.sm),
            )
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainer,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .safeDrawingPadding()
                    .padding(Spacing.lg),
            ) {
                Text(
                    text = presenter,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(
                        horizontal = Spacing.md,
                        vertical = Spacing.sm,
                    ),
                )
            }
            FilledTonalIconButton(
                onClick = onClose,
                colors = IconButtonDefaults.filledTonalIconButtonColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainer,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ),
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .safeDrawingPadding()
                    .padding(Spacing.md),
            ) {
                Icon(
                    imageVector = PqpIcons.ExitFullscreen,
                    contentDescription = stringResource(R.string.voice_close_screen),
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        }
    }
}
