package gg.pqp.app.watch.ui

import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsManifest
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView
import gg.pqp.app.R
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.watch.ChannelLive
import gg.pqp.app.watch.HlsLiveEdge
import gg.pqp.app.watch.HlsWatchdog
import gg.pqp.app.watch.LiveStream
import gg.pqp.app.watch.WatchPhase
import gg.pqp.app.watch.WATCH_TOKEN_RENEWAL_MS
import gg.pqp.app.watch.WatchdogDecision
import gg.pqp.app.watch.watchPhaseOf
import gg.pqp.app.watch.watchSourceChanged
import kotlinx.coroutines.delay

private const val TICK_MS = 1_000L

/**
 * The watch party, on the phone.
 *
 * ## What this is playing, and why it is not the call
 *
 * The picture is an HLS playlist written by a LiveKit egress from the
 * presenter's screen share. Watching it costs the media server nothing per
 * viewer: no seat, no peer connection, no LiveKit participant, no microphone
 * and therefore no permission prompt. Joining the call is a separate button in
 * the channel's app bar and a deliberate second act. See
 * [gg.pqp.app.watch.WatchLiveStore] for the frame that announces a watcher and
 * for why that frame is the only one this path sends.
 *
 * The picture is eight to twelve seconds behind the presenter. That is the
 * product, not a fault, and the badge says so.
 *
 * ## The three things Media3 needs told
 *
 * 1. **That this is HLS at all, twice.** The playlist URL is
 *    `/api/voice/hls-playlist/<channel>/<startedAt>?t=…` with no `.m3u8` on the
 *    end, so nothing can infer HLS from the path: the item carries
 *    [MimeTypes.APPLICATION_M3U8] and the player is built with an explicit
 *    `HlsMediaSource.Factory`. The second half is the one that matters in a
 *    release build, and the comment on it says why.
 * 2. **No default request headers, ever.** The `?t=` in the URL is the
 *    authorisation, precisely so no header is needed. A `DefaultHttpDataSource`
 *    applies its default headers to every request it makes, and the segment
 *    URLs inside the playlist are presigned absolutes on the bucket's origin.
 *    A bearer token attached there would be a user's Clerk-derived credential
 *    sent to a third party.
 * 3. **A new URL is not a new stream.** [watchSourceChanged] is that rule and
 *    carries the reasoning.
 *
 * ## What actually happens at an event
 *
 * - **The stream has not started.** `stream` is null and the pane is not drawn,
 *   unless this person was already watching, in which case it says the
 *   transmission ended rather than freezing on the last frame.
 * - **It ends.** The egress writes `#EXT-X-ENDLIST`; the player reaches
 *   `STATE_ENDED` and [HlsWatchdog] treats that as a source that has to be
 *   refetched rather than a video that finished.
 * - **A signed URL expires mid-play.** It does not, while the socket is up: the
 *   audience keyframe restamps the token every thirty seconds and this pane
 *   always reconnects to the newest URL. If the socket was down for the token's
 *   whole hour, the failure arrives as a playback error and the recovery is the
 *   same one: ask `GET /api/channels/:id/live` for a fresh URL.
 * - **The app is backgrounded.** Playback pauses, because this app's
 *   foreground-service exemption is for a *call* and a watch party is not one.
 *   Coming back seeks to the live edge rather than resuming ten minutes behind.
 * - **The network drops and comes back.** The watchdog sees a stall or a fatal
 *   error, refetches, and after three attempts in five minutes says the stream
 *   dropped and offers a button. A phone silently retrying forever is somebody
 *   else's data plan.
 */
