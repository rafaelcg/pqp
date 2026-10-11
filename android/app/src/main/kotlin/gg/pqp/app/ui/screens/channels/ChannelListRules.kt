package gg.pqp.app.ui.screens.channels

import gg.pqp.app.core.Channel
import gg.pqp.app.core.VoiceParticipant
import kotlinx.serialization.Serializable

/*
 * The channel list's decisions, without Compose.
 *
 * Every rule the "Lista viva" draws lives here so it can be tested on the JVM:
 * which row is bold, which is dimmed, what a folded category says, who is
 * listed under a voice room and what the banner's activity line counts. The
 * composables in this package only paint what these return.
 */

/** One channel's unread state, as `GET /api/servers/:id/unread` sends it. */
@Serializable
data class ChannelUnread(
    val channelId: String,
    val count: Int = 0,
    val mentions: Int = 0,
)

@Serializable
data class ServerUnreadResponse(val unread: List<ChannelUnread> = emptyList())

/**
 * A `channel-activity` frame on top of [existing]: one more unread, and one
 * more mention when the frame says it was one. Same arithmetic the iOS list
 * does on the same frame.
 */
fun bumped(existing: ChannelUnread?, channelId: String, mention: Boolean): ChannelUnread = ChannelUnread(
    channelId = channelId,
    count = (existing?.count ?: 0) + 1,
    mentions = (existing?.mentions ?: 0) + if (mention) 1 else 0,
)

/**
 * The unread counts, kept right while a `GET /unread` snapshot is in flight.
 *
 * A `channel-activity` frame that lands while the request is out may or may
 * not be in its answer, depending on which side of the query the message was
 * committed. Replaying it on top could count it twice, and dropping it could
 * lose it, so the count a frame brought the channel to during the request is
 * a floor: per channel the answer is the larger of what the server said and
 * that count. The one way that over-reports is a channel read on another
 * device during the same request, and the next refresh settles it.
 * Frames are only buffered while a request is pending, a snapshot from a
 * request older than the newest is dropped, and [activity] changes one entry
 * in place rather than copying the map. Confined to one thread (the screen's
 * effects run on the main dispatcher).
 */
class UnreadLedger {
    private var generation = 0
    private var pending = false
    private val inFlight = HashMap<String, ChannelUnread>()
    private val counts = HashMap<String, ChannelUnread>()

    /** A request is about to start; returns its ticket. */
    fun begin(): Int {
        inFlight.clear()
        pending = true
        return ++generation
    }

    /** The request holding [ticket] gave up; stop buffering for it. */
    fun abandon(ticket: Int) {
        if (ticket != generation) return
        pending = false
        inFlight.clear()
    }

    /** A frame arrived. Returns that channel's new entry. */
    fun activity(channelId: String, mention: Boolean): ChannelUnread {
        val next = bumped(counts[channelId], channelId, mention)
        counts[channelId] = next
        // The absolute count this frame brought the channel to, not the frame alone:
        // a snapshot older than the frame must not roll the badge back.
        if (pending) inFlight[channelId] = next
        return next
    }

    /** The request holding [ticket] answered. Null when a newer one has started since. */
    fun snapshot(ticket: Int, snapshot: Map<String, ChannelUnread>): Map<String, ChannelUnread>? {
        if (ticket != generation) return null
        counts.clear()
        counts.putAll(snapshot)
        inFlight.forEach { (channelId, seen) ->
            val said = counts[channelId]
            counts[channelId] = ChannelUnread(
                channelId = channelId,
                count = maxOf(said?.count ?: 0, seen.count),
                mentions = maxOf(said?.mentions ?: 0, seen.mentions),
            )
        }
        inFlight.clear()
        pending = false
        return HashMap(counts)
    }
}

/** How a channel row reads. */
enum class RowEmphasis {
    /** Nothing new. */
    Quiet,

    /** Something new: semibold name and the tick on the left edge. */
    Unread,

    /** Silenced by this person: dimmed, never bold, never ticked. */
    Muted,
}

data class RowBadge(
    val emphasis: RowEmphasis,
    /** Mentions still show on a muted channel: somebody asked for this person by name. */
    val mentions: Int,
)

fun rowBadge(unread: ChannelUnread?, muted: Boolean): RowBadge {
    val mentions = unread?.mentions?.coerceAtLeast(0) ?: 0
    val emphasis = when {
        muted -> RowEmphasis.Muted
        (unread?.count ?: 0) > 0 -> RowEmphasis.Unread
        else -> RowEmphasis.Quiet
    }
    return RowBadge(emphasis, mentions)
}

/**
 * The channels this person silenced: `notifications.channels[id] == "none"`
 * in their stored preferences, the same key the web's notification menu
 * writes. Only the channel level counts here; a server-wide choice is the
 * server row's business, not every row's.
 */
fun mutedChannelIds(channels: Map<String, String>?): Set<String> =
    channels.orEmpty().filterValues { it == "none" }.keys

