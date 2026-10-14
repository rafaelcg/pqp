package gg.pqp.app.stories

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the preloader wants ready, how it gets there with two slots, and when it
 * keeps its hands off the network. The window is the rule that decides whether
 * a tap on "next" shows a picture or a spinner, so it is pinned edge by edge.
 */
class StoryPreloadTest {

    private val none = { _: Int -> 0 }

    private fun item(author: String, ids: List<String>, unseen: Boolean) = StoryStripItem(
        author = StoryAuthor(author),
        storyIds = ids,
        unseen = unseen,
    )

    // --- the window ---

    @Test
    fun `the next two of the same author, and the first of the next author`() {
        val decks = listOf(listOf("a1", "a2", "a3", "a4"), listOf("b1", "b2"))
        assertEquals(listOf("a2", "a3", "b1"), StoryPreloadRules.window(decks, deck = 0, index = 0, startOf = none))
    }

    @Test
    fun `at the end of an author the queue walks into the next one, from where the viewer opens it`() {
        val decks = listOf(listOf("a1", "a2"), listOf("b1", "b2", "b3"), listOf("c1"))
        // b1 and b2 were seen: the viewer opens b at b3, and that is what comes next.
        val startOf = { d: Int -> if (d == 1) 2 else 0 }
        assertEquals(listOf("b3", "c1"), StoryPreloadRules.window(decks, deck = 0, index = 1, startOf = startOf))
    }

    @Test
    fun `the last story of the last author has nothing ahead`() {
        val decks = listOf(listOf("a1", "a2"))
        assertEquals(emptyList<String>(), StoryPreloadRules.window(decks, deck = 0, index = 1, startOf = none))
    }

    @Test
    fun `one story ahead is just that one, not padded`() {
        val decks = listOf(listOf("a1", "a2"))
        assertEquals(listOf("a2"), StoryPreloadRules.window(decks, deck = 0, index = 0, startOf = none))
    }

    @Test
    fun `an author with one story gives the next two authors and no repeats`() {
        val decks = listOf(listOf("a1"), listOf("b1"), listOf("c1"))
        assertEquals(listOf("b1", "c1"), StoryPreloadRules.window(decks, deck = 0, index = 0, startOf = none))
    }

    @Test
    fun `a start index past the end is held inside the deck`() {
        val decks = listOf(listOf("a1"), listOf("b1", "b2"))
        assertEquals(listOf("b2"), StoryPreloadRules.window(decks, deck = 0, index = 0, startOf = { 9 }))
    }

    // --- two at a time ---

    @Test
    fun `nothing running starts the two most wanted and leaves the third waiting`() {
        val plan = StoryPreloadRules.plan(listOf("a", "b", "c"), emptySet())
        assertEquals(listOf("a", "b"), plan.start)
        assertTrue(plan.cancel.isEmpty())
    }

    @Test
    fun `what left the window is cancelled, and a running one still wanted keeps its slot`() {
        val plan = StoryPreloadRules.plan(listOf("b", "c", "d"), running = setOf("a", "b"))
        assertEquals(setOf("a"), plan.cancel)
        // b keeps one slot; c takes the other; d waits.
        assertEquals(listOf("c"), plan.start)
    }

    @Test
    fun `a full house starts nothing new until something finishes`() {
        val plan = StoryPreloadRules.plan(listOf("a", "b", "c"), running = setOf("a", "b"))
        assertTrue(plan.start.isEmpty())
        assertTrue(plan.cancel.isEmpty())
    }

    @Test
    fun `an empty wish cancels everything`() {
        val plan = StoryPreloadRules.plan(emptyList(), running = setOf("a", "b"))
        assertEquals(setOf("a", "b"), plan.cancel)
        assertTrue(plan.start.isEmpty())
    }

    // --- data saver ---

    @Test
    fun `a clip is fetched ahead only with data saver off`() {
        // ConnectivityManager: 1 disabled, 2 whitelisted, 3 enabled.
        assertTrue(StoryPreloadRules.videoAllowed(1))
        assertFalse(StoryPreloadRules.videoAllowed(2))
        assertFalse(StoryPreloadRules.videoAllowed(3))
    }

    // --- the tray ---

    @Test
    fun `the tray wants the first three rings that have something new`() {
        val items = listOf(
            item("seen", listOf("s1"), unseen = false),
            item("a", listOf("a1", "a2"), unseen = true),
            item("b", listOf("b1"), unseen = true),
            item("empty", emptyList(), unseen = true),
            item("c", listOf("c1"), unseen = true),
            item("d", listOf("d1"), unseen = true),
        )
        assertEquals(listOf("a", "b", "c"), StoryPreloadRules.trayRings(items).map { it.author.id })
    }

    // --- the keys ---

    @Test
    fun `keys are stable per story and kept apart per kind of media`() {
        val keys = setOf(
            StoryPreloadRules.baseKey("s"),
            StoryPreloadRules.posterKey("s"),
            StoryPreloadRules.layerKey("s", "l1"),
            StoryPreloadRules.layerKey("s", "l2"),
            StoryPreloadRules.videoKey("s"),
        )
        assertEquals(5, keys.size)
        assertEquals(StoryPreloadRules.baseKey("s"), StoryPreloadRules.baseKey("s"))
    }
}
