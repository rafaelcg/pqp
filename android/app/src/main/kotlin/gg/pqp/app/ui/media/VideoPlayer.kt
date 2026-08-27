package gg.pqp.app.ui.media

import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import gg.pqp.app.R
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.Attachment
import gg.pqp.app.core.Backend
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * The only thing in this app that can play a video.
 *
 * Before this file there was no player of any kind in the module: no Media3, no
 * ExoPlayer, no `VideoView`, no `MediaPlayer`. A `video/mp4` attachment fell
 * through the image branch into the download chip, so the honest description of
 * what was wrong is not that video playback was broken, it is that it had never
 * been written.
 *
 * ## Why in-app, and not a hand-off to the system player
 *
 * The cheap version of this feature is `ACTION_VIEW` with the attachment URL
 * and a video MIME type, and several chat apps do exactly that. It does not
 * work here, for two reasons that are both about how this server serves
 * bytes:
 *
 *  1. **The read URL is signed with `Content-Disposition: attachment`.**
 *     `toPublicAttachment` in `server/src/services/attachments.ts` signs every
 *     non-image that way on purpose, so that nothing user-uploaded can ever be
 *     a top-level document in the bucket's origin. Handed that URL, a good
 *     number of Android video handlers download the file instead of streaming
 *     it, which is a silent trip through the notification shade rather than a
 *     video playing.
 *  2. **The URL expires.** It is presigned with a TTL measured in hours. Giving
 *     a *different app* a credential that dies is how you get a bug report
 *     saying "it worked yesterday".
 *
 * Playing it here sidesteps both: ExoPlayer streams over HTTP and does not care
 * what `Content-Disposition` says, and an expiry is something this process can
 * fix, which is what the re-mint in the error listener below does.
 *
 * ## Why one player over the whole screen, and not a player in the row
 *
 * The web renders an inline `<video>` per attachment and gets away with it
 * because the browser owns the decoders and reclaims them. On Android an
 * `ExoPlayer` per row means a `MediaCodec` instance, a surface and a buffer per
 * visible video, recycled by a `LazyColumn` that was not built to think about
 * any of that, all bidding for the same audio focus as a voice call that may be
 * running behind this screen. One player, alive only while this dialog is, is
 * the version that can be reasoned about.
 */
// `androidx.annotation.OptIn`, not Kotlin's. Media3's `@UnstableApi` is a
// Java annotation enforced by a lint check rather than a Kotlin
// `@RequiresOptIn`, so `kotlin.OptIn` compiles to nothing here and lint
// fails the release build anyway. `checkReleaseBuilds = true` in
// app/build.gradle.kts is what would have found that, days later.
@OptIn(UnstableApi::class)
@Composable
fun VideoPlayerDialog(
    attachment: Attachment,
    api: ApiClient,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var failed by remember { mutableStateOf(false) }

    val player = remember(attachment.id) {
        ExoPlayer.Builder(context).build().apply {
            // `handleAudioFocus = true` is what makes this behave in a call.
            // Voice holds focus with `USAGE_VOICE_COMMUNICATION`; asking for
            // media focus underneath it either ducks this or refuses it, and
            // either is better than a clip talking over the person on the
            // other end. It is also what pauses playback for an incoming call
            // rather than playing to nobody.
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            setMediaItem(MediaItem.fromUri(Backend.absolute(attachment.url).orEmpty()))
            playWhenReady = true
            prepare()
        }
    }

    DisposableEffect(player) {
        /**
         * One re-mint, then stop.
         *
         * The same bound the web puts on the same failure: a presigned URL can
         * expire while a channel sits open, and the first playback error is a
         * better signal that it has than any clock on the device. A second
         * failure is a real failure, and retrying it forever would be a loop
         * against somebody's data plan.
         */
        var retried = false

        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                if (retried) {
                    failed = true
                    return
                }
                retried = true
                scope.launch {
                    val fresh = runCatching { api.attachmentUrl(attachment.id) }.getOrNull()
                    if (fresh == null) {
                        failed = true
                        return@launch
                    }
                    player.setMediaItem(MediaItem.fromUri(Backend.absolute(fresh).orEmpty()))
                    player.prepare()
                    player.playWhenReady = true
                }
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) failed = false
            }
        }
        player.addListener(listener)

        onDispose {
            player.removeListener(listener)
            // Both, and in this order. `release()` alone leaves the codec to be
            // reclaimed whenever, and a MediaCodec that outlives its dialog is
            // exactly the leak this file exists to avoid.
            player.stop()
            player.release()
        }
    }

    // Backgrounding pauses. A video that keeps playing audio from a dialog
    // nobody can see is the behaviour every player is judged for, and the
    // foreground-service exemption this app holds is for a *call*, not for a
    // clip.
    LifecycleStartEffect(player) {
        onStopOrDispose { player.pause() }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            // The whole screen, not a card in the middle of one.
            usePlatformDefaultWidth = false,
        ),
    ) {
        Box(
            modifier = Modifier
                .testTag("video-player")
                .fillMaxSize()
                // Black, always, in both themes. A video is letterboxed against
                // its own surround and a light grey one turns every dark frame
                // into a grey rectangle with a picture floating in it.
                .background(Color.Black),
        ) {
            AndroidView(
                factory = { viewContext ->
                    PlayerView(viewContext).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        // Transport controls, seek bar and timings, drawn by
                        // the platform. Reinventing them would be a worse
                        // version of a solved thing.
                        useController = true
                        setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                        // The screen must not dim halfway through a clip.
                        // PlayerView tracks playback state to decide this, so
                        // it is not simply held on for the life of the dialog.
                        keepScreenOn = true
                    }
                },
                update = { view -> view.player = player },
                onRelease = { view -> view.player = null },
                modifier = Modifier.fillMaxSize(),
            )

            if (failed) {
                Text(
                    text = stringResource(R.string.attachment_video_failed),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier
                        .align(Alignment.Center)
                        .padding(Spacing.xl),
                )
            }

            IconButton(
                onClick = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    // The one place in this file that reasons about insets: a
                    // dialog that fills the screen puts its close button under
                    // the status bar otherwise.
                    .safeDrawingPadding()
                    .padding(Spacing.sm),
            ) {
                Icon(
                    imageVector = PqpIcons.Close,
                    contentDescription = stringResource(R.string.attachment_video_close),
                    // Against black, in both themes, so it cannot take the
                    // scheme's dark-on-light foreground.
                    tint = Color.White,
                )
            }
        }
    }
}
