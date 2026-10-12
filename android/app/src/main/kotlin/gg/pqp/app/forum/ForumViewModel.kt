package gg.pqp.app.forum

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.channelBits
import gg.pqp.app.core.hasPermission
import gg.pqp.app.core.serverPermissions
import gg.pqp.app.social.SocialRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Everything the forum screen reads from the outside world, in one seam, so
 * the view model runs on the JVM against a fake (`ForumViewModelTest`).
 */
interface ForumBackend {
    val viewerId: String?
    val frames: Flow<JsonObject>
    val connection: Flow<RealtimeState>

    suspend fun page(forumId: String, query: ForumQuery): ForumPostListResponse
    suspend fun tags(forumId: String): List<ForumTag>
    suspend fun settings(forumId: String): ForumSettings
    suspend fun config(serverId: String): ForumConfig
    suspend fun permissions(serverId: String): PermissionsSnapshot

    /** The forum takes the socket's primary slot: its two frames are fanned out to its viewers. */
    fun join(forumId: String)

    /** Move the forum's read cursor: the sidebar dot goes, and "Novo" is measured from here next visit. */
    fun markRead(channelId: String)
}

/** The live backend: the session's API and socket. */
class SessionForumBackend(private val session: SessionStore) : ForumBackend {
    override val viewerId: String?
        get() = (session.phase.value as? SessionPhase.Ready)?.me?.id
    override val frames: Flow<JsonObject> get() = session.realtime.frames
    override val connection: Flow<RealtimeState> get() = session.realtime.state

    override suspend fun page(forumId: String, query: ForumQuery) = session.api.forumPosts(forumId, query)
    override suspend fun tags(forumId: String) = session.api.forumTags(forumId)
    override suspend fun settings(forumId: String) = session.api.forumSettings(forumId)
    override suspend fun config(serverId: String) = session.api.forumConfig(serverId)
    override suspend fun permissions(serverId: String) = session.api.serverPermissions(serverId)
    override fun join(forumId: String) {
        session.realtime.joinChannel(forumId)
    }
    override fun markRead(channelId: String) {
        SocialRepository.of(session).markRead(channelId)
    }
}

data class ForumUiState(
    val list: ForumListState = ForumListState(),
    val filters: ForumFilters = ForumFilters(),
    val tags: List<ForumTag> = emptyList(),
    val settings: ForumSettings = ForumSettings(),
    /** The `forum_channels` flag. Off pauses new posts and hides nothing. */
    val postingEnabled: Boolean = true,
    /** SEND_MESSAGES on the forum. */
    val canPost: Boolean = true,
    /** MANAGE_MESSAGES or MANAGE_CHANNELS on the forum. */
    val isStaff: Boolean = false,
    /** Page 1 is on its way and nothing is drawn yet. */
    val loading: Boolean = true,
    /** Page 1 failed with nothing to show. */
    val loadError: Boolean = false,
    val loadingMore: Boolean = false,
    val moreError: Boolean = false,
    /** The search field is open over the header. */
    val searching: Boolean = false,
) {
    /** The tags a card or a chip can name, by id. */
    val tagsById: Map<String, ForumTag> get() = tags.associateBy { it.id }

    val isEmpty: Boolean get() = list.pinned.isEmpty() && list.posts.isEmpty()

    /** Nothing in the forum at all, as opposed to nothing under these filters. */
    val forumEmpty: Boolean get() = isEmpty && !filters.active && (list.counts?.posts ?: 0) == 0

    /** "Novo post" is offered: the flag is on and this account may write here. */
    val mayCreate: Boolean get() = postingEnabled && canPost
}

/**
 * One forum's list: page 1, paging, filters, the title search, and the two
 * live frames, with the rule that a list never reorders under the reader
 * ([ForumList]).
 */
