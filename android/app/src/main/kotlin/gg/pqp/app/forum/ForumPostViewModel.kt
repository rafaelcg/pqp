package gg.pqp.app.forum

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Message
import gg.pqp.app.core.Permission
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.channelBits
import gg.pqp.app.core.hasPermission
import gg.pqp.app.core.serverPermissions
import gg.pqp.app.social.SocialRepository
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Something the post screen says once, as a toast. Mapped to copy by the screen. */
enum class ForumNotice {
    SaveFailed,
    PinFull,
    AutomodTitle,
    TagRequired,
    LinkCopied,
    Following,
    Unfollowed,
}

data class ForumPostUiState(
    val post: ForumPostSummary? = null,
    val viewer: ForumPostViewer? = null,
    val acceptedAnswer: ForumAcceptedAnswer? = null,
    val participantCount: Int = 0,
    /**
     * The reader's cursor in this post before this visit: null for a first
     * visit, which opens on the question. Read from the detail, which answers
     * before this visit moves the cursor.
     */
    val previousReadAt: String? = null,
    /** [previousReadAt] is known (or the detail failed and the chat opens as a chat). */
    val landingReady: Boolean = false,
    val loading: Boolean = true,
    /** The post could not be read at all (gone, or never visible). */
    val loadFailed: Boolean = false,
    /** Deleted while open: the screen says so instead of closing on the reader. */
    val removed: Boolean = false,
    val isStaff: Boolean = false,
    val tags: List<ForumTag> = emptyList(),
) {
    val tagsById: Map<String, ForumTag> get() = tags.associateBy { it.id }
}

/**
 * One post's header and its actions (UX §2.4): the title, status and tags,
 * the accepted answer under the question, and what the author and staff may
 * do. The transcript itself is the chat screen's.
 *
 * Every action is optimistic and rolls back with "Não deu pra salvar" when the
 * server says no, and the server's `forum-post-upsert` is what the forum list
 * under this screen updates from, so the card and the post never disagree.
 */
