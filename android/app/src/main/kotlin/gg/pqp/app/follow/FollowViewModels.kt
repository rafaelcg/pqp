package gg.pqp.app.follow

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.runSuspendCatching
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Everything Seguir reads and writes, so the view models below can be built and
 * driven in a JVM test with no session, socket or Android.
 */
interface FollowBackend {
    suspend fun state(serverId: String): BauFollowState
    suspend fun destinations(serverId: String): BauFollowDestinations
    suspend fun create(serverId: String, request: CreateBauFollowRequest): BauFollow
    suspend fun channelFollows(channelId: String): List<BauFollow>
    suspend fun update(followId: String, request: UpdateBauFollowRequest): BauFollow
    suspend fun delete(followId: String)
    suspend fun followers(serverId: String): BauFollowers
    suspend fun setAllowed(serverId: String, allowed: Boolean): BauFollowers
    suspend fun removeFollower(serverId: String, followId: String, block: Boolean)
    suspend fun unblock(serverId: String, blockedServerId: String)
}

/** The live backend: the session's API. */
class SessionFollowBackend(private val session: SessionStore) : FollowBackend {
    private val api get() = session.api

    override suspend fun state(serverId: String) = api.bauFollowState(serverId)
    override suspend fun destinations(serverId: String) = api.bauFollowDestinations(serverId)
    override suspend fun create(serverId: String, request: CreateBauFollowRequest) =
        api.createBauFollow(serverId, request)
    override suspend fun channelFollows(channelId: String) = api.channelBauFollows(channelId)
    override suspend fun update(followId: String, request: UpdateBauFollowRequest) =
        api.updateBauFollow(followId, request)
    override suspend fun delete(followId: String) = api.deleteBauFollow(followId)
    override suspend fun followers(serverId: String) = api.bauFollowers(serverId)
    override suspend fun setAllowed(serverId: String, allowed: Boolean) =
        api.setBauFollowAllowed(serverId, allowed)
    override suspend fun removeFollower(serverId: String, followId: String, block: Boolean) =
        api.removeBauFollower(serverId, followId, block)
    override suspend fun unblock(serverId: String, blockedServerId: String) =
        api.unblockBauFollower(serverId, blockedServerId)
}

/** A "Followed" line the picker shows after a success. */
data class FollowedNotice(val channelName: String, val serverName: String)

/** Why the picker has no destinations to draw. */
enum class PickerLoadError {
    /** The read failed: offer a retry. */
    Failed,

    /** A 404: this Baú no longer accepts follows. */
    Off,
}

data class FollowPickerState(
    /** `null` while the destinations have not answered. */
    val destinations: List<BauFollowDestination>? = null,
    val maxPerServer: Int = FOLLOW_MAX_PER_SERVER,
    val loadError: PickerLoadError? = null,
    val destinationId: String = "",
    val channelId: String = "",
    /** Empty means "mention nobody". */
    val roleId: String = "",
    val busy: Boolean = false,
    /** The follow whose Deixar de seguir or Retomar is in flight. */
    val rowBusy: String? = null,
    val error: FollowFailure? = null,
    val notice: FollowedNotice? = null,
) {
    val destination: BauFollowDestination? get() = destinations?.firstOrNull { it.serverId == destinationId }
    val freeChannels: List<BauFollowChannel> get() = destination?.freeChannels.orEmpty()

    /** The picked server already holds as many follows as it may. */
    val full: Boolean get() = destination?.let { it.followCount >= maxPerServer } == true
    val canSubmit: Boolean get() = destination != null && channelId.isNotEmpty() && !busy && !full
}

/**
 * Seguir on the SOURCE's Baú: the button's state, the picker that sets a follow
 * up, and what the viewer already follows of this Baú.
 *
 * Everything is behind the per-source runtime flag: the state read answers
 * `enabled: false` and the header draws no button. A failed read is "not
 * followable": a button that cannot be trusted is better absent.
 *
 * Reads answer only if no newer read started after them, so a slow early answer
 * never overwrites a later one (two quick actions refresh twice).
 */
