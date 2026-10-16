package gg.pqp.app.stories

import gg.pqp.app.stories.ui.StoryStripRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The "+" on the own ring is drawn at 22 dp and touched at 48. */
class StoryStripRulesTest {

    @Test
    fun `the target is 48 dp square`() {
        assertEquals(48f, StoryStripRules.BADGE_RIGHT - StoryStripRules.BADGE_LEFT, 0.001f)
        assertEquals(48f, StoryStripRules.BADGE_BOTTOM - StoryStripRules.BADGE_TOP, 0.001f)
    }

    @Test
    fun `the badge itself and its edges are in`() {
        // The badge is drawn centred at (57, 55) in the bubble.
        assertTrue(StoryStripRules.inBadge(57f, 55f))
        assertTrue(StoryStripRules.inBadge(StoryStripRules.BADGE_LEFT, StoryStripRules.BADGE_TOP))
        assertTrue(StoryStripRules.inBadge(StoryStripRules.BADGE_RIGHT, StoryStripRules.BADGE_BOTTOM))
    }

    @Test
    fun `the avatar's top and left are the ring's, not the badge's`() {
        assertFalse(StoryStripRules.inBadge(10f, 10f))
        assertFalse(StoryStripRules.inBadge(19.9f, 55f))
        assertFalse(StoryStripRules.inBadge(57f, 30.9f))
        assertFalse(StoryStripRules.inBadge(57f, 79.1f))
    }

    @Test
    fun `the target stays inside the 68 dp bubble`() {
        assertTrue(StoryStripRules.BADGE_RIGHT <= 68f)
        assertTrue(StoryStripRules.BADGE_LEFT >= 0f)
    }

    @Test
    fun `with a story up the ring centre and the avatar body play it, not compose`() {
        assertFalse(StoryStripRules.inBadge(StoryStripRules.RING_CENTER_X, StoryStripRules.RING_CENTER_Y, hasStory = true))
        // Just right of and below the avatar's middle, where a thumb lands.
        assertFalse(StoryStripRules.inBadge(40f, 40f, hasStory = true))
        assertFalse(StoryStripRules.inBadge(40f, 50f, hasStory = true))
        // The caption under the ring, right half.
        assertFalse(StoryStripRules.inBadge(50f, 75f, hasStory = true))
    }

    @Test
    fun `with a story up the badge itself and its outside edge still add`() {
        assertTrue(StoryStripRules.inBadge(57f, 55f, hasStory = true))
        assertTrue(StoryStripRules.inBadge(46f, 44f, hasStory = true))
        assertTrue(StoryStripRules.inBadge(67f, 66f, hasStory = true))
        assertTrue(StoryStripRules.OWN_BADGE_RIGHT <= 68f)
    }

    @Test
    fun `with no story the big target stays, the ring composes there anyway`() {
        assertTrue(StoryStripRules.inBadge(StoryStripRules.RING_CENTER_X, 40f, hasStory = false))
        assertTrue(StoryStripRules.inBadge(57f, 55f))
    }
}
