package gg.pqp.app.bau.ui

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

/**
 * An uploaded Baú video, played in the card, full screen on demand.
 *
 * ## What it does
 *
 *  - **Inline.** Tap the card and it plays where it sits, with the system
 *    controls. Nothing plays until the tap (a feed that makes noise on scroll
 *    is what the web's `preload="none"` avoids).
 *  - **Full screen.** The player's own button opens an immersive full screen
 *    over the same [ExoPlayer], so playback carries on from where it was, and
 *    turns the phone to landscape while it is up ([fullscreenOrientation]).
 *  - **Picture in Picture.** Leaving the app (Home, recents) while the full
 *    screen is playing shrinks the app to a PiP window that shows only the
 *    video. See [BauPip].
 *  - **One at a time.** There is one player. Starting another video releases
 *    the first.
 *
 * ## What it deliberately does not do: PiP from the inline card
 *
 * Android has no Picture in Picture for one view. It is the whole activity
 * that shrinks, so a PiP started from the feed would be a postage stamp of the
 * feed. The video has to be the only thing the window shows, which is what the
 * full screen is. So scrolling an inline card away PAUSES it (the position is
 * kept, the card shows its controls when it comes back), rather than keeping
 * playing something nobody can see. Leaving the Baú altogether releases the
 * player.
 *
 * ## Audio in a call
 *
 * See [BauPlaybackPolicy.handleAudioFocus]: during a call the player does not
 * ask for audio focus, so it cannot take focus away from the call. It mixes in.
 *
 * The player takes a URL, not a post: a caller passes whichever rendition it
 * picked.
 */
internal val LocalBauCallActive = compositionLocalOf { false }

// ---------------------------------------------------------------------------
// Decisions, pure so they are tested without a device
// ---------------------------------------------------------------------------

internal object BauPlaybackPolicy {
    /**
     * Media focus is requested only OUTSIDE a call. The voice stack holds
     * focus with `USAGE_VOICE_COMMUNICATION`; a second `AUDIOFOCUS_GAIN`
     * request on top of it can make the call's audio pause or duck, which is
     * exactly the failure to avoid (the iOS twin leaves the audio session
     * alone for the same reason). Without focus the clip simply plays through
     * the output the call is already using. Outside a call, focus is wanted:
     * it is what pauses the clip for an incoming call and ducks music.
     */
    fun handleAudioFocus(callActive: Boolean): Boolean = !callActive

    /**
     * Whether leaving the app should enter Picture in Picture: only from the
     * full screen (the video is then the whole window) and only while it is
     * actually playing and the device can do it.
     */
    fun pipArmed(fullscreen: Boolean, playing: Boolean, supported: Boolean): Boolean =
        fullscreen && playing && supported

    /** Whether an inline card that left the screen should pause. */
    fun pauseWhenScrolledAway(fullscreen: Boolean, playing: Boolean): Boolean =
        playing && !fullscreen

    /** Whether the activity should pause on stop: not when it is a PiP window. */
    fun pauseOnStop(inPictureInPicture: Boolean): Boolean = !inPictureInPicture
}

/**
 * Landscape for anything wider than tall (and for a video whose size is not
 * known yet), the sensor for a portrait one: a vertical clip forced sideways
 * is a postage stamp, and a later portrait rendition is exactly that.
 */
