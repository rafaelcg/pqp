package gg.pqp.app.push

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.core.content.edit
import com.google.firebase.messaging.FirebaseMessaging
import gg.pqp.app.BuildConfig
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * What the push surface is currently able to do, which is mostly a question
 * about configuration rather than about the user.
 */
sealed interface PushState {
    /**
     * This build has no Firebase project behind it. Terminal until somebody
     * drops a `google-services.json` in and rebuilds; see the note on
     * `pushAvailable` in `app/build.gradle.kts`.
     */
    data object Unavailable : PushState

    /**
     * The build could send, but the server has no FCM leg to send *from*.
     * Also the state a build lands in when registration is refused, because a
     * server that will not accept the token is a server that cannot use it.
     */
    data object ServerUnsupported : PushState

    /** Everything is in place and the user has not switched it on. */
    data object Off : PushState

    data object Registering : PushState

    /** A token is registered against this account on this server. */
    data object On : PushState

    /** A transient failure worth a sentence on screen. */
    data class Failed(val reason: String) : PushState
}

/**
 * Push notifications, from the account's point of view.
 *
 * Owns the FCM token, the registration against the API, whether the app is
 * foregrounded, and the one tapped-notification target waiting to be navigated
 * to. Application-scoped, because a notification can arrive and be tapped with
 * no Activity in the process at all.
 *
 * WHAT THIS CLASS DOES NOT DO, and the list matters more than the list of what
 * it does: it forms no opinion about mute, notification level or
 * do-not-disturb. All three are decided server-side at send time (`shouldPush`
 * in `server/src/services/push.ts`) for the reason that the client which would
 * normally suppress an interruption is, by definition of this whole feature,
 * not running. A second opinion here could only disagree with the first.
 */
