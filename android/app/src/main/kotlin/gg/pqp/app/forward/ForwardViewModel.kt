package gg.pqp.app.forward

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.runSuspendCatching
import gg.pqp.app.core.serverPermissions
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.social.ui.titleOr
import java.util.UUID
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
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
    /**
     * A send whose outcome is unknown (the connection dropped before an answer):
     * the selection and the comment are frozen and the button retries that exact
     * request, so a changed target set can never re-send to somebody who may
     * already have the forward under the first request's nonce.
     */
    val retryLocked: Boolean = false,
)

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
    private val session: SessionStore,
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

    init {
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        val social = SocialRepository.of(session)
        social.refreshConversations()
        social.refreshFriends()
        val selfId = ((session.phase.value as? SessionPhase.Ready)?.me)?.id

        // People are known as soon as the two lists answer; do not make a
        // person wait for forty servers' channels to forward to a friend.
        viewModelScope.launch {
            combine(social.conversations, social.friends) { _, _ -> }.collect {
                publishPeople(social, selfId)
            }
        }

        val servers = session.servers.value
        val gate = Semaphore(LOAD_PARALLELISM)
        val jobs: List<Deferred<Unit>> = servers.map { server ->
            viewModelScope.async {
                gate.withPermit {
                    // The two reads are independent: ask for both at once.
                    val channelsCall = async { runSuspendCatching { session.api.channels(server.id) }.getOrNull() }
                    // No answer is "do not filter": the server refuses per target.
                    val permissionsCall = async {
                        runSuspendCatching { session.api.serverPermissions(server.id) }.getOrNull()
                    }
                    val channels = channelsCall.await()
                    val permissions = permissionsCall.await()
                    if (channels != null) {
                        val group = ForwardTargets.channelsOf(server, channels, permissions)
                        group.channels.forEach { byKey[it.key] = it }
                        _state.update { it.copy(groups = (it.groups + group).orderedLike(servers.map { s -> s.id })) }
                    }
                }
            }
        }
        jobs.forEach { it.await() }
        _state.update { it.copy(loading = false) }
    }

    private fun publishPeople(social: SocialRepository, selfId: String?) {
        val people = ForwardTargets.peopleOf(
            conversations = social.conversations.value,
            friends = social.friends.value.friends,
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
            runSuspendCatching { session.api.createForward(request) }
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
        val sentKeys = HashSet<String>()
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
                    ForwardViewModel(session, input, PrefsForwardRecents(context.applicationContext)) as T
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
