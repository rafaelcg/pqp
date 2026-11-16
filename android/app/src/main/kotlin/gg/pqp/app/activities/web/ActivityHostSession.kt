package gg.pqp.app.activities.web

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebChromeClient
import android.webkit.WebViewClient
import gg.pqp.app.BuildConfig
import gg.pqp.app.activities.ActivityApp
import gg.pqp.app.activities.ActivityEndReason
import gg.pqp.app.activities.bridge.ActivityTransportError
import gg.pqp.app.activities.bridge.BridgeHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayInputStream
import java.util.UUID

/** Where a running activity is: the screen draws the loading, the failure and the ending from this. */
sealed interface ActivityFrameStatus {
    data object Loading : ActivityFrameStatus
    data object Ready : ActivityFrameStatus
    data class Failed(val reason: Reason, val code: String? = null) : ActivityFrameStatus
    data class Ended(val reason: ActivityEndReason) : ActivityFrameStatus

    enum class Reason {
        /** The entry URL is not on the apps origin, so nothing was framed. */
        BadEntry,

        /** The seat was refused (full, not allowed, ended); see the code. */
        JoinFailed,

        /** The frame never said hello. */
        Timeout,

        /** The frame loaded a second document: it navigated itself. It was removed. */
        FrameNavigated,

        /** The app flooded the bridge. It was removed. */
        Flood,

        /** The web view's renderer died. */
        Crashed,
    }
}

/**
 * Puts one activity in a sandboxed frame inside a web view and runs its bridge:
 * `mountAppFrame` (`frame-controller.ts`) on a phone. The page it loads is
 * [ActivityHostPage]; read that for why the frame is not the top document and
 * how the two sides talk.
 *
 * Order of events, and why:
 *
 * 1. The web view is locked down before anything loads. No file or content
 *    access, no popups, no storage, no geolocation, no mixed content, no way to
 *    navigate the main frame. Every request goes through
 *    [shouldInterceptRequest]: only the apps origin is fetched, so a bundle that
 *    tries to reach anywhere else (the frame's own CSP already says `connect-src
 *    'none'`) is refused a second time by the phone.
 * 2. The seat is taken ([BridgeHost.start]) while the frame loads. The frame's
 *    `app-hello` is answered only after the seat exists, with one end of a
 *    `MessageChannel` the page creates.
 * 3. A SECOND load of the frame means it left the document it was given; the
 *    page tells us and the frame is removed.
 * 4. A frame that never says hello within [helloTimeoutMs] is removed.
 */
