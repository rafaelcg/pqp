package gg.pqp.app.ui.screens.channels

import gg.pqp.app.core.Channel
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/*
 * THE CHANNEL LIST, AS ONE SET OF RULES FOR EVERY CLIENT.
 *
 * A Kotlin port of `packages/shared/src/channel-layout.ts`. A server's list is
 * categories and the channels inside them, plus the channels in no category
 * ("loose"), which sit above the first category with no heading. With the
 * mixed list on (`GET /api/servers/:id/channel-layout` says `mixed`), every
 * type mixes in one order per parent. With it off, loose channels keep the old
 * split: text and forums, then voice, then watch party rooms.
 *
 * `packages/shared/fixtures/channel-layout-cases.json` pins these functions,
 * and `ChannelLayoutTest` runs that same file on the JVM, so the web, iOS and
 * Android cannot drift apart again (they had: this app drew a category's text
 * half before its voice half).
 */

/** The fields the layout reads. [Channel] has them all. */
interface LayoutChannel {
    val id: String
    val type: String
    val parentId: String?
    val position: Double
}

/** Wraps a [Channel] for the rules without touching the wire model. */
data class LayoutRow(val channel: Channel) : LayoutChannel {
    override val id: String get() = channel.id
    override val type: String get() = channel.type
    override val parentId: String? get() = channel.parentId
    override val position: Double get() = channel.position
}

data class SidebarCategory<T : LayoutChannel>(val category: T, val children: List<T>)

data class SidebarLayout<T : LayoutChannel>(
    /** Channels in no category, above the first category, no heading. */
    val loose: List<T>,
    val categories: List<SidebarCategory<T>>,
) {
    /** The layout as ids only: what tests compare, and what tells the organizer whether anything moved. */
    val ids: LayoutIds
        get() = LayoutIds(
            loose = loose.map { it.id },
            categories = categories.map { LayoutIds.Category(it.category.id, it.children.map { child -> child.id }) },
        )
}

/** A layout written as ids, in display order. The fixture's `expect` shape. */
@Serializable
data class LayoutIds(val loose: List<String>, val categories: List<Category>) {
    @Serializable
    data class Category(val id: String, val children: List<String>)
}

/** Where a channel lands: a parent (null = loose) and an index in it. */
@Serializable
data class LayoutTarget(val parentId: String?, val index: Int)

data class LayoutLocation(val parentId: String?, val index: Int, val total: Int, val isCategory: Boolean)

/** `PUT /api/servers/:id/channel-layout`, see `channelLayoutSchema`. */
@Serializable
data class ChannelLayoutPayload(
    val baseVersion: Int,
    val categoryIds: List<String>,
    val groups: List<Group>,
) {
    @Serializable
    data class Group(val parentId: String? = null, val channelIds: List<String>)

    /**
     * The body as sent. Built by hand because `PqpJson` drops nulls
     * (`explicitNulls = false`), and the loose group's `parentId` has to go
     * out as an explicit null: the server's schema requires the key.
     */
    fun toJson(): JsonObject = buildJsonObject {
        put("baseVersion", JsonPrimitive(baseVersion))
        put("categoryIds", JsonArray(categoryIds.map(::JsonPrimitive)))
        put(
            "groups",
            JsonArray(
                groups.map { group ->
                    buildJsonObject {
                        put("parentId", group.parentId?.let(::JsonPrimitive) ?: JsonNull)
                        put("channelIds", JsonArray(group.channelIds.map(::JsonPrimitive)))
                    }
                },
            ),
        )
    }
}

/** Old split order for loose channels: text and forums, voice, watch party. */
fun legacyTypeRank(type: String): Int = when (type) {
    "text", "forum" -> 0
    "voice" -> 1
    else -> 2
}

private val byPosition: Comparator<LayoutChannel> = compareBy<LayoutChannel> { it.position }.thenBy { it.id }
private val byTypeThenPosition: Comparator<LayoutChannel> =
    compareBy<LayoutChannel> { legacyTypeRank(it.type) }.then(byPosition)

