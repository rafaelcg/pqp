package gg.pqp.app.social

import java.text.Normalizer
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * Conversas: the pure rules behind the conversation list (search, the three
 * chips, the tab badge, the preview line) and the phone tabs' landing rule.
 * No Compose here, so every rule is a JVM test. The web keeps the same rules
 * in `client/src/lib/conversation-list.ts`; the two are meant to agree.
 */

/** The chips above the list: Tudo / Não lidas / Grupos. */
enum class ConversationFilter { All, Unread, Groups }

/** The phone shell's three tabs, behind `phoneTabs`. */
enum class PhoneTab { Conversas, Servidores, Tu }

object ConversationList {
    /** `systemKind` of a nudge on the wire, the only kind this client names. */
    const val NUDGE_KIND = "nudge"


    /**
     * Where the app opens. The last tab used, and Servidores for somebody who
     * never chose: nobody's habit changes until they change it themselves.
     */
    fun landingTab(stored: String?): PhoneTab =
        PhoneTab.entries.firstOrNull { it.name == stored } ?: PhoneTab.Servidores

    /** Lowercase with accents folded: "joao" finds "João", the way people type. */
    fun foldForSearch(value: String): String =
        Normalizer.normalize(value, Normalizer.Form.NFD)
            .replace(DIACRITICS, "")
            .lowercase(Locale.ROOT)
            .trim()

    /** By anybody's name, username or tag in it. An empty box matches all. */
    fun matches(conversation: DmSummary, query: String): Boolean {
        val needle = foldForSearch(query)
        if (needle.isEmpty()) return true
        return conversation.participants.any { person ->
            foldForSearch(person.displayName).contains(needle) ||
                person.username?.let { foldForSearch(it).contains(needle) } == true ||
                person.tag?.let { foldForSearch(it).contains(needle) } == true
        }
    }

    /** The list as drawn: the search box first, then the chip. */
    fun filter(
        list: List<DmSummary>,
        query: String,
        filter: ConversationFilter,
    ): List<DmSummary> = list.filter { conversation ->
        matches(conversation, query) && when (filter) {
            ConversationFilter.All -> true
            ConversationFilter.Unread -> conversation.unread.count > 0
            ConversationFilter.Groups -> conversation.isGroup
        }
    }

    /**
     * The Conversas tab badge: how many CONVERSATIONS are waiting, not how many
     * messages. Three people writing forty lines is "3".
     */
    fun waiting(list: List<DmSummary>): Int = list.count { it.unread.count > 0 }

    /**
     * The row's count. The server caps a conversation's unread at 100 (S3), so
     * anything past 99 is "99+" and never a number the server did not count.
     */
    fun countLabel(count: Int): String? = when {
        count <= 0 -> null
        count > 99 -> "99+"
        else -> count.toString()
    }

    /**
     * The words a preview line is built from, passed in so this file stays
     * free of Android resources. Each one is a pt-BR / en string resource at
     * the call site.
     */
    data class PreviewWords(
        val you: (String) -> String,
        val groupAuthor: (name: String, text: String) -> String,
        val voice: (duration: String) -> String,
        val gif: String,
        val attachment: String,
        /** A nudge I sent / one I received: the same two lines the web list says. */
        val nudgeSent: String,
        val nudgeReceived: String,
    )

    /**
     * The second line of a row: the server's redacted preview with the
     * reader's relationship to it in front. Own message "tu: ...", a group
     * author's first name, nothing for the other person in a 1:1. The server
     * never adds the prefix: it does not know which participant is reading.
     */
    fun previewLine(
        message: LastMessagePreview,
        viewerId: String?,
        isGroup: Boolean,
        words: PreviewWords,
    ): String {
        // Chamar a atenção: the row says what happened, with no "tu:" in front
        // (the sentence already says who). A nudge only exists in a 1:1.
        if (message.systemKind == NUDGE_KIND) {
            return if (viewerId != null && message.authorId == viewerId) words.nudgeSent else words.nudgeReceived
        }
        val duration = message.voiceDurationMs
        val body = when {
            message.isAttachment && message.isVoice == true && duration != null ->
                words.voice(noteDuration(duration))
            message.isAttachment && message.isGif -> words.gif
            message.isAttachment -> words.attachment
            // A frame for an attachment-only message carries an empty preview
            // and no flags at all. Empty is never a message anybody typed.
            message.preview.isBlank() -> words.attachment
            else -> message.preview
        }
        if (viewerId != null && message.authorId == viewerId) return words.you(body)
        if (isGroup && message.authorName.isNotBlank()) {
            val first = message.authorName.trim().split(" ").first().ifBlank { message.authorName }
            return words.groupAuthor(first, body)
        }
        return body
    }

