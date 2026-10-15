package gg.pqp.app.forward

import gg.pqp.app.core.Channel
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.core.channelBits
import gg.pqp.app.core.hasPermission
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.Friend
import java.text.Normalizer

/**
 * Where a forward can go, as the picker lists it, and the rules for building,
 * searching and ordering that list.
 *
 * Pure: the sheet loads servers, channels, permissions, conversations and
 * friends and hands them here, so what is offered (and what is not) is pinned
 * by a JVM test. The server still decides per target; this only keeps the
 * picker from offering what it knows will be refused.
 */
sealed interface ForwardTarget {
    /** Stable across loads; what recents and the selection are keyed on. */
    val key: String

    /** What a person calls it, for a "sent to" line. */
    val label: String

    /** A text channel in a server. */
    data class InChannel(
        val channelId: String,
        val channelName: String,
        val serverId: String,
        val serverName: String,
        val serverIconUrl: String?,
        val isPrivate: Boolean,
    ) : ForwardTarget {
        override val key: String get() = "c:$channelId"
        override val label: String get() = "#$channelName"
    }

    /** An existing DM or group. [channelId] is the conversation's channel. */
    data class Conversation(
        val channelId: String,
        val title: String,
        val isGroup: Boolean,
        val avatarUrl: String?,
        val seed: String,
    ) : ForwardTarget {
        override val key: String get() = "c:$channelId"
        override val label: String get() = title
    }

    /** A friend with no 1:1 yet: the server opens it under `POST /api/dms` rules. */
    data class Person(
        val userId: String,
        val displayName: String,
        val avatarUrl: String?,
    ) : ForwardTarget {
        override val key: String get() = "u:$userId"
        override val label: String get() = displayName
    }

    fun toRef(): ForwardTargetRef = when (this) {
        is InChannel -> ForwardTargetRef(channelId = channelId)
        is Conversation -> ForwardTargetRef(channelId = channelId)
        is Person -> ForwardTargetRef(userId = userId)
    }
}

/** One server's channels in the picker. */
data class ForwardServerGroup(
    val serverId: String,
    val serverName: String,
    val iconUrl: String?,
    val channels: List<ForwardTarget.InChannel>,
)

/** What the picker shows, in order. */
data class ForwardPickerList(
    /** Recently used targets that match the search, newest first. */
    val recent: List<ForwardTarget>,
    /** DMs, groups and friends with no conversation, minus what is in [recent]. */
    val people: List<ForwardTarget>,
    /** Servers that have at least one matching channel, minus what is in [recent]. */
    val servers: List<ForwardServerGroup>,
) {
    val isEmpty: Boolean get() = recent.isEmpty() && people.isEmpty() && servers.isEmpty()
}

object ForwardTargets {

    /**
     * The channels of one server a forward can go to: text channels the
     * account may write in. A category, a forum (its messages are posts, made
     * somewhere else), a voice channel and a watch party are not offered. The
     * permission snapshot is the same one the channel list reads; a channel
     * with no entry answers with the server-wide bits, so an unknown answer
     * still resolves the way the server resolves it. No snapshot at all (the
     * read failed) offers every text channel: the server refuses per target.
     */
    fun channelsOf(
        server: ServerSummary,
        channels: List<Channel>,
        permissions: PermissionsSnapshot?,
    ): ForwardServerGroup {
        val offered = channels
            .filter { it.isText && !it.isCategory && !it.isForum }
            .filter {
                permissions == null ||
                    hasPermission(permissions.channelBits(it.id), Permission.SEND_MESSAGES)
            }
            .sortedBy { it.position }
            .map {
                ForwardTarget.InChannel(
                    channelId = it.id,
                    channelName = it.name,
                    serverId = server.id,
                    serverName = server.name,
                    serverIconUrl = server.iconUrl,
                    isPrivate = it.isPrivate,
                )
            }
        return ForwardServerGroup(server.id, server.name, server.iconUrl, offered)
    }

