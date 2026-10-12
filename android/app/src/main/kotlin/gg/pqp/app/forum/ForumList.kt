package gg.pqp.app.forum

import java.text.Normalizer

/*
 * The forum list as the screen holds it, and every change a live frame can
 * make to it. Pure, so the rules that decide where a card goes (and, more
 * often, that it does NOT move) are tested on the JVM: `ForumListTest`.
 *
 * A port of `client/src/lib/forum-list.ts`, rule for rule, so a card moves on
 * a phone exactly when it moves on the web.
 *
 * THE RULE THIS FILE EXISTS FOR: a list must never reorder under the reader.
 * A new post or a bump that arrives while the reader is scrolled down is
 * QUEUED, and the screen says so with a pill ("3 posts com novidade"). Only at
 * the top does a change apply in place. An edit (title, tags, status) never
 * moves anything, held or not.
 *
 * A bump moves a card only under `activity`, and only when the post still
 * passes the filters on screen: under `created` the order is the creation
 * order and a reply cannot change it.
 */

data class ForumFilters(
    val sort: ForumSort = ForumSort.Activity,
    val status: ForumStatus? = null,
    val mine: Boolean = false,
    /** AND: a post must carry every one of these. */
    val tagIds: List<String> = emptyList(),
    /** The title search, trimmed. Empty is no search. */
    val q: String = "",
) {
    /** Anything that narrows the list (sort is an order, not a filter). */
    val active: Boolean get() = status != null || mine || tagIds.isNotEmpty() || q.isNotEmpty()

    fun query(cursor: String? = null): ForumQuery = ForumQuery(
        sort = sort,
        tagIds = tagIds,
        status = status,
        mine = mine,
        q = q.ifBlank { null },
        cursor = cursor,
    )
}

data class ForumListState(
    val pinned: List<ForumPostSummary> = emptyList(),
    val posts: List<ForumPostSummary> = emptyList(),
    val viewer: Map<String, ForumPostViewer> = emptyMap(),
    val nextCursor: String? = null,
    val counts: ForumCounts? = null,
    val forumPreviousReadAt: String? = null,
    /**
     * Live changes held back while the reader is busy, newest last, one entry
     * per post. Applied by [ForumList.flush] when the pill is tapped or the
     * reader returns to the top.
     */
    val queued: List<ForumPostSummary> = emptyList(),
) {
    fun find(postId: String): ForumPostSummary? =
        pinned.firstOrNull { it.id == postId } ?: posts.firstOrNull { it.id == postId }
}

/** What an upsert needs to know about the screen. */
data class ForumUpsertContext(
    val filters: ForumFilters,
    val viewerId: String?,
    /** The reader is scrolled down: queue, do not move. */
    val hold: Boolean,
    /** The post the reader has open, whose replies they are watching land. */
    val openPostId: String? = null,
)

/** Two unread levels (UX §2.3). */
sealed interface ForumUnread {
    /** Never opened, somebody else's, created after the last visit. */
    data object New : ForumUnread

    /** Opened before, replies since. */
    data class Unread(val count: Int) : ForumUnread

    data object Read : ForumUnread
}

object ForumList {

    fun fromPage(page: ForumPostListResponse): ForumListState {
        val pinnedIds = page.pinned.map { it.id }.toSet()
        return ForumListState(
            pinned = page.pinned,
            posts = page.posts.filterNot { it.id in pinnedIds },
            viewer = page.viewer.associateBy { it.postId },
            nextCursor = page.nextCursor,
            counts = page.counts,
            forumPreviousReadAt = page.forumPreviousReadAt,
        )
    }

    /**
     * A later page, deduplicated by id: a keyset page read after a bump moved
     * a card up can hand back a post already on screen.
     */
    fun append(state: ForumListState, page: ForumPostListResponse): ForumListState {
        val seen = (state.pinned + state.posts).map { it.id }.toSet()
        return state.copy(
            posts = state.posts + page.posts.filterNot { it.id in seen },
            viewer = state.viewer + page.viewer.associateBy { it.postId },
            nextCursor = page.nextCursor,
        )
    }

