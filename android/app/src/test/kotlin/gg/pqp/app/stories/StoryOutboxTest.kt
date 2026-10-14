package gg.pqp.app.stories

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The outbox's rules without a phone: what the own ring shows for a set of
 * posts, how the progress number is made, and that a draft written to disk
 * comes back whole (which is what "kept until posted or discarded" rests on).
 */
class StoryOutboxTest {

    @get:Rule
    val folder = TemporaryFolder()

    private fun entry(id: String, status: StoryOutboxRules.Status, fraction: Float? = null) =
        StoryOutboxRules.Entry(id, status, fraction)

    // --- the bubble ---

    @Test
    fun `no posts is the plain own bubble`() {
        assertEquals(StoryOutboxRules.Bubble.Idle, StoryOutboxRules.bubble(emptyList()))
    }

    @Test
    fun `a post on its way is a ring with its number`() {
        val bubble = StoryOutboxRules.bubble(listOf(entry("a", StoryOutboxRules.Status.Uploading, 0.4f)))
        assertEquals(StoryOutboxRules.Bubble.Posting(0.4f, "a"), bubble)
    }

    @Test
    fun `a post with nothing to measure is a ring with no number`() {
        val bubble = StoryOutboxRules.bubble(listOf(entry("a", StoryOutboxRules.Status.Preparing)))
        assertEquals(StoryOutboxRules.Bubble.Posting(null, "a"), bubble)
    }

    @Test
    fun `a failed post wins over one still going, because it needs a finger`() {
        val bubble = StoryOutboxRules.bubble(
            listOf(
                entry("going", StoryOutboxRules.Status.Uploading, 0.9f),
                entry("failed", StoryOutboxRules.Status.Failed),
            ),
        )
        assertEquals(StoryOutboxRules.Bubble.Failed("failed"), bubble)
    }

    @Test
    fun `several going shows the one furthest behind, and no number if one has none`() {
        val behind = StoryOutboxRules.bubble(
            listOf(
                entry("a", StoryOutboxRules.Status.Uploading, 0.8f),
                entry("b", StoryOutboxRules.Status.Uploading, 0.2f),
            ),
        )
        assertEquals(StoryOutboxRules.Bubble.Posting(0.2f, "b"), behind)
        val unknown = StoryOutboxRules.bubble(
            listOf(
                entry("a", StoryOutboxRules.Status.Uploading, 0.8f),
                entry("b", StoryOutboxRules.Status.Preparing),
            ),
        )
        assertEquals(StoryOutboxRules.Bubble.Posting(null, "b"), unknown)
    }

    // --- waiting for a connection ---

    @Test
    fun `a post with no connection waits, grey, and a failure still wins over it`() {
        assertEquals(
            StoryOutboxRules.Bubble.Waiting("w"),
            StoryOutboxRules.bubble(listOf(entry("w", StoryOutboxRules.Status.Waiting), entry("g", StoryOutboxRules.Status.Uploading, 0.5f))),
        )
        assertEquals(
            StoryOutboxRules.Bubble.Failed("f"),
            StoryOutboxRules.bubble(listOf(entry("w", StoryOutboxRules.Status.Waiting), entry("f", StoryOutboxRules.Status.Failed))),
        )
    }

    @Test
    fun `an answer from the server is red, whatever it is`() {
        val refused = gg.pqp.app.core.ApiException(403, "no")
        assertEquals(StoryOutboxRules.Outcome.Failed, StoryOutboxRules.outcome(refused, online = true, retriedAlready = false))
        assertEquals(StoryOutboxRules.Outcome.Failed, StoryOutboxRules.outcome(refused, online = false, retriedAlready = false))
    }

    @Test
    fun `no answer and no connection waits, and a connection that fails is tried once more before it is red`() {
        val link = java.io.IOException("no route")
        assertEquals(StoryOutboxRules.Outcome.Waiting, StoryOutboxRules.outcome(link, online = false, retriedAlready = false))
        assertEquals(StoryOutboxRules.Outcome.Waiting, StoryOutboxRules.outcome(link, online = false, retriedAlready = true))
        assertEquals(StoryOutboxRules.Outcome.RetrySoon, StoryOutboxRules.outcome(link, online = true, retriedAlready = false))
        assertEquals(StoryOutboxRules.Outcome.Failed, StoryOutboxRules.outcome(link, online = true, retriedAlready = true))
    }

    @Test
    fun `a session that is not ready waits whether or not there is a connection`() {
        val notReady = StoryOutboxRules.SessionNotReady()
        assertEquals(StoryOutboxRules.Outcome.Waiting, StoryOutboxRules.outcome(notReady, online = true, retriedAlready = false))
        assertEquals(StoryOutboxRules.Outcome.Waiting, StoryOutboxRules.outcome(notReady, online = false, retriedAlready = true))
    }

