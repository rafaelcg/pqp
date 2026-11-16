package gg.pqp.app.activities

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Starting an activity from a channel, in as few taps as the rules allow: one
 * tap on the tile starts it when this person has already accepted the app, and
 * the consent sheet comes first when they have not (the first time per app,
 * `join-model.ts` on the web), so a person who says "agora não" has started
 * nothing.
 *
 * ONE START REQUEST PER CHANNEL AT A TIME. A second tap while one is out does
 * nothing, and a start that outlives [START_TIMEOUT_MS] is cancelled and reads as
 * a failure. If the server did start it after all, the `channel-app` frame brings
 * it into the store and the strip offers it, and a retry meets a 409 that names
 * it, which is adopted the same way.
 *
 * Pure of Android: the screen hands in the two things it needs (the API's
 * start call and the consents), so a JVM test drives it.
 */
class ActivityStarter(
    private val scope: CoroutineScope,
    private val store: ActivitiesStore,
    private val consents: ActivityConsents,
    private val channelId: String,
    private val start: suspend (appId: String) -> ActivitySession,
) {
    data class State(
        /** The app a start is in flight for. */
        val starting: String? = null,
        val failure: ActivityRules.StartFailure? = null,
        /** The user id of whoever started the activity that is already there, for the failure line. */
        val liveByUserId: String? = null,
        /** The app the consent sheet is open for. */
        val consentFor: String? = null,
        val consentWorking: Boolean = false,
        val consentFailed: Boolean = false,
    )

    /** What the screen does when an activity starts here: open it. */
    data class Started(val session: ActivitySession)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private val _started = MutableSharedFlow<Started>(extraBufferCapacity = 4)
    val started: SharedFlow<Started> = _started.asSharedFlow()

    private var inFlight: kotlinx.coroutines.Job? = null

    /** A tap on a tile that can start here. */
    fun tap(app: ActivityApp) {
        if (_state.value.starting != null) return
        _state.update { it.copy(failure = null, liveByUserId = null) }
        scope.launch {
            if (consents.accepted(app.id)) {
                begin(app.id)
            } else {
                _state.update { it.copy(consentFor = app.id, consentFailed = false, consentWorking = false) }
            }
        }
    }

    /** "Começar" on the consent sheet: record the acceptance, then start. */
    fun confirmConsent(app: ActivityApp, identityGranted: Boolean) {
        if (_state.value.consentWorking) return
        _state.update { it.copy(consentWorking = true, consentFailed = false) }
        scope.launch {
            try {
                consents.accept(app.id, identityGranted)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(consentWorking = false, consentFailed = true) }
                return@launch
            }
            _state.update { it.copy(consentFor = null, consentWorking = false) }
            begin(app.id)
        }
    }

    fun dismissConsent() {
        if (_state.value.consentWorking) return
        _state.update { it.copy(consentFor = null, consentFailed = false) }
    }

    fun clearFailure() {
        _state.update { it.copy(failure = null, liveByUserId = null) }
    }

    private fun begin(appId: String) {
        if (inFlight?.isActive == true) return
        _state.update { it.copy(starting = appId, failure = null) }
        inFlight = scope.launch {
            val outcome = runCatching { withTimeoutOrNull(START_TIMEOUT_MS) { start(appId) } }
            val session = outcome.getOrNull()
            val error = outcome.exceptionOrNull()
            if (error is CancellationException) throw error
            when {
                session != null -> {
                    store.adopt(channelId, session)
                    _state.update { it.copy(starting = null) }
                    _started.tryEmit(Started(session))
                }

                error is StartRefusal.AlreadyLive -> {
                    // Somebody started one first: it is the live one now, and the strip says so.
                    error.session?.let { store.adopt(channelId, it) }
                    _state.update {
                        it.copy(starting = null, failure = ActivityRules.StartFailure.SessionLive, liveByUserId = error.session?.startedBy)
                    }
                }

                error is StartRefusal -> _state.update { it.copy(starting = null, failure = ActivityRules.failureOf(error)) }
                else -> _state.update { it.copy(starting = null, failure = ActivityRules.StartFailure.Failed) }
            }
        }
    }

    companion object {
        /** A start that outlives this is a failure the person can retry (eight seconds, as on the web). */
        const val START_TIMEOUT_MS = 8_000L
    }
}
