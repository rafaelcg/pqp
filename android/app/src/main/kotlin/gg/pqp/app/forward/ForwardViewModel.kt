package gg.pqp.app.forward

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.Channel
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.runSuspendCatching
import gg.pqp.app.core.serverPermissions
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.Friend
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.social.ui.titleOr
import java.util.UUID
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * What is being forwarded. The picker needs only enough to say so in its header
 * and to know where the content may not leave.
 */
data class ForwardInput(
    val source: ForwardSource,
    /** The post's title or the message's first words, for the sheet's header line. */
    val preview: String,
    /**
     * Set when the source is members-only (a VIP post) or private: it may only
     * go back into this server, so the picker offers nothing else. Null when
     * the client cannot tell; the server is still the authority per target.
     */
    val restrictedToServerId: String? = null,
    /**
     * A server's channel list the caller already fetched (to decide the boundary
     * above), as `serverId to channels`. The picker uses it instead of asking for
     * the same list a second time, one after the other.
     */
    val knownChannels: Pair<String, List<Channel>>? = null,
)

/** One target that took the forward, for the "Encaminhado" line and its "Ver". */
data class ForwardSent(
    val channelId: String,
    /** Null for a conversation. */
    val serverId: String?,
    val label: String,
    val isConversation: Boolean,
)

data class ForwardDone(val sent: List<ForwardSent>)

/** A server the picker could not list the channels of. */
data class ForwardFailedServer(val serverId: String, val name: String)

data class ForwardPickerState(
    val loading: Boolean = true,
    val groups: List<ForwardServerGroup> = emptyList(),
    val people: List<ForwardTarget> = emptyList(),
    val recents: List<String> = emptyList(),
    val query: String = "",
    /** Target keys, in the order picked. */
    val selected: List<String> = emptyList(),
    val comment: String = "",
    val sending: Boolean = false,
    /** Keys that took the forward in an earlier attempt of this sheet. */
    val sentKeys: Set<String> = emptySet(),
    /** Per-target refusals of the last attempt, by key. */
    val refusals: Map<String, TargetRefusal> = emptyMap(),
    /** The whole call failed (not one target). Kept until the next attempt. */
    val failure: ForwardFailure? = null,
    /** The cap on targets was hit by the last tap. */
    val capHit: Boolean = false,
    /** Servers whose channels could not be read: the picker says so and offers a retry. */
    val failedServers: List<ForwardFailedServer> = emptyList(),
    /**
     * A send whose outcome is unknown (the connection dropped before an answer):
     * the selection and the comment are frozen and the button retries that exact
     * request, so a changed target set can never re-send to somebody who may
     * already have the forward under the first request's nonce.
     */
    val retryLocked: Boolean = false,
)

/**
 * Everything the picker reads and the one thing it writes, so the view model can
 * be built and driven in a JVM test with no session, socket or Android.
 */
interface ForwardBackend {
    /** The servers this account is in, in the order the list shows them. */
    val servers: List<ServerSummary>
    val conversations: Flow<List<DmSummary>>
    val friends: Flow<List<Friend>>
    val selfId: String?

    /** Ask for fresh conversations and friends. Never waits for the answer. */
    fun refreshPeople()

    suspend fun channels(serverId: String): List<Channel>
    suspend fun permissions(serverId: String): PermissionsSnapshot
    suspend fun createForward(request: CreateForwardRequest): CreateForwardResponse
}

/** The live backend: the session's API and the social repository. */
class SessionForwardBackend(private val session: SessionStore) : ForwardBackend {
    private val social get() = SocialRepository.of(session)

    override val servers: List<ServerSummary> get() = session.servers.value
    override val conversations: Flow<List<DmSummary>> get() = social.conversations
    override val friends: Flow<List<Friend>> get() = social.friends.map { it.friends }
    override val selfId: String? get() = ((session.phase.value as? SessionPhase.Ready)?.me)?.id

    override fun refreshPeople() {
        social.refreshConversations()
        social.refreshFriends()
    }

    override suspend fun channels(serverId: String): List<Channel> = session.api.channels(serverId)
    override suspend fun permissions(serverId: String): PermissionsSnapshot = session.api.serverPermissions(serverId)
    override suspend fun createForward(request: CreateForwardRequest): CreateForwardResponse =
        session.api.createForward(request)
}

/**
 * The Encaminhar sheet's brain: loads what can be forwarded to, keeps the
 * selection, sends, and says what came of it.
 *
 * Servers' channels and permissions load concurrently but bounded (four at a
 * time) and appear as they arrive, so a long server list fills in rather than
 * waiting on its slowest member. Everything the picker knows is advisory; the
 * server's per-target answer is the truth and is what the sheet reports.
 */
