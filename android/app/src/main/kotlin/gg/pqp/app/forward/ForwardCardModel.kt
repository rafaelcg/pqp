package gg.pqp.app.forward

/**
 * What a forward card draws, worked out from the snapshot and nothing else.
 *
 * Kept out of the composable so the states (a post with a poster, a message
 * with no media, a card whose thumbnail the server never stored, a snapshot
 * with nothing to say) are pinned by a JVM test rather than by a screenshot.
 */
enum class ForwardGlyph { Image, Video, Youtube, Embed }

/** Where the source lives, for the header line: the Baú, or a channel's name. */
sealed interface ForwardOrigin {
    data object Bau : ForwardOrigin

    /** [name] is without the `#`. Blank when the server did not send one. */
    data class Channel(val name: String) : ForwardOrigin
}

data class ForwardCardModel(
    val serverName: String,
    val serverIconUrl: String?,
    val origin: ForwardOrigin,
    /** A post's title, or a message's author. Null when there is neither. */
    val heading: String?,
    /** Plain text, trimmed. The card cuts it to three lines. */
    val excerpt: String,
    /** A stable public image URL, or null. */
    val thumbUrl: String?,
    /** What to draw in the thumbnail's place: no URL, or one that failed to load. */
    val glyph: ForwardGlyph?,
    /** A members-only post or a private-channel message: it stays in its server. */
    val restricted: Boolean,
) {
    /** Nothing to read at all: the header alone, with a line saying so. */
    val isEmpty: Boolean
        get() = heading == null && excerpt.isEmpty() && thumbUrl == null && glyph == null

    /** The one line TalkBack reads for the whole card. */
    fun spokenSummary(): String =
        listOfNotNull(heading, excerpt.takeIf { it.isNotEmpty() }).joinToString(". ")
}

object ForwardCards {

    fun model(forward: MessageForward): ForwardCardModel {
        val heading = if (forward.isBauPost) {
            forward.title?.trim()?.takeIf { it.isNotEmpty() }
        } else {
            forward.authorDisplayName?.trim()?.takeIf { it.isNotEmpty() }
        }
        val origin = if (forward.isBauPost) {
            ForwardOrigin.Bau
        } else {
            ForwardOrigin.Channel(forward.sourceChannelName.orEmpty().trim().removePrefix("#"))
        }
        return ForwardCardModel(
            serverName = forward.sourceServerName,
            serverIconUrl = forward.sourceServerIconUrl?.takeIf { it.isNotBlank() },
            origin = origin,
            heading = heading,
            excerpt = forward.excerpt.trim(),
            thumbUrl = forward.mediaThumbUrl?.takeIf { it.isNotBlank() },
            glyph = glyphFor(forward.mediaKind),
            restricted = forward.restricted,
        )
    }

    /**
     * `mediaKind` can be set with no thumbnail (signed URLs are never stored),
     * so a glyph says what kind of thing the source had. An unknown future kind
     * draws nothing rather than a wrong picture.
     */
    fun glyphFor(kind: String?): ForwardGlyph? = when (kind) {
        "image" -> ForwardGlyph.Image
        "video" -> ForwardGlyph.Video
        "youtube" -> ForwardGlyph.Youtube
        "embed" -> ForwardGlyph.Embed
        else -> null
    }
}
