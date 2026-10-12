package gg.pqp.app.forum

import gg.pqp.app.core.Message
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Where a post opens: the question on a first visit, the first reply not yet
 * seen on a revisit, never the newest reply because that is where a page ends.
 * The rules of `client/src/lib/forum-landing.ts` and `unread-divider.ts`.
 */
class ForumLandingTest {

    private fun message(id: String, minute: Int, author: String = "bob") = Message(
        id = id,
        channelId = "p",
        authorId = author,
        authorName = author,
        createdAt = "2026-10-11T10:%02d:00.000Z".format(minute),
    )

    private val transcript = listOf(
        message("q", 0, author = "op"),
        message("r1", 5),
        message("r2", 10, author = "me"),
        message("r3", 15),
        message("r4", 20),
    )

    @Test
    fun `a first visit lands on the question and pages back until it has it`() {
        assertEquals(PostLanding.Question, ForumLanding.landing(transcript, null, "me"))
        assertTrue(ForumLanding.needsOlder(transcript.drop(2), hasMore = true, previousReadAt = null))
        assertFalse(ForumLanding.needsOlder(transcript, hasMore = false, previousReadAt = null))
    }

    @Test
    fun `a revisit lands on the first reply by somebody else since the cursor`() {
        val since = "2026-10-11T10:06:00.000Z"
        assertEquals(PostLanding.FirstUnread("r3"), ForumLanding.landing(transcript, since, "me"))
        assertEquals(2, ForumLanding.unreadCount(transcript, since, "me"))
        // The window starts after the cursor: page back until it does not.
        assertTrue(ForumLanding.needsOlder(transcript.drop(3), hasMore = true, previousReadAt = since))
        assertFalse(ForumLanding.needsOlder(transcript.drop(1), hasMore = true, previousReadAt = since))
    }

    @Test
    fun `a revisit with nothing new opens like a chat`() {
        assertEquals(PostLanding.Newest, ForumLanding.landing(transcript, "2026-10-11T11:00:00.000Z", "me"))
        assertNull(ForumLanding.firstUnread(transcript, null, "me"))
    }

    @Test
    fun `now is written the way the server writes it`() {
        assertEquals("2026-10-11T10:05:00.000Z", ForumLanding.isoNow(Instant.parse("2026-10-11T10:05:00Z")))
    }

    @Test
    fun `filters and drafts survive the round trip, and a broken value is nothing`() {
        val saved = SavedForumFilters(
            ForumFilters(sort = ForumSort.Created, status = ForumStatus.Open, mine = true, tagIds = listOf("a", "b")),
            sortExplicit = true,
        )
        assertEquals(saved, ForumPrefs.decodeFilters(ForumPrefs.encodeFilters(saved)))
        val implicit = saved.copy(sortExplicit = false, filters = saved.filters.copy(sort = ForumSort.Activity))
        assertEquals(implicit, ForumPrefs.decodeFilters(ForumPrefs.encodeFilters(implicit)))
        assertNull(ForumPrefs.decodeFilters("garbage"))

        val draft = ForumDraft(title = "Tela azul", body = "linha 1\nlinha 2", tagIds = listOf("t1"))
        assertEquals(draft, ForumPrefs.decodeDraft(ForumPrefs.encodeDraft(draft)))
        assertTrue(ForumDraft().isEmpty)
    }
}