// `androidx.annotation.OptIn`, not Kotlin's: Media3's `@UnstableApi` is a Java
// annotation enforced by lint, and `checkReleaseBuilds = true` fails the
// release build on it. Same note as `ui/media/VideoPlayer.kt`.
@OptIn(UnstableApi::class)
@Composable
fun WatchPane(
    live: ChannelLive,
    /** Newest URL for this channel, straight from the API. Null means gone. */
    refresh: suspend () -> LiveStream?,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current

    var everPlayed by remember { mutableStateOf(false) }
    var hasFrame by remember { mutableStateOf(false) }
    var dead by remember { mutableStateOf(false) }
    var reconnecting by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var fullscreen by remember { mutableStateOf(false) }

    // The stream the player is attached to, as opposed to the one the server
    // last mentioned. They differ for thirty seconds at a time, every time the
    // token is restamped, and re-attaching on that difference is the bug
    // `watchSourceChanged` exists to prevent.
    var attached by remember { mutableStateOf<LiveStream?>(null) }
    val newest by rememberUpdatedState(live.stream)
    val refreshNow by rememberUpdatedState(refresh)

    LaunchedEffect(live.stream?.startedAt) {
        val next = newest
        if (watchSourceChanged(attached, next)) {
            attached = next
            dead = false
            reconnecting = false
            hasFrame = false
        }
    }

    val phase = watchPhaseOf(
        live = attached != null,
        everPlayed = everPlayed,
        hasFrame = hasFrame,
        dead = dead,
        reconnecting = reconnecting,
    )
    if (phase == WatchPhase.Idle) return

    val watchdog = remember { HlsWatchdog() }
    val player = remember {
        ExoPlayer.Builder(context)
            // `HlsMediaSource.Factory` by name, NOT `DefaultMediaSourceFactory`.
            //
            // The default factory finds the HLS source by reflection
            // (`Class.forName` on `androidx.media3.exoplayer.hls.HlsMediaSource$Factory`),
            // which means nothing in this module references it and R8 is free
            // to strip it out of the release build. That failure is invisible
            // here and total on a tester's phone: debug plays, the signed
            // sideload APK does not, and the only symptom is a playback error
            // with no picture. Naming the class is a reference, so it is kept
            // for the same reason the GIF decoder in `PqpApplication` is
            // registered by hand rather than left to a `META-INF/services`
            // entry.
            //
            // The data source carries NO default request headers, deliberately.
            // The `?t=` token in the playlist URL is the authorisation, and a
            // header set here would also travel on every segment request, which
            // goes to the bucket's own origin.
            .setMediaSourceFactory(
                HlsMediaSource.Factory(
                    DefaultHttpDataSource.Factory()
                        .setAllowCrossProtocolRedirects(true),
                ),
            )
            .build()
            .apply {
            // Media focus under a call's `USAGE_VOICE_COMMUNICATION`, and
            // `handleAudioFocus = true` so a ring pauses the film instead of
            // talking over it. Same reasoning as `ui/media/VideoPlayer.kt`.
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            playWhenReady = true
        }
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_BUFFERING -> watchdog.onBuffering(System.currentTimeMillis())
                    Player.STATE_READY -> {
                        watchdog.onPlaying()
                        hasFrame = true
                        everPlayed = true
                        reconnecting = false
                    }
                    // `#EXT-X-ENDLIST`. Not "the video finished": a live
                    // playlist that grew an end marker is a share that stopped,
                    // or the previous share's leftover playlist being served
                    // until the next one overwrites it. Either way the answer
                    // is to go and ask what is live now.
                    Player.STATE_ENDED -> watchdog.onEnded()
                    else -> Unit
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                watchdog.onError()
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            // Both, in this order: `release()` alone leaves the codec to be
            // reclaimed whenever, and a MediaCodec that outlives its pane is
            // the leak the attachment player was written to avoid.
            player.stop()
            player.release()
        }
    }

    // Attach. Keyed on the session and the attempt counter, never on the URL,
    // so a restamped token does not restart the stream.
    LaunchedEffect(player, attached?.startedAt, attempt) {
        val stream = attached ?: return@LaunchedEffect
        // The newest URL rather than the one this session was first announced
        // with: a reconnect wants the freshest token, and by the time a retry
        // runs the keyframe has usually already handed one over.
        val url = (newest?.takeIf { it.startedAt == stream.startedAt } ?: stream).hlsUrl
        player.setMediaItem(
            MediaItem.Builder()
                .setUri(url)
                // Required. There is no `.m3u8` in the path for Media3 to
                // sniff, so without this it builds a progressive source.
                .setMimeType(MimeTypes.APPLICATION_M3U8)
                // Default live offset is ~three TARGETDURATIONs from the
                // edge, which on a five-segment playlist is the segment
                // that expires next. Same 6 s / 8 s window as iOS and web.
                .setLiveConfiguration(
                    MediaItem.LiveConfiguration.Builder()
                        .setTargetOffsetMs(HlsLiveEdge.TARGET_OFFSET_MS)
                        .setMinOffsetMs(HlsLiveEdge.MIN_OFFSET_MS)
                        .setMaxOffsetMs(HlsLiveEdge.MAX_OFFSET_MS)
                        .setMaxPlaybackSpeed(HlsLiveEdge.MAX_PLAYBACK_SPEED)
                        .build(),
                )
                .build(),
        )
        player.prepare()
        player.playWhenReady = true
        watchdog.onSourceChanged(System.currentTimeMillis())
        reconnecting = false
    }

    // The watchdog's clock. One second, matching the web, and it also reads the
    // playlist's media sequence off the manifest so a dead egress that still
    // answers 200 is caught rather than looking like a slow link.
    LaunchedEffect(player, attached?.startedAt, attempt, dead) {
        if (attached == null || dead) return@LaunchedEffect
        while (true) {
            delay(TICK_MS)
            val now = System.currentTimeMillis()
            (player.currentManifest as? HlsManifest)?.mediaPlaylist?.mediaSequence?.let {
                watchdog.onMediaSequence(it, now)
            }
            when (watchdog.tick(now)) {
                WatchdogDecision.None -> Unit
                WatchdogDecision.Reconnect -> {
                    reconnecting = true
                    hasFrame = false
                    // A share that died and came back has a new session, so the
                    // URL we hold is gone and only the API knows the new one.
                    // A failure here is not fatal: the attempt bump re-attaches
                    // what we have and the watchdog judges that on its own.
                    val fresh = runCatching { refreshNow() }.getOrNull()
                    if (fresh != null && fresh.startedAt != attached?.startedAt) {
                        attached = fresh
                    } else {
                        attempt += 1
                    }
                    return@LaunchedEffect
                }
                WatchdogDecision.Dead -> {
                    dead = true
                    hasFrame = false
                    reconnecting = false
                    player.stop()
                    return@LaunchedEffect
                }
            }
        }
    }

    // The token renewal. A film is longer than an hour and the token is not,
    // so the swap is scheduled rather than left to expire into a 401 in the
    // middle of the party. Keyed on the attach, so a reconnect restarts the
    // clock; `attempt` is what re-attaches, and it picks up the freshly
    // stamped URL the keyframe has already delivered.
    LaunchedEffect(player, attached?.startedAt, attempt) {
        if (attached == null) return@LaunchedEffect
        delay(WATCH_TOKEN_RENEWAL_MS)
        attempt += 1
    }

    // The stream went away. Stop rather than sit on the last decoded frame:
    // the pane is about to say so in words, and a paused MediaCodec behind
    // that sentence is a codec held for a party that is over.
    LaunchedEffect(player, attached) {
        if (attached == null) player.stop()
    }

    // Backgrounding pauses, and coming back rejoins the live edge rather than
    // resuming wherever the buffer stopped. A watch party watched ten minutes
    // behind everybody else is not a watch party, and this app's
    // foreground-service exemption is for a call rather than for a film.
    LifecycleStartEffect(player, dead) {
        if (!dead) {
            player.seekToDefaultPosition()
            player.playWhenReady = true
        }
        onStopOrDispose { player.pause() }
    }

    val retry = {
        watchdog.reset(System.currentTimeMillis())
        dead = false
        reconnecting = true
        attempt += 1
    }

    if (fullscreen) {
        Dialog(
            onDismissRequest = { fullscreen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black)
                    .testTag("watch.fullscreen"),
            ) {
                // Only one `PlayerView` may hold the player at a time, so the
                // inline surface below is replaced by a placeholder while this
                // is up rather than both being composed.
                PlayerSurface(player, Modifier.fillMaxSize())
                IconButton(
                    onClick = { fullscreen = false },
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .safeDrawingPadding()
                        .padding(Spacing.sm),
                ) {
                    Icon(
                        imageVector = PqpIcons.ExitFullscreen,
                        contentDescription = stringResource(R.string.watch_exit_fullscreen),
                        tint = Color.White,
                    )
                }
            }
        }
    }

    Column(modifier.fillMaxWidth().testTag("watch.pane")) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .clip(RoundedCornerShape(Spacing.sm))
                // Black in both themes: a picture is letterboxed against its
                // own surround and a light grey one turns every dark frame into
                // a grey rectangle with a film floating in it.
                .background(Color.Black),
        ) {
            when (phase) {
                WatchPhase.Playing, WatchPhase.Opening -> {
                    if (!fullscreen) PlayerSurface(player, Modifier.fillMaxSize())
                    if (phase == WatchPhase.Opening) {
                        Waiting(stringResource(R.string.watch_opening))
                    }
                }

                WatchPhase.Reconnecting -> Waiting(stringResource(R.string.watch_reconnecting))

                WatchPhase.Dead -> Trouble(
                    text = stringResource(R.string.watch_dead),
                    action = stringResource(R.string.watch_retry),
                    onAction = retry,
                    tag = "watch.dead",
                )

                WatchPhase.Ended -> Trouble(
                    text = stringResource(R.string.watch_ended),
                    hint = stringResource(R.string.watch_ended_hint),
                    tag = "watch.ended",
                )

                WatchPhase.Idle -> Unit
            }

            if (phase == WatchPhase.Playing || phase == WatchPhase.Opening) {
                IconButton(
                    onClick = { fullscreen = true },
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(Spacing.xs)
                        .testTag("watch.fullscreenButton"),
                ) {
                    Icon(
                        imageVector = PqpIcons.EnterFullscreen,
                        contentDescription = stringResource(R.string.watch_fullscreen),
                        tint = Color.White,
                        modifier = Modifier.size(Sizes.iconAction),
                    )
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.xs, vertical = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (phase != WatchPhase.Ended) {
                Text(
                    text = stringResource(R.string.watch_live),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onError,
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(MaterialTheme.colorScheme.error)
                        .padding(horizontal = Spacing.xs, vertical = 2.dp)
                        .testTag("watch.livePill"),
                )
            }
            Text(
                // Zero gets its own sentence rather than "0 assistindo".
                // Portuguese CLDR counts 0 as `one`, so no plural form can say
                // this; the web client splits it the same way and for the same
                // reason (`voice.watch.audience_zero`).
                text = if (live.watching == 0) {
                    stringResource(R.string.watch_audience_none)
                } else {
                    pluralStringResource(
                        R.plurals.watch_audience,
                        live.watching,
                        live.watching,
                    )
                },
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("watch.audience"),
            )
            attached?.delaySeconds?.let { seconds ->
                Text(
                    text = stringResource(R.string.watch_delay, seconds),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun PlayerSurface(player: ExoPlayer, modifier: Modifier) {
    AndroidView(
        factory = { context ->
            PlayerView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                // The platform's own transport controls. On a live window
                // Media3 draws the live indicator and hides the scrubber
                // itself, so there is nothing here to reinvent.
                useController = true
                setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                // A film must not dim the screen halfway through.
                keepScreenOn = true
            }
        },
        update = { view -> view.player = player },
        onRelease = { view -> view.player = null },
        modifier = modifier,
    )
}

@Composable
private fun Waiting(text: String) {
    Column(
        modifier = Modifier.fillMaxSize().padding(Spacing.lg),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(color = Color.White)
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = Color.White,
            modifier = Modifier.padding(top = Spacing.md).testTag("watch.waiting"),
        )
    }
}

@Composable
private fun Trouble(
    text: String,
    tag: String,
    hint: String? = null,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(Spacing.lg).testTag(tag),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = PqpIcons.Warning,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(Sizes.iconAction),
        )
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White,
            modifier = Modifier.padding(top = Spacing.sm),
        )
        if (hint != null) {
            Text(
                text = hint,
                style = MaterialTheme.typography.bodySmall,
                color = Color.White.copy(alpha = 0.7f),
                modifier = Modifier.padding(top = Spacing.xs),
            )
        }
        if (action != null && onAction != null) {
            TextButton(onClick = onAction, modifier = Modifier.testTag("watch.retry")) {
                Icon(
                    imageVector = PqpIcons.Retry,
                    contentDescription = null,
                    modifier = Modifier.size(Sizes.iconInline),
                )
                Text(text = action, modifier = Modifier.padding(start = Spacing.xs))
            }
        }
    }
}