    @Test
    fun `anything that is not the link or the server is red`() {
        assertEquals(StoryOutboxRules.Outcome.Failed, StoryOutboxRules.outcome(IllegalStateException("x"), online = false, retriedAlready = false))
    }

    // --- the number ---

    @Test
    fun `bytes over bytes, held under the cap until the story is live`() {
        assertEquals(0f, StoryOutboxRules.ringFraction(0, 100)!!, 0.0001f)
        assertEquals(0.5f * StoryOutboxRules.RING_CAP, StoryOutboxRules.ringFraction(50, 100)!!, 0.0001f)
        assertEquals(StoryOutboxRules.RING_CAP, StoryOutboxRules.ringFraction(100, 100)!!, 0.0001f)
        // Never past the whole, even if a count overshoots.
        assertEquals(StoryOutboxRules.RING_CAP, StoryOutboxRules.ringFraction(300, 100)!!, 0.0001f)
    }

    @Test
    fun `nothing to send has no number`() {
        assertNull(StoryOutboxRules.ringFraction(0, 0))
    }

    @Test
    fun `the tally adds every file and a restarted file steps the count back`() {
        val tally = StoryOutboxRules.Tally(total = 1_000)
        tally.report("base", 400)
        tally.report("layer", 100)
        assertEquals(500, tally.sent)
        tally.report("base", 0)
        assertEquals(100, tally.sent)
        tally.report("base", 900)
        tally.report("layer", 900)
        // The sum is capped at the total, so the ring cannot run past the end.
        assertEquals(1_000, tally.sent)
        assertNotNull(tally.fraction)
    }

    // --- the draft on disk ---

    private fun draft(id: String, userId: String = "me", createdAt: Long = 1L) = StoryDraft(
        id = id,
        userId = userId,
        request = CreateStoryRequest(
            kind = "image",
            audiences = StoryAudienceTargets(serverIds = listOf("s1"), friends = true),
            media = StoryMediaInput("image/jpeg", 3, 10, 20),
            requestId = id,
        ),
        files = listOf(DraftFile(DraftFile.BASE, "image/jpeg", 3, "base")),
        refreshKeys = listOf("server:s1", "friends"),
        createdAt = createdAt,
    )

    @Test
    fun `a draft comes back whole, files included`() {
        val store = StoryDraftStore(folder.newFolder("outbox"))
        store.write(draft("one"), mapOf("base" to byteArrayOf(1, 2, 3)))
        val back = store.list().single()
        assertEquals(draft("one"), back)
        assertEquals(listOf<Byte>(1, 2, 3), store.file("one", "base").readBytes().toList())
    }

    @Test
    fun `drafts come back oldest first and a deleted one is gone with its files`() {
        val root = folder.newFolder("outbox")
        val store = StoryDraftStore(root)
        store.write(draft("late", createdAt = 20), mapOf("base" to byteArrayOf(1)))
        store.write(draft("early", createdAt = 10), mapOf("base" to byteArrayOf(2)))
        assertEquals(listOf("early", "late"), store.list().map { it.id })
        store.delete("early")
        assertEquals(listOf("late"), store.list().map { it.id })
        assertFalse(File(root, "early").exists())
    }

    @Test
    fun `a half written folder is cleaned away and never offered as a draft`() {
        val root = folder.newFolder("outbox")
        val store = StoryDraftStore(root)
        File(root, "torn").mkdirs()
        File(root, "torn/base").writeBytes(byteArrayOf(9))
        assertTrue(store.list().isEmpty())
        assertFalse(File(root, "torn").exists())
    }

    @Test
    fun `a draft being built is not listed and not cleaned away`() {
        val root = folder.newFolder("outbox")
        val store = StoryDraftStore(root)
        File(root, ".building-x").mkdirs()
        File(root, ".building-x/base").writeBytes(byteArrayOf(1))
        assertTrue(store.list().isEmpty())
        assertTrue(File(root, ".building-x").exists())
        // A finished write leaves nothing hidden behind.
        store.write(draft("done"), mapOf("base" to byteArrayOf(1)))
        assertFalse(File(root, ".building-done").exists())
        assertEquals(listOf("done"), store.list().map { it.id })
    }

    @Test
    fun `an unreadable manifest is cleaned away too`() {
        val root = folder.newFolder("outbox")
        val store = StoryDraftStore(root)
        File(root, "bad").mkdirs()
        File(root, "bad/draft.json").writeText("{not json")
        assertTrue(store.list().isEmpty())
        assertFalse(File(root, "bad").exists())
    }
}