    /**
     * Conversations first, then friends who have no 1:1 with this account yet.
     * A friend who already has a DM appears once, as that DM (reusing it is what
     * the server does anyway, and two rows for one person would be noise).
     */
    fun peopleOf(
        conversations: List<DmSummary>,
        friends: List<Friend>,
        selfId: String?,
        titleOf: (DmSummary) -> String,
    ): List<ForwardTarget> {
        val dms = conversations.map { dm ->
            val first = dm.participants.firstOrNull()
            ForwardTarget.Conversation(
                channelId = dm.channelId,
                title = titleOf(dm),
                isGroup = dm.isGroup,
                avatarUrl = if (dm.isGroup) null else first?.avatarUrl,
                seed = first?.id ?: dm.channelId,
            )
        }
        val withDm = conversations
            .filter { !it.isGroup }
            .mapNotNull { it.participants.singleOrNull()?.id }
            .toSet()
        val strangers = friends
            .filter { it.id != selfId && it.id !in withDm }
            .sortedBy { it.displayName.lowercase() }
            .map { ForwardTarget.Person(it.id, it.displayName, it.avatarUrl) }
        return dms + strangers
    }

    /**
     * The list the sheet draws.
     *
     * [restrictedToServerId] is set when the source is members-only or private:
     * it can only go back into its own server, so no conversation, no person
     * and no other server is offered, rather than offered and refused.
     * [recents] are target keys, newest first; a recent that no longer exists
     * (a left server, a closed DM) is simply absent. [query] matches names,
     * accent- and case-insensitively, against the channel and its server, a
     * conversation's title or a person's name.
     */
    fun list(
        groups: List<ForwardServerGroup>,
        people: List<ForwardTarget>,
        recents: List<String>,
        query: String,
        restrictedToServerId: String? = null,
    ): ForwardPickerList {
        val needle = fold(query)
        fun matches(target: ForwardTarget): Boolean {
            if (needle.isEmpty()) return true
            return when (target) {
                is ForwardTarget.InChannel ->
                    fold(target.channelName).contains(needle) || fold(target.serverName).contains(needle)
                is ForwardTarget.Conversation -> fold(target.title).contains(needle)
                is ForwardTarget.Person -> fold(target.displayName).contains(needle)
            }
        }

        val visibleGroups = groups.filter { restrictedToServerId == null || it.serverId == restrictedToServerId }
        val visiblePeople = if (restrictedToServerId == null) people else emptyList()

        val everything = linkedMapOf<String, ForwardTarget>()
        visibleGroups.forEach { g -> g.channels.forEach { everything[it.key] = it } }
        visiblePeople.forEach { everything[it.key] = it }

        val recent = recents.mapNotNull { everything[it] }.filter(::matches)
        val recentKeys = recent.mapTo(HashSet()) { it.key }

        val peopleRows = visiblePeople.filter { it.key !in recentKeys && matches(it) }
        val serverRows = visibleGroups.mapNotNull { group ->
            val rows = group.channels.filter { it.key !in recentKeys && matches(it) }
            if (rows.isEmpty()) null else group.copy(channels = rows)
        }
        return ForwardPickerList(recent, peopleRows, serverRows)
    }

    /** Lower-case, accents folded: "Conversão" finds "conv", "açaí" finds "acai". */
    fun fold(text: String): String =
        Normalizer.normalize(text.trim().lowercase(), Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "")

    /**
     * Toggle [key] in the selection, newest last, capped at [FORWARD_MAX_TARGETS].
     * Returns the new selection and whether the cap refused an addition.
     */
    fun toggle(selected: List<String>, key: String): Pair<List<String>, Boolean> = when {
        key in selected -> selected - key to false
        selected.size >= FORWARD_MAX_TARGETS -> selected to true
        else -> selected + key to false
    }

    /** The recents after a send: [sent] first (in the order sent), then the rest, capped. */
    fun bumpRecents(recents: List<String>, sent: List<String>, cap: Int = RECENTS_CAP): List<String> =
        (sent + recents).distinct().take(cap)

    const val RECENTS_CAP = 12
}