    /**
     * Page 1 read again (a reconnect, coming back from a post), MERGED into
     * what the reader already has: the fresh page replaces the top, the pages
     * below it stay with the cursor that continues them, and anything queued
     * stays queued. Replacing everything would throw a reader on page 3 back
     * to the top on every network blip.
     */
    fun refreshFirstPage(state: ForumListState, page: ForumPostListResponse): ForumListState {
        val fresh = fromPage(page)
        val shown = (fresh.pinned + fresh.posts).map { it.id }.toSet()
        val tail = state.posts.filterNot { it.id in shown }
        val keepsTail = tail.isNotEmpty() && state.posts.size > page.posts.size
        return fresh.copy(
            posts = if (keepsTail) fresh.posts + tail else fresh.posts,
            nextCursor = if (keepsTail) state.nextCursor else fresh.nextCursor,
            viewer = state.viewer + fresh.viewer,
            queued = state.queued.filterNot { it.id in shown },
        )
    }

    /** Lowercased, accents folded: "Notebook não liga" matches "notebook nao". */
    fun fold(value: String): String =
        Normalizer.normalize(value, Normalizer.Form.NFD)
            .replace(DIACRITICS, "")
            .lowercase()
            .trim()

    private val DIACRITICS = Regex("\\p{Mn}+")

    /** Every word of the query appears in the title, in any order. */
    fun titleMatches(title: String, q: String): Boolean {
        val words = fold(q).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return true
        val folded = fold(title)
        return words.all { folded.contains(it) }
    }

    /** The server's filter, for a post a frame just handed us. */
    fun passes(post: ForumPostSummary, filters: ForumFilters, viewerId: String?): Boolean {
        if (filters.status == ForumStatus.Open && post.resolvedAt != null) return false
        if (filters.status == ForumStatus.Resolved && post.resolvedAt == null) return false
        if (filters.mine && (viewerId == null || post.authorId != viewerId)) return false
        if (filters.tagIds.any { it !in post.tagIds }) return false
        if (filters.q.isNotEmpty() && !titleMatches(post.title, filters.q)) return false
        return true
    }

    private fun key(post: ForumPostSummary, sort: ForumSort): String =
        if (sort == ForumSort.Activity) post.lastActivityAt else post.createdAt

    /** Newest first, then id descending: the server's keyset order. */
    private fun comparator(sort: ForumSort): Comparator<ForumPostSummary> = Comparator { a, b ->
        val ka = key(a, sort)
        val kb = key(b, sort)
        when {
            ka != kb -> if (ka < kb) 1 else -1
            else -> b.id.compareTo(a.id)
        }
    }

    private fun List<ForumPostSummary>.replacing(post: ForumPostSummary) =
        map { if (it.id == post.id) post else it }

    private fun List<ForumPostSummary>.without(id: String) = filterNot { it.id == id }

    /**
     * Where a post the list did not hold belongs, or null when it sorts past
     * the loaded pages (paging will bring it).
     */
    private fun insertSorted(
        list: List<ForumPostSummary>,
        post: ForumPostSummary,
        sort: ForumSort,
        complete: Boolean,
    ): List<ForumPostSummary>? {
        val compare = comparator(sort)
        val index = list.indexOfFirst { compare.compare(post, it) < 0 }
        if (index == -1) return if (complete) list + post else null
        return list.subList(0, index) + post + list.subList(index, list.size)
    }

