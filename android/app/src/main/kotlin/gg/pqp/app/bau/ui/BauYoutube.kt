package gg.pqp.app.bau.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.graphics.createBitmap
import androidx.core.net.toUri
import androidx.lifecycle.compose.LifecycleStartEffect
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.bau.BauEmbedGate
import gg.pqp.app.bau.BauYoutubeEmbed
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import java.util.UUID

/**
 * A YouTube Baú post, played in the card.
 *
 * Until this file a tap handed the link to the YouTube app. The web has always
 * embedded it, so the phone now does what the web does: the public poster
 * first, and on the first tap a [WebView] with YouTube's IFrame Player from
 * `youtube-nocookie.com` (the rules are in [BauYoutubeEmbed]).
 *
 *  - **Poster first.** Nothing from YouTube loads while a person scrolls past.
 *  - **It never leaves the card.** Every main-frame navigation after the page
 *    itself is refused, and so is any app scheme; **Abrir no YouTube** under
 *    the card is the only way to the YouTube app.
 *  - **Full screen** is the player's own button: WebView hands over its video
 *    view ([WebChromeClient.onShowCustomView]) and it is shown immersive and
 *    in landscape, the same way the uploaded-video full screen is.
 *  - **Same floor as an uploaded video.** One Baú video plays at a time, in
 *    both directions ([BauPlayback.claimEmbed]).
 *  - **Audio.** WebView asks for media focus by itself when the clip plays
 *    (Chromium's `AudioFocusDelegate`, seen in `dumpsys audio`), which outside
 *    a call is what [BauPlaybackPolicy.handleAudioFocus] wants: music ducks,
 *    a ring pauses it. The app must not ask as well, or the two requests take
 *    focus from each other and the player pauses itself. In a call the voice
 *    stack keeps `MODE_IN_COMMUNICATION` and ignores focus changes
 *    (`VoiceController.acquireAudioFocus`), so the clip mixes into the call
 *    instead of taking the microphone or the output away from it.
 *  - **Scrolling away** throws the card's player away (a lazy list disposes
 *    the row), which stops the sound; the card comes back as its poster.
 *
 * The VIP lock is upstream: a locked post carries no media at all.
 */