class BauFollowViewModel(
    private val backend: FollowBackend,
    private val serverId: String,
) : ViewModel() {

    private val _state = MutableStateFlow<BauFollowState?>(null)

    /** `null` until it answers, and after any failure. */
    val state: StateFlow<BauFollowState?> = _state.asStateFlow()

    private val _managerFlagOn = MutableStateFlow(false)

    /**
     * For somebody who manages the server: the flag is on for this Baú, so
     * "Permitir seguir" and the follower list are worth offering even while
     * the owner's switch is still off (it is how it gets switched on).
     */
    val managerFlagOn: StateFlow<Boolean> = _managerFlagOn.asStateFlow()

    private val _picker = MutableStateFlow(FollowPickerState())
    val picker: StateFlow<FollowPickerState> = _picker.asStateFlow()

    private val _pickerOpen = MutableStateFlow(false)
    val pickerOpen: StateFlow<Boolean> = _pickerOpen.asStateFlow()

    private var stateGeneration = 0
    private var pickerGeneration = 0
    private var canManage = false

    init {
        refresh()
    }

    /**
     * Whether the viewer holds Manage Server here. It is known after the
     * permissions answer, which is later than this view model is built, so the
     * screen says so when it learns it; only then is the owner's side read.
     */
    fun setCanManage(value: Boolean) {
        if (canManage == value) return
        canManage = value
        if (value) refreshManager()
    }

    fun refresh() {
        stateGeneration += 1
        val mine = stateGeneration
        viewModelScope.launch {
            val next = runSuspendCatching { backend.state(serverId) }.getOrNull()
            if (stateGeneration == mine) _state.value = next
        }
    }

    /** The owner moved the switch, or the follower list changed: re-read both. */
    fun refreshAll() {
        refresh()
        if (canManage) refreshManager()
    }

    private fun refreshManager() {
        viewModelScope.launch {
            val next = runSuspendCatching { backend.followers(serverId) }.getOrNull()
            // A failed read leaves what was known: only a real answer moves it.
            if (next != null) _managerFlagOn.value = next.flagOn
        }
    }

    // ---- the picker

    fun openPicker() {
        _pickerOpen.value = true
        _picker.value = FollowPickerState()
        // What the viewer follows can change under an open screen (a follow that
        // paused itself, one removed on the web): the sheet opens on what is true.
        refresh()
        loadDestinations()
    }

    fun closePicker() {
        pickerGeneration += 1
        _pickerOpen.value = false
    }

    fun retryLoad() = loadDestinations()

    private fun loadDestinations() {
        pickerGeneration += 1
        val mine = pickerGeneration
        _picker.update { it.copy(loadError = null) }
        viewModelScope.launch {
            runSuspendCatching { backend.destinations(serverId) }
                .onSuccess { res ->
                    if (pickerGeneration != mine) return@onSuccess
                    _picker.update { current ->
                        val keepId = current.destinationId.takeIf { id -> res.servers.any { it.serverId == id } }
                        current.copy(
                            destinations = res.servers,
                            maxPerServer = res.maxPerServer,
                            destinationId = keepId ?: res.servers.firstOrNull()?.serverId.orEmpty(),
                        ).validated()
                    }
                }
                .onFailure { error ->
                    if (pickerGeneration != mine) return@onFailure
                    // A 404 is "this Baú no longer accepts follows" (the owner
                    // switched it off): say so, and let the header drop its button.
                    val off = error is ApiException && error.status == 404
                    _picker.update { it.copy(loadError = if (off) PickerLoadError.Off else PickerLoadError.Failed) }
                    if (off) refresh()
                }
        }
    }

    /** Keep the channel and role picks valid for the server on show. */
    private fun FollowPickerState.validated(): FollowPickerState {
        val free = freeChannels
        val channel = if (free.any { it.id == channelId }) channelId else free.firstOrNull()?.id.orEmpty()
        val role = if (destination?.roles?.any { it.id == roleId } == true) roleId else ""
        return copy(channelId = channel, roleId = role)
    }

    fun pickDestination(id: String) = _picker.update {
        it.copy(destinationId = id, error = null, notice = null).validated()
    }

    fun pickChannel(id: String) = _picker.update { it.copy(channelId = id, error = null, notice = null) }

    fun pickRole(id: String) = _picker.update { it.copy(roleId = id) }

    fun submit() {
        val current = _picker.value
        if (!current.canSubmit) return
        _picker.update { it.copy(busy = true, error = null, notice = null) }
        viewModelScope.launch {
            runSuspendCatching {
                backend.create(
                    serverId,
                    CreateBauFollowRequest(
                        channelId = current.channelId,
                        rolePingId = current.roleId.takeIf { it.isNotEmpty() },
                    ),
                )
            }
                .onSuccess { follow ->
                    _picker.update {
                        it.copy(
                            busy = false,
                            notice = FollowedNotice(follow.targetChannelName, follow.targetServerName),
                        )
                    }
                    refresh()
                    loadDestinations()
                }
                .onFailure { error ->
                    val failure = FollowFailures.ofCreate(error)
                    _picker.update { it.copy(busy = false, error = failure) }
                    // A lost response can hide a change that did commit, and a 404 means
                    // the button should go: re-read what is true either way.
                    refresh()
                    loadDestinations()
                }
        }
    }

    fun unfollow(follow: BauFollow) {
        if (_picker.value.rowBusy != null) return
        _picker.update { it.copy(rowBusy = follow.id, error = null) }
        viewModelScope.launch {
            runSuspendCatching { backend.delete(follow.id) }
                .onSuccess {
                    _picker.update { it.copy(rowBusy = null) }
                    refresh()
                    loadDestinations()
                }
                .onFailure { error ->
                    _picker.update { it.copy(rowBusy = null, error = FollowFailures.ofAction(error)) }
                    refresh()
                    loadDestinations()
                }
        }
    }

    fun resume(follow: BauFollow) {
        if (_picker.value.rowBusy != null) return
        _picker.update { it.copy(rowBusy = follow.id, error = null) }
        viewModelScope.launch {
            runSuspendCatching { backend.update(follow.id, UpdateBauFollowRequest(resume = true)) }
                .onSuccess {
                    _picker.update { it.copy(rowBusy = null) }
                    refresh()
                }
                .onFailure { error ->
                    _picker.update { it.copy(rowBusy = null, error = FollowFailures.ofAction(error)) }
                    refresh()
                    loadDestinations()
                }
        }
    }

    companion object {
        fun factory(session: SessionStore, serverId: String) =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    BauFollowViewModel(SessionFollowBackend(session), serverId) as T
            }
    }
}