/** What a folded category shows in place of its channels. */
data class FoldedSummary(val channelCount: Int, val hasUnread: Boolean)

fun foldedSummary(
    channels: List<Channel>,
    unread: Map<String, ChannelUnread>,
    muted: Set<String>,
): FoldedSummary = FoldedSummary(
    channelCount = channels.size,
    hasUnread = channels.any { channel ->
        channel.id !in muted && (unread[channel.id]?.count ?: 0) > 0
    },
)

/**
 * Who is listed under a voice room.
 *
 * Up to three people get a line each. Past three, two keep their lines and
 * the rest fold into one "+N pessoas" line with their faces, so a busy room
 * is never taller than the room plus three lines and nobody is silently
 * missing from the count.
 */
data class OccupantSummary(
    val listed: List<VoiceParticipant>,
    /** How many people the "+N" line stands for. */
    val overflowCount: Int,
    /** The first few of them, for the faces on that line; never the whole room. */
    val overflowFaces: List<VoiceParticipant>,
) {
    val total: Int get() = listed.size + overflowCount
}

const val OCCUPANT_LINES = 3
const val OVERFLOW_FACES = 3

fun occupantSummary(participants: List<VoiceParticipant>, selfUserId: String? = null): OccupantSummary {
    // One person on two devices is one person in the room as far as anybody
    // reading the list is concerned. The roster keeps both seats; the list
    // keeps the first one. The person holding the phone goes first, so their
    // own line is never folded into "+N".
    val people = participants.distinctBy { it.userId }
        .sortedByDescending { selfUserId != null && it.userId == selfUserId }
    if (people.size <= OCCUPANT_LINES) return OccupantSummary(people, 0, emptyList())
    val keep = OCCUPANT_LINES - 1
    return OccupantSummary(
        listed = people.take(keep),
        overflowCount = people.size - keep,
        overflowFaces = people.subList(keep, minOf(people.size, keep + OVERFLOW_FACES)),
    )
}

/** The line under the server's name: how many are in a call, how many rooms are live. */
data class ServerActivity(val inCall: Int, val live: Int) {
    val isEmpty: Boolean get() = inCall == 0 && live == 0
}

fun serverActivity(
    voiceChannelIds: Collection<String>,
    rooms: Map<String, List<VoiceParticipant>>,
    liveChannelIds: Collection<String>,
): ServerActivity {
    val people = voiceChannelIds.flatMap { id -> rooms[id].orEmpty().map { it.userId } }.toSet()
    return ServerActivity(inCall = people.size, live = liveChannelIds.toSet().size)
}

/**
 * A section of the list: one category's text channels, or its voice channels,
 * or the top-level ones.
 *
 * [categoryId] is null for the top-level groups, which have no heading to tap
 * and so never fold.
 */
data class ChannelSection(
    val key: String,
    val title: String,
    val categoryId: String?,
    val channels: List<Channel>,
) {
    /**
     * Which category this section belongs to, with the `-text` / `-voice` half
     * dropped. Two sections in the same group are one category split by the
     * ordering rule, and only the first of them draws a heading.
     */
    val group: String get() = key.substringBeforeLast('-')
}

/**
 * Categories first as containers, then whatever sits at the top level.
 *
 * Ordering has one trap in it: `position` is unique only within a sibling
 * group, and top-level text channels, top-level voice channels and categories
 * are three separate groups that all carry `parentId == null`. Sorting them as
 * one list interleaves three sequences of 0, 1, 2. They are separate sections
 * for that reason, not for looks.
 *
 * A `watch_party` channel is never in here (the card above the list and the
 * "Criar watch party" row are where it lives), and neither is any channel type
 * this build does not know how to open: only text and voice rows are drawn.
 */
fun sectionsOf(all: List<Channel>): List<ChannelSection> {
    val categories = all.filter { it.isCategory }.sortedBy { it.position }
    val byParent = all.filterNot { it.isCategory }.groupBy { it.parentId }

    val sections = mutableListOf<ChannelSection>()

    fun add(key: String, title: String, categoryId: String?, channels: List<Channel>) {
        if (channels.isNotEmpty()) {
            sections += ChannelSection(key, title, categoryId, channels.sortedBy { it.position })
        }
    }

    fun voiceRooms(list: List<Channel>) = list.filter { it.isVoice && it.type != "watch_party" }

    val topLevel = byParent[null].orEmpty()
    add("top-text", "", null, topLevel.filter { it.isText })
    add("top-voice", "", null, voiceRooms(topLevel))

    categories.forEach { category ->
        val children = byParent[category.id].orEmpty()
        add("cat-${category.id}-text", category.name, category.id, children.filter { it.isText })
        add("cat-${category.id}-voice", category.name, category.id, voiceRooms(children))
    }

    return sections
}

/** Every channel in [categoryId], text and voice halves together. */
fun channelsInCategory(sections: List<ChannelSection>, categoryId: String): List<Channel> =
    sections.filter { it.categoryId == categoryId }.flatMap { it.channels }
