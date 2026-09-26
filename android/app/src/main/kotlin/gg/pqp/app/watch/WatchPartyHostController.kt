package gg.pqp.app.watch

import android.content.Intent
import android.util.Log
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionStore
import gg.pqp.app.voice.VoiceController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What this phone is in the middle of doing to a party it is hosting, if anything. */
enum class WatchPartyHostBusy { None, Creating, GoingLive, Ending }

data class WatchPartyHostState(
    val busy: WatchPartyHostBusy = WatchPartyHostBusy.None,
    /** The server's own sentence for the last refusal, or null. */
    val error: String? = null,
)

/**
 * Hosting a watch party from this phone: create, go live, end.
 *
 * Application-scoped, like [gg.pqp.app.voice.CallController], and for the
 * same reason it is allowed to hold [voice] where [WatchLiveStore] by design
 * cannot ([WatchLiveStore]'s own class doc calls this out: nothing there can
 * reach [VoiceController], structurally). Hosting genuinely IS a call, seat
 * and all -- the screen share this reuses already requires one -- and this
 * class is where that seam is deliberately crossed. Watching stays entirely
 * inside [WatchLiveStore], untouched by anything in this file.
 *
 * A phone hosts at most one party at a time: one screen to capture, one
 * voice seat to hold. So one [state] for the whole process is enough; there
 * is no per-channel host state to keep separate the way [WatchLiveStore]
 * keeps [WatchLiveStore.parties] per channel.
 */
class WatchPartyHostController(
    private val session: SessionStore,
    private val voice: VoiceController,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(WatchPartyHostState())
    val state: StateFlow<WatchPartyHostState> = _state.asStateFlow()

    fun dismissError() {
        _state.value = _state.value.copy(error = null)
    }

    /**
     * "Criar watch party". Always a name-only, immediate `draft` -- no
     * scheduling in this build (see `WatchPartyApi.createWatchParty`'s doc).
     * The created party reaches [WatchLiveStore.parties] via the
     * `watch-party-update` this call itself provokes; nothing here applies
     * an optimistic copy, matching how the web treats every watch-party
     * mutation.
     */
    fun create(channelId: String, name: String) {
        run(WatchPartyHostBusy.Creating) {
            session.api.createWatchParty(channelId, name.trim())
        }
    }

    /**
     * "Ir ao vivo". See [performWatchPartyGoLive] for the ordering this
     * wires up: the state transition, then the room join, then the capture
     * -- in that order, on purpose.
     */
    fun goLive(channelId: String, channelName: String?, partyId: String, lowLatency: Boolean, consent: Intent) {
        run(WatchPartyHostBusy.GoingLive) {
            performWatchPartyGoLive(
                setLive = { session.api.setWatchPartyState(partyId, "live", lowLatency) != null },
                joinVoice = { voice.join(channelId, channelName) },
                startScreenShare = { data: Intent -> voice.startScreenShare(data) },
                consent = consent,
            )
        }
    }

    /** "Encerrar". See [performWatchPartyEnd] for the two effects and their order. */
    fun end(partyId: String) {
        run(WatchPartyHostBusy.Ending) {
            performWatchPartyEnd(
                setEnded = { session.api.setWatchPartyState(partyId, "ended") },
                leaveVoice = { voice.leave() },
            )
        }
    }

    private fun run(busy: WatchPartyHostBusy, block: suspend () -> Unit) {
        scope.launch {
            _state.value = WatchPartyHostState(busy = busy)
            try {
                block()
                _state.value = WatchPartyHostState()
            } catch (e: ApiException) {
                Log.w(TAG, "watch party host action ($busy) refused: ${e.serverMessage}")
                _state.value = WatchPartyHostState(error = e.serverMessage)
            } catch (e: Exception) {
                Log.w(TAG, "watch party host action ($busy) failed: ${e.message}")
                _state.value = WatchPartyHostState()
            }
        }
    }

    private companion object {
        const val TAG = "pqp.watchPartyHost"
    }
}
