package gg.pqp.app.core

import android.app.Activity
import android.app.Application
import android.os.Bundle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * "Is this app in front of the person?", reported to the server as `set-attention { foreground }`.
 *
 * WHAT THE SERVER DOES WITH IT. With `push_attention_gate` on (it is, in production) a phone is
 * pushed unless at least one of the account's sockets is foreground AND not idle. A socket that never
 * sends the frame is read as foreground unless idle, which is what this client was: Android sent
 * neither `set-attention` nor `set-idle`, so a backgrounded phone whose socket was still up counted
 * as being in front of the person, and the server withheld the push from the very phone that most
 * needed it (`socketIsAttentive` in `server/src/ws/status.ts`, `socketRefusal` in
 * `server/src/services/push.ts`).
 *
 * THE RULES ARE THE WEB'S (`client/src/lib/attention.ts`), the same state machine:
 *  - Foreground is reported at once when it begins; the state at startup is reported as it is.
 *  - Losing it is reported only after [BACKGROUND_GRACE_MS], and cancelled if the app comes back first.
 *  - Frames are sent only on a change, and only while the socket is `ready`. Attention is scoped to the
 *    socket that sent it and the server forgets it with the socket, so every (re)connect announces the
 *    current value again: a reconnect while the app is in the background must say so, or the new
 *    socket reads as "never declared", which is foreground.
 *  - A send that did not leave is not recorded as reported; the next event or reconnect tries again.
 *
 * ONE DIFFERENCE, ON PURPOSE: the grace is 5 seconds here, not the web's 60. The web waits a minute
 * so that alt-tabbing to look something up does not send the next DM to the phone as well, because
 * the page is still on screen on another window. A phone has no other window: the app leaving the
 * screen is the person not looking at it, and the push is the only way a message reaches them. Five
 * seconds only absorbs a system picker or a permission sheet taking the screen for a moment.
 *
 * It does not send `set-idle` either: foreground false is the whole signal, and idle is the web's
 * ten-minutes-without-input rule, which has no meaning on a touch screen that is off in a pocket.
 *
 * Pure (a scope, a clock through `delay`, three lambdas) so the rules are a JVM test.
 */
class AttentionTracker(
    private val scope: CoroutineScope,
    /** Hands `set-attention` to the socket; false when it did not leave. */
    private val send: (Boolean) -> Boolean,
    /** Whether the app is in front of the person right now. */
    private val isForeground: () -> Boolean,
    private val graceMs: Long = BACKGROUND_GRACE_MS,
) {
    private val lock = Any()

    /** What this app is declaring right now, after the grace. */
    @Volatile
    var declared: Boolean = isForeground()
        private set

    /** What the current socket was last told; null means nothing yet. */
    private var reported: Boolean? = null
    private var connected = false
    private var timer: Job? = null

    /** Something changed (an Activity started or stopped): look again. */
    fun evaluate() = synchronized(lock) {
        if (isForeground()) {
            cancelTimer()
            declare(true)
            return@synchronized
        }
        if (!declared) {
            // Already background. Normally a no-op; it re-sends only if the last attempt did not go out.
            declare(false)
            return@synchronized
        }
        if (timer != null) return@synchronized
        timer = scope.launch {
            delay(graceMs)
            synchronized(lock) {
                timer = null
                // Re-checked at the end of the wait, as the web does.
                if (!isForeground()) declare(false)
            }
        }
    }

    /** The socket came up (ready) or went away. */
    fun setConnected(next: Boolean) = synchronized(lock) {
        connected = next
        // A new socket knows nothing and an old one is gone: either way the next declaration has to go out.
        reported = null
        if (next) declare(declared)
    }

    fun dispose() = synchronized(lock) {
        cancelTimer()
        connected = false
    }

    private fun cancelTimer() {
        timer?.cancel()
        timer = null
    }

    private fun declare(next: Boolean) {
        declared = next
        if (connected && reported != next) {
            // Recorded only once the send went through.
            reported = if (runCatching { send(next) }.getOrDefault(false)) next else null
        }
    }

    companion object {
        /** How long the app must stay out of the person's way before it says so. */
        const val BACKGROUND_GRACE_MS = 5_000L
    }
}

/**
 * Counts started Activities, which is what "in front of the person" means on a phone: at least one of
 * ours is visible. A configuration change stops and restarts the Activity in the same breath, so a stop
 * that is one does not count as leaving (the manifest handles most itself, this is the belt).
 */
class ProcessForeground : Application.ActivityLifecycleCallbacks {
    @Volatile
    private var started = 0

    @Volatile
    private var listener: (() -> Unit)? = null

    val isForeground: Boolean get() = started > 0

    fun onChange(block: () -> Unit) {
        listener = block
    }

    override fun onActivityStarted(activity: Activity) {
        started += 1
        listener?.invoke()
    }

    override fun onActivityStopped(activity: Activity) {
        started = (started - 1).coerceAtLeast(0)
        if (!activity.isChangingConfigurations) listener?.invoke()
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}

/** Wires the tracker to the app's lifecycle and the socket. Application-scoped, like the socket. */
class AttentionReporter(
    application: Application,
    private val realtime: RealtimeClient,
    scope: CoroutineScope,
) {
    private val foreground = ProcessForeground()
    private val tracker = AttentionTracker(
        scope = scope,
        send = ::sendFrame,
        isForeground = { foreground.isForeground },
    )

    init {
        application.registerActivityLifecycleCallbacks(foreground)
        foreground.onChange { tracker.evaluate() }
        // Ready is the moment the server will take the frame; anything else is "not connected".
        scope.launch {
            realtime.state.map { it == RealtimeState.Ready }.distinctUntilChanged().collect { tracker.setConnected(it) }
        }
    }

    private fun sendFrame(foreground: Boolean): Boolean = realtime.send(attentionFrame(foreground))

    companion object {
        /** `setAttentionMessageSchema`. */
        fun attentionFrame(foreground: Boolean) = buildJsonObject {
            put("type", "set-attention")
            put("foreground", foreground)
        }
    }
}
