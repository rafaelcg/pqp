package gg.pqp.app.core

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import gg.pqp.app.onboarding.markOnboarded
import okhttp3.OkHttpClient

/**
 * The room first run opens when it hands over, and how to greet the person
 * there. [inviteCode] is the organizer's fresh invite, for the owner banner's
 * copy button; null for everybody else.
 */
data class Landing(
    val serverId: String,
    val serverName: String,
    val kind: Kind,
    val inviteCode: String? = null,
) {
    enum class Kind {
        /** Arrived on an invite (the link, or the room step's invite door). */
        Arrived,

        /** Made the room during first run. */
        Owner,
    }
}

/**
 * Which screen the app is allowed to be on.
 *
 * `AgeGate` is a phase rather than a screen flag because it is enforced by the
 * server, not by us: until it clears, every endpoint except four answers 403
 * and the WebSocket refuses the handshake. Treating it as a normal loading
 * failure produces an app that looks broken.
 */
sealed interface SessionPhase {
    data object Launching : SessionPhase
    data object SignedOut : SessionPhase
    data object AgeGate : SessionPhase
    data class Ready(val me: Me) : SessionPhase
    data class Blocked(val reason: String) : SessionPhase
    data class Failed(val reason: String) : SessionPhase
}

/**
 * The one object that knows whether there is a session, and the owner of the
 * clients that need one.
 *
 * Nothing on the launch path may wait indefinitely: the splash has no controls,
 * so anything that hangs during restore strands the app on a logo. `restore()`
 * therefore carries its own deadline on top of OkHttp's timeouts.
 */
