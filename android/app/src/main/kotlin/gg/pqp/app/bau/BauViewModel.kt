package gg.pqp.app.bau

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.SessionStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

data class BauState(
    val posts: List<BauPost> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
    /** The instance flags, for the VIP chip. Off until the config answers. */
    val config: CommunityHomeConfig = CommunityHomeConfig(),
    /** Posts whose full comment list has been fetched, by post id. */
    val expandedComments: Map<String, List<BauComment>> = emptyMap(),
    /** Posts whose full comment list is on its way. */
    val loadingComments: Set<String> = emptySet(),
    /** Posts with a comment in flight, so the composer cannot double-send. */
    val submitting: Set<String> = emptySet(),
    /** Posts whose last comment did not land, for the composer to say so. */
    val commentFailed: Set<String> = emptySet(),
)

/**
 * One server's Baú.
 *
 * Posts come over HTTP and stay put; the only live thing is the
 * `community-home-update` frame, which says "refetch" and nothing more (a
 * publish, a comment, a deletion; likes deliberately do not fan out). The
 * feed is small and unpaginated on the API this pass, so a refetch is the
 * whole list.
 */
class BauViewModel(
    private val session: SessionStore,
    private val serverId: String,
) : ViewModel() {

    private val _state = MutableStateFlow(BauState())
    val state: StateFlow<BauState> = _state.asStateFlow()

    init {
        viewModelScope.launch { _state.value = _state.value.copy(config = CommunityHomeConfigs.resolve(session.api)) }
        viewModelScope.launch { load() }
        viewModelScope.launch { listen() }
    }

    fun refresh() {
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        runCatching { session.api.bauPosts(serverId) }
            .onSuccess { posts ->
                _state.value = _state.value.copy(posts = posts, loading = false, error = null)
            }
            .onFailure { failure ->
                _state.value = _state.value.copy(
                    loading = false,
                    error = failure.message?.takeIf { it.isNotBlank() }
                        ?: failure::class.java.simpleName,
                )
            }
    }

    private suspend fun listen() {
        session.realtime.frames.collect { frame ->
            if (frame["type"]?.jsonPrimitive?.contentOrNull != "community-home-update") return@collect
            if (frame["serverId"]?.jsonPrimitive?.contentOrNull != serverId) return@collect
            // A nudge, not a payload: the server says something changed and
            // the list is re-read. Expanded comment lists are dropped so a
            // deleted comment does not survive on screen.
            _state.value = _state.value.copy(expandedComments = emptyMap())
            load()
        }
    }

    /**
     * Applied locally first, then confirmed by the response, which carries
     * the count the server settled on. A heart that waits for the round trip
     * reads as a dead control; a heart that never hears back is rolled back.
     */
    fun toggleLike(postId: String) {
        val before = _state.value.posts
        _state.value = _state.value.copy(
            posts = before.map { post ->
                if (post.id != postId) {
                    post
                } else {
                    post.copy(
                        likedByMe = !post.likedByMe,
                        likeCount = (post.likeCount + if (post.likedByMe) -1 else 1).coerceAtLeast(0),
                    )
                }
            },
        )
        viewModelScope.launch {
            runCatching { session.api.toggleBauLike(serverId, postId) }
                .onSuccess { result ->
                    _state.value = _state.value.copy(
                        posts = _state.value.posts.map { post ->
                            if (post.id != postId) {
                                post
                            } else {
                                post.copy(likedByMe = result.liked, likeCount = result.likeCount)
                            }
                        },
                    )
                }
                .onFailure { _state.value = _state.value.copy(posts = before) }
        }
    }

    /** "See all N": fetch the whole list once and keep it under the card. */
    fun loadAllComments(postId: String) {
        val current = _state.value
        if (postId in current.loadingComments || postId in current.expandedComments) return
        _state.value = current.copy(loadingComments = current.loadingComments + postId)
        viewModelScope.launch {
            val comments = runCatching { session.api.bauComments(serverId, postId) }.getOrNull()
            _state.value = _state.value.copy(
                loadingComments = _state.value.loadingComments - postId,
                expandedComments = if (comments == null) {
                    _state.value.expandedComments
                } else {
                    _state.value.expandedComments + (postId to comments)
                },
            )
        }
    }

    fun collapseComments(postId: String) {
        _state.value = _state.value.copy(expandedComments = _state.value.expandedComments - postId)
    }

    /**
     * Post a comment. The card is patched from the response rather than
     * refetched: the teaser becomes the two newest, the count goes up by one,
     * and an expanded list gets the new row at the end, which is exactly what
     * the web does with the same response.
     */
    fun addComment(postId: String, body: String) {
        val trimmed = body.trim()
        if (trimmed.isEmpty()) return
        val current = _state.value
        if (postId in current.submitting) return
        _state.value = current.copy(
            submitting = current.submitting + postId,
            commentFailed = current.commentFailed - postId,
        )
        viewModelScope.launch {
            runCatching { session.api.addBauComment(serverId, postId, trimmed) }
                .onSuccess { comment ->
                    val state = _state.value
                    _state.value = state.copy(
                        submitting = state.submitting - postId,
                        posts = state.posts.map { post ->
                            if (post.id != postId) {
                                post
                            } else {
                                post.copy(
                                    commentTeaser = (post.commentTeaser + comment).takeLast(2),
                                    commentCount = post.commentCount + 1,
                                )
                            }
                        },
                        expandedComments = state.expandedComments[postId]?.let { all ->
                            state.expandedComments + (postId to all + comment)
                        } ?: state.expandedComments,
                    )
                }
                .onFailure {
                    val state = _state.value
                    _state.value = state.copy(
                        submitting = state.submitting - postId,
                        commentFailed = state.commentFailed + postId,
                    )
                }
        }
    }

    companion object {
        fun factory(session: SessionStore, serverId: String) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                BauViewModel(session, serverId) as T
        }
    }
}