class ActivityHostSession(
    context: Context,
    private val app: ActivityApp,
    private val appsOrigin: String,
    private val scope: CoroutineScope,
    private val title: String,
    private val backgroundColorInt: Int,
    private val onStatus: (ActivityFrameStatus) -> Unit,
    makeBridge: (post: (String) -> Unit, onViolation: () -> Unit, onEnded: (ActivityEndReason) -> Unit) -> BridgeHost,
    private val helloTimeoutMs: Long = DEFAULT_HELLO_TIMEOUT_MS,
) {
    private val main = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    val webView: WebView = WebView(context).apply {
        setBackgroundColor(backgroundColorInt)
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        overScrollMode = WebView.OVER_SCROLL_NEVER
        // The wrapper page and the frame both need script; nothing else is allowed.
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        settings.setGeolocationEnabled(false)
        settings.mediaPlaybackRequiresUserGesture = true
        // The hosted apps origin is https and stays strict. A dev box serves bundles from http://localhost (debug builds only reach it).
        settings.mixedContentMode =
            if (appsOrigin.startsWith("https://")) WebSettings.MIXED_CONTENT_NEVER_ALLOW else WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        // A page that wants a different text size gets the app's, not the system's: games and polls are laid out for 100%.
        settings.textZoom = 100
        isLongClickable = false
        setOnLongClickListener { true }
    }

    private val bridge: BridgeHost
    private var nativePort: WebMessagePort? = null
    private var portPosted = false
    private var helloSeen = false
    private var removed = false
    private var destroyed = false
    private var status: ActivityFrameStatus = ActivityFrameStatus.Loading
    private var started: Job? = null
    private var helloDeadline: Job? = null

    private val client = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String?) {
            if (portPosted || destroyed || removed) return
            // The page's own load, not about:blank after a removal.
            if (url == "about:blank") return
            portPosted = true
            val page = pagePort ?: return
            // Main frame only: the sandboxed frame is not the main frame and its origin is opaque, so it
            // cannot receive this port.
            view.postWebMessage(
                WebMessage(ActivityHostPage.NATIVE_HELLO, arrayOf(page)),
                // The page loaded from a data URL has an opaque origin, so no origin can be named; the message goes to the
                // main frame only whatever the target says, and the page checks its own source.
                Uri.parse("*"),
            )
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            // The main frame never navigates away from the page it was given. The frame's own navigations
            // are for the interceptor below, which only lets the apps origin through.
            request.isForMainFrame

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            if (ActivityHostPage.isOnOrigin(request.url.toString(), appsOrigin) || request.url.scheme == "data" || request.url.scheme == "blob") {
                null
            } else {
                // Nothing the page or the bundle asks for outside the apps origin is fetched.
                if (BuildConfig.DEBUG) Log.d(TAG, "blocked ${request.url}")
                blocked()
            }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            remove(ActivityFrameStatus.Failed(ActivityFrameStatus.Reason.Crashed))
            return true
        }
    }

    init {
        bridge = makeBridge(
            { text -> postToPage(text) },
            { remove(ActivityFrameStatus.Failed(ActivityFrameStatus.Reason.Flood)) },
            { reason -> finish(reason) },
        )
        webView.webViewClient = client
        // The console of the page and the frame, in debug builds only, so a bundle that fails to start says why.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
            webView.webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    Log.d(TAG, "console: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                    return true
                }
            }
        }
    }

    /** Loads the frame and takes the seat. */
    fun start(asSpectator: Boolean) {
        val entry = app.entry.url
        if (entry == null || !ActivityHostPage.isOnOrigin(entry, appsOrigin)) {
            remove(ActivityFrameStatus.Failed(ActivityFrameStatus.Reason.BadEntry))
            return
        }
        val port = webView.createWebMessageChannel()
        nativePort = port[0]
        port[0].setWebMessageCallback(
            object : WebMessagePort.WebMessageCallback() {
                override fun onMessage(p: WebMessagePort, message: WebMessage) {
                    message.data?.let(::onPageMessage)
                }
            },
        )
        pagePort = port[1]
        helloDeadline = scope.launch {
            delay(helloTimeoutMs)
            remove(ActivityFrameStatus.Failed(ActivityFrameStatus.Reason.Timeout))
        }
        val html = ActivityHostPage.html(
            entryUrl = entry,
            appsOrigin = appsOrigin,
            nonce = UUID.randomUUID().toString().replace("-", ""),
            title = title,
            background = hex(backgroundColorInt),
            debug = BuildConfig.DEBUG,
        )
        webView.loadDataWithBaseURL(ActivityHostPage.BASE_ORIGIN + "/", html, "text/html", "utf-8", null)
        // The seat is taken while the frame loads. If the screen goes away before the join lands, the
        // bridge sees itself detached and releases the seat it just got, so no separate cancellation.
        started = scope.launch {
            try {
                bridge.start(asSpectator)
                joined = true
                maybeAttach()
            } catch (e: ActivityTransportError) {
                remove(ActivityFrameStatus.Failed(ActivityFrameStatus.Reason.JoinFailed, e.code))
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                remove(ActivityFrameStatus.Failed(ActivityFrameStatus.Reason.JoinFailed, "unavailable"))
            }
        }
    }

    private var pagePort: WebMessagePort? = null
    private var joined = false
    private var attached = false

    /** The page said hello and the seat exists: hand the frame its port and send our own hello. */
    private fun maybeAttach() {
        if (!helloSeen || !joined || attached || removed || destroyed) return
        attached = true
        helloDeadline?.cancel()
        nativePort?.postMessage(WebMessage(ActivityHostPage.CONTROL_PORT))
        bridge.attach()
        setStatus(ActivityFrameStatus.Ready)
    }

    private fun onPageMessage(text: String) {
        if (removed || destroyed) return
        when {
            text == ActivityHostPage.CONTROL_HELLO -> {
                if (helloSeen) return
                helloSeen = true
                maybeAttach()
            }

            text == ActivityHostPage.CONTROL_NAVIGATED -> remove(ActivityFrameStatus.Failed(ActivityFrameStatus.Reason.FrameNavigated))

            text.startsWith("{") -> {
                val envelope = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                if (envelope["k"]?.jsonPrimitive?.content == "req") {
                    envelope["m"]?.let { bridge.onPortMessage(it.toString()) }
                }
            }
        }
    }

    private fun postToPage(text: String) {
        if (destroyed) return
        runCatching { nativePort?.postMessage(WebMessage(text)) }
    }

    private fun setStatus(next: ActivityFrameStatus) {
        if (destroyed) return
        // an end of the session or a removal is final
        if (status is ActivityFrameStatus.Failed || status is ActivityFrameStatus.Ended) return
        status = next
        onStatus(next)
    }

    /**
     * The session is over (the app was told, the phone's seat needs no releasing): the screen draws its ending, and
     * the frame is taken out of the page so a bundle with timers or animation stops costing anything. Also what the
     * screen calls when its own End succeeded and the `app-ended` frame has not arrived (the socket may be down).
     */
    fun finish(reason: ActivityEndReason) {
        if (removed || destroyed) return
        removed = true
        helloDeadline?.cancel()
        setStatus(ActivityFrameStatus.Ended(reason))
        postToPage(ActivityHostPage.CONTROL_REMOVE)
        bridge.detach()
    }

    /** Takes the frame out of the page and stops talking to it; the seat is released. */
    private fun remove(failure: ActivityFrameStatus.Failed) {
        if (removed || destroyed) return
        removed = true
        helloDeadline?.cancel()
        postToPage(ActivityHostPage.CONTROL_REMOVE)
        bridge.detach()
        bridge.leave()
        setStatus(failure)
        // Whatever the app had on screen goes with it.
        webView.loadUrl("about:blank")
    }

    /** Releases the seat and the web view. Safe to call twice. */
    fun destroy() {
        if (destroyed) return
        helloDeadline?.cancel()
        started?.cancel()
        bridge.detach()
        bridge.leave()
        destroyed = true
        runCatching { nativePort?.close() }
        nativePort = null
        main.post {
            runCatching {
                webView.stopLoading()
                webView.loadUrl("about:blank")
                webView.removeAllViews()
                webView.destroy()
            }
        }
    }

    /** The phone's theme changed (light or dark): the app is told once, and only when it differs. */
    fun refreshTheme() = bridge.refreshTheme()

    fun onPause() = webView.onPause()
    fun onResume() = webView.onResume()

    companion object {
        const val DEFAULT_HELLO_TIMEOUT_MS = 20_000L
        private const val TAG = "pqp.activities"

        private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

        fun hex(color: Int): String = String.format("#%02x%02x%02x", Color.red(color), Color.green(color), Color.blue(color))
    }
}