class ForumViewModel(
    private val backend: ForumBackend,
    private val serverId: String,
    private val forumId: String,
    /** Saved filters for this forum, or null; see [ForumPrefs]. */
    saved: SavedForumFilters? = null,
    /** Called whenever the reader changes a filter, to keep it for next time. */
    private val onFiltersChanged: (SavedForumFilters) -> Unit = {},
    /** The search debounce; zero in tests. */
    private val searchDebounceMs: Long = 300L,
    /** The wait before retry [attempt] of a failed merge refresh; the socket's backoff, zero in tests. */
    private val refreshBackoffMs: (attempt: Int) -> Long = { gg.pqp.app.core.RealtimeClient.backoffMillis(it) },
) : ViewModel() {

    private val _state = MutableStateFlow(ForumUiState(filters = saved?.filters ?: ForumFilters()))
    val state: StateFlow<ForumUiState> = _state.asStateFlow()

    /** The sort was the reader's choice; otherwise it follows the forum's default. */
    private var sortExplicit = saved?.sortExplicit ?: false

    /** Scrolled away from the top: live moves queue instead of applying. */
    private var hold = false

    /** The post the reader has open on top of this list. */
    private var openPostId: String? = null

    /** Bumped for every new page-1 request, so a stale answer never lands. */
    private var generation = 0
    private var pageJob: Job? = null
    private var searchJob: Job? = null

    /** The forum's cursor has been moved for this visit (once, after page 1). */
    private var markedRead = false

    /** A page 1 is out; frames wait in [held] so its answer cannot erase them. */
    private var pageReading = false
    private val held = LinkedHashMap<String, ForumFrame>()

    /**
     * The cursor this VISIT replaced, from its first page. Every later page 1
     * (a filter, a reconnect, coming back from a post) is read after this
     * visit moved the cursor, and would otherwise take "Novo" off every card
     * the reader has not opened yet.
     */
    private var visitPreviousReadAt: String? = null

    private fun forVisit(list: ForumListState) = list.copy(forumPreviousReadAt = visitPreviousReadAt)

    init {
        viewModelScope.launch { loadMeta() }
        reload()
        viewModelScope.launch { listen() }
        viewModelScope.launch { followConnection() }
    }

    private fun upsertContext() = ForumUpsertContext(
        filters = _state.value.filters,
        viewerId = backend.viewerId,
        hold = hold,
        openPostId = openPostId,
    )

    private suspend fun loadMeta() = coroutineScope {
        val config = async { runCatching { backend.config(serverId) }.getOrNull() }
        val tags = async { runCatching { backend.tags(forumId) }.getOrNull() }
        val settings = async { runCatching { backend.settings(forumId) }.getOrNull() }
        val permissions = async { runCatching { backend.permissions(serverId) }.getOrNull() }

        settings.await()?.let { loaded ->
            val default = ForumSort.fromWire(loaded.defaultSort) ?: ForumSort.Activity
            _state.value = _state.value.copy(
                settings = loaded,
                // The server already sorted page 1 by this when no sort was
                // asked for, so adopting it here re-reads nothing.
                filters = if (sortExplicit) _state.value.filters else _state.value.filters.copy(sort = default),
            )
        }
        tags.await()?.let { loaded ->
            _state.value = _state.value.copy(tags = loaded.sortedBy { it.position })
        }
        // Off on a failure would hide "Novo post" from everybody on a flaky
        // network; the server refuses a create with the flag off anyway, and
        // the composer says so in its own words.
        config.await()?.let { _state.value = _state.value.copy(postingEnabled = it.enabled) }
        permissions.await()?.let { snapshot ->
            val bits = snapshot.channelBits(forumId)
            _state.value = _state.value.copy(
                canPost = hasPermission(bits, Permission.SEND_MESSAGES),
                isStaff = hasPermission(bits, Permission.MANAGE_MESSAGES) ||
                    hasPermission(bits, Permission.MANAGE_CHANNELS),
            )
        }
    }

    private fun query(cursor: String? = null): ForumQuery {
        val filters = _state.value.filters
        val base = filters.query(cursor)
        return if (sortExplicit) base else base.copy(sort = null)
    }

    /** Page 1 from scratch: first open, a filter change, a retry. */
    fun reload() {
        val ticket = ++generation
        pageJob?.cancel()
        val hadPosts = !_state.value.isEmpty
        // A load-more from the old filters may still be out; its answer is
        // dropped by the ticket, so the flag is cleared here or paging would
        // stay "in progress" for good.
        _state.value = _state.value.copy(
            loading = !hadPosts,
            loadError = false,
            moreError = false,
            loadingMore = false,
        )
        pageReading = true
        pageJob = viewModelScope.launch {
            val page = try {
                backend.page(forumId, query())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            if (ticket != generation) return@launch
            pageReading = false
            if (page == null) {
                _state.value = _state.value.copy(loading = false, loadError = _state.value.isEmpty)
                replayHeld()
                return@launch
            }
            val first = !markedRead
            if (first) visitPreviousReadAt = page.forumPreviousReadAt
            _state.value = _state.value.copy(list = forVisit(ForumList.fromPage(page)), loading = false, loadError = false)
            // Frames that landed while the page was out may be newer than it.
            replayHeld()
            if (first) {
                // After the first page, never before: its `forumPreviousReadAt`
                // is the cursor this visit replaces, which is what "Novo" means.
                markedRead = true
                backend.markRead(forumId)
            }
        }
    }

    /** The next page, when the reader nears the end. */
    fun loadMore() {
        val current = _state.value
        val cursor = current.list.nextCursor ?: return
        if (current.loadingMore || current.loading) return
        val ticket = generation
        _state.value = current.copy(loadingMore = true, moreError = false)
        viewModelScope.launch {
            val page = try {
                backend.page(forumId, query(cursor))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            if (ticket != generation) return@launch
            _state.value = if (page == null) {
                _state.value.copy(loadingMore = false, moreError = true)
            } else {
                _state.value.copy(list = ForumList.append(_state.value.list, page), loadingMore = false)
            }
        }
    }

    // --- filters ---

    private fun setFilters(next: ForumFilters, explicitSort: Boolean = sortExplicit) {
        if (next == _state.value.filters && explicitSort == sortExplicit) return
        sortExplicit = explicitSort
        _state.value = _state.value.copy(filters = next)
        onFiltersChanged(SavedForumFilters(next.copy(q = ""), sortExplicit))
        reload()
    }

    fun setSort(sort: ForumSort) = setFilters(_state.value.filters.copy(sort = sort), explicitSort = true)

    /** Abertos and Resolvidos are toggles; Todos is "neither on". */
    fun toggleStatus(status: ForumStatus) {
        val current = _state.value.filters
        setFilters(current.copy(status = if (current.status == status) null else status))
    }

    fun toggleMine() = setFilters(_state.value.filters.copy(mine = !_state.value.filters.mine))

    /** AND, at most five like the server's query. */
    fun toggleTag(tagId: String) {
        val current = _state.value.filters
        val next = if (tagId in current.tagIds) {
            current.tagIds - tagId
        } else {
            (current.tagIds + tagId).takeLast(ForumLimits.MAX_TAGS_PER_POST)
        }
        setFilters(current.copy(tagIds = next))
    }

    fun clearFilters() = setFilters(_state.value.filters.copy(status = null, mine = false, tagIds = emptyList(), q = ""))

    fun openSearch() {
        _state.value = _state.value.copy(searching = true)
    }

    /** Closing the field clears the query, so the list is never filtered by text nobody can see. */
    fun closeSearch() {
        _state.value = _state.value.copy(searching = false)
        setQuery("")
    }

    fun setQuery(text: String) {
        val q = text.trim().take(ForumLimits.SEARCH_MAX)
        // Cancelled first: a query still in its debounce must not land after
        // the field was cleared or closed.
        searchJob?.cancel()
        if (q == _state.value.filters.q) return
        searchJob = viewModelScope.launch {
            if (searchDebounceMs > 0) delay(searchDebounceMs)
            _state.value = _state.value.copy(filters = _state.value.filters.copy(q = q))
            reload()
        }
    }

    // --- live ---

    /** The reader scrolled away from the top (true) or came back (false). */
    fun setHold(held: Boolean) {
        if (hold == held) return
        hold = held
        if (!held && _state.value.list.queued.isNotEmpty()) flush()
    }

    /** "Atualizar" on the pill: everything held back, in place. */
    fun flush() {
        val overflowed = _state.value.list.queueOverflowed
        _state.value = _state.value.copy(list = ForumList.flush(_state.value.list, upsertContext()))
        // More arrived than the queue holds: what was dropped comes with page 1.
        if (overflowed) refreshInPlace()
    }

    /** The reader opened [postId] (null: came back to the list). */
    fun setOpenPost(postId: String?) {
        val left = openPostId
        openPostId = postId
        val read = postId ?: left ?: return
        _state.value = _state.value.copy(
            list = ForumList.markRead(_state.value.list, read, ForumLanding.isoNow()),
        )
    }

    /** A post this screen changed itself (the composer's new post, an edit from the post screen). */
    fun applyPost(post: ForumPostSummary) {
        _state.value = _state.value.copy(list = ForumList.upsert(_state.value.list, post, upsertContext()))
    }

    /** Re-take the forum's slot: a screen pushed on top may have taken it. */
    fun resubscribe() {
        backend.join(forumId)
    }

    private suspend fun listen() {
        backend.frames.collect { frame ->
            // `forum-post-upsert`: a post appeared, was bumped, or changed
            // (title, tags, pin, lock, resolve); under the reader's hand it
            // queues (see `ForumList`). `forum-post-removed`: a post was
            // deleted, and its card leaves, from the queue too.
            when (frame["type"]?.jsonPrimitive?.contentOrNull) {
                "forum-post-upsert", "forum-post-removed" -> ForumFrame.decode(frame)?.let(::onFrame)
            }
        }
    }

    private fun replayHeld() {
        val frames = held.values.toList()
        held.clear()
        frames.forEach(::apply)
    }

    private fun ForumFrame.postId(): String = when (this) {
        is ForumFrame.Upsert -> post.id
        is ForumFrame.Removed -> postId
    }

    internal fun onFrame(frame: ForumFrame) {
        if (frame.forumId != forumId) return
        if (frame is ForumFrame.Upsert && frame.post.forumId != forumId) return
        if (pageReading) {
            // One entry per post, the latest state (a removal is final and
            // never replaced by an older upsert). Bounded by the posts the
            // forum has rather than by its traffic, and nothing is dropped.
            val id = frame.postId()
            if (held[id] !is ForumFrame.Removed) {
                held.remove(id)
                held[id] = frame
            }
            return
        }
        apply(frame)
    }

    private fun apply(frame: ForumFrame) {
        val list = _state.value.list
        _state.value = _state.value.copy(
            list = when (frame) {
                is ForumFrame.Upsert -> ForumList.upsert(list, frame.post, upsertContext())
                is ForumFrame.Removed -> ForumList.removed(list, frame.postId)
            },
        )
    }

    /**
     * The socket forgets this forum on every reconnect, and whatever was said
     * meanwhile never arrives as frames: re-take the slot and merge a fresh
     * page 1 over what is drawn (never a reset: a reader on page 3 stays).
     */
    private suspend fun followConnection() {
        var first = true
        backend.connection.collect { state ->
            if (state != RealtimeState.Ready) return@collect
            backend.join(forumId)
            if (first) {
                first = false
                return@collect
            }
            refreshInPlace()
        }
    }

    /** Page 1 again, merged (coming back from a post, a reconnect). */
    fun refreshInPlace() {
        if (_state.value.loading) return
        val ticket = generation
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch {
            // After a reconnect this read is the only way back to what was
            // said meanwhile, so a failure is retried on the socket's backoff
            // rather than left standing until the next reconnect.
            for (attempt in 1..REFRESH_TRIES) {
                val page = try {
                    backend.page(forumId, query())
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    null
                }
                if (ticket != generation) return@launch
                if (page != null) {
                    _state.value = _state.value.copy(list = forVisit(ForumList.refreshFirstPage(_state.value.list, page)))
                    return@launch
                }
                if (attempt < REFRESH_TRIES) delay(refreshBackoffMs(attempt))
            }
        }
    }

    private var refreshJob: Job? = null

    override fun onCleared() {
        // Everything the list showed is read now; a list that never loaded
        // showed nothing, and leaves the cursor where it was.
        if (markedRead) backend.markRead(forumId)
    }

    companion object {
        /** Tries for one merge refresh (the first read plus two retries). */
        internal const val REFRESH_TRIES = 3

        fun factory(
            session: SessionStore,
            prefs: ForumPrefs,
            serverId: String,
            forumId: String,
        ) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = ForumViewModel(
                backend = SessionForumBackend(session),
                serverId = serverId,
                forumId = forumId,
                saved = prefs.filters(forumId),
                onFiltersChanged = { prefs.saveFilters(forumId, it) },
            ) as T
        }
    }
}