/**
 * The list, from a server's channels as the API returns them. Threads are
 * dropped. A channel whose category is not in the list is loose, so nothing
 * ever vanishes.
 */
fun <T : LayoutChannel> buildSidebarLayout(
    channels: List<T>,
    mixed: Boolean,
    hideWatchParty: Boolean = false,
): SidebarLayout<T> {
    val rows = channels.filter { it.type != "thread" && !(hideWatchParty && it.type == "watch_party") }
    val categories = rows.filter { it.type == "category" }.sortedWith(byPosition)
    val categoryIds = categories.map { it.id }.toSet()
    val children = HashMap<String, MutableList<T>>()
    val loose = mutableListOf<T>()
    for (channel in rows) {
        if (channel.type == "category") continue
        val parentId = channel.parentId
        if (parentId != null && parentId in categoryIds) {
            children.getOrPut(parentId) { mutableListOf() } += channel
        } else {
            loose += channel
        }
    }
    return SidebarLayout(
        loose = loose.sortedWith(if (mixed) byPosition else byTypeThenPosition),
        categories = categories.map { category ->
            SidebarCategory(category, children[category.id].orEmpty().sortedWith(byPosition))
        },
    )
}

fun <T : LayoutChannel> locateInLayout(layout: SidebarLayout<T>, id: String): LayoutLocation? {
    val categoryIndex = layout.categories.indexOfFirst { it.category.id == id }
    if (categoryIndex != -1) return LayoutLocation(null, categoryIndex, layout.categories.size, isCategory = true)
    val looseIndex = layout.loose.indexOfFirst { it.id == id }
    if (looseIndex != -1) return LayoutLocation(null, looseIndex, layout.loose.size, isCategory = false)
    for (entry in layout.categories) {
        val index = entry.children.indexOfFirst { it.id == id }
        if (index != -1) return LayoutLocation(entry.category.id, index, entry.children.size, isCategory = false)
    }
    return null
}

/**
 * Move one channel to `target.index` of `target.parentId` (null = loose), or
 * one category to `target.index` among categories (its parent must be null:
 * categories never nest). The index is read with the moved row already taken
 * out, and clamped. Anything impossible returns null.
 */
fun <T : LayoutChannel> moveInLayout(layout: SidebarLayout<T>, id: String, target: LayoutTarget): SidebarLayout<T>? {
    val from = locateInLayout(layout, id) ?: return null
    if (from.isCategory) {
        if (target.parentId != null) return null
        val categories = layout.categories.toMutableList()
        val moved = categories.removeAt(from.index)
        categories.add(target.index.coerceIn(0, categories.size), moved)
        return layout.copy(categories = categories)
    }
    if (target.parentId != null && layout.categories.none { it.category.id == target.parentId }) return null
    val loose = layout.loose.toMutableList()
    val children = layout.categories.associate { it.category.id to it.children.toMutableList() }
    val source = if (from.parentId == null) loose else children.getValue(from.parentId)
    val moved = source.removeAt(from.index)
    val destination = if (target.parentId == null) loose else children.getValue(target.parentId)
    destination.add(target.index.coerceIn(0, destination.size), moved)
    return SidebarLayout(
        loose = loose,
        categories = layout.categories.map { SidebarCategory(it.category, children.getValue(it.category.id)) },
    )
}

/**
 * One step up (-1) or down (+1), crossing category borders, so an
 * accessibility action reaches every slot a drag can. A channel at the top of
 * a category moving up lands at the end of the previous one (or of the loose
 * area); at the bottom moving down, at the start of the next. A category swaps
 * with its neighbour. Null when there is nowhere to go.
 */
