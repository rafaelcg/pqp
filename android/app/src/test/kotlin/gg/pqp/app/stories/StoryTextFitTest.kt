package gg.pqp.app.stories

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The words of a text story from before layers keep out of what the viewer's
 * chrome covers (QA S1: with the keyboard up a long text ran behind the
 * reaction pill and the reply field). The twin of iOS's `StoryTextFitTests`.
 */
class StoryTextFitTest {

    private val w = 1000f
    private val h = 1778f

    @Test
    fun `without the keyboard the box is the canvas less its safe area`() {
        val box = StoryTextFit.box(w, h)
        assertEquals(50f, box.left, 0.01f)
        assertEquals(950f, box.right, 0.01f)
        assertEquals(177.8f, box.top, 0.01f)
        assertEquals(1778f - 1778f * 0.13f, box.bottom, 0.01f)
    }

    @Test
    fun `the footer pulls the bottom up, and only when it is higher than the safe area`() {
        val raised = StoryTextFit.box(w, h, footerTop = 900f)
        assertEquals(888f, raised.bottom, 0.01f)
        // A footer below the safe area's edge changes nothing.
        val low = StoryTextFit.box(w, h, footerTop = 1700f)
        assertEquals(StoryTextFit.box(w, h).bottom, low.bottom, 0.01f)
    }

    @Test
    fun `the header pushes the top down, and only when it is lower than the safe area`() {
        val pushed = StoryTextFit.box(w, h, headerBottom = 300f)
        assertEquals(312f, pushed.top, 0.01f)
        val high = StoryTextFit.box(w, h, headerBottom = 50f)
        assertEquals(StoryTextFit.box(w, h).top, high.top, 0.01f)
    }

    @Test
    fun `a footer above the header leaves a line of room that grows up, never over the footer`() {
        val box = StoryTextFit.box(w, h, headerBottom = 700f, footerTop = 600f)
        assertEquals(StoryTextFit.MIN_HEIGHT, box.height, 0.01f)
        assertEquals(588f, box.bottom, 0.01f)
    }

    @Test
    fun `a short line keeps the size a card always had`() {
        assertEquals(StoryTextFit.MAX_SP, StoryTextFit.fontSize { true })
    }

    @Test
    fun `a long text takes the biggest size that still fits`() {
        // Pretend a size s needs s * 10 px of height and the box has 250.
        assertEquals(25, StoryTextFit.fontSize { sp -> sp * 10 <= 250 })
    }

    @Test
    fun `nothing fits, the floor is used and never less`() {
        assertEquals(StoryTextFit.MIN_SP, StoryTextFit.fontSize { false })
    }

    @Test
    fun `the fit never asks about a size outside the range`() {
        val asked = mutableListOf<Int>()
        StoryTextFit.fontSize { asked += it; false }
        assertTrue(asked.all { it in (StoryTextFit.MIN_SP + 1)..StoryTextFit.MAX_SP })
    }
}
