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

/** A landing's scroll: an item at the list's start edge, or a message brought near the top. */
sealed interface LandingScroll {
    data class ToItem(val index: Int) : LandingScroll

    data class NearTop(val index: Int) : LandingScroll
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

    /**
     * How the reversed transcript (index 0 = newest message) scrolls to land
     * on [target]. [rows] are the loaded messages newest first; [hasMore] says
     * older history is still unloaded (the paging cap was reached), in which
     * case the list's last item is the paging row, not the post's title.
     */
    fun scrollFor(target: PostLanding, rows: List<Message>, hasMore: Boolean, totalItems: Int): LandingScroll =
        when (target) {
            // The title sits past the oldest message, at the list's end; with
            // history still to load the end is the paging spinner instead, so
            // the oldest loaded message goes to the top rather than the spinner.
            PostLanding.Question ->
                if (!hasMore || rows.isEmpty()) {
                    LandingScroll.ToItem(totalItems.coerceAtLeast(1) - 1)
                } else {
                    LandingScroll.NearTop(rows.lastIndex)
                }
            is PostLanding.FirstUnread -> {
                val index = rows.indexOfFirst { it.id == target.messageId }
                if (index >= 0) LandingScroll.NearTop(index) else LandingScroll.ToItem(0)
            }
            PostLanding.Newest -> LandingScroll.ToItem(0)
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