internal fun fullscreenOrientation(width: Int, height: Int): Int =
    if (width > 0 && height > width) {
        ActivityInfo.SCREEN_ORIENTATION_FULL_USER
    } else {
        ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

/** Which video holds the floor; a second one displaces the first. */
internal class BauActivePlayer {
    var current: String? = null
        private set

    /** Returns whoever was displaced, if anyone. */
    fun claim(key: String): String? {
        val displaced = current?.takeIf { it != key }
        current = key
        return displaced
    }

    fun release(key: String) {
        if (current == key) current = null
    }
}

// ---------------------------------------------------------------------------
// The player and Picture in Picture state
// ---------------------------------------------------------------------------

/** The one player, and which card it belongs to. */
internal object BauPlayback {
    private val floor = BauActivePlayer()

    /** The card whose video is loaded; Compose reads it to swap badge for player. */
    var activeKey by mutableStateOf<String?>(null)
        private set
    var failedKey by mutableStateOf<String?>(null)
        private set
    var player: ExoPlayer? = null
        private set
    var videoSize by mutableStateOf(VideoSize.UNKNOWN)
        private set

    fun play(context: Context, key: String, url: String, callActive: Boolean) {
        floor.claim(key)?.let { releasePlayer() }
        if (player != null) return
        failedKey = null
        val exo = ExoPlayer.Builder(context.applicationContext).build().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                BauPlaybackPolicy.handleAudioFocus(callActive),
            )
            setMediaItem(MediaItem.fromUri(Backend.absolute(url).orEmpty()))
            playWhenReady = true
            addListener(object : Player.Listener {
                override fun onPlayerError(error: PlaybackException) {
                    // The feed re-signs on reload; a failed clip says so and
                    // the card offers the open-out fallback.
                    BauPlayback.failedKey = key
                }

                override fun onVideoSizeChanged(size: VideoSize) {
                    BauPlayback.videoSize = size
                }
            })
            prepare()
        }
        player = exo
        activeKey = key
    }

    /** Pause, keeping the position and the card. */
    fun pause() {
        player?.pause()
    }

    /** Release the player and put the card back to its badge. */
    fun stop(key: String? = null) {
        if (key != null && activeKey != key) return
        activeKey?.let { floor.release(it) }
        releasePlayer()
    }

    private fun releasePlayer() {
        player?.let {
            // Both, in this order: a codec that outlives its card is a leak.
            it.stop()
            it.release()
        }
        player = null
        activeKey = null
        failedKey = null
        videoSize = VideoSize.UNKNOWN
    }
}

/**
 * Picture in Picture for the activity, armed only while the full screen
 * video plays. `MainActivity` declares `supportsPictureInPicture` and asks
 * this object in `onUserLeaveHint`; nothing else in the app enters PiP, so
 * the declaration changes nothing for any other screen (there is no call PiP
 * to disturb: the call UI is a bar inside the activity).
 */
object BauPip {
    @Volatile
    var armed: Boolean = false

    var inPip by mutableStateOf(false)

