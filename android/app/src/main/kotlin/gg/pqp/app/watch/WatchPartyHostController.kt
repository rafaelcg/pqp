package gg.pqp.app.watch

import android.content.Context
import android.content.Intent
import android.util.Log
import gg.pqp.app.R
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionStore
import gg.pqp.app.voice.VoiceController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What this phone is in the middle of doing to a party it is hosting, if anything. */
enum class WatchPartyHostBusy { None, Creating, GoingLive, Ending }

data class WatchPartyHostState(
    val busy: WatchPartyHostBusy = WatchPartyHostBusy.None,
    /**
     * A sentence for the host about the LAST action that did not land clean:
     * the server's own refusal for an [gg.pqp.app.core.ApiException], or one
     * of this class's own strings when a state transition was asked for and
     * the server never confirmed it (a lost response, a timeout, anything
     * that is not a clean refusal). Never silently discarded in favour of a
     * plain reset -- a Farol review of the first cut of this controller
     * caught exactly that: `create`/`goLive`/`end` all reset to a clean,
     * error-less state on ANY non-[ApiException] failure, which reported
     * success to the host for a request that may or may not have landed.
     */
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
 *
 * [state] is read at the top of the signed-in tree (`SignedInNav` in
 * `PqpApp.kt`), not only inside the host panel: a failure on Encerrar is
 * reported AFTER `voice.leave()` has already dropped `canStartWatchParty`,
 * which is what unmounts the panel that would otherwise show it. A toast
 * hoisted above the per-channel UI is what survives that.
 */
class WatchPartyHostController(
    private val context: Context,
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
     * "Ir ao vivo". See [performWatchPartyGoLive] for the ordering and the
     * two Farol findings it exists to close: an ambiguous `setLive` failure
     * is re-checked against the party's real state rather than assumed
     * refused, and a join that fails on an already-live party is reported
     * as such (best-effort ended, honestly, whichever way that lands) rather
     * than as an unqualified success.
     */
    fun goLive(channelId: String, channelName: String?, partyId: String, lowLatency: Boolean, consent: Intent) {
        run(WatchPartyHostBusy.GoingLive) {
            val result = performWatchPartyGoLive(
                setLive = { session.api.setWatchPartyState(partyId, "live", lowLatency) != null },
                checkLive = { session.api.fetchChannelWatchParty(channelId)?.let { it.id == partyId && it.isLive } == true },
                joinVoice = { voice.join(channelId, channelName) },
                endParty = { session.api.setWatchPartyState(partyId, "ended") != null },
                startScreenShare = { data: Intent -> voice.startScreenShare(data) },
                consent = consent,
            )
            when (result) {
                GoLiveResult.Live -> Unit
                GoLiveResult.Refused ->
                    throw IllegalStateException(context.getString(R.string.watch_party_host_go_live_failed))
                is GoLiveResult.JoinFailed -> throw IllegalStateException(
                    context.getString(
                        if (result.ended) {
                            R.string.watch_party_host_join_failed_ended
                        } else {
                            R.string.watch_party_host_join_failed_not_ended
                        },
                    ),
                )
            }
        }
    }

    /**
     * "Compartilhar tela" again, once the party is already live but this
     * phone's own capture never started or dropped -- the recovery path for
     * exactly the failure mode [goLive]'s doc describes as intended ("live,
     * no picture"). No party-state call here: the party is already `live`,
     * only the capture needs retrying.
     */
    fun retryShare(consent: Intent) {
        voice.startScreenShare(consent)
    }

    /**
     * "Encerrar". See [performWatchPartyEnd] for the two effects and their
     * order. Voice is left even when the server never confirmed the end
     * (that guarantee lives in [performWatchPartyEnd] itself); what this
     * wrapper adds is telling the host when that happened, rather than
     * reporting a clean success either way.
     */
    fun end(partyId: String) {
        run(WatchPartyHostBusy.Ending) {
            val ended = performWatchPartyEnd(
                setEnded = { session.api.setWatchPartyState(partyId, "ended") != null },
                leaveVoice = { voice.leave() },
            )
            if (!ended) throw IllegalStateException(context.getString(R.string.watch_party_host_end_failed))
        }
    }

    private fun run(busy: WatchPartyHostBusy, block: suspend () -> Unit) {
        scope.launch {
            _state.value = WatchPartyHostState(busy = busy)
            try {
                block()
                _state.value = WatchPartyHostState()
            } catch (e: CancellationException) {
                // Not a failure of the action -- the scope went away (a
                // screen left, the process is dying). Reporting it as one
                // would show a host a refusal for a request that was simply
                // never finished asking. Coroutine cancellation must also
                // propagate rather than being swallowed here.
                throw e
            } catch (e: ApiException) {
                Log.w(TAG, "watch party host action ($busy) refused: ${e.serverMessage}")
                _state.value = WatchPartyHostState(error = e.serverMessage)
            } catch (e: Exception) {
                Log.w(TAG, "watch party host action ($busy) failed: ${e.message}")
                _state.value = WatchPartyHostState(
                    error = e.message ?: context.getString(R.string.watch_party_host_generic_error),
                )
            }
        }
    }

    private companion object {
        const val TAG = "pqp.watchPartyHost"
    }
}
