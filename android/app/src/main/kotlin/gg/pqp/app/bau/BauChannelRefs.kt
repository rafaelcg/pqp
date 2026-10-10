package gg.pqp.app.bau

import gg.pqp.app.core.Channel

/**
 * `#channel` inside a Baú post, the phone's half of the web's
 * `client/src/lib/community-home/channel-refs.ts`. Same grammar, same rules;
 * keep the two in step.
 *
 * The API stores `<#channelId>`, never the name, so a rename does not break the
 * link and a body that holds only an id cannot leak a private channel's name.
 * The name comes from the channel list this person already loads for the
 * server, which is the list they are allowed to see: an id that is not in it is
 * drawn as [Part.Unavailable], with no name and no link.
 *
 * Old posts that say `#geral` in plain words become a link too when exactly one
 * visible channel carries that name.
 */
object BauChannelRefs {

    sealed interface Part {
        data class Text(val value: String) : Part
        data class Link(val id: String, val name: String) : Part
        data class Unavailable(val id: String) : Part
    }

    private const val UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    private val REF = Regex("<#($UUID)>")

    /** Same set as the web's `createChannelSchema`: letters, digits, `-`, `_`. */
    private const val NAME = "[A-Za-z0-9_-]"
    private val PLAIN_HASH = Regex("(^|[\\s(\\[{\"'])#($NAME+)")
    private const val MAX_QUERY = 100
    const val MAX_SUGGESTIONS = 8

    fun ref(channelId: String): String = "<#${channelId.lowercase()}>"

    /** Categories are folders, not places to send somebody. */
    fun referenceable(channels: List<Channel>): List<Channel> = channels.filter { !it.isCategory }

    /** `null` marks a name more than one channel shares: never guessed. */
    private fun byName(channels: List<Channel>): Map<String, Channel?> {
        val out = HashMap<String, Channel?>()
        for (channel in referenceable(channels)) {
            val key = channel.name.lowercase()
            out[key] = if (out.containsKey(key)) null else channel
        }
        return out
    }

    /** Cuts a stored body into text and `<#id>` references, ids lowercased. */
    private fun splitRefs(text: String): List<Pair<String?, String>> {
        val out = ArrayList<Pair<String?, String>>()
        var last = 0
        for (match in REF.findAll(text)) {
            if (match.range.first > last) out.add(null to text.substring(last, match.range.first))
            out.add(match.groupValues[1].lowercase() to match.value)
            last = match.range.last + 1
        }
        if (last < text.length) out.add(null to text.substring(last))
        return out
    }

    private fun splitPlain(text: String, names: Map<String, Channel?>): List<Part> {
        val parts = ArrayList<Part>()
        var last = 0
        for (match in PLAIN_HASH.findAll(text)) {
            val channel = names[match.groupValues[2].lowercase()] ?: continue
            val start = match.range.first + match.groupValues[1].length
            if (start > last) parts.add(Part.Text(text.substring(last, start)))
            parts.add(Part.Link(channel.id, channel.name))
            last = match.range.last + 1
        }
        if (last < text.length) parts.add(Part.Text(text.substring(last)))
        return if (parts.isEmpty()) listOf(Part.Text(text)) else parts
    }

    /** The pieces of a body to draw. */
    fun parse(text: String, channels: List<Channel>): List<Part> {
        if (text.isEmpty()) return emptyList()
        val visible = referenceable(channels).associateBy { it.id.lowercase() }
        val names = byName(channels)
        val out = ArrayList<Part>()
        for ((id, raw) in splitRefs(text)) {
            when {
                id != null -> {
                    val channel = visible[id]
                    out.add(if (channel != null) Part.Link(channel.id, channel.name) else Part.Unavailable(id))
                }
                names.isEmpty() -> out.add(Part.Text(raw))
                else -> out.addAll(splitPlain(raw, names))
            }
        }
        return out
    }

    // -------------------------------------------------------------- composer

    data class Query(val start: Int, val end: Int, val query: String)

    /** The `#token` the caret is inside, or null. The `#` has to start a word. */
    fun findQuery(value: String, caret: Int): Query? {
        val end = caret.coerceIn(0, value.length)
        var index = end
        while (index > 0) {
            if (end - index > MAX_QUERY) return null
            val char = value[index - 1]
            if (char == '#') {
                val preceding = if (index > 1) value[index - 2] else null
                if (preceding != null && !preceding.isWhitespace()) return null
                return Query(index - 1, end, value.substring(index, end))
            }
            if (!(char.isAsciiLetterOrDigit() || char == '_' || char == '-')) return null
            index -= 1
        }
        return null
    }

    private fun Char.isAsciiLetterOrDigit() = this in 'a'..'z' || this in 'A'..'Z' || this in '0'..'9'

    /** Prefix matches first, then substring matches, each in sidebar order. */
    fun filter(channels: List<Channel>, query: String, limit: Int = MAX_SUGGESTIONS): List<Channel> {
        val needle = query.lowercase()
        val scored = referenceable(channels).mapIndexedNotNull { order, channel ->
            val name = channel.name.lowercase()
            when {
                needle.isEmpty() || name.startsWith(needle) -> Triple(channel, 0, order)
                name.contains(needle) -> Triple(channel, 1, order)
                else -> null
            }
        }
        return scored.sortedWith(compareBy({ it.second }, { it.third })).take(limit).map { it.first }
    }

    data class Insertion(val value: String, val caret: Int)

    /** Replace the active token. A shared name goes in as the raw `<#id>`. */
    fun apply(value: String, query: Query, channel: Channel, channels: List<Channel>): Insertion {
        val ambiguous = byName(channels).let { it.containsKey(channel.name.lowercase()) && it[channel.name.lowercase()] == null }
        val token = if (ambiguous) ref(channel.id) else "#${channel.name}"
        val gap = if (value.getOrNull(query.end)?.isWhitespace() == true) "" else " "
        return Insertion(
            value = value.substring(0, query.start) + token + gap + value.substring(query.end),
            caret = query.start + token.length + 1,
        )
    }

    /** Stored `<#id>` to readable `#name`, where the name is unique and visible. */
    fun toDisplay(stored: String, channels: List<Channel>): String {
        val visible = referenceable(channels).associateBy { it.id.lowercase() }
        val names = byName(channels)
        return splitRefs(stored).joinToString("") { (id, raw) ->
            if (id == null) {
                raw
            } else {
                val channel = visible[id]
                if (channel == null || names[channel.name.lowercase()] == null) ref(id) else "#${channel.name}"
            }
        }
    }

    /** Readable `#name` to stored `<#id>` for every name that matches one channel. */
    fun toStored(display: String, channels: List<Channel>): String {
        val names = byName(channels)
        if (names.isEmpty()) return display
        return splitRefs(display).joinToString("") { (id, raw) ->
            if (id != null) {
                ref(id)
            } else {
                splitPlain(raw, names).joinToString("") { part ->
                    when (part) {
                        is Part.Link -> ref(part.id)
                        is Part.Text -> part.value
                        is Part.Unavailable -> ""
                    }
                }
            }
        }
    }
}
