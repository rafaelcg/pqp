package gg.pqp.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.voice.CameraRailEntry
import gg.pqp.app.voice.CameraSurface
import gg.pqp.app.voice.RemoteVideoFeed
import gg.pqp.app.voice.VoiceController
import gg.pqp.app.voice.VoiceState
import gg.pqp.app.voice.cameraRailEntries

/**
 * The faces in the call, as a strip along the bottom of the call bar.
 *
 * **Why a strip and not a row of "Ana turned her camera on" lines.** The Watch
 * row above this is a line per presenter because opening a screen share is a
 * decision: it takes the whole phone and interrupts whatever is on it. A camera
 * is the opposite. There can be a dozen at once, nobody wants a dozen lines,
 * and the thing a person actually wants from a camera is to *see* it, which a
 * sentence about it cannot do. So the picture is the affordance: the strip
 * appears when somebody turns a camera on and shows their face, and a tap on a
 * face makes it full screen. Nothing has to be explained.
 *
 * **Why it lives on the call bar.** A call outlives the screen that started it,
 * and so do the cameras in it. Putting the strip anywhere else would mean
 * somebody reading a channel next door has no idea anyone is on camera, which
 * is exactly what the phone looked like during the 5 Sep watch party.
 *
 * **The strip is also the bandwidth rule.** Each tile tells the transport it is
 * drawing that camera for exactly as long as it is composed and the app is
 * started ([LifecycleStartEffect]), and the SFU stops sending the ones nobody
 * has on screen. A `LazyRow` composes what fits and no more, so scrolling to a
 * face is what starts paying for it and scrolling away is what stops. See
 * [gg.pqp.app.voice.CameraDemand].
 */
@Composable
fun CameraRail(
    state: VoiceState,
    controller: VoiceController,
    modifier: Modifier = Modifier,
) {
    val cameras by controller.remoteCameras.collectAsStateWithLifecycle()
    val entries = cameraRailEntries(
        participants = state.participants,
        cameraPeerIds = cameras.keys,
        localPeerId = state.localPeerId,
    )
    var openPeerId by remember { mutableStateOf<String?>(null) }

    AnimatedVisibility(
        visible = entries.isNotEmpty(),
        enter = expandVertically(),
        exit = shrinkVertically(),
        modifier = modifier,
    ) {
        LazyRow(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = Spacing.sm),
            contentPadding = PaddingValues(horizontal = Spacing.gutter),
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            items(entries, key = { it.peerId }) { entry ->
                // The feed can go while the entry is still in this frame's
                // list: the peer's camera and the roster arrive over different
                // connections. Drawing nothing for that beat is right; the
                // recomposition that follows drops the tile.
                cameras[entry.peerId]?.let { feed ->
                    CameraTile(
                        entry = entry,
                        feed = feed,
                        controller = controller,
                        onOpen = { openPeerId = entry.peerId },
                    )
                }
            }
        }
    }

    val open = entries.firstOrNull { it.peerId == openPeerId }
    val openFeed = open?.let { cameras[it.peerId] }

    // They turned the camera off, or left, while the viewer was open. Closed
    // from an effect rather than from composition, because writing state while
    // composing is how a recomposition loop starts.
    LaunchedEffect(openFeed) {
        if (openFeed == null) openPeerId = null
    }

    if (open != null && openFeed != null) {
        val name = open.displayName ?: stringResource(R.string.voice_camera_someone)
        // The viewer's own claim on the camera, on top of the tile's: the tile
        // behind the dialog is still composed, so this is what raises the layer
        // while it is open and lowers it again when it closes, without the
        // close pausing a picture that is still on screen underneath.
        LifecycleStartEffect(open.peerId, controller) {
            controller.setCameraViewer(open.peerId, CameraSurface.Fullscreen, true)
            onStopOrDispose {
                controller.setCameraViewer(open.peerId, CameraSurface.Fullscreen, false)
            }
        }
        RemoteVideoDialog(
            feed = openFeed,
            name = name,
            onClose = { openPeerId = null },
            closeLabel = stringResource(R.string.voice_camera_close),
        )
    }
}

/**
 * One face.
 *
 * The name sits on a scrim rather than straight on the picture, for the reason
 * the share viewer's name chip does: white text on a camera disappears the
 * moment somebody stands in front of a window.
 *
 * [LifecycleStartEffect] rather than `DisposableEffect`, and that is the
 * difference between a phone in a pocket paying for six cameras and not. A
 * composition survives the app going to the background; the started state does
 * not. Both ends matter: the bind resumes delivery when the person comes back,
 * within one signalling round trip.
 */
@Composable
private fun CameraTile(
    entry: CameraRailEntry,
    feed: RemoteVideoFeed,
    controller: VoiceController,
    onOpen: () -> Unit,
) {
    val name = entry.displayName ?: stringResource(R.string.voice_camera_someone)
    val label = stringResource(R.string.voice_camera_of, name)

    LifecycleStartEffect(entry.peerId, controller) {
        controller.setCameraViewer(entry.peerId, CameraSurface.Tile, true)
        onStopOrDispose {
            controller.setCameraViewer(entry.peerId, CameraSurface.Tile, false)
        }
    }

    Box(
        modifier = Modifier
            .size(width = Sizes.cameraTileWidth, height = Sizes.cameraTileHeight)
            .clip(MaterialTheme.shapes.medium)
            .clickable(onClick = onOpen)
            .semantics { contentDescription = label },
    ) {
        RemoteVideoView(
            feed = feed,
            modifier = Modifier.fillMaxSize(),
            fill = true,
        )
        Text(
            text = name,
            style = MaterialTheme.typography.labelSmall,
            color = Color.White,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .background(SCRIM)
                .padding(horizontal = Spacing.xs, vertical = 2.dp),
        )
    }
}

/** Enough to hold a name over a bright frame, not enough to be a bar. */
private val SCRIM = Color.Black.copy(alpha = 0.45f)
