package gg.pqp.app.core

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient

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
                else -> _phase.value = SessionPhase.AgeGate
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