    /**
     * The row's time, the way a chat list says it: "20:41" today, "ontem",
     * the weekday inside the last week, then a short date. Null for a
     * conversation nobody has spoken in.
     */
    fun listTime(iso: String?, now: ZonedDateTime, locale: Locale, yesterday: String): String? {
        val instant = runCatching { Instant.parse(iso ?: return null) }.getOrNull() ?: return null
        val at = instant.atZone(now.zone)
        val days = ChronoUnit.DAYS.between(at.toLocalDate(), now.toLocalDate())
        return when {
            days <= 0L -> at.format(DateTimeFormatter.ofPattern("HH:mm", locale))
            days == 1L -> yesterday
            days < 7L -> at.format(DateTimeFormatter.ofPattern("EEE", locale)).trimEnd('.')
            else -> at.format(DateTimeFormatter.ofPattern("d MMM", locale)).trimEnd('.')
        }
    }

    /** "0:12", "1:05". A voice note is never an hour long. */
    fun noteDuration(ms: Long): String {
        val seconds = (ms.coerceAtLeast(0) + 500) / 1000
        return "%d:%02d".format(Locale.ROOT, seconds / 60, seconds % 60)
    }

    private val DIACRITICS = Regex("\\p{Mn}+")
}

/**
 * Who is typing in which conversation, for the LIST.
 *
 * The open channel's typing line is the chat screen's own and is untouched.
 * Since the server sends a conversation's `typing-broadcast` to every
 * participant (not only to whoever has it open), the repository hands each one
 * here and a row can say "digitando...". Same five second life the chat screen
 * gives it; that person's next message ends it at once.
 *
 * Not thread safe on purpose: only the repository's main-thread collector
 * touches it.
 */
class ListTyping(private val ttlMs: Long = LIST_TYPING_TTL_MS) {

    private data class Typist(val name: String, val expiresAt: Long)

    private val typing = mutableMapOf<String, MutableMap<String, Typist>>()

    /**
     * Somebody typed. Answers whether what the list draws changed: a typist
     * who was already showing only has their expiry pushed out, which nobody
     * can see.
     */
    fun note(channelId: String, userId: String, name: String, now: Long): Boolean {
        val people = typing.getOrPut(channelId) { mutableMapOf() }
        val known = people[userId]
        people[userId] = Typist(name, now + ttlMs)
        return known == null || known.name != name || known.expiresAt <= now
    }

    /** Their message landed: not typing any more. */
    fun clear(channelId: String, userId: String): Boolean {
        val people = typing[channelId] ?: return false
        val removed = people.remove(userId) != null
        if (people.isEmpty()) typing.remove(channelId)
        return removed
    }

    fun clearAll() = typing.clear()

    /** channelId to the names typing there now. Drops whoever has expired. */
    fun snapshot(now: Long): Map<String, List<String>> {
        val out = mutableMapOf<String, List<String>>()
        val channels = typing.entries.iterator()
        while (channels.hasNext()) {
            val (channelId, people) = channels.next()
            people.entries.removeAll { it.value.expiresAt <= now }
            if (people.isEmpty()) {
                channels.remove()
            } else {
                out[channelId] = people.values.map { it.name }
            }
        }
        return out
    }

    /** When the next typist runs out, so one timer can redraw the list then. */
    fun nextExpiry(): Long? = typing.values.flatMap { it.values }.minOfOrNull { it.expiresAt }

    companion object {
        const val LIST_TYPING_TTL_MS = 5_000L
    }
}
