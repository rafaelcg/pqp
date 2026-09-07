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
import gg.pqp.app.voice.RemoteVideoFeed

/**
 * Somebody else's video, full bleed, from whichever transport it came over.
 *
 * The renderer is a plain Android view because there is no Compose equivalent:
 * WebRTC hands out frames to a `VideoSink` and a `SurfaceViewRenderer` is the
 * one that draws them on a surface the GPU already owns.
 *
 * Two renderers, not one, and the `when` is the point. The mesh decodes into
 * `org.webrtc` and LiveKit into `livekit.org.webrtc`, two unrelated libwebrtc
 * builds in this process, each with its own GL context. A renderer initialised
 * on one cannot draw the other's frames; it compiles and fails at the first
 * frame. [RemoteVideoFeed] is sealed so the compiler picks the renderer here.
 *
 * Two lifecycle rules, and getting either wrong is a leak that survives the
 * call. The sink has to come *off* the track before the renderer is released,
 * or a frame arrives at a freed surface. And the renderer has to be released at
 * all: it holds an EGL surface, and a phone that opens and closes a share a few
 * times without this runs out of them.
 *
 * **Fit or fill, and it depends on what the picture is.** A shared screen is
 * always `SCALE_ASPECT_FIT`: cropping one to a phone's aspect ratio hides
 * whatever the presenter was pointing at, and the letterboxing is the price. A
 * camera tile is the opposite case, `fill = true`: it is a face in a small
 * fixed rectangle, nobody is reading its corners, and fitting a 16:9 camera
 * into a 4:3 tile would draw two black bars and a face half the size it could
 * be. The camera *viewer* fits again, because at full screen the bars cost
 * nothing and cropping somebody out of their own frame is worse.
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
fun RemoteVideoView(
    feed: RemoteVideoFeed,
    modifier: Modifier = Modifier,
    fill: Boolean = false,
) {
    val shape = MaterialTheme.shapes.medium
    Box(
        modifier = modifier
            .clip(shape)
            .background(Color.Black, shape)
            .border(Sizes.hairline, MaterialTheme.colorScheme.outline, shape),
    ) {
        when (feed) {
            is RemoteVideoFeed.Mesh -> MeshVideoRenderer(feed, fill, Modifier.fillMaxSize())
            is RemoteVideoFeed.LiveKit -> LiveKitVideoRenderer(feed, fill, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun MeshVideoRenderer(feed: RemoteVideoFeed.Mesh, fill: Boolean, modifier: Modifier) {
    val context = LocalContext.current
    val renderer = remember(feed.eglContext) {
        org.webrtc.SurfaceViewRenderer(context).apply {
            init(feed.eglContext, null)
            setEnableHardwareScaler(true)
        }
    }

    DisposableEffect(feed.track, renderer) {
        feed.track.addSink(renderer)
        onDispose { runCatching { feed.track.removeSink(renderer) } }
    }

    DisposableEffect(renderer) {
        onDispose { runCatching { renderer.release() } }
    }

    // Scaling in `update`, not in `remember`, so a tile that becomes the viewer
    // keeps its renderer and only changes how it draws. Rebuilding it on `fill`
    // would release an EGL surface and take a live picture with it mid-tap.
    AndroidView(
        factory = { renderer },
        modifier = modifier,
        update = {
            it.setScalingType(
                if (fill) {
                    org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FILL
                } else {
                    org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FIT
                },
            )
        },
    )
}

/**
 * LiveKit's own `SurfaceViewRenderer`, initialised by the room.
 *
 * `Room.initVideoRenderer` is the only way to get the SFU's GL context: it
 * belongs to LiveKit's libwebrtc and is not exposed on its own. It also sets
 * the scaling type and the hardware scaler, which this then overrides for the
 * same reason the mesh renderer does.
 *
 * Attached with `addRenderer` rather than `addSink`, because that is the API
 * on a `RemoteVideoTrack` and it is what keeps the track's own sink list
 * right. What layer arrives, and whether anything arrives at all, is decided
 * by [gg.pqp.app.voice.LiveKitEngine] rather than by this view: the SDK's
 * view-measuring path is deliberately off there, so a camera keeps flowing
 * for as long as the composable that asked for it is alive, and no longer.
 */
@Composable
private fun LiveKitVideoRenderer(feed: RemoteVideoFeed.LiveKit, fill: Boolean, modifier: Modifier) {
    val context = LocalContext.current
    val renderer = remember(feed.room) {
        io.livekit.android.renderer.SurfaceViewRenderer(context).apply {
            feed.room.initVideoRenderer(this)
            setEnableHardwareScaler(true)
        }
    }

    DisposableEffect(feed.track, renderer) {
        feed.track.addRenderer(renderer)
        onDispose { runCatching { feed.track.removeRenderer(renderer) } }
    }

    DisposableEffect(renderer) {
        onDispose { runCatching { renderer.release() } }
    }

    AndroidView(
        factory = { renderer },
        modifier = modifier,
        update = {
            it.setScalingType(
                if (fill) {
                    livekit.org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FILL
                } else {
                    livekit.org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FIT
                },
            )
        },
    )
}

/**
 * The viewer, as a full-screen dialog rather than a navigation destination.
 *
 * One dialog for both kinds of video: a share opened from the Watch row and a
 * camera opened from the strip. What differs is [fill] and the label, and
 * neither is worth a second copy of the lifecycle rules above.
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
fun RemoteVideoDialog(
    feed: RemoteVideoFeed,
    name: String,
    onClose: () -> Unit,
    closeLabel: String = stringResource(R.string.voice_close_screen),
    fill: Boolean = false,
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
            RemoteVideoView(
                feed = feed,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(Spacing.sm),
                fill = fill,
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
                    text = name,
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
                    contentDescription = closeLabel,
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        }
    }
}
