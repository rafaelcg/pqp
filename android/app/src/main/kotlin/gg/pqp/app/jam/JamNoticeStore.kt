package gg.pqp.app.jam

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** The one small toast of the notices ("Pedido novo em ..."): only for a server that wrote no card for the take. */
data class JamNoticeToast(val key: Int, val songId: String, val title: String, val admitted: Boolean)

/**
 * What this account knows about waiting parts: the flag, the starter's inbox, and the open notice items.
 *
 * OFF MEANS INVISIBLE. While `jam_public` is off for this account (or the API predates it) the store holds nothing and
 * every surface built on it draws nothing. `jam_take_notices` is the server's to state: with it off `GET /notices` is
 * an empty list and no card exists, while the inbox (and so the wall's pill and the song's own block, the PERSISTENT
 * markers) still reads, because those are the state and not the notice.
 */
data class JamNoticeState(
    val loaded: Boolean = false,
    val enabled: Boolean = false,
    val inbox: List<JamPublicInboxItem> = emptyList(),
    val notices: List<JamTakeNotice> = emptyList(),
    val toast: JamNoticeToast? = null,
    /** One of the reads of the waiting lists did not arrive: a list is out of date and is being asked for again. */
    val stale: Boolean = false,
) {
    fun pending(songId: String): List<JamTrack> = JamNoticeRules.pending(inbox, songId)
    fun waitingCount(songId: String): Int = JamNoticeRules.waitingCount(inbox, songId)
}

/** Everything the store reads from the outside world, in one seam so it runs on the JVM against a fake. */
interface JamNoticeBackend {
    /** The signed-in account's id, or null while signed out. A change is another person: nothing held is theirs. */
    val accounts: Flow<String?>
    val frames: Flow<JsonObject>
    val connection: Flow<RealtimeState>

    suspend fun config(): JamPublicMeConfig
    suspend fun inbox(): JamPublicInboxResponse
    suspend fun notices(): JamTakeNoticesResponse
    suspend fun ack(id: String)
}

class SessionJamNoticeBackend(private val session: SessionStore) : JamNoticeBackend {
    override val accounts: Flow<String?>
        get() = session.phase.map { (it as? SessionPhase.Ready)?.me?.id }
    override val frames: Flow<JsonObject> get() = session.realtime.frames
    override val connection: Flow<RealtimeState> get() = session.realtime.state

    override suspend fun config() = session.api.jamPublicConfig()
    override suspend fun inbox() = session.api.jamPublicInbox()
    override suspend fun notices() = session.api.jamTakeNotices()
    override suspend fun ack(id: String) = session.api.ackJamTakeNotice(id)
}

/**
 * The state behind the starter's "N partes esperando tua resposta" (the wall's pill and strip, the song's own block, the
 * card that follows the person around the app) and the sender's "tua parte entrou". The web's `jam-public-store.ts`.
 *
 * The live frames are only a nudge ("ask again"); the durable state is in the two reads, so a missed frame costs
 * nothing the next read does not fix. Read at sign-in, when a frame arrives, when the socket comes back, and when a
 * screen that shows it opens.
 */