fun <T : LayoutChannel> stepInLayout(layout: SidebarLayout<T>, id: String, direction: Int): Pair<SidebarLayout<T>, LayoutTarget>? {
    val from = locateInLayout(layout, id) ?: return null
    if (direction != 1 && direction != -1) return null
    val index = from.index + direction
    val target = when {
        index in 0 until from.total -> LayoutTarget(from.parentId, index)
        from.isCategory -> null
        else -> {
            val groups: List<String?> = listOf<String?>(null) + layout.categories.map { it.category.id }
            val neighbour = groups.getOrNull(groups.indexOf(from.parentId) + direction)
            when {
                groups.indexOf(from.parentId) + direction !in groups.indices -> null
                direction == -1 -> LayoutTarget(
                    neighbour,
                    if (neighbour == null) {
                        layout.loose.size
                    } else {
                        layout.categories.first { it.category.id == neighbour }.children.size
                    },
                )
                else -> LayoutTarget(neighbour, 0)
            }
        }
    } ?: return null
    val next = moveInLayout(layout, id, target) ?: return null
    return next to target
}

/** The full order the server stores, as the PUT body. */
fun <T : LayoutChannel> layoutToPayload(layout: SidebarLayout<T>, baseVersion: Int): ChannelLayoutPayload =
    ChannelLayoutPayload(
        baseVersion = baseVersion,
        categoryIds = layout.categories.map { it.category.id },
        groups = listOf(ChannelLayoutPayload.Group(null, layout.loose.map { it.id })) +
            layout.categories.map { entry ->
                ChannelLayoutPayload.Group(entry.category.id, entry.children.map { it.id })
            },
    )

/**
 * Rewrites `parentId` and `position` on every channel the layout holds, so an
 * order saved with a `null` read-back draws the order that was sent. Channels
 * the layout does not hold (threads, watch party rooms, types this build
 * cannot draw) come back as they were.
 */
fun applyLayoutToChannels(channels: List<Channel>, layout: SidebarLayout<LayoutRow>): List<Channel> {
    val placed = HashMap<String, Pair<String?, Double>>()
    layout.categories.forEachIndexed { index, entry ->
        placed[entry.category.id] = null to index.toDouble()
        entry.children.forEachIndexed { childIndex, child -> placed[child.id] = entry.category.id to childIndex.toDouble() }
    }
    layout.loose.forEachIndexed { index, channel -> placed[channel.id] = null to index.toDouble() }
    return channels.map { channel ->
        val place = placed[channel.id] ?: return@map channel
        channel.copy(parentId = place.first, position = place.second)
    }
}

/** The mixed list from a server's channels: categories and every type this build draws, never a watch party room. */
fun mixedLayoutOf(channels: List<Channel>): SidebarLayout<LayoutRow> = buildSidebarLayout(
    channels.filter { it.isCategory || it.isText || it.isForum || it.type == "voice" }.map(::LayoutRow),
    mixed = true,
)

// --- Organizar canais ---

/** One row of the organizer's flat list: headings and channels in one list, so a drag can cross a border. */
sealed interface OrganizerItem<T : LayoutChannel> {
    val key: String

    data class Header<T : LayoutChannel>(val category: T) : OrganizerItem<T> {
        override val key: String get() = "h:${category.id}"
    }

    data class Row<T : LayoutChannel>(val channel: T) : OrganizerItem<T> {
        override val key: String get() = "c:${channel.id}"
    }

    /** "Vazia. Arrasta um canal pra cá." under an empty category. Never moves. */
    data class Empty<T : LayoutChannel>(val categoryId: String) : OrganizerItem<T> {
        override val key: String get() = "e:$categoryId"
    }
}

/**
 * The staged order in Organizar canais. Every move edits this copy only;
 * Concluir sends it in one PUT and Cancelar throws it away, so a whole
 * reorganisation is one request and at most one 409.
 */
class ChannelOrganizer<T : LayoutChannel>(layout: SidebarLayout<T>) {
    var layout: SidebarLayout<T> = layout
        private set
    private var original: LayoutIds = layout.ids

    val hasChanges: Boolean get() = layout.ids != original

    /** Start again from a fresh list (after a 409), keeping nothing staged. */
    fun reset(to: SidebarLayout<T>) {
        layout = to
        original = to.ids
    }

    /** A category created from inside the mode: already on the server, so not a staged move. */
    fun appendCategory(category: T) {
        layout = layout.copy(categories = layout.categories + SidebarCategory(category, emptyList()))
        original = original.copy(categories = original.categories + LayoutIds.Category(category.id, emptyList()))
    }

