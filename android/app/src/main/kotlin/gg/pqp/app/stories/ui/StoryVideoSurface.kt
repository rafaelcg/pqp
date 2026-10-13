package gg.pqp.app.stories.ui

import android.net.Uri
import androidx.annotation.OptIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay

/**
 * A local clip playing on a loop, for the composer's preview and the trim
 * screen. One player for as long as the composable lives; it pauses when the
 * screen stops and does not take audio focus (a call may be running behind
 * the composer, and a preview must not talk over it).
 *
 * [startMs] / [endMs] loop one stretch of the clip, which is what the trim
 * screen needs: the player seeks back to [startMs] when it reaches [endMs]. The
 * loop is a poll on the player's position, not an animation, so it runs the
 * same with "Remove animations" on.
 */
@OptIn(UnstableApi::class)
@Composable
fun StoryVideoSurface(
    uri: Uri,
    muted: Boolean,
    modifier: Modifier = Modifier,
    startMs: Long = 0L,
    endMs: Long? = null,
    fill: Boolean = false,
) {
    val context = LocalContext.current
    val exo = remember(uri) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(uri))
            repeatMode = Player.REPEAT_MODE_ONE
            playWhenReady = true
            prepare()
        }
    }
    DisposableEffect(exo) { onDispose { exo.release() } }
    LifecycleStartEffect(exo) {
        exo.play()
        onStopOrDispose { exo.pause() }
    }
    LaunchedEffect(exo, muted) { exo.volume = if (muted) 0f else 1f }

    val start by rememberUpdatedState(startMs)
    val end by rememberUpdatedState(endMs)
    LaunchedEffect(exo, startMs) { exo.seekTo(startMs) }
    LaunchedEffect(exo, endMs) {
        if (endMs == null) return@LaunchedEffect
        while (true) {
            val limit = end ?: break
            if (exo.currentPosition >= limit || exo.currentPosition < start - 500) exo.seekTo(start)
            delay(80)
        }
    }

    AndroidView(
        factory = { viewContext ->
            PlayerView(viewContext).apply {
                useController = false
                setShutterBackgroundColor(android.graphics.Color.TRANSPARENT)
                this.player = exo
            }
        },
        update = {
            it.player = exo
            it.resizeMode = if (fill) AspectRatioFrameLayout.RESIZE_MODE_ZOOM else AspectRatioFrameLayout.RESIZE_MODE_FIT
        },
        modifier = modifier,
    )
}
