package gg.pqp.app.ui.chat

/**
 * Finding the `@token` somebody is typing, and what to put in its place.
 *
 * A port of `client/src/lib/mention-autocomplete.ts`, rule for rule. The wire
 * format of a mention is `@username`, resolved server-side against the
 * channel's members (`resolveMentions` in `server/src/services/messages.ts`),
 * so the only thing the composer has to get right is which username lands in
 * the text. A display name in the text is a name that mentions nobody.
 */
data class MentionCandidate(
    val id: String,
    val displayName: String,
    /** Null for an account that never claimed one; such a member cannot be mentioned. */
    val username: String? = null,
    val nickname: String? = null,
    val avatarUrl: String? = null,
)

/** The `@token` under the caret. [start] is the `@`, [end] is the caret. */
data class MentionQuery(val start: Int, val end: Int, val query: String)

object MentionAutocomplete {

    /** Mirrors the username half of `MENTION_PATTERN`. */
    private val TOKEN_CHAR = Regex("[A-Za-z0-9_]")

    /** Same ceiling as `usernameSchema`; past it the token cannot be a handle. */
    private const val MAX_QUERY_LENGTH = 32

    /** Long lists are a scroll, not a picker. */
    const val MAX_SUGGESTIONS = 8

    /**
     * The active token at [caret], or null when the caret is not inside one.
     * The `@` must start a word: `you@example.com` is an address.
     */
    fun find(value: String, caret: Int): MentionQuery? {
        val end = caret.coerceIn(0, value.length)
        var index = end
        while (index > 0) {
            if (end - index > MAX_QUERY_LENGTH) return null
            val char = value[index - 1]
            if (char == '@') {
                val preceding = if (index > 1) value[index - 2] else null
                if (preceding != null && !preceding.isWhitespace()) return null
                return MentionQuery(start = index - 1, end = end, query = value.substring(index, end))
            }
            if (!TOKEN_CHAR.matches(char.toString())) return null
            index -= 1
        }
        return null
    }

    /**
     * Members matching the token, best first. Anyone without a username is
     * dropped: there is nothing to insert for them.
     */
    fun filter(
        candidates: List<MentionCandidate>,
        query: String,
        limit: Int = MAX_SUGGESTIONS,
    ): List<MentionCandidate> {
        val needle = query.lowercase()
        val scored = mutableListOf<Pair<MentionCandidate, Int>>()
        for (candidate in candidates) {
            val username = candidate.username?.lowercase() ?: continue
            val displayName = candidate.displayName.lowercase()
            val nickname = candidate.nickname.orEmpty().lowercase()
            val rank = when {
                needle.isEmpty() -> 1
                username.startsWith(needle) -> 0
                nickname.startsWith(needle) || displayName.startsWith(needle) -> 1
                username.contains(needle) || displayName.contains(needle) || nickname.contains(needle) -> 2
                else -> continue
            }
            scored += candidate to rank
        }
        return scored
            .sortedWith(compareBy({ it.second }, { it.first.displayName.lowercase() }))
            .take(limit)
            .map { it.first }
    }

    /** Replace the active token with `@username `, keeping the rest of the draft. */
    fun apply(value: String, active: MentionQuery, username: String): Pair<String, Int> {
        val inserted = "@$username "
        val next = value.substring(0, active.start) + inserted + value.substring(active.end)
        return next to active.start + inserted.length
    }
}
