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
import androidx.media3.exoplayer.DefaultLoadControl
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
import gg.pqp.app.watch.hlsSessionToken
import gg.pqp.app.watch.WatchPhase
import gg.pqp.app.watch.WATCH_TOKEN_RENEWAL_MS
import gg.pqp.app.watch.WatchdogDecision
import gg.pqp.app.watch.reconnectAttachment
import gg.pqp.app.watch.watchPhaseOf
import gg.pqp.app.watch.watchSourceChanged
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
 * The picture sits about twenty seconds behind the presenter (`HlsLiveEdge`'s
 * target of five target durations, at the 4 s `LIVE_HLS_SEGMENT_SECONDS`
 * production runs), free to drift between twelve and forty. That is the
 * product, not a fault, and the badge says so: a deep, resilience-first
 * cushion so an ordinary publish hiccup never surfaces as a pause.
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
    /**
     * "I am still watching" (`ApiClient.sendHlsPresence`). Called every 30 s
     * while a picture is attached; a default no-op keeps every other caller
     * (previews, tests) exactly as they were.
     */
    sendPresence: suspend (String) -> Unit = {},
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
    val sendPresenceNow by rememberUpdatedState(sendPresence)

    // Set for exactly the one reattach that follows a completed refetch in
    // the Reconnect branch below, and consumed (reset to false) the instant
    // that reattach reads it. That URL was minted moments ago by a direct
    // `GET /api/channels/:id/live`, which cannot be staler than `newest` —
    // and in the one scenario that sends the watchdog down this path at all
    // (the socket has not delivered a fresher keyframe in a while, or the
    // playing token was simply wrong), `newest` can be exactly the same
    // stale value that just failed. Without this, the attach effect's own
    // `newest?.takeIf { it.startedAt == stream.startedAt } ?: stream` would
    // still pick `newest` over the freshly-fetched `stream` whenever the
    // session matches, which it always does here, silently undoing the
    // refetch and reproducing the "same expired token" symptom this exists
    // to fix. Every other reattach — a scheduled renewal, the retry button,
    // a refetch that itself failed — has no fresher value of its own and is
    // untouched: it keeps trusting `newest` exactly as before.
    var trustFreshRefetch by remember { mutableStateOf(false) }

    // One "latest wins" counter, bumped by every event that can supersede an
    // in-flight refetch in the Reconnect branch below: a socket-delivered
    // `live.stream` update (any change, not only a new session — a
    // token-only restamp counts), AND the start of every refetch itself.
    // The Reconnect branch snapshots the value right after bumping it for
    // its own call, and only trusts its response if the snapshot still
    // equals the live counter when the response comes back.
    //
    // That single comparison covers both ways a response can go stale: a
    // socket delivers a fresher token strictly faster than an HTTP
    // round-trip this same server serves, so if an update landed while the
    // request was in flight the socket has already said something newer;
    // and two reconnect attempts can overlap over the network even though
    // only one is ever started here at a time — the token-renewal timer
    // below can bump `attempt` while a reconnect fetch is still in the air,
    // which cancels that fetch's `LaunchedEffect`, and the only thing
    // standing between a cancelled coroutine and it running to completion
    // anyway is `refresh` rethrowing `CancellationException` rather than
    // swallowing it (see `WatchChannelPane`). This counter is the second
    // line of defence for that race: even if a cancelled call's response
    // somehow still lands, it can no longer win.
    var generation by remember { mutableIntStateOf(0) }

    LaunchedEffect(live.stream?.startedAt) {
        val next = newest
        if (watchSourceChanged(attached, next)) {
            attached = next
            dead = false
            reconnecting = false
            hasFrame = false
        }
    }

    // Bumped on every socket-delivered update to this channel's stream,
    // keyed on the full value rather than just `startedAt` so a same-session
    // token restamp counts too — the case the comment on `generation` above
    // calls out explicitly.
    LaunchedEffect(live.stream) { generation++ }

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
            // A deeper pre-load than Media3's own defaults (15/50 s, 2.5/5 s),
            // to match the 20 s target cushion in `HlsLiveEdge`: the buffer
            // that holds the cushion has to be at least as deep as the
            // cushion itself, or the player reaches the target offset and
            // then immediately empties it back out. `maxBufferMs` stays
            // under the playlist's 60 s window
            // (`server/src/voice/hls-live-window.ts`) so this never asks for
            // more than the proxy can actually serve.
            //
            // `bufferForPlaybackAfterRebufferMs = 8_000`: after a stall,
            // refill about two segments before resuming rather than the
            // default one, so a resume does not immediately re-stall on the
            // next tick of jitter. `HlsWatchdog.stallMs` carries a matching
            // comment: it must stay comfortably above this number, or a
            // legitimate refill and a "give up and reconnect" verdict race
            // each other.
            .setLoadControl(
                DefaultLoadControl.Builder()
                    .setBufferDurationsMs(
                        /* minBufferMs = */ HlsLiveEdge.MIN_BUFFER_MS,
                        /* maxBufferMs = */ HlsLiveEdge.MAX_BUFFER_MS,
                        /* bufferForPlaybackMs = */ HlsLiveEdge.BUFFER_FOR_PLAYBACK_MS,
                        /* bufferForPlaybackAfterRebufferMs = */
                        HlsLiveEdge.BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS,
                    )
                    .build(),
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
        // runs the keyframe has usually already handed one over. That
        // assumption only holds when nothing has already fetched a fresher
        // one directly — `trustFreshRefetch` overrides it for the one
        // reattach that follows a completed refetch, since `newest` here can
        // be the exact stale token that refetch was sent to replace. Consumed
        // immediately so it never leaks into a later, unrelated reattach.
        val url = if (trustFreshRefetch) {
            stream.hlsUrl
        } else {
            (newest?.takeIf { it.startedAt == stream.startedAt } ?: stream).hlsUrl
        }
        trustFreshRefetch = false
        // The real `#EXT-X-TARGETDURATION` is not known until the manifest
        // loads, so the join itself carries `HlsLiveEdge.ASSUMED_TARGET_DURATION_MS`
        // (production's segment length today) rather than no configuration
        // at all. That is not cosmetic: `DefaultLivePlaybackSpeedControl`
        // only closes a gap between the CURRENT offset and the target at
        // `MAX_PLAYBACK_SPEED`, so joining on Media3's own 3x fallback (12 s)
        // and correcting to 20 s only once the manifest loads would spend the
        // first several minutes of every watch drifting open the last 8 s at
        // 1.05x — on the old, shallow buffer the "still too close" report was
        // about. Starting the join on this ratio's own numbers means the
        // deeper cushion is there from the first segment, not minutes later.
        player.setMediaItem(liveMediaItem(url, HlsLiveEdge.ASSUMED_TARGET_DURATION_MS))
        player.prepare()
        player.playWhenReady = true
        watchdog.onSourceChanged(System.currentTimeMillis())
        reconnecting = false

        // Correct the assumption once the real target duration is known,
        // instead of ever trusting it blindly. #498 (2026-09-12) hardcoded
        // `LiveConfiguration` at build time assuming 2 s segments; production
        // silently moved to 4 s and the same numbers became a band one
        // playlist update wide, stalling once a segment. Reading the real
        // `HlsManifest` here means these ratios are correct at 2 s, 4 s, or
        // whatever `LIVE_HLS_SEGMENT_SECONDS` is set to next, with no client
        // release required either time — the join only has to be *plausible*
        // above, never correct, because this poll fixes it the moment it is
        // wrong.
        //
        // Forked rather than awaited in line: the manifest is not available
        // until the first playlist fetch completes, and this must not hold
        // up `playWhenReady` while it waits. Polls rather than reading
        // `player.currentManifest` once, because the fetch races this
        // coroutine, and keeps polling with no fixed number of attempts —
        // there is no bounded worst case for how long a first playlist
        // fetch can take, and giving up early would leave a slow-to-load
        // session stuck on the assumption forever. Safe to leave unbounded
        // because it is cancelled for free the moment this effect is: a
        // reattach (a new `attempt` or `startedAt`) or the pane leaving
        // composition both cancel this coroutine along with everything else
        // `LaunchedEffect` started. `replaceMediaItem` (same index, same
        // URI) rather than a fresh `setMediaItem` + `prepare`, so Media3
        // updates the live-offset configuration on the existing period
        // instead of restarting the load. Skips the replace entirely when
        // the manifest agrees with the assumption — the ordinary case, since
        // the join above already carries the right numbers — so a normal
        // attach never pays for a needless swap of the item it just
        // prepared.
        launch {
            while (true) {
                delay(150)
                val manifest = player.currentManifest as? HlsManifest
                val targetDurationMs = manifest?.mediaPlaylist?.targetDurationUs?.let { it / 1_000 }
                if (targetDurationMs != null && targetDurationMs > 0) {
                    if (targetDurationMs != HlsLiveEdge.ASSUMED_TARGET_DURATION_MS) {
                        player.replaceMediaItem(0, liveMediaItem(url, targetDurationMs))
                    }
                    break
                }
                // No manifest yet: keep polling rather than giving up after a
                // fixed number of tries. There is no bounded worst case for
                // the first playlist fetch, and this coroutine is cancelled
                // for free the moment this `LaunchedEffect` is (a reattach
                // bumps `attempt` or `startedAt`, or the pane leaves
                // composition), so an unbounded loop here never outlives the
                // attach it belongs to.
            }
        }
    }

    // "I am still watching" (`ApiClient.sendHlsPresence`), every 30 s while a
    // picture is attached and this pane has not given up on it. This is what
    // makes a broadcast's PERSISTED peak/unique numbers
    // (`hls_session_viewer_stats`) count a phone that plays low-latency
    // segments straight off the edge Worker, which never makes a request
    // this API's own playlist proxy can see — see the doc comment on
    // `ApiClient.sendHlsPresence`. Reads the freshest URL each tick, same as
    // the attach effect above, because the keyframe restamps the token every
    // 30 s and a beat sent with a just-expired one is a beat wasted.
    // Fire-and-forget: a failed send is one fewer sighting, never shown.
    LaunchedEffect(attached?.startedAt, attempt, dead) {
        if (attached == null || dead) return@LaunchedEffect
        while (true) {
            (newest ?: attached)?.let { stream ->
                hlsSessionToken(stream.hlsUrl)?.let { token ->
                    runCatching { sendPresenceNow(token) }
                }
            }
            delay(30_000)
        }
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
                    // But the ordinary case is the SAME session with a token
                    // that just expired, and a fresh refetch is exactly what
                    // that wants too — `reconnectAttachment` is what makes
                    // sure that result is not thrown away just because
                    // `startedAt` did not change. A failure here is not
                    // fatal: the attempt bump re-attaches what we already
                    // have and the watchdog judges that on its own.
                    //
                    // Claim the next number before the GET goes out. If a
                    // socket-delivered update lands, or a different
                    // reconnect attempt starts, while this one is in flight,
                    // that event bumps `generation` past this snapshot and
                    // the response below is discarded outright rather than
                    // being allowed to win a race against whatever is now
                    // current. `refresh` rethrows `CancellationException`
                    // (see `WatchChannelPane`) rather than swallowing it, so
                    // only network and decoding failures are caught here —
                    // this coroutine's own cancellation (the pane leaving
                    // composition, a reattach elsewhere) propagates and
                    // never reaches the lines below at all.
                    val requestedGeneration = ++generation
                    val fresh = try {
                        refreshNow()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        null
                    }
                    if (generation == requestedGeneration) {
                        attached = reconnectAttachment(fresh, attached)
                        // A successful refetch is trusted over `newest` for
                        // the next reattach — see `trustFreshRefetch` above
                        // — now that the generation check above has already
                        // confirmed nothing fresher arrived while the fetch
                        // was in flight.
                        trustFreshRefetch = fresh != null
                    }
                    // Always bumped: when the session changed, `startedAt`
                    // alone already reruns the keyed attach effect below, so
                    // this is a no-op key change riding along with it; when
                    // it did not, `attached` is a new object with the SAME
                    // `startedAt`, and this is the only thing that makes the
                    // effect re-run and read the token `attached` now holds.
                    // Bumped even when the response above was discarded as
                    // stale: something newer already exists to reattach to,
                    // and the watchdog will judge the result on its own.
                    attempt += 1
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

/**
 * The `MediaItem` this pane ever attaches with: same URI and MIME type
 * every time, `LiveConfiguration` derived from [HlsLiveEdge.offsetsFor] on
 * whatever target duration is passed in — [HlsLiveEdge.ASSUMED_TARGET_DURATION_MS]
 * at attach, the manifest's real one once known. One function so the two
 * call sites can never drift into building the item differently, and so
 * neither one carries a raw millisecond literal of its own.
 */
@OptIn(UnstableApi::class)
private fun liveMediaItem(url: String, targetDurationMs: Long): MediaItem {
    val offsets = HlsLiveEdge.offsetsFor(targetDurationMs)
    return MediaItem.Builder()
        .setUri(url)
        // Required. There is no `.m3u8` in the path for Media3 to sniff, so
        // without this it builds a progressive source.
        .setMimeType(MimeTypes.APPLICATION_M3U8)
        .setLiveConfiguration(
            MediaItem.LiveConfiguration.Builder()
                .setTargetOffsetMs(offsets.targetMs)
                .setMinOffsetMs(offsets.minMs)
                .setMaxOffsetMs(offsets.maxMs)
                .setMaxPlaybackSpeed(HlsLiveEdge.MAX_PLAYBACK_SPEED)
                .setMinPlaybackSpeed(HlsLiveEdge.MIN_PLAYBACK_SPEED)
                .build(),
        )
        .build()
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