    /**
     * The reader's half for a post a frame changed. Frames carry no viewer
     * state, so this is a local estimate until the next read: a bump of a
     * post the reader opened before counts its new replies; the post the
     * reader has open counts nothing, because they are reading as it lands.
     */
    private fun nextViewer(
        previous: ForumPostSummary?,
        post: ForumPostSummary,
        viewer: ForumPostViewer?,
        ctx: ForumUpsertContext,
    ): ForumPostViewer? {
        if (ctx.openPostId == post.id) {
            return ForumPostViewer(
                postId = post.id,
                lastReadAt = post.lastActivityAt,
                newReplyCount = 0,
                following = viewer?.following ?: false,
            )
        }
        if (viewer == null || previous == null || viewer.lastReadAt == null) return viewer
        val added = post.replyCount - previous.replyCount
        if (added <= 0) return viewer
        return viewer.copy(newReplyCount = minOf(ForumLimits.UNREAD_CAP, viewer.newReplyCount + added))
    }

    private fun adjustCounts(
        counts: ForumCounts?,
        previous: ForumPostSummary?,
        post: ForumPostSummary,
        isNew: Boolean,
    ): ForumCounts? {
        counts ?: return null
        var posts = counts.posts
        var open = counts.open
        if (isNew) {
            posts += 1
            if (post.resolvedAt == null) open += 1
        } else if (previous != null) {
            val wasOpen = previous.resolvedAt == null
            val isOpen = post.resolvedAt == null
            if (wasOpen && !isOpen) open = maxOf(0, open - 1) else if (!wasOpen && isOpen) open += 1
        }
        return ForumCounts(posts, open)
    }

    /** One `forum-post-upsert`. See the file header for the rules. */
    fun upsert(state: ForumListState, post: ForumPostSummary, ctx: ForumUpsertContext): ForumListState {
        val filters = ctx.filters
        val previous = state.find(post.id) ?: state.queued.firstOrNull { it.id == post.id }
        val viewer = nextViewer(previous, post, state.viewer[post.id], ctx)
        val viewerNext = if (viewer != null && viewer != state.viewer[post.id]) {
            state.viewer + (post.id to viewer)
        } else {
            state.viewer
        }
        // A post the list never held, with no replies and newer than anything
        // it did hold, is a new post; anything else unknown is an old post
        // bumped or edited beyond the loaded pages.
        val newestCreated = (state.pinned + state.posts).maxOfOrNull { it.createdAt } ?: ""
        val brandNew = previous == null && post.replyCount == 0 && post.createdAt > newestCreated
        val counts = adjustCounts(state.counts, previous, post, brandNew)

        // Pins sit above every filter and only vanish under a search.
        val wasPinned = state.pinned.any { it.id == post.id }
        if (post.pinnedAt != null && filters.q.isEmpty()) {
            return state.copy(
                pinned = if (wasPinned) state.pinned.replacing(post) else state.pinned + post,
                posts = state.posts.without(post.id),
                queued = state.queued.without(post.id),
                viewer = viewerNext,
                counts = counts,
            )
        }
        val base = state.copy(
            pinned = if (wasPinned) state.pinned.without(post.id) else state.pinned,
            viewer = viewerNext,
            counts = counts,
        )

        val index = base.posts.indexOfFirst { it.id == post.id }
        val passes = passes(post, filters, ctx.viewerId)

        if (index != -1) {
            val old = base.posts[index]
            if (!passes) {
                // It left the filter. Under the reader's hand it stays put,
                // updated, until they let go.
                return if (ctx.hold) {
                    base.copy(posts = base.posts.replacing(post))
                } else {
                    base.copy(posts = base.posts.without(post.id))
                }
            }
            val moved = filters.sort == ForumSort.Activity && post.lastActivityAt > old.lastActivityAt
            if (!moved || index == 0) return base.copy(posts = base.posts.replacing(post))
            if (ctx.hold) {
                // The words update now; the move waits for the pill.
                return base.copy(
                    posts = base.posts.replacing(post),
                    queued = base.queued.without(post.id) + post,
                )
            }
            val rest = base.posts.without(post.id)
            return base.copy(posts = insertSorted(rest, post, filters.sort, true) ?: rest)
        }

        if (!passes) return base.copy(queued = base.queued.without(post.id))
        // A reply cannot move a post under "Mais novos", and an old post the
        // pages did not reach yet arrives with them.
        if (filters.sort == ForumSort.Created && !brandNew) return base
        val placed = insertSorted(base.posts, post, filters.sort, base.nextCursor == null)
            ?: return base.copy(queued = base.queued.without(post.id))
        if (ctx.hold) return base.copy(queued = base.queued.without(post.id) + post)
        return base.copy(posts = placed)
    }