class PushController(
    private val app: Application,
    private val session: SessionStore,
    private val scope: CoroutineScope,
) {
    private val notifier = PushNotifier(app)
    private val api = PushApi(session.api)
    private val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val _state = MutableStateFlow<PushState>(
        if (BuildConfig.PUSH_AVAILABLE) PushState.Off else PushState.Unavailable,
    )
    val state: StateFlow<PushState> = _state.asStateFlow()

    /**
     * Whether a DM push may name the sender, as the server reports it. Read
     * only: the toggle for it is not built on this client yet, and inventing a
     * local default would let the phone disagree with the web.
     */
    private val _dmDetails = MutableStateFlow(false)
    val dmDetails: StateFlow<Boolean> = _dmDetails.asStateFlow()

    /**
     * A tapped notification with nowhere to go yet.
     *
     * Held rather than acted on because a cold start routes a tap while the app
     * is still on its splash screen, long before there is a NavController. The
     * UI collects this and clears it with [consumeTarget]. Exactly one is kept:
     * two taps before the first frame is not a thing, and if it were, the
     * second is the one the user meant.
     */
    private val _pendingTarget = MutableStateFlow<DeepLinkTarget?>(null)
    val pendingTarget: StateFlow<DeepLinkTarget?> = _pendingTarget.asStateFlow()

    /** Started activities. Zero means nothing of this app is on screen. */
    @Volatile
    private var startedActivities = 0

    val isForeground: Boolean get() = startedActivities > 0

    private val _enabled = MutableStateFlow(prefs.getBoolean(KEY_ENABLED, false))

    /** The switch's position, which survives a reinstall of nothing and a relaunch of everything. */
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    private var enabledByUser: Boolean
        get() = _enabled.value
        set(value) {
            _enabled.value = value
            prefs.edit { putBoolean(KEY_ENABLED, value) }
        }

    private var lastToken: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit { putString(KEY_TOKEN, value) }

    init {
        app.registerActivityLifecycleCallbacks(ForegroundCounter())
        if (BuildConfig.PUSH_AVAILABLE) notifier.ensureChannel()
        watchSession()
    }

    // ------------------------------------------------------------- lifecycle

    /**
     * Follows the session so that registration happens once there is an account
     * to register against, and stops when there is not.
     *
     * Registering earlier is pointless: every endpoint answers 403 until the
     * age gate clears, and a token filed against no account notifies nobody.
     */
    private fun watchSession() {
        scope.launch {
            var wasReady = false
            session.phase.collect { phase ->
                val ready = phase is SessionPhase.Ready
                if (ready && !wasReady) onSignedIn()
                if (!ready && wasReady) onSignedOut()
                wasReady = ready
            }
        }
    }

    private fun onSignedIn() {
        scope.launch {
            refreshConfig()
            // Re-register on every launch, not only on the launch where
            // permission was granted. FCM rotates a token on restore, on
            // cleared data and after long silences, and the old one stops
            // working without telling anybody.
            if (enabledByUser && _state.value !is PushState.ServerUnsupported) {
                register()
            }
        }
    }

    private fun onSignedOut() {
        VisibleChannel.clear()
        notifier.clearAll()
        val token = lastToken
        lastToken = null
        if (token == null) return
        // Best effort, and ordered this way on purpose: the row has to go
        // before the credential does, or the next person to hold this phone
        // gets the last one's notifications. A failure here is not worth a
        // message, because there is no longer a screen it belongs on.
        scope.launch { runCatching { api.unregister(token) } }
    }

    // ------------------------------------------------------------- the toggle

    /**
     * Ask the server what it can send, and park the surface if the answer is
     * "nothing this app can use".
     */
    suspend fun refreshConfig() {
        if (!BuildConfig.PUSH_AVAILABLE) return
        val config = runCatching { api.config() }.getOrElse {
            Log.w(TAG, "push config failed: ${it.message}")
            return
        }
        _dmDetails.value = config.dmDetails
        if (!config.fcm) {
            _state.value = PushState.ServerUnsupported
            return
        }
        if (_state.value is PushState.ServerUnsupported) {
            _state.value = if (enabledByUser) PushState.On else PushState.Off
        }
    }

    /**
     * Switch notifications on for this account on this device.
     *
     * Called after POST_NOTIFICATIONS has been granted, because a token
     * registered for an app that is not allowed to draw anything is a row on
     * the server that produces silence.
     */
    fun enable() {
        if (!BuildConfig.PUSH_AVAILABLE) return
        enabledByUser = true
        scope.launch { register() }
    }

    fun disable() {
        enabledByUser = false
        val token = lastToken
        lastToken = null
        _state.value = if (BuildConfig.PUSH_AVAILABLE) PushState.Off else PushState.Unavailable
        notifier.clearAll()
        if (token != null) scope.launch { runCatching { api.unregister(token) } }
        scope.launch { runCatching { firebaseDeleteToken() } }
    }

    private suspend fun register() {
        _state.value = PushState.Registering
        val token = runCatching { firebaseToken() }.getOrElse { error ->
            // The overwhelmingly likely cause is a build with no Firebase
            // project, which the flag should already have caught; anything else
            // is Google Play services missing or too old, which is a real
            // device state on some hardware and not something to nag about.
            Log.w(TAG, "no FCM token: ${error.message}")
            _state.value = PushState.Unavailable
            return
        }
        submit(token)
    }

    /**
     * `onNewToken`, arriving from [PqpMessagingService].
     *
     * FCM delivers this whenever it rotates, including while the app is in the
     * background, so it is filed even when the user has not switched the
     * feature on: the value is what makes the *next* enable a single call.
     */
    fun onTokenRefreshed(token: String) {
        if (token == lastToken) return
        if (!enabledByUser) {
            lastToken = token
            return
        }
        scope.launch { submit(token) }
    }

    private suspend fun submit(token: String) {
        runCatching { api.register(token) }
            .onSuccess {
                lastToken = token
                _state.value = PushState.On
            }
            .onFailure { error ->
                // A 400 here is not a bug in this client and not something to
                // put in front of anybody: it is the server's registration
                // schema refusing a shape it does not know, which is exactly
                // what it does until an FCM leg exists. See PushApi's note.
                Log.w(TAG, "push registration refused: ${error.message}")
                _state.value = PushState.ServerUnsupported
            }
    }

    // ------------------------------------------------------------- delivery

    /**
     * A push has arrived. Draw it, unless the person is already looking at it.
     *
     * Runs on whatever thread FCM chose, which is why every input is either
     * immutable or `@Volatile`.
     */
    fun onMessageReceived(data: Map<String, String>) {
        val message = PushMessage.from(data) ?: return
        if (!PushPresentation.shouldNotify(message, VisibleChannel.id, isForeground)) {
            return
        }
        notifier.show(message)
    }

    // ------------------------------------------------------------ navigation

    /**
     * A notification tap, as it arrives on `MainActivity`'s intent.
     *
     * Returns whether the intent was one of ours, so the caller can leave a
     * plain launcher start alone.
     */
    fun onActivityIntent(intent: Intent?): Boolean {
        val path = intent?.getStringExtra(PushNotifier.EXTRA_PATH)
        val tag = intent?.getStringExtra(PushNotifier.EXTRA_TAG)
        if (path == null && tag == null) return false

        // The extras are consumed once. An Activity is re-created on every
        // rotation with the same intent attached, and without this the app
        // would jump back to the notification's channel every time the phone
        // was turned.
        intent.removeExtra(PushNotifier.EXTRA_PATH)
        intent.removeExtra(PushNotifier.EXTRA_TAG)

        val target = DeepLink.target(path)
            ?: tag?.let { DeepLinkTarget.Conversation(it) }
            ?: return false
        _pendingTarget.value = target
        return true
    }

    fun consumeTarget() {
        _pendingTarget.value = null
    }

    // -------------------------------------------------------------- firebase

    /**
     * `FirebaseMessaging.getToken()` as a suspend function.
     *
     * Hand-rolled rather than pulling in `kotlinx-coroutines-play-services` for
     * two call sites. `getInstance()` throws rather than returning null when no
     * Firebase project is configured, which is caught by the caller.
     *
     * `getToken`/`deleteToken` are deprecated in favour of
     * `register`/`unregister`, and are used regardless: they are the pair that
     * yields an **FCM registration token**, which is what an FCM send addresses
     * and what a server SDK expects. The replacements yield a Firebase
     * Installation ID instead. See the long note on
     * [PqpMessagingService.onNewToken].
     */
    @Suppress("DEPRECATION")
    private suspend fun firebaseToken(): String =
        suspendCancellableCoroutine { continuation ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (!continuation.isActive) return@addOnCompleteListener
                val token = task.result
                if (task.isSuccessful && token != null) {
                    continuation.resume(token)
                } else {
                    continuation.cancel(task.exception ?: IllegalStateException("no token"))
                }
            }
        }

    @Suppress("DEPRECATION")
    private suspend fun firebaseDeleteToken() {
        suspendCancellableCoroutine { continuation ->
            FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener {
                if (continuation.isActive) continuation.resume(Unit)
            }
        }
    }

    // ------------------------------------------------------------ foreground

    /**
     * Counts started activities.
     *
     * `ProcessLifecycleOwner` would say the same thing and would cost another
     * dependency (`lifecycle-process`) for one boolean. STARTED rather than
     * RESUMED because a chat behind a permission dialog is still being read.
     */
    private inner class ForegroundCounter : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
            startedActivities += 1
        }

        override fun onActivityStopped(activity: Activity) {
            startedActivities = (startedActivities - 1).coerceAtLeast(0)
            // Nothing of this app is on screen, so nothing is being read. Not
            // strictly needed (shouldNotify ignores the visible channel when
            // backgrounded) but it keeps the two from ever disagreeing.
            if (startedActivities == 0) VisibleChannel.clear()
        }

        override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
        override fun onActivityResumed(activity: Activity) = Unit
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, out: Bundle) = Unit
        override fun onActivityDestroyed(activity: Activity) = Unit
    }

    private companion object {
        const val TAG = "pqp.push"
        const val PREFS = "pqp.push"
        const val KEY_ENABLED = "enabled"
        const val KEY_TOKEN = "token"
    }
}