class JamNoticeStore(
    private val backend: JamNoticeBackend,
    private val scope: CoroutineScope,
    /** Waits before asking again after a read that did not fully arrive. */
    private val retryMs: List<Long> = listOf(3_000, 10_000, 30_000),
) {
    private val _state = MutableStateFlow(JamNoticeState())
    val state: StateFlow<JamNoticeState> = _state.asStateFlow()

    /** Screens that must not be interrupted (a song's transport, the studio) hold the notices back while they are open. */
    private val _holds = MutableStateFlow(0)

    /** How many screens hold the notices back right now: they are drawn only at 0. */
    val holds: StateFlow<Int> = _holds.asStateFlow()

    /** Another account is looking when it moves: a read that started before it is not for the account now signed in. */
    private var epoch = 0
    private var started = false
    private var waitingLoad: Job? = null
    private var meLoad: Job? = null
    private var retryJob: Job? = null
    private var toastKey = 0

    /** Idempotent: the store lives as long as the process, and every screen that shows it calls this. */
    fun start() {
        if (started) return
        started = true
        scope.launch {
            backend.accounts.distinctUntilChanged().collect { account ->
                reset()
                if (account != null) loadMe()
            }
        }
        // One coroutine per frame, so a burst of them shares the read already in flight instead of queueing one each.
        scope.launch { backend.frames.collect { frame -> scope.launch { onFrame(frame) } } }
        scope.launch {
            var wasDown = false
            backend.connection.collect { connection ->
                if (connection == RealtimeState.Ready) {
                    // Frames sent while the socket was down are gone, so read again.
                    if (wasDown && _state.value.enabled) loadWaiting()
                    wasDown = false
                } else {
                    wasDown = true
                }
            }
        }
    }

    /** Hold the notices back until the returned release runs (a song is open, the studio is up). */
    fun hold(): () -> Unit {
        _holds.update { it + 1 }
        var released = false
        return {
            if (!released) {
                released = true
                _holds.update { (it - 1).coerceAtLeast(0) }
            }
        }
    }

    private fun reset() {
        epoch += 1
        waitingLoad?.cancel()
        meLoad?.cancel()
        retryJob?.cancel()
        waitingLoad = null
        meLoad = null
        retryJob = null
        _state.value = JamNoticeState()
    }

    // --- reads ---

    /** The flag, asked once per identity; when it is on, the waiting lists follow. */
    private fun loadMe(): Job {
        meLoad?.takeIf { it.isActive }?.let { return it }
        val mine = epoch
        val run = scope.launch {
            try {
                val me = backend.config()
                if (mine != epoch) return@launch
                _state.update { if (me.enabled) it.copy(loaded = true, enabled = true) else JamNoticeState(loaded = true) }
                if (me.enabled) loadWaiting().join()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (mine != epoch) return@launch
                // An API that predates the routes, or one with the flag off, reads as off. A network failure keeps
                // what was there (nothing, the first time) and is asked again with the next nudge.
                val status = (e as? ApiException)?.status
                if (status == 404 || status == 401 || status == 403) _state.value = JamNoticeState(loaded = true)
            }
        }
        meLoad = run
        return run
    }

    /** The inbox and the notice items, asked together. Coalesced: a burst of frames is one read. */
    fun loadWaiting(): Job {
        if (!_state.value.enabled) return scope.launch { }
        waitingLoad?.takeIf { it.isActive }?.let { return it }
        val mine = epoch
        val run = scope.launch {
            val inbox = scope.async { runCatchingRead { backend.inbox() } }
            val notices = scope.async { runCatchingRead { backend.notices() } }
            val gotInbox = inbox.await()
            val gotNotices = notices.await()
            if (mine != epoch) return@launch
            _state.update {
                it.copy(
                    inbox = gotInbox?.takes ?: it.inbox,
                    notices = gotNotices?.notices ?: it.notices,
                    stale = gotInbox == null || gotNotices == null,
                )
            }
        }
        waitingLoad = run
        return run
    }

    private suspend fun <T> runCatchingRead(block: suspend () -> T): T? =
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }

    /**
     * Read the waiting lists again AFTER something this person did that changes them (an accept, an undo, a decline, a
     * delete of their own part). Best effort that never gets in the way of what they did: the action already succeeded
     * and was applied locally, so a failed read must not make it look undone. When a read did not fully arrive the list
     * it feeds is stale and is asked again 3, 10 and 30 seconds later, one retry in flight at a time.
     */
    fun refresh(attempt: Int = 0) {
        val mine = epoch
        scope.launch {
            if (!_state.value.enabled) {
                loadMe().join()
            } else {
                loadWaiting().join()
            }
            if (mine != epoch || !_state.value.stale || attempt >= retryMs.size || retryJob?.isActive == true) return@launch
            retryJob = scope.launch {
                delay(retryMs[attempt])
                if (mine == epoch) refresh(attempt + 1)
            }
        }
    }

    // --- the frames ---

    private suspend fun onFrame(frame: JsonObject) {
        if (!JamPublicFrame.isPublic(frame)) return
        val decoded = JamPublicFrame.decode(frame) ?: return
        // Not yet asked whether this account has public jams at all: this frame is the proof it does.
        if (!_state.value.enabled) loadMe().join()
        if (!_state.value.enabled) return
        when (decoded) {
            is JamPublicFrame.Decision -> loadWaiting().join()
            is JamPublicFrame.Notice -> {
                if (decoded.kind != JamPublicNoticeKind.Take) return
                if (decoded.admitted) {
                    // Auto-accept already put it in: nothing waits, so there is no card. The toast says so.
                    toast(decoded)
                    loadWaiting().join()
                    return
                }
                loadWaiting().join()
                // With `jam_take_notices` on the server wrote an item for this take and the card it draws IS the
                // notice; the toast is only for a server with no such item, so a person is not told twice.
                val carded = _state.value.notices.any { it.kind == JamTakeNoticeKind.Take && it.songId == decoded.songId }
                if (!carded) toast(decoded)
            }
        }
    }

    private fun toast(frame: JamPublicFrame.Notice) {
        toastKey += 1
        _state.update { it.copy(toast = JamNoticeToast(toastKey, frame.songId, frame.title, frame.admitted)) }
    }

    fun dismissToast(key: Int) = _state.update { if (it.toast?.key == key) it.copy(toast = null) else it }

    // --- what the person does ---

    /** A tap on a card's button, or its X: the item leaves the list at once, and the server keeps it spent. */
    fun ack(id: String) {
        _state.update { it.copy(notices = it.notices.filterNot { notice -> notice.id == id }) }
        scope.launch { runCatchingRead { backend.ack(id) } }
    }

    /** A take left the inbox (accepted, or removed): drop it without waiting for the read. */
    fun dropInboxTake(trackId: String) = _state.update { JamNoticeRules.afterDrop(it, trackId) }

    /** What a song's answers change here. */
    fun asRequestsHook(): JamRequestsHook = object : JamRequestsHook {
        override fun dropped(trackId: String) = dropInboxTake(trackId)
        override fun changed() = refresh()
    }

    companion object {
        @Volatile
        private var instance: JamNoticeStore? = null

        fun of(session: SessionStore): JamNoticeStore =
            instance ?: synchronized(this) {
                instance ?: JamNoticeStore(
                    SessionJamNoticeBackend(session),
                    CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
                ).also {
                    instance = it
                    it.start()
                }
            }
    }
}