    /** One `forum-post-removed`: gone from every list, the queue included. */
    fun removed(state: ForumListState, postId: String): ForumListState {
        val previous = state.find(postId)
        if (previous == null && state.queued.none { it.id == postId }) return state
        val counts = if (previous != null && state.counts != null) {
            ForumCounts(
                posts = maxOf(0, state.counts.posts - 1),
                open = if (previous.resolvedAt == null) maxOf(0, state.counts.open - 1) else state.counts.open,
            )
        } else {
            state.counts
        }
        return state.copy(
            pinned = state.pinned.without(postId),
            posts = state.posts.without(postId),
            queued = state.queued.without(postId),
            viewer = state.viewer - postId,
            counts = counts,
        )
    }

    /** The pill was tapped (or the reader is back at the top): apply the queue. */
    fun flush(state: ForumListState, ctx: ForumUpsertContext): ForumListState {
        val free = ctx.copy(hold = false)
        // Queued posts were counted when they were queued; applying them is
        // not a second arrival.
        var next = state.copy(queued = emptyList(), counts = null)
        for (post in state.queued) {
            val onScreen = next.posts.any { it.id == post.id }
            if (onScreen && ctx.filters.sort == ForumSort.Activity) {
                // Its words were already updated in place when it was queued,
                // so an upsert would see no bump; the move is what waited.
                val rest = next.posts.without(post.id)
                next = next.copy(
                    posts = if (passes(post, ctx.filters, ctx.viewerId)) {
                        insertSorted(rest, post, ForumSort.Activity, true) ?: rest
                    } else {
                        rest
                    },
                )
                continue
            }
            next = upsert(next, post, free)
        }
        // A card that left the filter while held stayed put; letting go is
        // when it leaves.
        return next.copy(
            counts = state.counts,
            posts = next.posts.filter { passes(it, ctx.filters, ctx.viewerId) },
        )
    }

    /** The reader opened a post: read locally until the next page says so. */
    fun markRead(state: ForumListState, postId: String, now: String): ForumListState {
        val viewer = state.viewer[postId]
        // Never earlier than the post's own last activity: a phone clock
        // behind the server's would leave the card bold right after reading.
        val post = state.find(postId)
        val at = if (post != null && post.lastActivityAt > now) post.lastActivityAt else now
        return state.copy(
            viewer = state.viewer + (
                postId to ForumPostViewer(
                    postId = postId,
                    lastReadAt = at,
                    newReplyCount = 0,
                    following = viewer?.following ?: false,
                )
                ),
        )
    }

    /** Replace one post wherever it is drawn (an optimistic edit or its rollback). */
    fun patch(state: ForumListState, post: ForumPostSummary): ForumListState =
        state.copy(pinned = state.pinned.replacing(post), posts = state.posts.replacing(post))

    fun unread(
        post: ForumPostSummary,
        viewer: ForumPostViewer?,
        viewerId: String?,
        forumPreviousReadAt: String?,
    ): ForumUnread {
        val mine = viewerId != null && post.authorId == viewerId
        val lastReadAt = viewer?.lastReadAt
        if (lastReadAt == null) {
            if (mine) return ForumUnread.Read
            if (forumPreviousReadAt != null && post.createdAt <= forumPreviousReadAt) return ForumUnread.Read
            return ForumUnread.New
        }
        if (viewer.newReplyCount > 0 || post.lastActivityAt > lastReadAt) {
            return ForumUnread.Unread(viewer.newReplyCount)
        }
        return ForumUnread.Read
    }
}
