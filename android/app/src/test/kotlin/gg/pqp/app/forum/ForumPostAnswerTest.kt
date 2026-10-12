package gg.pqp.app.forum

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Solução card against the post a frame or an answer brings: it never
 * quotes a reply other than the one marked, and it goes the moment the answer
 * is taken off, whether or not the detail read that would refresh it lands.
 */
class ForumPostAnswerTest {

    private fun post(answerId: String?) = ForumPostSummary(
        id = "p",
        forumId = "f",
        title = "t",
        createdAt = "2026-10-11T10:00:00.000Z",
        lastActivityAt = "2026-10-11T10:00:00.000Z",
        resolvedAt = answerId?.let { "2026-10-11T11:00:00.000Z" },
        acceptedAnswerId = answerId,
    )

    private val card = ForumAcceptedAnswer(messageId = "m1", authorName = "kaique", excerpt = "Desliga e reinicia")

    @Test
    fun `the answer taken off takes the card with it`() {
        assertNull(ForumPostViewModel.answerFor(post(null), card))
    }

    @Test
    fun `the same answer keeps its card`() {
        assertEquals(card, ForumPostViewModel.answerFor(post("m1"), card))
    }

    @Test
    fun `a different answer never shows the old reply's excerpt`() {
        assertNull(ForumPostViewModel.answerFor(post("m2"), card))
        assertNull(ForumPostViewModel.answerFor(post("m2"), null))
    }
}
