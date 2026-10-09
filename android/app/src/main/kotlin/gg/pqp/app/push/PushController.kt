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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
     * The build could send, but the server has no FCM leg to send *from*:
     * `GET /api/push/config` said `fcm: false`, or the registration came back
     * 409. Nothing else lands here; a network blip is [Offline], not this.
     */
    data object ServerUnsupported : PushState

    /** Everything is in place and the user has not switched it on. */
    data object Off : PushState

    data object Registering : PushState

    /** A token is registered against this account on this server. */
    data object On : PushState

    /**
     * The API could not be reached, or answered with something a later attempt
     * can fix. A retry with backoff is already scheduled (see
     * [PushFailures.backoffMillis]); the next launch starts over if it runs out.
     */
    data object Offline : PushState

    /** Android will not let this app draw notifications. Fixed in Android settings. */
    data object PermissionDenied : PushState

    /** No Google Play services on this phone, so there is no FCM to register with. */
    data object PlayServicesMissing : PushState

    /** The server looked at the registration and refused it. Retrying repeats it. */
    data object Rejected : PushState
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

    /**
     * Whether the one-time "turn on notifications?" explainer should be on
     * screen. Computed at sign-in, answered with [promptAnswered], and never
     * raised again once it has been answered either way: a person who said no
     * finds the switch on the You screen, they are not asked a second time.
     */
    private val _promptNeeded = MutableStateFlow(false)
    val promptNeeded: StateFlow<Boolean> = _promptNeeded.asStateFlow()

    /** The registration in flight, or sleeping between retries. One at a time. */
    private var registerJob: Job? = null

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
            if (!BuildConfig.PUSH_AVAILABLE) return@launch
            if (_state.value is PushState.ServerUnsupported) return@launch
            when {
                // Re-register on every launch, not only on the launch where
                // permission was granted. FCM rotates a token on restore, on
                // cleared data and after long silences, and the old one stops
                // working without telling anybody.
                enabledByUser -> startRegistration()
                // On by default: somebody who has never answered gets
                // notifications as soon as Android allows them. Below Android
                // 13 (or with the permission already held) there is nothing to
                // ask, so it simply turns on. From 13 up an in-app explainer
                // comes first and the system dialog second.
                !decided -> {
                    if (hasNotificationPermission(app)) enable() else _promptNeeded.value = true
                }
            }
        }
    }

    /** The person (or this app on their behalf) has settled the question. */
    private val decided: Boolean
        get() = prefs.contains(KEY_ENABLED) || prefs.getBoolean(KEY_PROMPTED, false)

    private fun onSignedOut() {
        registerJob?.cancel()
        _promptNeeded.value = false
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
        _promptNeeded.value = false
        startRegistration()
    }

    fun disable() {
        registerJob?.cancel()
        enabledByUser = false
        val token = lastToken
        lastToken = null
        _state.value = if (BuildConfig.PUSH_AVAILABLE) PushState.Off else PushState.Unavailable
        notifier.clearAll()
        if (token != null) scope.launch { runCatching { api.unregister(token) } }
        scope.launch { runCatching { firebaseDeleteToken() } }
    }

    /**
     * The explainer dialog was answered. [granted] is the outcome of the system
     * permission request that followed "Turn on"; a "Not now" passes false
     * without ever having asked. Either way the question is settled for good.
     */
    fun promptAnswered(granted: Boolean) {
        prefs.edit { putBoolean(KEY_PROMPTED, true) }
        _promptNeeded.value = false
        if (granted) {
            enable()
        } else {
            enabledByUser = false
        }
    }

    private fun startRegistration() {
        registerJob?.cancel()
        registerJob = scope.launch { registerWithBackoff() }
    }

    /**
     * Register, and on a transient failure keep trying on the
     * [PushFailures.backoffMillis] schedule. Every other outcome is final for
     * this attempt and puts its own reason on screen.
     */
    private suspend fun registerWithBackoff() {
        var attempt = 0
        while (true) {
            if (_state.value !is PushState.Offline) _state.value = PushState.Registering
            val failure = attemptRegistration() ?: return
            _state.value = stateFor(failure)
            if (failure != PushFailure.Transient) return
            val wait = PushFailures.backoffMillis(attempt++) ?: return
            delay(wait)
        }
    }

    /** One try. Null is success; otherwise what went wrong. */
    private suspend fun attemptRegistration(): PushFailure? {
        // Checked before the token: a revoked permission is a state with its
        // own sentence, and a token filed for an app that may not draw
        // anything is a row that produces silence.
        if (!hasNotificationPermission(app)) return PushFailure.PermissionDenied
        val playServices = playServicesPresent()
        if (!playServices) return PushFailure.PlayServicesMissing
        val token = try {
            firebaseToken()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            Log.w(TAG, "no FCM token: ${error.message}")
            return PushFailures.classifyToken(error, playServices)
        }
        return submit(token)
    }

    private fun stateFor(failure: PushFailure): PushState = when (failure) {
        PushFailure.ServerNotConfigured -> PushState.ServerUnsupported
        PushFailure.Transient -> PushState.Offline
        PushFailure.PermissionDenied -> PushState.PermissionDenied
        PushFailure.PlayServicesMissing -> PushState.PlayServicesMissing
        PushFailure.Rejected -> PushState.Rejected
    }

    /**
     * Whether Google Play services is installed and enabled. Without it
     * `FirebaseMessaging` has nothing to talk to, which is a normal state for
     * a Huawei or de-Googled phone and not worth retrying. The manifest's
     * `<queries>` entry is what lets this see the package on Android 11+.
     */
    @Suppress("DEPRECATION")
    private fun playServicesPresent(): Boolean =
        runCatching { app.packageManager.getApplicationInfo(GMS_PACKAGE, 0).enabled }
            .getOrDefault(false)

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
        startRegistration()
    }

    /** POST the token. Null on success, otherwise the classified failure. */
    private suspend fun submit(token: String): PushFailure? =
        try {
            api.register(token)
            lastToken = token
            _state.value = PushState.On
            null
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            Log.w(TAG, "push registration failed: ${error.message}")
            PushFailures.classifyRegistration(error)
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
     * Anything that arrives on `MainActivity`'s intent and names a destination:
     * a notification tap, or a `pqp://` link somebody followed.
     *
     * The two are handled together because they are the same question ("where
     * does this intent want the app to go?") answered by the same parser, and
     * because both have to be *consumed*. The link half was the missing half:
     * `AndroidManifest.xml` has registered the `pqp` scheme since the first
     * commit and nothing ever read `intent.data`, so every invite link opened
     * the app on the server list and said nothing. Advertising a scheme and
     * dropping what arrives through it is worse than not registering it.
     *
     * Returns whether the intent was one of ours, so the caller can leave a
     * plain launcher start alone.
     */
    fun onActivityIntent(intent: Intent?): Boolean {
        val path = intent?.getStringExtra(PushNotifier.EXTRA_PATH)
        val tag = intent?.getStringExtra(PushNotifier.EXTRA_TAG)
        val link = intent?.data?.toString()
        if (path == null && tag == null && link == null) return false

        // Consumed once, all three. An Activity is re-created on every rotation
        // with the same intent attached, and without this the app would jump
        // back to the notification's channel, or re-redeem the invite, every
        // time the phone was turned.
        intent.removeExtra(PushNotifier.EXTRA_PATH)
        intent.removeExtra(PushNotifier.EXTRA_TAG)
        intent.data = null

        val target = DeepLink.target(path)
            ?: tag?.let { DeepLinkTarget.Conversation(it) }
            ?: DeepLink.target(link)
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
        const val KEY_PROMPTED = "prompted"
        const val GMS_PACKAGE = "com.google.android.gms"
    }
}
