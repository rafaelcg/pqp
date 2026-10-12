package gg.pqp.app.forum

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The list's one rule, a card never moves under the reader, and the cases
 * around it. The same cases `client/src/lib/forum-list.test.ts` pins for the
 * web, so a card moves on a phone exactly when it moves there.
 */
class ForumListTest {

    private fun post(
        id: String,
        created: String,
        activity: String = created,
        replies: Int = 0,
        resolved: Boolean = false,
        pinned: Boolean = false,
        tags: List<String> = emptyList(),
        author: String? = "bob",
        title: String = "Post $id",
    ) = ForumPostSummary(
        id = id,
        forumId = "f",
        title = title,
        authorId = author,
        authorName = author,
        createdAt = "2026-10-11T$created:00.000Z",
        lastActivityAt = "2026-10-11T$activity:00.000Z",
        resolvedAt = if (resolved) "2026-10-11T23:00:00.000Z" else null,
        pinnedAt = if (pinned) "2026-10-11T23:00:00.000Z" else null,
        replyCount = replies,
        tagIds = tags,
    )

    private fun page(vararg posts: ForumPostSummary, pinned: List<ForumPostSummary> = emptyList(), cursor: String? = null) =
        ForumPostListResponse(
            pinned = pinned,
            posts = posts.toList(),
            viewer = posts.map { ForumPostViewer(it.id, lastReadAt = null) },
            nextCursor = cursor,
            counts = ForumCounts(posts = posts.size + pinned.size, open = posts.count { !it.resolved }),
        )

    private val free = ForumUpsertContext(ForumFilters(), viewerId = "me", hold = false)
    private val held = free.copy(hold = true)

    private fun ids(state: ForumListState) = state.posts.map { it.id }

    @Test
    fun `a new post lands on top at the top, and queues while the reader is scrolled`() {
        val start = ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00")))
        val fresh = post("c", "11:00")

        assertEquals(listOf("c", "b", "a"), ids(ForumList.upsert(start, fresh, free)))

        val queued = ForumList.upsert(start, fresh, held)
        assertEquals(listOf("b", "a"), ids(queued))
        assertEquals(listOf("c"), queued.queued.map { it.id })
        assertEquals(3, queued.counts?.posts)

        val flushed = ForumList.flush(queued, held)
        assertEquals(listOf("c", "b", "a"), ids(flushed))
        assertTrue(flushed.queued.isEmpty())
        assertEquals("applying the queue is not a second arrival", 3, flushed.counts?.posts)
    }

    @Test
    fun `a bump moves a card only under activity, and only when the reader lets go`() {
        val start = ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00")))
        val bumped = post("a", "09:00", activity = "12:00", replies = 1)

        assertEquals(listOf("a", "b"), ids(ForumList.upsert(start, bumped, free)))

        val whileHeld = ForumList.upsert(start, bumped, held)
        assertEquals("the words update, the card stays", listOf("b", "a"), ids(whileHeld))
        assertEquals(1, whileHeld.posts.first { it.id == "a" }.replyCount)
        assertEquals(listOf("a", "b"), ids(ForumList.flush(whileHeld, held)))

        val newest = free.copy(filters = ForumFilters(sort = ForumSort.Created))
        assertEquals(listOf("b", "a"), ids(ForumList.upsert(start, bumped, newest)))
    }

    @Test
    fun `an edit never moves anything`() {
        val start = ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00")))
        val retitled = post("a", "09:00", title = "Novo título")
        val next = ForumList.upsert(start, retitled, held)
        assertEquals(listOf("b", "a"), ids(next))
        assertEquals("Novo título", next.posts[1].title)
        assertTrue(next.queued.isEmpty())
    }

    @Test
    fun `a post that leaves the filter stays put while held and goes when let go`() {
        val open = ForumFilters(status = ForumStatus.Open)
        val start = ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00")))
        val resolved = post("a", "09:00", resolved = true)

        val heldState = ForumList.upsert(start, resolved, held.copy(filters = open))
        assertEquals(listOf("b", "a"), ids(heldState))
        assertEquals(1, heldState.counts?.open)

        assertEquals(listOf("b"), ids(ForumList.upsert(start, resolved, free.copy(filters = open))))
        assertEquals(listOf("b"), ids(ForumList.flush(heldState, held.copy(filters = open))))
    }

    @Test
    fun `tags are AND`() {
        val bugAndGames = ForumFilters(tagIds = listOf("bug", "games"))
        assertTrue(ForumList.passes(post("a", "09:00", tags = listOf("bug", "games", "pc")), bugAndGames, "me"))
        assertTrue(!ForumList.passes(post("a", "09:00", tags = listOf("bug")), bugAndGames, "me"))
    }

    @Test
    fun `search folds accents and case, every word in any order`() {
        assertTrue(ForumList.titleMatches("Notebook não liga", "notebook nao"))
        assertTrue(ForumList.titleMatches("Notebook não liga", "LIGA notebook"))
        assertTrue(!ForumList.titleMatches("Notebook não liga", "desliga"))
    }

    @Test
    fun `pins sit above every filter and leave the posts list`() {
        val start = ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00")))
        val pinned = post("a", "09:00", pinned = true, tags = listOf("x"))
        val next = ForumList.upsert(start, pinned, free.copy(filters = ForumFilters(tagIds = listOf("y"))))
        assertEquals(listOf("a"), next.pinned.map { it.id })
        assertEquals(listOf("b"), ids(next))

        val unpinned = ForumList.upsert(next, post("a", "09:00"), free)
        assertTrue(unpinned.pinned.isEmpty())
        assertEquals(listOf("b", "a"), ids(unpinned))
    }

