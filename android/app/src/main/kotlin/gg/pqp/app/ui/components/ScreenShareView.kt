package gg.pqp.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import gg.pqp.app.R
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

    AndroidView(factory = { renderer }, modifier = modifier)
}

/**
 * The viewer, as a full-screen dialog rather than a navigation destination.
 *
 * A share starts and stops on somebody else's schedule, so it cannot be a place
 * in the back stack that outlives it: a route left behind after the presenter
 * stops is a screen with nothing on it and a back button that goes somewhere
 * unexpected. A dialog is dismissed by the same gesture and disappears with the
 * track.
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
                modifier = Modifier.fillMaxSize(),
            )
            Text(
                text = presenter,
                color = Color.White,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .safeDrawingPadding()
                    .padding(16.dp),
            )
            FilledTonalIconButton(
                onClick = onClose,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .safeDrawingPadding()
                    .padding(12.dp),
            ) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = stringResource(R.string.voice_close_screen),
                )
            }
        }
    }
}
