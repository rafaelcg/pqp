package gg.pqp.app.core

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import gg.pqp.app.ui.screens.ServerActions
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
     * Whether [servers] has ever been answered since sign-in. An account in no
     * server and a list that has not arrived are both empty; this tells them apart.
     */
    private val _serversLoaded = MutableStateFlow(false)
    val serversLoaded: StateFlow<Boolean> = _serversLoaded.asStateFlow()

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
     * A server this account lost (kicked, banned, deleted), once the list has dropped it. The
     * screens that are open inside it leave, and the person is told why, once.
     */
    private val _serverGone = MutableStateFlow<List<ServerGone>>(emptyList())

    /**
     * Held until the UI says it has dealt with them ([acknowledgeGone]), not emitted: a removal that lands while
     * nothing is collecting (the navigation host is between lifecycles) must still pop the screens inside that
     * server and say why once it is back.
     */
    val serverGone: StateFlow<List<ServerGone>> = _serverGone.asStateFlow()

    fun acknowledgeGone(handled: List<ServerGone>) {
        _serverGone.update { pending -> pending.filterNot { it in handled } }
    }

    private fun onAccountFrame(frame: JsonObject) {
        when ((frame["type"] as? JsonPrimitive)?.contentOrNull) {
            "server-removed" -> AccountFrames.serverRemoved(frame)?.let { removed ->
                val lost = synchronized(orderLock) {
                    val (rest, lost) = AccountFrames.apply(_servers.value, removed) ?: return@synchronized null
                    _servers.value = rest
                    lost
                }
                if (lost != null) _serverGone.update { it + lost }
            }
            "own-status" -> AccountFrames.ownStatus(frame)?.let(::onRemoteStatus)
        }
    }

    private val statusLock = Any()
    private var statusSaving = 0
    private var statusGeneration = 0
    private val heldStatus = mutableListOf<String>()

    /** The account's own manual status, as the session holds it. */
    fun ownStatus(): String = OwnStatus.read((_phase.value as? SessionPhase.Ready)?.me?.preferences?.status)

    private fun applyOwnStatus(status: String) {
        val current = (_phase.value as? SessionPhase.Ready)?.me ?: return
        _phase.value = SessionPhase.Ready(
            current.copy(preferences = (current.preferences ?: MePreferences()).copy(status = status)),
        )
    }

    /** Another device of this account chose a status. Held while this phone's own write is in the air. */
    private fun onRemoteStatus(status: String) {
        synchronized(statusLock) {
            if (statusSaving > 0) {
                heldStatus += status
                return
            }
            statusGeneration += 1
        }
        applyOwnStatus(status)
    }

    /**
     * Choose a status. Optimistic, then awaited: this is the one preference that must not be
     * fire-and-forget, because "I picked invisible, the request failed, nobody told me" is
     * somebody believing they are hidden while they are not. A failure puts the old choice back
     * and calls [onError]. See [OwnStatus.needsReadBack] for what arrives meanwhile.
     */
    fun setOwnStatus(wanted: String, onError: () -> Unit) {
        val previous = ownStatus()
        if (wanted == previous || wanted !in OwnStatus.CHOICES) return
        val mine = synchronized(statusLock) {
            statusSaving += 1
            statusGeneration += 1
            heldStatus.clear()
            statusGeneration
        }
        applyOwnStatus(wanted)
        scope.launch {
            val saved = runSuspendCatching { api.setStatus(wanted) }.isSuccess
            val held: List<String>
            val generation: Int
            synchronized(statusLock) {
                statusSaving -= 1
                held = heldStatus.toList()
                heldStatus.clear()
                generation = statusGeneration
            }
            when {
                !saved -> {
                    // Only the newest choice puts the old one back: if another was made while this one was
                    // in the air, that one owns the row and an earlier failure must not undo it.
                    if (generation == mine) {
                        // Another device's choice that arrived meanwhile is newer than the one that failed.
                        applyOwnStatus(held.lastOrNull() ?: previous)
                        onError()
                    }
                }
                OwnStatus.needsReadBack(wanted, held) -> {
                    val stored = runSuspendCatching { api.me() }.getOrNull()
                        ?.let { OwnStatus.read(it.preferences?.status) }
                    // A newer save or frame has a fresher answer than this read, issued before it.
                    if (synchronized(statusLock) { statusGeneration == generation }) {
                        applyOwnStatus(stored ?: held.last())
                    }
                }
            }
        }
    }

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
                runSuspendCatching { api.me() }.getOrElse { error ->
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
                    followRemoteServerOrder()
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
     * Change the stored preferences held by the session, at once. The writer
     * (`ConversationPrefs`) owns the request; this is only the local half, so
     * every screen reads one value.
     */
    fun updatePreferences(transform: (MePreferences) -> MePreferences) {
        val current = (_phase.value as? SessionPhase.Ready)?.me ?: return
        _phase.value = SessionPhase.Ready(
            current.copy(preferences = transform(current.preferences ?: MePreferences())),
        )
    }

    /**
     * Chamar a atenção's opt-out, reflected into the session the moment it is
     * chosen, so every screen reads one value and a remount never shows the
     * one from launch. The write itself is `NudgePreference`'s.
     */
    fun applyAllowNudges(allow: Boolean) {
        val current = (_phase.value as? SessionPhase.Ready)?.me ?: return
        _phase.value = SessionPhase.Ready(
            current.copy(preferences = (current.preferences ?: MePreferences()).copy(allowNudges = allow)),
        )
    }

    /**
     * Voice note transcription's two switches, reflected into the session the moment they are chosen,
     * so every screen reads one value. The write itself is `VoiceTranscriptionPreference`'s.
     */
    fun applyVoiceTranscription(prefs: VoiceTranscriptionPrefs) {
        val current = (_phase.value as? SessionPhase.Ready)?.me ?: return
        _phase.value = SessionPhase.Ready(
            current.copy(preferences = (current.preferences ?: MePreferences()).copy(voiceTranscription = prefs)),
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
        // Bound to the credential of the account that finished, not to the
        // swappable `tokens`: a sign-out and sign-in racing this write must
        // not mark somebody else's first run as done.
        val bound = ApiClient(tokens, http)
        scope.launch {
            runCatching { bound.markOnboarded(now) }
                .onFailure { Log.w(TAG, "onboardedAt not saved: ${it.message}") }
        }
        // The invite link's join was still running when the wizard handed
        // over (the ten-second cap on "Entrar em"). It lives on this scope,
        // not on the wizard's, so it finishes anyway, and the room opens then.
        val join = inviteJoin
        if (landing == null && join != null && join.isActive) {
            scope.launch {
                val joined = join.await() ?: return@launch
                if ((_phase.value as? SessionPhase.Ready)?.me?.id == current.id) {
                    _landing.value = Landing(joined.serverId, joined.serverName, Landing.Kind.Arrived)
                }
            }
        }
        inviteJoin = null
    }

    /**
     * The invite link's join, started when first run begins and owned by the
     * session rather than by a screen, so the wizard closing cannot cancel
     * the only attempt at a code that has already been taken off the link.
     */
    private var inviteJoin: kotlinx.coroutines.Deferred<JoinInviteResponse?>? = null

    fun startInviteJoin(code: String): kotlinx.coroutines.Deferred<JoinInviteResponse?> =
        inviteJoin ?: scope.async { redeemInvite(code) }.also { inviteJoin = it }

    fun refreshServers() {
        scope.launch {
            runCatching { api.servers() }
                .onSuccess { fresh ->
                    _serversLoaded.value = true
                    // A read that began before a move can land while that move's
                    // save is still queued or in the air: keep the order the
                    // person just chose over the one the read carries.
                    synchronized(orderLock) {
                        _servers.value = if (orderSavesPending > 0) {
                            gg.pqp.app.ui.screens.ServerActions
                                .applyOrder(fresh, _servers.value.map { it.id })
                        } else {
                            fresh
                        }
                    }
                }
                .onFailure { Log.w(TAG, "servers failed: ${it.message}") }
        }
    }

    /**
     * Move a server up or down one place in this account's own list, and save
     * it. Optimistic: the list moves now. Nothing happens at the ends.
     *
     * SAVES RUN ONE AT A TIME (the [orderSaves] mutex). Two requests in the air
     * can be processed in either order and leave the stored order older than
     * the one shown. Each queued save sends the order as it is when its turn
     * comes, so several quick moves collapse into one request (a later turn
     * that finds the stored order already current sends nothing). A refused
     * save puts the order back to the last one the server confirmed, never to
     * an intermediate one that was not saved, changing only the order, and
     * [onError] gets the server's own sentence.
     */
    fun moveServer(serverId: String, delta: Int, onError: (String) -> Unit) {
        synchronized(orderLock) {
            val moved = gg.pqp.app.ui.screens.ServerActions
                .reordered(_servers.value, serverId, delta) ?: return
            if (confirmedOrder == null) {
                confirmedOrder = _servers.value.map { it.id }
            }
            orderSavesPending += 1
            _servers.value = moved
        }
        scope.launch {
            try {
                orderSaves.withLock {
                    val ids = _servers.value.map { it.id }
                    if (ids == synchronized(orderLock) { confirmedOrder }) return@withLock
                    runCatching { api.saveServerOrder(ids, orderOrigin) }
                        .onSuccess {
                            synchronized(orderLock) {
                                confirmedOrder = ids
                                orderLedger.saveSucceeded()
                            }
                        }
                        .onFailure {
                            synchronized(orderLock) {
                                val back = confirmedOrder.orEmpty()
                                _servers.value = gg.pqp.app.ui.screens.ServerActions
                                    .applyOrder(_servers.value, back)
                            }
                            synchronized(orderLock) { orderLedger.saveFailed() }
                            onError(it.message.orEmpty())
                        }
                }
            } finally {
                synchronized(orderLock) {
                    orderSavesPending -= 1
                    if (orderSavesPending == 0) {
                        confirmedOrder = null
                        // A reorder from another device that arrived while saves were out was
                        // ignored (the order here was the newer one). If a save FAILED, ours is
                        // not the newest any more, so the one that was ignored is.
                        orderLedger.settle(_servers.value)?.let { _servers.value = it }
                    }
                }
            }
        }
    }

    private val orderSaves = Mutex()
    private val orderLock = Any()
    private var orderSavesPending = 0
    private var confirmedOrder: List<String>? = null

    /** What a remote `server-order-update` that arrived during our saves means once they settle. */
    private val orderLedger = ServerOrderLedger()

    /** Named on every save, so this phone's own `server-order-update` echo is recognised. */
    private val orderOrigin = "android-" + java.util.UUID.randomUUID().toString().take(8)

    private var orderFollowJob: Job? = null

    /**
     * Follow the order this account drew on another tab or device, live. The
     * server addresses the frame to every socket of the person; the list
     * already answers in the saved order on open, so this is only about not
     * waiting for the next open ([ServerActions.followRemoteOrder] is the rule).
     */
    private fun followRemoteServerOrder() {
        orderFollowJob?.cancel()
        orderFollowJob = scope.launch {
            realtime.frames.collect { frame ->
                when ((frame["type"] as? JsonPrimitive)?.contentOrNull) {
                    "server-order-update" -> {
                        val ids = (frame["serverIds"] as? JsonArray)
                            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                            ?: return@collect
                        val sender = (frame["origin"] as? JsonPrimitive)?.contentOrNull
                        synchronized(orderLock) {
                            val saving = orderSavesPending > 0
                            if (saving && sender != orderOrigin) orderLedger.ignored(ids)
                            ServerActions.followRemoteOrder(
                                _servers.value, ids, sender, orderOrigin, saving = saving,
                            )?.let { _servers.value = it }
                        }
                    }
                }
            }
        }
    }

    /**
     * `idempotencyKey`, when given, is forwarded to [ApiClient.createServer]
     * so a caller that retries this call for the same room (the person
     * reopening the create dialog and typing the same name again after a
     * failure, say) gets that room back instead of a second one. `onSuccess`
     * is the caller's cue that the attempt is over and the key may be
     * retired; a caller with nothing to do there may leave it as the no-op
     * default.
     */
    fun createServer(
        name: String,
        idempotencyKey: String? = null,
        onSuccess: () -> Unit = {},
        onError: (String) -> Unit,
    ) {
        scope.launch {
            runCatching { api.createServer(name, idempotencyKey) }
                .onSuccess {
                    refreshServers()
                    onSuccess()
                }
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
        _serversLoaded.value = false
        _linkError.value = null
        _landing.value = null
        inviteJoin?.cancel()
        inviteJoin = null
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

    // The frames addressed to the account itself, which no screen owns: a server taken away
    // (`server-removed`) and a status chosen on another device (`own-status`). Started with the
    // store, because the socket outlives every screen. Last in the class on purpose: the collector
    // may run at once, and everything it touches has to exist by then.
    init {
        scope.launch { realtime.frames.collect(::onAccountFrame) }
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