    /** A category renamed from inside the mode: same id, same place. */
    fun replaceCategory(category: T) {
        layout = layout.copy(
            categories = layout.categories.map { if (it.category.id == category.id) it.copy(category = category) else it },
        )
    }

    val items: List<OrganizerItem<T>>
        get() = buildList {
            layout.loose.forEach { add(OrganizerItem.Row(it)) }
            layout.categories.forEach { entry ->
                add(OrganizerItem.Header(entry.category))
                if (entry.children.isEmpty()) {
                    add(OrganizerItem.Empty(entry.category.id))
                } else {
                    entry.children.forEach { add(OrganizerItem.Row(it)) }
                }
            }
        }

    /**
     * A drag ended: the item at [from] in [items] now sits at [to] (an index in
     * the list with it moved, the way a drag reads it). A heading carries its
     * channels and lands among the other categories; a channel belongs to the
     * nearest heading above where it landed (none: loose). Returns whether
     * anything changed.
     */
    fun move(from: Int, to: Int): Boolean {
        val rows = items
        if (from !in rows.indices) return false
        val rest = rows.toMutableList()
        val item = rest.removeAt(from)
        val insertAt = to.coerceIn(0, rest.size)
        val (id, target) = when (item) {
            is OrganizerItem.Empty -> return false
            is OrganizerItem.Header -> item.category.id to LayoutTarget(
                null,
                rest.subList(0, insertAt).count { it is OrganizerItem.Header },
            )
            is OrganizerItem.Row -> {
                var parentId: String? = null
                var index = 0
                for (above in rest.subList(0, insertAt).asReversed()) {
                    if (above is OrganizerItem.Header) {
                        parentId = above.category.id
                        break
                    }
                    if (above is OrganizerItem.Row) index++
                }
                item.channel.id to LayoutTarget(parentId, index)
            }
        }
        val next = moveInLayout(layout, id, target) ?: return false
        val changed = next.ids != layout.ids
        layout = next
        return changed
    }

    /** The accessibility actions Mover para cima / Mover para baixo. */
    fun step(id: String, direction: Int): LayoutTarget? {
        val (next, target) = stepInLayout(layout, id, direction) ?: return null
        layout = next
        return target
    }

    fun canStep(id: String, direction: Int): Boolean = stepInLayout(layout, id, direction) != null
}

// --- What the server answers ---

/**
 * `GET /api/servers/:id/channel-layout`. Draw the mixed list only when
 * [mixed]; an older server answers 404, which reads as the old list.
 * [version] goes back as the PUT's `baseVersion`.
 */
@Serializable
data class ChannelLayoutConfig(val mixed: Boolean = false, val version: Int = 0) {
    companion object {
        val Legacy = ChannelLayoutConfig(mixed = false, version = 0)
    }
}

/** What a `PUT …/channel-layout` came back with. */
sealed interface ChannelLayoutSaveResult {
    /** Saved. [channels] null means the server could not read the list back: keep the order drawn. */
    data class Saved(val channels: List<Channel>?, val version: Int) : ChannelLayoutSaveResult

    /** Somebody else changed the list first. Adopt both, say so, try again. */
    data class Stale(val channels: List<Channel>, val version: Int) : ChannelLayoutSaveResult

    /** The server is not in the mixed list (any more): draw the old one. */
    data object Off : ChannelLayoutSaveResult

    /** The server refused the body. Its sentence, shown as is. */
    data class Invalid(val message: String) : ChannelLayoutSaveResult
}

/**
 * A category is a label, not a slug: "Salas de voz" is fine. The server's
 * `categoryNameSchema`: trimmed, 1 to 32 characters (UTF-16 units, the way
 * JavaScript counts and the way a Kotlin `String.length` counts), no control
 * characters. Null when the server would refuse it.
 */
fun normalizedCategoryName(raw: String): String? {
    val name = raw.trim()
    if (name.isEmpty() || name.length > CATEGORY_NAME_MAX_LENGTH) return null
    if (name.any { it.isISOControl() || it == ' ' || it == ' ' }) return null
    return name
}

const val CATEGORY_NAME_MAX_LENGTH = 32
