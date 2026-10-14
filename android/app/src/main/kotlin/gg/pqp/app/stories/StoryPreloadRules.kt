package gg.pqp.app.stories

/**
 * What to have ready before somebody taps, as pure rules (`StoryPreloadTest`).
 *
 * With a story open: the next two stories of the queue (across authors, in the
 * order the viewer will walk them) and the first story of the next author, so a
 * swipe to the next person is as instant as a tap. With the tray showing: the
 * first story somebody has not seen yet, for the first three rings. Anything
 * that leaves that window is cancelled, at most two run at once, and a clip is
 * not fetched while Data Saver is on.
 */
object StoryPreloadRules {

    /** Stories of the queue after the one on screen. */
    const val NEXT_STORIES = 2

    /** Rings of the tray whose first unseen story is fetched. */
    const val TRAY_RINGS = 3

    /** Stories being fetched at once. */
    const val MAX_CONCURRENT = 2

    /** `ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED`: Data Saver is off for this app. */
    const val DATA_SAVER_OFF = 1

    /**
     * The stories to have ready while [deck]'s story at [index] is on screen,
     * most wanted first. [decks] are the story ids of each author in the order
     * the viewer walks them; [startOf] is where the viewer opens a deck (its
     * first unseen story), because the queue never walks back into stories
     * somebody already saw.
     */
    fun window(decks: List<List<String>>, deck: Int, index: Int, startOf: (Int) -> Int): List<String> {
        val picked = LinkedHashSet<String>()
        var d = deck
        var i = index + 1
        while (picked.size < NEXT_STORIES && d < decks.size) {
            if (i < decks[d].size) {
                picked += decks[d][i]
                i += 1
            } else {
                d += 1
                if (d < decks.size) i = startOf(d).coerceIn(0, (decks[d].size - 1).coerceAtLeast(0))
            }
        }
        decks.getOrNull(deck + 1)?.let { next ->
            next.getOrNull(startOf(deck + 1).coerceIn(0, (next.size - 1).coerceAtLeast(0)))?.let { picked += it }
        }
        return picked.toList()
    }

    /** What a preloader should do to get from what is running to what is wanted. */
    data class Plan(val start: List<String>, val cancel: Set<String>)

    /**
     * Cancel what left the window, then start the most wanted that is not
     * running, as many as the cap leaves room for. What waits is started by the
     * next plan, when something finishes.
     */
    fun plan(wanted: List<String>, running: Set<String>, max: Int = MAX_CONCURRENT): Plan {
        val cancel = running - wanted.toSet()
        val keeping = running.count { it in wanted }
        val room = (max - keeping).coerceAtLeast(0)
        return Plan(start = wanted.filter { it !in running }.take(room), cancel = cancel)
    }

    /** A clip is worth fetching ahead of time only when Data Saver is off. Pictures always are: they are small. */
    fun videoAllowed(restrictBackgroundStatus: Int): Boolean = restrictBackgroundStatus == DATA_SAVER_OFF

    /** The first [TRAY_RINGS] rings that have something new, in strip order. */
    fun trayRings(items: List<StoryStripItem>): List<StoryStripItem> =
        items.filter { it.unseen && it.storyIds.isNotEmpty() }.take(TRAY_RINGS)

    /** How long a story's details are trusted before they are read again (its media links are signed). */
    const val DETAILS_FRESH_MS = 10 * 60 * 1000L

    /** Bytes from the start of a clip, and from its end (a recorder that writes its index last), kept ahead of a tap. */
    const val VIDEO_HEAD_BYTES = 1_048_576L
    const val VIDEO_TAIL_BYTES = 262_144L

    /** The cache keys: stable per story, so a link that is signed again for the same picture still hits. */
    fun baseKey(storyId: String) = "story:$storyId:base"
    fun posterKey(storyId: String) = "story:$storyId:poster"
    fun layerKey(storyId: String, layerId: String) = "story:$storyId:layer:$layerId"
    fun videoKey(storyId: String) = "story:$storyId:video"
}