    @Test
    fun `an unpinned post goes back to its place under either order`() {
        val start = ForumList.fromPage(page(post("c", "11:00"), post("a", "09:00"), pinned = listOf(post("b", "10:00", pinned = true))))
        val created = free.copy(filters = ForumFilters(sort = ForumSort.Created))
        assertEquals(listOf("c", "b", "a"), ids(ForumList.upsert(start, post("b", "10:00"), created)))
        assertEquals(listOf("c", "b", "a"), ids(ForumList.upsert(start, post("b", "10:00"), free)))
    }

    @Test
    fun `an edit to a queued post reaches the queue, so the pill does not put the old words back`() {
        val start = ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00")))
        val queued = ForumList.upsert(start, post("a", "09:00", activity = "12:00", replies = 1), held)
        val resolved = post("a", "09:00", activity = "12:00", replies = 1, resolved = true)
        val edited = ForumList.upsert(queued, resolved, held)
        val flushed = ForumList.flush(edited, held)
        assertEquals(listOf("a", "b"), ids(flushed))
        assertTrue(flushed.posts.first().resolved)
    }

    @Test
    fun `the queue is bounded and says so, so the pill reads page 1 instead`() {
        var state = ForumList.fromPage(page(post("a", "09:00")))
        repeat(ForumList.QUEUE_MAX + 5) { i ->
            state = ForumList.upsert(state, post("n$i", "10:%02d".format(i % 60)).copy(createdAt = "2026-10-12T00:%02d:%02d.000Z".format(i / 60, i % 60)), held)
        }
        assertEquals(ForumList.QUEUE_MAX, state.queued.size)
        assertTrue(state.queueOverflowed)
        assertTrue(!ForumList.flush(state, held).queueOverflowed)
    }

    @Test
    fun `a removed post goes everywhere, the queue and the counts too`() {
        val start = ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00")))
        val queued = ForumList.upsert(start, post("c", "11:00"), held)
        val gone = ForumList.removed(ForumList.removed(queued, "c"), "a")
        assertEquals(listOf("b"), ids(gone))
        assertTrue(gone.queued.isEmpty())
        assertEquals(2, gone.counts?.posts)
        assertEquals(gone, ForumList.removed(gone, "nope"))
    }

    @Test
    fun `an old post bumped past the loaded pages waits for paging`() {
        val start = ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00"), cursor = "next"))
        val old = post("z", "01:00", activity = "02:00", replies = 3)
        val next = ForumList.upsert(start, old, free)
        assertEquals(listOf("b", "a"), ids(next))
    }

    @Test
    fun `paging never draws a card twice`() {
        val start = ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00"), cursor = "next"))
        val more = ForumList.append(start, page(post("a", "09:00"), post("y", "08:00")))
        assertEquals(listOf("b", "a", "y"), ids(more))
        assertEquals(null, more.nextCursor)
    }

    @Test
    fun `a refresh merges page 1 over a reader on page 2`() {
        val start = ForumList.append(
            ForumList.fromPage(page(post("b", "10:00"), post("a", "09:00"), cursor = "p2")),
            page(post("y", "08:00"), cursor = "p3"),
        )
        val refreshed = ForumList.refreshFirstPage(start, page(post("c", "11:00"), post("b", "10:00"), cursor = "p2"))
        assertEquals(listOf("c", "b", "a", "y"), ids(refreshed))
        assertEquals("p3", refreshed.nextCursor)
    }

    @Test
    fun `two unread levels, and nothing unread is your own`() {
        val prev = "2026-10-11T10:30:00.000Z"
        val fresh = post("c", "11:00")
        assertEquals(ForumUnread.New, ForumList.unread(fresh, null, "me", prev))
        assertEquals(ForumUnread.Read, ForumList.unread(post("a", "09:00"), null, "me", prev))
        assertEquals(ForumUnread.Read, ForumList.unread(post("m", "11:00", author = "me"), null, "me", prev))

        val opened = ForumPostViewer("a", lastReadAt = "2026-10-11T09:30:00.000Z", newReplyCount = 2)
        assertEquals(ForumUnread.Unread(2), ForumList.unread(post("a", "09:00", activity = "12:00"), opened, "me", prev))
    }

    @Test
    fun `a bump of a post opened before counts its new replies, the open post counts none`() {
        val start = ForumList.fromPage(page(post("a", "09:00", replies = 1)))
            .let { it.copy(viewer = mapOf("a" to ForumPostViewer("a", lastReadAt = "2026-10-11T09:10:00.000Z"))) }
        val bumped = post("a", "09:00", activity = "12:00", replies = 3)
        assertEquals(2, ForumList.upsert(start, bumped, free).viewer["a"]?.newReplyCount)
        val open = ForumList.upsert(start, bumped, free.copy(openPostId = "a"))
        assertEquals(0, open.viewer["a"]?.newReplyCount)
        assertEquals(ForumUnread.Read, ForumList.unread(bumped, open.viewer["a"], "me", null))
    }

    @Test
    fun `reading a post locally never stamps it before its own activity`() {
        val start = ForumList.fromPage(page(post("a", "09:00", activity = "12:00")))
        val read = ForumList.markRead(start, "a", "2026-10-11T11:00:00.000Z")
        assertEquals("2026-10-11T12:00:00.000Z", read.viewer["a"]?.lastReadAt)
    }
}