data class FollowersState(
    val data: BauFollowers? = null,
    val loadFailed: Boolean = false,
    /** The key of the change in flight (a follow id, a blocked server id, or [SWITCH]). */
    val busyKey: String? = null,
    val error: FollowFailure? = null,
    /** Follower rows drawn so far. */
    val shown: Int = FOLLOWERS_PAGE,
    /** Blocking is not obvious to undo, so it asks first. */
    val confirmBlock: BauFollower? = null,
)

/** The `busyKey` of the "Permitir seguir" switch. */
const val FOLLOW_SWITCH_KEY = "switch"

/**
 * The source's staff: which servers follow this Baú (names, never people),
 * remove one, or remove and block its server, unblock, and the owner's switch
 * "Permitir seguir".
 *
 * Every change is reflected at once (`apply`) so a refresh that fails afterwards
 * cannot leave a removed server on show; the read that follows only reconciles.
 */
class BauFollowersViewModel(
    private val backend: FollowBackend,
    private val serverId: String,
    private val onChanged: () -> Unit,
) : ViewModel() {

    private val _state = MutableStateFlow(FollowersState())
    val state: StateFlow<FollowersState> = _state.asStateFlow()

    private var generation = 0

    init {
        load()
    }

    fun load() {
        generation += 1
        val mine = generation
        _state.update { it.copy(loadFailed = false) }
        viewModelScope.launch {
            runSuspendCatching { backend.followers(serverId) }
                .onSuccess { next -> if (generation == mine) _state.update { it.copy(data = next) } }
                .onFailure { if (generation == mine) _state.update { it.copy(loadFailed = true) } }
        }
    }

    fun showMore() = _state.update { it.copy(shown = it.shown + FOLLOWERS_PAGE) }

    /** The owner's switch. The server answers the whole new picture. */
    fun setAllowed(next: Boolean) {
        if (_state.value.busyKey != null) return
        _state.update { it.copy(busyKey = FOLLOW_SWITCH_KEY, error = null) }
        viewModelScope.launch {
            runSuspendCatching { backend.setAllowed(serverId, next) }
                .onSuccess { res ->
                    _state.update { it.copy(busyKey = null, data = res) }
                    onChanged()
                }
                .onFailure { error ->
                    _state.update { it.copy(busyKey = null, error = FollowFailures.ofAction(error)) }
                }
        }
    }

    fun remove(follower: BauFollower) = act(
        key = follower.id,
        run = { backend.removeFollower(serverId, follower.id, block = false) },
        apply = { current ->
            current.copy(
                count = (current.count - 1).coerceAtLeast(0),
                followers = current.followers.filterNot { it.id == follower.id },
            )
        },
    )

    fun askBlock(follower: BauFollower) = _state.update { it.copy(confirmBlock = follower) }

    fun cancelBlock() = _state.update { it.copy(confirmBlock = null) }

    fun confirmBlock() {
        val target = _state.value.confirmBlock ?: return
        _state.update { it.copy(confirmBlock = null) }
        act(
            key = target.id,
            run = { backend.removeFollower(serverId, target.id, block = true) },
            apply = { current ->
                // Blocking removes every follow of that server.
                val gone = current.followers.count { it.targetServerId == target.targetServerId }
                current.copy(
                    count = (current.count - gone.coerceAtLeast(1)).coerceAtLeast(0),
                    followers = current.followers.filterNot { it.targetServerId == target.targetServerId },
                    blocked = listOf(
                        BauFollowBlock(target.targetServerId, target.targetServerName),
                    ) + current.blocked.filterNot { it.serverId == target.targetServerId },
                )
            },
        )
    }

    fun unblock(block: BauFollowBlock) = act(
        key = block.serverId,
        run = { backend.unblock(serverId, block.serverId) },
        apply = { current -> current.copy(blocked = current.blocked.filterNot { it.serverId == block.serverId }) },
    )

    private fun act(key: String, run: suspend () -> Unit, apply: (BauFollowers) -> BauFollowers) {
        if (_state.value.busyKey != null) return
        _state.update { it.copy(busyKey = key, error = null) }
        viewModelScope.launch {
            runSuspendCatching { run() }
                .onSuccess {
                    _state.update { s -> s.copy(busyKey = null, data = s.data?.let(apply)) }
                    onChanged()
                    load()
                }
                .onFailure { error ->
                    _state.update { it.copy(busyKey = null, error = FollowFailures.ofAction(error)) }
                    load()
                }
        }
    }

    companion object {
        fun factory(session: SessionStore, serverId: String, onChanged: () -> Unit) =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    BauFollowersViewModel(SessionFollowBackend(session), serverId, onChanged) as T
            }
    }
}