@Composable
internal fun BauYoutubeCard(
    videoId: String,
    watchUrl: String?,
    name: String,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var started by remember(videoId) { mutableStateOf(false) }
    var failed by remember(videoId) { mutableStateOf(false) }

    Column(modifier = modifier.fillMaxWidth()) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh),
            contentAlignment = Alignment.Center,
        ) {
            when {
                failed -> Text(
                    text = stringResource(R.string.bau_media_youtube_failed),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(Spacing.xl).testTag("bau.media.youtube.failed"),
                )

                started -> BauYoutubePlayer(videoId = videoId, onFailed = { failed = true })

                else -> {
                    val label = name.ifBlank { stringResource(R.string.bau_media_video) }
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .clickable(role = Role.Button) { started = true }
                            .semantics { contentDescription = label }
                            .testTag("bau.media.youtube"),
                        contentAlignment = Alignment.Center,
                    ) {
                        AsyncImage(
                            model = BauYoutubeEmbed.posterUrl(videoId),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize(),
                        )
                        Box(
                            modifier = Modifier
                                .size(56.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primary),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = PqpIcons.Play,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onPrimary,
                            )
                        }
                    }
                }
            }
        }

        if (watchUrl != null) {
            TextButton(
                onClick = {
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, watchUrl.toUri()))
                    }
                },
                modifier = Modifier.align(Alignment.End).testTag("bau.media.youtube.open"),
            ) {
                Text(
                    text = stringResource(R.string.bau_media_youtube_open),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
@Composable
private fun BauYoutubePlayer(videoId: String, onFailed: () -> Unit) {
    val context = LocalContext.current
    val onFailedNow by rememberUpdatedState(onFailed)
    // One per card, so two cards of the same video never stand in for each other.
    val key = remember(videoId) { "youtube:$videoId:${UUID.randomUUID()}" }
    val gate = remember(videoId) { BauEmbedGate() }

    var fullscreenView by remember { mutableStateOf<View?>(null) }
    var fullscreenCallback by remember { mutableStateOf<WebChromeClient.CustomViewCallback?>(null) }

    val webView = remember(videoId) {
        WebView(context).apply {
            val view = this
            fun pause() = view.evaluateJavascript("bauPause()", null)
            fun stopped() = BauPlayback.releaseEmbed(key)

            setBackgroundColor(android.graphics.Color.BLACK)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                allowFileAccess = false
                allowContentAccess = false
            }
            addJavascriptInterface(
                BauYoutubeBridge(
                    post = { view.post(it) },
                    onState = { state ->
                        if (gate.alive) {
                            when (BauYoutubeEmbed.event(state)) {
                                BauYoutubeEmbed.Event.PLAYING ->
                                    if (gate.mayClaim()) {
                                        BauPlayback.claimEmbed(key) {
                                            gate.yielded()
                                            pause()
                                        }
                                    } else {
                                        pause()
                                    }
                                BauYoutubeEmbed.Event.STOPPED -> {
                                    gate.stopped()
                                    stopped()
                                }
                                BauYoutubeEmbed.Event.BUFFERING, null -> Unit
                            }
                        }
                    },
                    onError = {
                        if (gate.alive) {
                            stopped()
                            onFailedNow()
                        }
                    },
                ),
                BauYoutubeEmbed.BRIDGE,
            )
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    !BauYoutubeEmbed.mayLoad(request.url?.toString(), request.isForMainFrame)

                // A renderer that dies must not take the app with it: the card
                // drops the player (which destroys this view) and says so.
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    stopped()
                    onFailedNow()
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                    fullscreenView = view
                    fullscreenCallback = callback
                }

                override fun onHideCustomView() {
                    fullscreenView = null
                    fullscreenCallback = null
                }

                // Without this the player shows WebView's grey play icon for a
                // moment before the first frame.
                override fun getDefaultVideoPoster(): Bitmap =
                    createBitmap(1, 1)
            }
            loadDataWithBaseURL(
                "${BauYoutubeEmbed.PAGE_ORIGIN}/",
                BauYoutubeEmbed.playerPage(videoId),
                "text/html",
                "utf-8",
                null,
            )
        }
    }

    // Home or recents: stop making noise.
    LifecycleStartEffect(webView) {
        onStopOrDispose { webView.evaluateJavascript("bauPause()", null) }
    }

    DisposableEffect(webView) {
        onDispose {
            gate.dispose()
            runCatching { fullscreenCallback?.onCustomViewHidden() }
            BauPlayback.releaseEmbed(key)
        }
    }

    AndroidView(
        factory = { webView },
        onRelease = { view ->
            view.stopLoading()
            view.destroy()
        },
        modifier = Modifier.fillMaxSize().testTag("bau.media.youtube.player"),
    )

    fullscreenView?.let { view ->
        BauYoutubeFullscreen(
            view = view,
            onExit = {
                fullscreenCallback?.onCustomViewHidden()
                fullscreenView = null
                fullscreenCallback = null
            },
        )
    }
}

/**
 * What the player page calls. Only small integers come in, on the bridge's own
 * thread; everything is posted back to the main one. Android exposes the
 * interface to every frame in the view, the YouTube iframe included, which is
 * why it does nothing but report a state.
 */
private class BauYoutubeBridge(
    private val post: (Runnable) -> Unit,
    private val onState: (Int) -> Unit,
    private val onError: () -> Unit,
) {
    @JavascriptInterface
    fun onState(state: Int) = post(Runnable { onState.invoke(state) })

    @JavascriptInterface
    fun onError(@Suppress("UNUSED_PARAMETER") code: Int) = post(Runnable { onError.invoke() })
}

/** WebView's own video view, immersive and in landscape while it is up. */
@Composable
private fun BauYoutubeFullscreen(view: View, onExit: () -> Unit) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    DisposableEffect(activity) {
        val previous = activity?.requestedOrientation
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        onDispose {
            if (previous != null) activity.requestedOrientation = previous
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
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black)
                .testTag("bau.media.youtube.fullscreen"),
        ) {
            AndroidView(
                factory = { holderContext ->
                    FrameLayout(holderContext).apply {
                        (view.parent as? ViewGroup)?.removeView(view)
                        addView(
                            view,
                            FrameLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT,
                            ),
                        )
                        keepScreenOn = true
                    }
                },
                onRelease = { holder -> holder.removeAllViews() },
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}
