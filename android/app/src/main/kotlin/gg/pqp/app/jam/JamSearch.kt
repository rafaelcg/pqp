package gg.pqp.app.jam

/*
 * SEARCHING A JAM WALL, as the phones agree on it (iOS built it first): the server's `q` on the channel's song list
 * (`GET /api/channels/:id/jam-songs?q=`), which matches TITLE and ARTIST, case- and accent-insensitive
 * (`listJamSongsQuerySchema`), asked once the person has typed at least TWO letters, after a short pause.
 *
 * Three answers that must never look alike: results, no results ("Nenhuma música com ..."), and a search that FAILED
 * ("A busca não deu certo"), which says nothing about whether the song exists.
 */
object JamSearchRules {
    /** Letters before the first request: one letter matches half the wall and costs a request per key. */
    const val MIN_LETTERS = 2

    /** The pause after the last key before a request goes out. */
    const val DEBOUNCE_MS = 300L

    /** The server's own cap (`JAM_SEARCH_MAX`). */
    const val MAX_CHARS = 100

    /**
     * What is sent for what was typed: whitespace collapsed and trimmed (the server trims too, and a query that is only
     * spaces is not a query), or null while there are fewer than [MIN_LETTERS] characters to look for.
     */
    fun effective(typed: String): String? {
        val cleaned = JamBidi.clean(typed).trim().replace(Regex("\\s+"), " ").take(MAX_CHARS)
        return cleaned.takeIf { it.codePointCount(0, it.length) >= MIN_LETTERS }
    }

    /** One letter typed: the field says what it waits for. */
    fun needsMore(typed: String): Boolean {
        val cleaned = JamBidi.clean(typed).trim()
        return cleaned.isNotEmpty() && effective(typed) == null
    }
}

/** Where the wall's search stands. */
sealed interface JamSearchState {
    /** No search: the wall is the wall. */
    data object Idle : JamSearchState

    /** Asked, not answered: what was shown stays (it is not blanked on every key). */
    data class Searching(val previous: List<JamSongSummary>?) : JamSearchState

    /** Answered: the songs that match, with the rest of the pages when there are more. */
    data class Done(
        val query: String,
        val songs: List<JamSongSummary>,
        val nextCursor: String?,
        val loadingMore: Boolean = false,
        val moreFailed: Boolean = false,
    ) : JamSearchState

    /** The request did not get an answer: NOT "no results". */
    data class Failed(val query: String) : JamSearchState
}