class ForumPostViewModel(
    private val session: SessionStore,
    private val serverId: String?,
    private val postId: String,
) : ViewModel() {

    private val _state = MutableStateFlow(ForumPostUiState())
    val state: StateFlow<ForumPostUiState> = _state.asStateFlow()

    private val _notices = MutableSharedFlow<ForumNotice>(extraBufferCapacity = 4)
    val notices: SharedFlow<ForumNotice> = _notices.asSharedFlow()

    /** "Ir pra resposta": message ids for the transcript to bring into view. */
    private val _jumps = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val jumps: SharedFlow<String> = _jumps.asSharedFlow()

    /** The detail answered, so the reader saw the post: only then does leaving mark it read. */
    private var loaded = false

    private val viewerId: String?
        get() = (session.phase.value as? SessionPhase.Ready)?.me?.id

    init {
        viewModelScope.launch { load() }
        viewModelScope.launch { listen() }
    }

    private suspend fun load() = coroutineScope {
        val detail = async { runCatching { session.api.forumPost(postId) } }
        val permissions = async {
            serverId?.let { runCatching { session.api.serverPermissions(it) }.getOrNull() }
        }
        val result = detail.await()
        val loaded = result.getOrNull()
        if (loaded == null) {
            _state.value = _state.value.copy(loading = false, loadFailed = true, landingReady = true)
            return@coroutineScope
        }
        _state.value = _state.value.copy(
            post = loaded.post,
            viewer = loaded.viewer,
            acceptedAnswer = loaded.acceptedAnswer,
            participantCount = loaded.participantCount,
            previousReadAt = loaded.viewer.lastReadAt,
            landingReady = true,
            loading = false,
        )
        // After the detail, never before: its cursor is the one this visit
        // replaces, and the "Novas" divider is measured against it.
        this@ForumPostViewModel.loaded = true
        SocialRepository.of(session).markRead(postId)

        val tags = runCatching { session.api.forumTags(loaded.post.forumId) }.getOrNull()
        val snapshot = permissions.await()
        _state.value = _state.value.copy(
            tags = tags?.sortedBy { it.position } ?: _state.value.tags,
            isStaff = snapshot?.channelBits(loaded.post.forumId)?.let { bits ->
                hasPermission(bits, Permission.MANAGE_MESSAGES) || hasPermission(bits, Permission.MANAGE_CHANNELS)
            } ?: false,
        )
    }

    /** The detail again, for the answer's excerpt and the people count after a change. */
    private fun refreshDetail() {
        viewModelScope.launch {
            val loaded = runCatching { session.api.forumPost(postId) }.getOrNull() ?: return@launch
            _state.value = _state.value.copy(
                post = loaded.post,
                acceptedAnswer = loaded.acceptedAnswer,
                participantCount = loaded.participantCount,
                viewer = _state.value.viewer?.copy(following = loaded.viewer.following) ?: loaded.viewer,
            )
        }
    }

    private suspend fun listen() {
        session.realtime.frames.collect { frame ->
            // `forum-post-upsert` reaches this screen because the forum keeps
            // the socket's primary slot; `forum-post-removed` also goes to the
            // post's own viewers.
            when (frame["type"]?.jsonPrimitive?.contentOrNull) {
                "forum-post-upsert", "forum-post-removed" -> ForumFrame.decode(frame)?.let(::onFrame)
            }
        }
    }

    private fun onFrame(frame: ForumFrame) {
        when (frame) {
            is ForumFrame.Removed -> if (frame.postId == postId) {
                _state.value = _state.value.copy(removed = true)
            }
            is ForumFrame.Upsert -> if (frame.post.id == postId) {
                val before = _state.value.post
                _state.value = _state.value.copy(post = frame.post)
                if (before?.acceptedAnswerId != frame.post.acceptedAnswerId) refreshDetail()
            }
        }
    }

    // --- who may do what ---

    val isAuthor: Boolean
        get() = viewerId != null && _state.value.post?.authorId == viewerId

    /** Title, tags, resolve and the answer: the author or staff. */
    val canEdit: Boolean get() = isAuthor || _state.value.isStaff

    /** A reply in this post that the author or staff may mark as the answer; never the question. */
    fun mayMarkAnswer(message: Message, openingId: String?): Boolean {
        val post = _state.value.post ?: return false
        if (!canEdit) return false
        return !isOpening(message, post, openingId)
    }

    companion object {
        /**
         * The question is the post's first message. Known exactly once the
         * transcript reaches the start ([openingId]); before that, it is the
         * author's message written in the same moment the post was.
         */
        fun isOpening(message: Message, post: ForumPostSummary, openingId: String?): Boolean {
            if (openingId != null) return message.id == openingId
            if (message.authorId != post.authorId) return false
            val created = runCatching { java.time.Instant.parse(post.createdAt) }.getOrNull() ?: return false
            val at = runCatching { java.time.Instant.parse(message.createdAt) }.getOrNull() ?: return false
            return kotlin.math.abs(java.time.Duration.between(created, at).toMillis()) < OPENING_WINDOW_MS
        }

        private const val OPENING_WINDOW_MS = 5_000L

        /** `FORUM_ANSWER_EXCERPT_MAX`, for the card drawn before the server's own excerpt lands. */
        private const val EXCERPT_MAX = 280

        fun factory(session: SessionStore, serverId: String?, postId: String) =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ForumPostViewModel(session, serverId, postId) as T
            }
    }

    // --- actions ---

    /**
     * One optimistic change: [optimistic] is drawn now, [request] runs, and
     * the server's answer replaces it, or the old post comes back with a
     * reason.
     */
    private fun change(
        optimistic: (ForumPostSummary) -> ForumPostSummary,
        request: suspend () -> ForumPostSummary,
        after: (ForumPostSummary) -> Unit = {},
        rollback: () -> Unit = {},
    ) {
        val before = _state.value.post ?: return
        val drawn = optimistic(before)
        _state.value = _state.value.copy(post = drawn)
        viewModelScope.launch {
            runCatching { request() }
                .onSuccess { updated ->
                    _state.value = _state.value.copy(post = updated)
                    after(updated)
                }
                .onFailure { failure ->
                    if (_state.value.post == drawn) {
                        _state.value = _state.value.copy(post = before)
                        rollback()
                    } else {
                        // Something newer was drawn since (a second action, a
                        // frame): the snapshot is stale, the server is not.
                        refreshDetail()
                    }
                    _notices.tryEmit(noticeFor(failure))
                }
        }
    }

    private fun noticeFor(failure: Throwable): ForumNotice {
        val api = failure as? ApiException ?: return ForumNotice.SaveFailed
        return when {
            api.serverMessage == ForumErrors.PIN_LIMIT || api.status == 409 -> ForumNotice.PinFull
            api.serverMessage == ForumErrors.TAG_REQUIRED -> ForumNotice.TagRequired
            api.serverMessage == ForumErrors.POST_REJECTED &&
                api.body?.get("reason")?.jsonPrimitive?.contentOrNull == "automod" -> ForumNotice.AutomodTitle
            else -> ForumNotice.SaveFailed
        }
    }

    private fun now() = ForumLanding.isoNow()

    /** Resolve, or "Reabrir", which clears the answer too. */
    fun toggleResolved() {
        val post = _state.value.post ?: return
        val resolve = !post.resolved
        val previousAnswer = _state.value.acceptedAnswer
        if (!resolve) _state.value = _state.value.copy(acceptedAnswer = null)
        change(
            optimistic = {
                if (resolve) it.copy(resolvedAt = now()) else it.copy(resolvedAt = null, acceptedAnswerId = null)
            },
            request = { session.api.updateForumPost(postId, UpdateForumPostRequest(resolved = resolve)) },
            rollback = { _state.value = _state.value.copy(acceptedAnswer = previousAnswer) },
        )
    }

    /** "Marcar como solução": also resolves. The card under the question is drawn from [message] at once. */
    fun markAnswer(message: Message) {
        val previousAnswer = _state.value.acceptedAnswer
        _state.value = _state.value.copy(
            acceptedAnswer = ForumAcceptedAnswer(
                messageId = message.id,
                authorId = message.authorId,
                authorName = message.authorName,
                excerpt = message.body.replace(Regex("\\s+"), " ").trim().take(EXCERPT_MAX).ifEmpty { null },
                createdAt = message.createdAt,
            ),
        )
        change(
            optimistic = { it.copy(acceptedAnswerId = message.id, resolvedAt = it.resolvedAt ?: now()) },
            request = { session.api.updateForumPost(postId, UpdateForumPostRequest(acceptedAnswerId = message.id)) },
            after = { refreshDetail() },
            rollback = { _state.value = _state.value.copy(acceptedAnswer = previousAnswer) },
        )
    }

    /** "Tirar a solução": the post stays resolved, the card goes. */
    fun unmarkAnswer() {
        val previousAnswer = _state.value.acceptedAnswer
        _state.value = _state.value.copy(acceptedAnswer = null)
        val before = _state.value.post ?: return
        _state.value = _state.value.copy(post = before.copy(acceptedAnswerId = null))
        viewModelScope.launch {
            runCatching { session.api.clearAcceptedAnswer(postId) }
                .onSuccess { _state.value = _state.value.copy(post = it) }
                .onFailure {
                    _state.value = _state.value.copy(post = before, acceptedAnswer = previousAnswer)
                    _notices.tryEmit(noticeFor(it))
                }
        }
    }

    fun togglePinned() {
        val pin = _state.value.post?.pinned != true
        change(
            optimistic = { it.copy(pinnedAt = if (pin) now() else null) },
            request = { session.api.updateForumPost(postId, UpdateForumPostRequest(pinned = pin)) },
        )
    }

    fun toggleLocked() {
        val lock = _state.value.post?.locked != true
        change(
            optimistic = { it.copy(lockedAt = if (lock) now() else null) },
            request = { session.api.updateForumPost(postId, UpdateForumPostRequest(locked = lock)) },
        )
    }

    fun setTitle(title: String) {
        val clean = title.replace(Regex("\\s+"), " ").trim().take(ForumLimits.TITLE_MAX)
        if (clean.isEmpty() || clean == _state.value.post?.title) return
        change(
            optimistic = { it.copy(title = clean) },
            request = { session.api.updateForumPost(postId, UpdateForumPostRequest(title = clean)) },
        )
    }

    fun setTags(tagIds: List<String>) {
        val ordered = _state.value.tags.map { it.id }.filter { it in tagIds }
        if (ordered == _state.value.post?.tagIds) return
        change(
            optimistic = { it.copy(tagIds = ordered) },
            request = { session.api.updateForumPost(postId, UpdateForumPostRequest(tagIds = ordered)) },
        )
    }

    /** Bumped per tap, so only the newest tap's answer is drawn. */
    private var followTicket = 0

    fun toggleFollow() {
        val viewer = _state.value.viewer ?: return
        val follow = !viewer.following
        val ticket = ++followTicket
        _state.value = _state.value.copy(viewer = viewer.copy(following = follow))
        viewModelScope.launch {
            runCatching { session.api.setForumPostFollow(postId, follow) }
                .onSuccess {
                    if (ticket != followTicket) return@onSuccess
                    _state.value = _state.value.copy(viewer = _state.value.viewer?.copy(following = it.following))
                    _notices.tryEmit(if (it.following) ForumNotice.Following else ForumNotice.Unfollowed)
                }
                .onFailure {
                    if (ticket != followTicket) return@onFailure
                    _state.value = _state.value.copy(viewer = viewer)
                    _notices.tryEmit(ForumNotice.SaveFailed)
                }
        }
    }

    /** Staff only. Answers through [onDone] so the screen can leave once it is gone. */
    fun delete(onDone: () -> Unit) {
        viewModelScope.launch {
            runCatching { session.api.deleteForumPost(postId) }
                .onSuccess { onDone() }
                .onFailure { _notices.tryEmit(ForumNotice.SaveFailed) }
        }
    }

    fun jumpToAnswer() {
        _state.value.acceptedAnswer?.takeUnless { it.deleted }?.let { _jumps.tryEmit(it.messageId) }
    }

    fun linkCopied() {
        _notices.tryEmit(ForumNotice.LinkCopied)
    }

    override fun onCleared() {
        // Everything on screen is read now, the replies that landed meanwhile too.
        if (loaded) SocialRepository.of(session).markRead(postId)
    }
}