    fun supported(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    fun params(aspect: Rational?): PictureInPictureParams = PictureInPictureParams.Builder()
        .apply { aspect?.let { setAspectRatio(it) } }
        .build()

    /** Called by `MainActivity.onUserLeaveHint`. Android 12+ enters by itself. */
    fun onUserLeaveHint(activity: Activity) {
        if (!armed || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
        if (!supported(activity)) return
        runCatching { activity.enterPictureInPictureMode(params(aspectOf(BauPlayback.videoSize))) }
    }

    internal fun aspectOf(size: VideoSize): Rational? =
        aspectRatio(size.width, size.height).let { (n, d) -> Rational(n, d) }

    /** Numerator and denominator, clamped to what the system accepts. */
    internal fun aspectRatio(width: Int, height: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 16 to 9
        // PiP refuses ratios beyond roughly 2.39:1 and 1:2.39.
        val ratio = width.toDouble() / height
        return when {
            ratio > 2.39 -> 239 to 100
            ratio < 1 / 2.39 -> 100 to 239
            else -> width to height
        }
    }
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** The card while its video is loaded: inline controls, full screen button. */
@OptIn(UnstableApi::class)
@Composable
internal fun BauActiveVideo(
    key: String,
    open: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val player = BauPlayback.player
    var fullscreen by remember(key) { mutableStateOf(false) }
    val fullscreenNow by rememberUpdatedState(fullscreen)
    val failed = BauPlayback.failedKey == key

    // The card left the screen. Pause where it stopped, unless the full screen
    // is what is showing (it is a child of this composable, so reaching here
    // while it is up means the screen is going away altogether).
    DisposableEffect(key) {
        onDispose {
            val exo = BauPlayback.player
            if (exo != null && BauPlaybackPolicy.pauseWhenScrolledAway(fullscreenNow, exo.isPlaying)) {
                BauPlayback.pause()
            }
        }
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(MaterialTheme.shapes.medium)
            .background(Color.Black)
            .testTag("bau.media.video.active"),
    ) {
        if (player != null && !fullscreen) {
            AndroidView(
                factory = { viewContext ->
                    PlayerView(viewContext).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        useController = true
                        setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                        // Shows the full screen button; tapping it hands the
                        // same player to the immersive dialog below.
                        setFullscreenButtonClickListener { fullscreen = true }
                    }
                },
                update = { view -> view.player = player },
                onRelease = { view -> view.player = null },
                modifier = Modifier.fillMaxSize(),
            )
        }

        if (failed) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clickable(role = Role.Button, onClick = open),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(R.string.attachment_video_failed),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White,
                    modifier = Modifier.padding(Spacing.xl),
                )
            }
        }
    }

    if (fullscreen && player != null) {
        BauFullscreen(player = player, onExit = { fullscreen = false })
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun BauFullscreen(player: ExoPlayer, onExit: () -> Unit) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    var playing by remember { mutableStateOf(player.isPlaying) }
    val size = BauPlayback.videoSize
    val callbackPlaying = rememberUpdatedState(playing)

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener) }
    }

    // Landscape while it is up, whatever the app does the rest of the time.
    DisposableEffect(activity, size.width > size.height) {
        val previous = activity?.requestedOrientation
        activity?.requestedOrientation = fullscreenOrientation(size.width, size.height)
        onDispose {
            if (previous != null) activity.requestedOrientation = previous
        }
    }

    // Leaving the app while it plays: Picture in Picture.
    val armed = BauPlaybackPolicy.pipArmed(
        fullscreen = true,
        playing = callbackPlaying.value,
        supported = BauPip.supported(context),
    )
    DisposableEffect(activity, armed, size) {
        BauPip.armed = armed
        if (activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching {
                activity.setPictureInPictureParams(
                    PictureInPictureParams.Builder()
                        .setAspectRatio(BauPip.aspectOf(size))
                        .setAutoEnterEnabled(armed)
                        .build(),
                )
            }
        }
        onDispose {
            BauPip.armed = false
            if (activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                runCatching {
                    activity.setPictureInPictureParams(
                        PictureInPictureParams.Builder().setAutoEnterEnabled(false).build(),
                    )
                }
            }
        }
    }

    // Backgrounding pauses, except into a PiP window, which is the point.
    // Closing that window stops the activity, and then it does pause.
    LifecycleStartEffect(player) {
        onStopOrDispose {
            if (BauPlaybackPolicy.pauseOnStop(activity?.isInPictureInPictureMode == true)) {
                player.pause()
            }
        }
    }

    Dialog(
        onDismissRequest = onExit,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        ImmersiveWindow()
        val inPip = BauPip.inPip
        Box(
            modifier = Modifier
                .testTag("video-player")
                .fillMaxSize()
                .background(Color.Black),
        ) {
            AndroidView(
                factory = { viewContext ->
                    PlayerView(viewContext).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        useController = true
                        setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                        keepScreenOn = true
                        setFullscreenButtonState(true)
                        setFullscreenButtonClickListener { onExit() }
                    }
                },
                update = { view ->
                    view.player = player
                    // A PiP window is too small for controls.
                    view.useController = !inPip
                },
                onRelease = { view -> view.player = null },
                modifier = Modifier.fillMaxSize(),
            )

            if (!inPip) {
                IconButton(
                    onClick = onExit,
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
}

/** Hide the system bars of the dialog's window; a swipe brings them back. */
@Composable
private fun ImmersiveWindow() {
    val view = LocalView.current
    DisposableEffect(view) {
        val window = (view.parent as? DialogWindowProvider)?.window
        if (window != null) {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            WindowInsetsControllerCompat(window, view).apply {
                systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
        }
        onDispose {
            if (window != null) {
                WindowInsetsControllerCompat(window, view).show(WindowInsetsCompat.Type.systemBars())
            }
        }
    }
}

private fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}
