package gg.pqp.app.stories

/**
 * Where, and how big, the words of a text story from before layers are drawn
 * in the viewer. Pure so each edge is a JVM test; the viewer measures the
 * chrome and the text and hands the numbers in.
 *
 * The box is the canvas less its safe area (the twin of `STORY_SAFE_AREA` in
 * `packages/shared/src/stories.ts`, and of web's `usableBox` and iOS's
 * `StoryStage.legacyTextBox`). With the keyboard up the reply sits on it, far
 * taller than the 13% the safe area keeps, so the measured top of that footer
 * (and the bottom of the header) pull the box in and the words shrink into what
 * is left instead of printing behind the reaction pill and the reply field.
 */
object StoryTextFit {
    const val SAFE_X = 0.05f
    const val SAFE_TOP = 0.10f
    const val SAFE_BOTTOM = 0.13f

    /** The size a card has always had, and the floor the fit never goes under. */
    const val MAX_SP = 34
    const val MIN_SP = 12

    /** Never collapse to nothing: the box keeps a line's height and grows up, not down over the footer. */
    const val MIN_HEIGHT = 24f

    data class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
        val width: Float get() = right - left
        val height: Float get() = bottom - top
    }

    /**
     * The box for a canvas [width] by [height], all in the card's own pixels.
     * [headerBottom] and [footerTop] are the chrome's measured edges in the
     * same space, given only while the keyboard is up; [gap] is the breathing
     * room kept from each.
     */
    fun box(
        width: Float,
        height: Float,
        headerBottom: Float? = null,
        footerTop: Float? = null,
        gap: Float = 12f,
    ): Box {
        val left = width * SAFE_X
        val right = width - width * SAFE_X
        var top = height * SAFE_TOP
        if (headerBottom != null && headerBottom + gap > top) top = headerBottom + gap
        var bottom = height - height * SAFE_BOTTOM
        if (footerTop != null && footerTop - gap < bottom) bottom = footerTop - gap
        if (bottom - top < MIN_HEIGHT) top = bottom - MIN_HEIGHT
        return Box(left, top, right, bottom)
    }

    /**
     * The biggest size from [MAX_SP] down to [MIN_SP] for which [fits] says the
     * words wrapped to the box still fit its height. Measured rather than left
     * to a scale factor, which shrinks a long unbroken word to a speck by first
     * trying to keep it on one line.
     */
    fun fontSize(fits: (sp: Int) -> Boolean): Int {
        var size = MAX_SP
        while (size > MIN_SP) {
            if (fits(size)) return size
            size -= 1
        }
        return MIN_SP
    }
}