data class ChannelFollowsState(
    /** The read has answered once. */
    val loaded: Boolean = false,
    val follows: List<BauFollow> = emptyList(),
    /** The read FAILED (not "feature off", not "may not manage"): say so and offer a retry. */
    val failed: Boolean = false,
    val busyId: String? = null,
    val error: FollowFailure? = null,
) {
    /**
     * Drawn only when the channel follows something, or the read failed, so a
     * deployment where Seguir is off never shows it, and a hiccup does not hide
     * the way to unfollow.
     */
    val visible: Boolean get() = follows.isNotEmpty() || failed
}

/**
 * "Seguindo" for one text channel: the Baús it follows, each with Deixar de
 * seguir, and Retomar when the follow paused itself.
 */
class ChannelFollowsViewModel(
    private val backend: FollowBackend,
    private val channelId: String,
) : ViewModel() {

    private val _state = MutableStateFlow(ChannelFollowsState())
    val state: StateFlow<ChannelFollowsState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        _state.update { it.copy(failed = false) }
        viewModelScope.launch {
            runSuspendCatching { backend.channelFollows(channelId) }
                .onSuccess { follows -> _state.update { it.copy(loaded = true, follows = follows) } }
                .onFailure { error ->
                    // 404 is a deployment with the feature off and 403 somebody who
                    // may not manage the channel: both are "nothing to show".
                    val quiet = error is ApiException && (error.status == 404 || error.status == 403)
                    _state.update { it.copy(loaded = true, failed = !quiet) }
                }
        }
    }

    fun unfollow(follow: BauFollow) {
        if (_state.value.busyId != null) return
        _state.update { it.copy(busyId = follow.id, error = null) }
        viewModelScope.launch {
            runSuspendCatching { backend.delete(follow.id) }
                .onSuccess {
                    _state.update { s ->
                        s.copy(busyId = null, follows = s.follows.filterNot { it.id == follow.id })
                    }
                }
                .onFailure { error ->
                    _state.update { it.copy(busyId = null, error = FollowFailures.ofAction(error)) }
                }
        }
    }

    fun resume(follow: BauFollow) {
        if (_state.value.busyId != null) return
        _state.update { it.copy(busyId = follow.id, error = null) }
        viewModelScope.launch {
            runSuspendCatching { backend.update(follow.id, UpdateBauFollowRequest(resume = true)) }
                .onSuccess { updated ->
                    _state.update { s ->
                        s.copy(
                            busyId = null,
                            follows = s.follows.map { if (it.id == follow.id) updated else it },
                        )
                    }
                }
                .onFailure { error ->
                    _state.update { it.copy(busyId = null, error = FollowFailures.ofAction(error)) }
                }
        }
    }

    companion object {
        fun factory(session: SessionStore, channelId: String) =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ChannelFollowsViewModel(SessionFollowBackend(session), channelId) as T
            }
    }
}