class SessionStore(
    private val scope: CoroutineScope,
    /** Shared with the API and the socket; the connection check borrows it too. */
    val http: OkHttpClient = ApiClient.defaultHttpClient(),
) {
    private val _phase = MutableStateFlow<SessionPhase>(SessionPhase.Launching)
    val phase: StateFlow<SessionPhase> = _phase.asStateFlow()

    private val _servers = MutableStateFlow<List<ServerSummary>>(emptyList())
    val servers: StateFlow<List<ServerSummary>> = _servers.asStateFlow()

    /**
     * Why the last `pqp://` link went nowhere, in the server's own words.
     *
     * A followed link that silently does nothing is indistinguishable from a
     * broken app, and only the server knows whether the invite was expired,
     * revoked, exhausted, or the account banned from that server.
     */
    private val _linkError = MutableStateFlow<String?>(null)
    val linkError: StateFlow<String?> = _linkError.asStateFlow()

    /**
     * Swapped when the account changes, which is why it is a `var` behind a
     * delegating provider rather than a constructor argument: the API and the
     * socket are built once and must not be rebuilt on sign-in.
     */
    @Volatile
    var tokens: TokenProvider = when (Backend.authMode) {
        AuthMode.Clerk -> ClerkTokenProvider()
        AuthMode.DevBypass -> DevTokenProvider()
        // A release build with no Clerk key. It has no credential to offer, and
        // handing out the dev token here would send a request that any real
        // server refuses, so this answers null and every call 401s honestly.
        // `SignInScreen` shows the explanation; this just refuses to invent one.
        AuthMode.Misconfigured -> TokenProvider { null }
    }
        private set

    private val delegating = TokenProvider { tokens.currentToken() }

    val api: ApiClient = ApiClient(delegating, http)
    val realtime: RealtimeClient = RealtimeClient(delegating, scope, http)

    private var restoreJob: Job? = null

    /**
     * Whether the account sitting at the age gate will be shown the wizard
     * after it, so the gate can draw the right number of dots. Read from the
     * same `/api/me` that sent the phase there.
     */
    @Volatile
    var gateLeadsToOnboarding: Boolean = true
        private set

    /**
     * Where the app should open the moment first run hands over: the room an
     * invite joined, or the one the organizer just made. Consumed once by the
     * signed-in navigation, which also draws the arrival banner from it.
     */
    private val _landing = MutableStateFlow<Landing?>(null)
    val landing: StateFlow<Landing?> = _landing.asStateFlow()

    fun consumeLanding() {
        _landing.value = null
    }

    fun useDevAccount(suffix: String? = null) {
        tokens = DevTokenProvider(suffix)
        restore()
    }

    fun restore() {
        restoreJob?.cancel()
        restoreJob = scope.launch {
            _phase.value = SessionPhase.Launching
            val me = withTimeoutOrNull(LAUNCH_DEADLINE_MS) {
                runCatching { api.me() }.getOrElse { error ->
                    when {
                        error is ApiException && error.isUnauthorized -> null
                        else -> {
                            Log.w(TAG, "restore failed: ${error.message}")
                            _phase.value = SessionPhase.Failed(error.message ?: "")
                            return@withTimeoutOrNull null
                        }
                    }
                }
            }

            if (_phase.value is SessionPhase.Failed) return@launch

            when (me?.ageGate) {
                null -> _phase.value = SessionPhase.SignedOut
                "passed" -> {
                    _phase.value = SessionPhase.Ready(me)
                    realtime.connect()
                    refreshServers()
                }
                "blocked" -> _phase.value = SessionPhase.Blocked(me.ageGate)
                else -> {
                    gateLeadsToOnboarding = gg.pqp.app.onboarding.shouldRunOnboarding(me)
                    _phase.value = SessionPhase.AgeGate
                }
            }
        }
    }

    fun submitAgeCheck(dateOfBirth: String, onError: (String) -> Unit) {
        scope.launch {
            runCatching { api.submitAgeCheck(dateOfBirth) }
                .onSuccess { restore() }
                .onFailure { onError(it.message.orEmpty()) }
        }
    }

    /**
     * A profile saved on the wizard's "você" step, reflected into the session
     * without a round trip. The preferences are kept from the session rather
     * than taken from the response, so a save can never be the thing that
     * reads as "onboarding finished" or "not finished".
     */
    fun applyProfile(updated: Me) {
        val current = (_phase.value as? SessionPhase.Ready)?.me ?: return
        _phase.value = SessionPhase.Ready(
            updated.copy(ageGate = current.ageGate, preferences = current.preferences),
        )
    }

    /**
     * Close the wizard for good, on every device, and open [landing] behind it.
     *
     * The phase moves first and the write is not awaited: a failed write costs
     * one repeat of the wizard on the next launch, whereas awaiting it would
     * make a slow network look like a frozen button on the last tap of signup.
     */
    fun finishOnboarding(landing: Landing?) {
        val current = (_phase.value as? SessionPhase.Ready)?.me ?: return
        val now = java.time.Instant.now().toString()
        _landing.value = landing
        _phase.value = SessionPhase.Ready(
            current.copy(preferences = (current.preferences ?: MePreferences()).copy(onboardedAt = now)),
        )
        scope.launch {
            runCatching { api.markOnboarded(now) }
                .onFailure { Log.w(TAG, "onboardedAt not saved: ${it.message}") }
        }
    }

    fun refreshServers() {
        scope.launch {
            runCatching { api.servers() }
                .onSuccess { _servers.value = it }
                .onFailure { Log.w(TAG, "servers failed: ${it.message}") }
        }
    }

    fun createServer(name: String, onError: (String) -> Unit) {
        scope.launch {
            runCatching { api.createServer(name) }
                .onSuccess { refreshServers() }
                .onFailure { onError(it.message.orEmpty()) }
        }
    }

    /**
     * Delete a community, or leave one, then re-read the list.
     *
     * Both refusals are handed to [onError] in the server's own words, the way
     * [createServer] and [redeemInvite] do: only the server knows whether a
     * delete was refused because the caller is no longer the owner, or a leave
     * because they are.
     *
     * These two are the reason `DELETE /api/me` is not a dead end on Android.
     * Its 409 tells somebody to hand over or delete the communities they own,
     * and until now the app had nowhere to do either.
     */
    fun deleteServer(serverId: String, onError: (String) -> Unit) {
        scope.launch {
            runCatching { api.deleteServer(serverId) }
                .onSuccess { refreshServers() }
                .onFailure { onError(it.message.orEmpty()) }
        }
    }

    fun leaveServer(serverId: String, onError: (String) -> Unit) {
        scope.launch {
            runCatching { api.leaveServer(serverId) }
                .onSuccess { refreshServers() }
                .onFailure { onError(it.message.orEmpty()) }
        }
    }

    /**
     * Redeem an invite and answer with the server it let us into, or null if it
     * was refused, in which case [linkError] carries the server's reason.
     *
     * The name is taken from the response rather than looked up in [servers]
     * afterwards: `refreshServers` is a separate round trip and the caller
     * navigates immediately, so a lookup would find nothing and title the
     * screen blank on the one path where the name is guaranteed to be known.
     */
    suspend fun redeemInvite(code: String): JoinInviteResponse? = try {
        _linkError.value = null
        val joined = api.joinInvite(code)
        refreshServers()
        joined
    } catch (cancelled: kotlinx.coroutines.CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        _linkError.value = (error as? ApiException)?.serverMessage ?: error.message.orEmpty()
        null
    }

    fun clearLinkError() {
        _linkError.value = null
    }

    fun signOutLocally() {
        realtime.disconnect()
        _servers.value = emptyList()
        _linkError.value = null
        _landing.value = null
        _phase.value = SessionPhase.SignedOut
    }

    /**
     * Ends the Clerk session first, while the call can still authenticate,
     * then forgets it locally. Clearing local state first would leave a live
     * session on the device with nothing able to revoke it.
     *
     * Here rather than on the account screen because it has a second caller
     * now: the connection banner's "Sign in again", which is the only fix for
     * a session the server has stopped accepting.
     */
    fun signOut() {
        scope.launch {
            if (Backend.authMode == AuthMode.Clerk) {
                runCatching { com.clerk.api.Clerk.auth.signOut() }
            }
            signOutLocally()
        }
    }

    companion object {
        private const val TAG = "pqp.session"

        /**
         * A backstop, not the mechanism. The clients fail fast on their own;
         * this only exists so that a case nobody thought of still ends on a
         * screen with a button rather than on the splash forever.
         */
        private const val LAUNCH_DEADLINE_MS = 12_000L
    }
}
