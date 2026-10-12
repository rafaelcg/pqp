package gg.pqp.app.forum

import gg.pqp.app.core.Message
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/*
 * Where a post opens (UX §2.4 #26): on the question for a first visit, on the
 * first reply the reader has not seen for a later one, and never on the
 * newest reply just because that is where a history page ends.
 *
 * The Kotlin half of `client/src/lib/forum-landing.ts` and of
 * `findFirstUnreadMessageId` in `client/src/lib/unread-divider.ts`, same rules.
 */

/** Older pages read at most before landing. A page is 50 messages. */
const val FORUM_LANDING_MAX_PAGES = 20

/** Where the transcript lands once it has what it needs. */
sealed interface PostLanding {
    /** A first visit: the question, at the top. */
    data object Question : PostLanding

    /** A revisit with something new: the first unread reply, under the "Novas" divider. */
    data class FirstUnread(val messageId: String) : PostLanding

    /** A revisit with nothing new: the newest reply, where a chat opens. */
    data object Newest : PostLanding
}

object ForumLanding {

    /**
     * True while the landing point is above the loaded window: a first visit
     * (no cursor) needs the very first message, a revisit needs a message at
     * or before the cursor so the first unread one is on screen with its
     * divider. [messages] is oldest first.
     */
    fun needsOlder(messages: List<Message>, hasMore: Boolean, previousReadAt: String?): Boolean {
        if (!hasMore) return false
        if (previousReadAt == null) return true
        val oldest = messages.firstOrNull() ?: return true
        return isAfter(oldest.createdAt, previousReadAt)
    }

    /** The first message after [since] that somebody else wrote, or null. */
    fun firstUnread(messages: List<Message>, since: String?, viewerId: String?): Message? {
        since ?: return null
        val sinceAt = parse(since) ?: return null
        return messages.firstOrNull { message ->
            if (viewerId != null && message.authorId == viewerId) return@firstOrNull false
            val at = parse(message.createdAt) ?: return@firstOrNull false
            at.isAfter(sinceAt)
        }
    }

    /** How many messages from others arrived after [since]: the "↓ N novas" pill. */
    fun unreadCount(messages: List<Message>, since: String?, viewerId: String?): Int {
        val first = firstUnread(messages, since, viewerId) ?: return 0
        val start = messages.indexOf(first)
        return messages.drop(start).count { viewerId == null || it.authorId != viewerId }
    }

    fun landing(messages: List<Message>, previousReadAt: String?, viewerId: String?): PostLanding {
        if (previousReadAt == null) return PostLanding.Question
        val first = firstUnread(messages, previousReadAt, viewerId) ?: return PostLanding.Newest
        return PostLanding.FirstUnread(first.id)
    }

    private fun parse(iso: String): Instant? = runCatching { Instant.parse(iso) }.getOrNull()

    private fun isAfter(a: String, b: String): Boolean {
        val left = parse(a) ?: return false
        val right = parse(b) ?: return false
        return left.isAfter(right)
    }

    private val ISO_MILLIS: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /**
     * Now, in exactly the shape the server writes (`toISOString`), because the
     * list compares these as strings the way the web does.
     */
    fun isoNow(now: Instant = Instant.now()): String = ISO_MILLIS.format(now)
}