class ForwardViewModel(
    private val backend: ForwardBackend,
    val input: ForwardInput,
    private val recents: ForwardRecentsStore,
) : ViewModel() {

    private val _state = MutableStateFlow(ForwardPickerState(recents = recents.load()))
    val state: StateFlow<ForwardPickerState> = _state.asStateFlow()

    private val _done = MutableStateFlow<ForwardDone?>(null)

    /** Set once, when the sheet is finished with and something was sent. */
    val done: StateFlow<ForwardDone?> = _done.asStateFlow()

    /**
     * The request whose outcome is unknown, kept whole (targets, comment, nonce)
     * across a lost connection. Retrying sends exactly this, never a rebuilt one.
     */
    private var unknownOutcome: Pair<CreateForwardRequest, List<ForwardTarget>>? = null

    /** Everything that went out, across attempts, for the "Encaminhado" line. */
    private val sent = mutableListOf<ForwardSent>()

    private val byKey = HashMap<String, ForwardTarget>()

    private var serverOrder: List<String> = emptyList()

    /** Shared by the first load and every retry, so a burst of taps cannot exceed it. */
    private val serverGate = Semaphore(LOAD_PARALLELISM)

    /** Servers being read right now, so a second tap on the same retry does nothing. */
    private val loadingServers = HashSet<String>()

    /** Servers asked for again by hand: the list the caller seeded is not reused for them. */
    private val retrying = HashSet<String>()

    // LAST among the fields on purpose. `viewModelScope` runs on Main.immediate, so
    // this block executes `load()` right here, up to its first suspension, and a
    // field declared below it would still be null. That was the Encaminhar crash
    // (`synchronize on a null object`); `ForwardViewModelTest` constructs the view
    // model so it cannot come back.
    init {
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        backend.refreshPeople()
        val selfId = backend.selfId

        // People are known as soon as the two lists answer; do not make a
        // person wait for forty servers' channels to forward to a friend.
        viewModelScope.launch {
            combine(backend.conversations, backend.friends) { dms, friends -> dms to friends }.collect {
                publishPeople(it.first, it.second, selfId)
            }
        }

        val servers = backend.servers
        serverOrder = servers.map { it.id }
        val jobs: List<Deferred<Unit>> = servers.map { server ->
            viewModelScope.async { loadServerBounded(server) }
        }
        jobs.forEach { it.await() }
        _state.update { it.copy(loading = false) }
    }

    private suspend fun loadServerBounded(server: ServerSummary) {
        if (!synchronized(loadingServers) { loadingServers.add(server.id) }) return
        try {
            serverGate.withPermit { loadServer(server) }
        } finally {
            synchronized(loadingServers) { loadingServers.remove(server.id) }
        }
    }

    /** One server's channels and permissions, asked for together. A failure is kept, not hidden. */
    private suspend fun loadServer(server: ServerSummary) = coroutineScope {
        val known = input.knownChannels?.takeIf { it.first == server.id && !retrying.contains(server.id) }
        val channelsCall = async {
            known?.second ?: runSuspendCatching { backend.channels(server.id) }.getOrNull()
        }
        // No permission answer is "do not filter": the server refuses per target.
        val permissionsCall = async {
            runSuspendCatching { backend.permissions(server.id) }.getOrNull()
        }
        val channels = channelsCall.await()
        val permissions = permissionsCall.await()
        if (channels == null) {
            _state.update {
                it.copy(
                    failedServers = (it.failedServers.filterNot { f -> f.serverId == server.id } +
                        ForwardFailedServer(server.id, server.name)),
                )
            }
            return@coroutineScope
        }
        val group = ForwardTargets.channelsOf(server, channels, permissions)
        group.channels.forEach { byKey[it.key] = it }
        _state.update {
            it.copy(
                groups = (it.groups.filterNot { g -> g.serverId == server.id } + group).orderedLike(serverOrder),
                failedServers = it.failedServers.filterNot { f -> f.serverId == server.id },
            )
        }
    }

    /** Try a server that failed to load again. */
    fun retryServer(serverId: String) {
        val server = backend.servers.firstOrNull { it.id == serverId } ?: return
        retrying += serverId
        viewModelScope.launch { loadServerBounded(server) }
    }

    private fun publishPeople(conversations: List<DmSummary>, friends: List<Friend>, selfId: String?) {
        val people = ForwardTargets.peopleOf(
            conversations = conversations,
            friends = friends,
            selfId = selfId,
            titleOf = { it.titleOr("") },
        )
        people.forEach { byKey[it.key] = it }
        _state.update { it.copy(people = people) }
    }

    private fun List<ForwardServerGroup>.orderedLike(order: List<String>): List<ForwardServerGroup> =
        sortedBy { order.indexOf(it.serverId).let { i -> if (i < 0) Int.MAX_VALUE else i } }

    fun setQuery(query: String) = _state.update { it.copy(query = query.take(64)) }

    fun setComment(comment: String) = _state.update {
        if (it.retryLocked) it else it.copy(comment = comment.take(FORWARD_COMMENT_MAX))
    }

    /** A target that already took this forward cannot be picked again in the same sheet. */
    fun toggle(key: String) {
        _state.update { current ->
            if (key in current.sentKeys || current.sending || current.retryLocked) return@update current
            val (next, capHit) = ForwardTargets.toggle(current.selected, key)
            current.copy(
                selected = next,
                capHit = capHit,
                // A target picked again is a fresh try: its old refusal is stale.
                refusals = current.refusals - key,
                failure = null,
            )
        }
    }

    fun clearCapHit() = _state.update { it.copy(capHit = false) }

    fun targetFor(key: String): ForwardTarget? = byKey[key]

    fun send() {
        val current = _state.value
        if (current.sending || current.selected.isEmpty()) return
        // After a lost connection the retry is the SAME request, nonce and all.
        val (request, targets) = unknownOutcome ?: run {
            val picked = current.selected.mapNotNull { byKey[it] }
            if (picked.isEmpty()) return
            CreateForwardRequest(
                source = input.source,
                targets = picked.map { it.toRef() },
                comment = current.comment.trim().takeIf { it.isNotEmpty() },
                nonce = UUID.randomUUID().toString(),
            ) to picked
        }
        _state.update { it.copy(sending = true, failure = null, refusals = emptyMap(), capHit = false) }

        viewModelScope.launch {
            runSuspendCatching { backend.createForward(request) }
                .onSuccess { response -> onResponse(targets, response) }
                .onFailure { error ->
                    val failure = ForwardOutcomes.failureOf(error)
                    // Only a call that may have landed keeps its request: a 404, 422 or 429
                    // answered, so nothing went out and the selection is free again.
                    val ambiguous = failure.mayHaveLanded
                    unknownOutcome = if (ambiguous) request to targets else null
                    _state.update {
                        it.copy(sending = false, failure = failure, retryLocked = ambiguous)
                    }
                }
        }
    }

    private fun onResponse(targets: List<ForwardTarget>, response: CreateForwardResponse) {
        // An answer ends this attempt: whatever is sent next is a new request.
        unknownOutcome = null
        val refusals = HashMap<String, TargetRefusal>()
        val sentKeys = LinkedHashSet<String>()
        response.results.forEachIndexed { index, result ->
            val target = targets.firstOrNull { it.toRef() == result.target }
                ?: targets.getOrNull(index)
                ?: return@forEachIndexed
            if (result.ok && result.channelId != null) {
                sentKeys += target.key
                sent += ForwardSent(
                    channelId = result.channelId,
                    serverId = result.serverId,
                    label = target.label,
                    isConversation = result.serverId == null,
                )
            } else {
                refusals[target.key] = ForwardOutcomes.refusalOf(result)
            }
        }
        if (sentKeys.isNotEmpty()) {
            recents.save(ForwardTargets.bumpRecents(_state.value.recents, sentKeys.toList()))
        }
        _state.update { s ->
            s.copy(
                sending = false,
                retryLocked = false,
                sentKeys = s.sentKeys + sentKeys,
                selected = s.selected.filterNot { it in sentKeys },
                refusals = refusals,
                recents = ForwardTargets.bumpRecents(s.recents, sentKeys.toList()),
            )
        }
        // Everything went: the sheet is finished with. Anything refused keeps it open.
        if (refusals.isEmpty() && response.results.isNotEmpty()) finish()
    }

    /** The sheet is going away. Reports what was sent, once, if anything was. */
    fun finish() {
        if (_done.value == null && sent.isNotEmpty()) _done.value = ForwardDone(sent.toList())
    }

    companion object {
        private const val LOAD_PARALLELISM = 4

        fun factory(session: SessionStore, input: ForwardInput, context: Context) =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ForwardViewModel(
                        SessionForwardBackend(session),
                        input,
                        PrefsForwardRecents(context.applicationContext),
                    ) as T
            }
    }
}

/** Where recent targets are remembered. An interface so tests need no Context. */
interface ForwardRecentsStore {
    fun load(): List<String>
    fun save(keys: List<String>)
}

/** Device-local, newest first. Keys are channel and user ids, so a stale one is simply not shown. */
class PrefsForwardRecents(context: Context) : ForwardRecentsStore {
    private val prefs = context.getSharedPreferences("pqp_forward", Context.MODE_PRIVATE)

    override fun load(): List<String> =
        prefs.getString(KEY, "").orEmpty().split(',').filter { it.isNotBlank() }

    override fun save(keys: List<String>) {
        prefs.edit().putString(KEY, keys.take(ForwardTargets.RECENTS_CAP).joinToString(",")).apply()
    }

    private companion object {
        const val KEY = "recent_targets"
    }
}
