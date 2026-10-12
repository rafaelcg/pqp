package gg.pqp.app.stories

import java.time.Instant

/**
 * The story rules that have an edge to get wrong, without Compose, so each is
 * a JVM test. Timings and limits mirror `packages/shared/src/stories.ts`;
 * `StoriesTest` reads them out of that file rather than trusting these.
 */
object StoriesRules {

    const val PHOTO_DISPLAY_MS = 5_000L
    const val CALL_DISPLAY_MS = 8_000L
    const val MAX_VIDEO_MS = 30_000L
    const val MAX_BYTES = 25L * 1024 * 1024
    const val IMAGE_MAX_EDGE = 1440
    const val CAPTION_MAX = 200
    const val TEXT_MAX = 280
    const val REPLY_MAX = 2000

    /** How long after a story is on screen it counts as seen. */
    const val SEEN_AFTER_MS = 1_000L

    /** `STORY_REACTIONS`, in the order the row draws them. */
    val REACTIONS = listOf("gg", "fire", "joy", "wow", "skull", "clap")

    /** `STORY_BACKGROUNDS`, in the order the picker draws them. */
    val BACKGROUNDS = listOf("lime", "night", "ember", "grape", "sand", "ink")

    /** What a reaction looks like. GG is the house one and is a word, not an emoji. */
    fun reactionGlyph(reaction: String): String = when (reaction) {
        "gg" -> "GG"
        "fire" -> "🔥"
        "joy" -> "😂"
        "wow" -> "😮"
        "skull" -> "💀"
        "clap" -> "👏"
        else -> "?"
    }

    /** `storyTextDisplayMs`: 5 s plus 50 ms per character, at most 10 s. */
    fun textDisplayMs(text: String): Long =
        minOf(10_000L, 5_000L + 50L * text.codePointCount(0, text.length))

    /**
     * How long a story stays on screen before the next one. A video runs its
     * own length; a call sticker gets 8 s so somebody can read who is in the
     * room; a text card scales with what there is to read.
     */
    fun displayMs(story: Story): Long = when {
        story.kind == "video" -> story.media?.durationMs?.takeIf { it > 0 } ?: PHOTO_DISPLAY_MS
        story.sticker?.type == "call" -> CALL_DISPLAY_MS
        story.kind == "text" -> textDisplayMs(story.text.orEmpty())
        else -> PHOTO_DISPLAY_MS
    }

    private fun parse(iso: String?): Long? =
        iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

    /** Clients drop expired rings themselves: no frame is ever sent for expiry. */
    fun isExpired(expiresAt: String?, nowMs: Long): Boolean {
        val at = parse(expiresAt) ?: return false
        return at <= nowMs
    }

    /** The strip as it should read right now: expired authors gone, nothing else touched. */
    fun live(strip: StoryStrip, nowMs: Long): StoryStrip = strip.copy(
        own = strip.own?.takeUnless { isExpired(it.expiresAt, nowMs) },
        items = strip.items.filterNot { isExpired(it.expiresAt, nowMs) },
    )

    /** When the next ring on this strip runs out, so one timer can redraw it then. */
    fun nextExpiry(strip: StoryStrip, nowMs: Long): Long? =
        (listOfNotNull(strip.own) + strip.items)
            .mapNotNull { parse(it.expiresAt) }
            .filter { it > nowMs }
            .minOrNull()

    /** "12 min", "2 h": the age in the viewer header. */
    fun age(publishedAt: String?, nowMs: Long): String? {
        val at = parse(publishedAt) ?: return null
        val minutes = ((nowMs - at) / 60_000L).coerceAtLeast(0)
        return if (minutes < 60) "$minutes min" else "${minutes / 60} h"
    }

    /** "21 h", "40 min": what is left before a story goes. */
    fun left(expiresAt: String?, nowMs: Long): String? {
        val at = parse(expiresAt) ?: return null
        val minutes = ((at - nowMs) / 60_000L).coerceAtLeast(0)
        return if (minutes < 60) "$minutes min" else "${minutes / 60} h"
    }

    /** A photo's long side capped at 1440 px, aspect kept. Re-encoding drops EXIF too. */
    fun scaledSize(width: Int, height: Int, maxEdge: Int = IMAGE_MAX_EDGE): Pair<Int, Int> {
        val long = maxOf(width, height)
        if (long <= maxEdge || long <= 0) return width to height
        val ratio = maxEdge.toDouble() / long
        return maxOf(1, (width * ratio).toInt()) to maxOf(1, (height * ratio).toInt())
    }

    /** Why a picked file cannot be a story, said before anything is uploaded. */
    enum class MediaRefusal { WrongType, TooBig, TooLong }

    fun checkMedia(contentType: String, byteSize: Long, durationMs: Long?, maxBytes: Long = MAX_BYTES): MediaRefusal? =
        when {
            contentType != "video/mp4" && contentType !in IMAGE_TYPES -> MediaRefusal.WrongType
            byteSize > maxBytes -> MediaRefusal.TooBig
            contentType == "video/mp4" && (durationMs == null || durationMs > MAX_VIDEO_MS) -> MediaRefusal.TooLong
            else -> null
        }

    val IMAGE_TYPES = listOf("image/jpeg", "image/webp", "image/png")

    /**
     * The audience the composer opens with: where the person was. A server
     * they may post to, or Amigos from the Conversas strip. Nothing they may
     * not post to is ever pre-ticked.
     */
    fun defaultAudience(
        options: StoryAudienceOptions,
        contextServerId: String?,
        fromFriends: Boolean,
    ): StoryAudienceTargets {
        val server = options.servers.firstOrNull { it.serverId == contextServerId && it.canPost }
        val friends = fromFriends && options.friends.enabled && options.friends.canPost
        return StoryAudienceTargets(
            serverIds = listOfNotNull(server?.serverId),
            friends = friends || (server == null && options.friends.enabled && options.friends.canPost),
        )
    }

    /** At least one audience, and at most ten servers (`STORY_MAX_SERVER_AUDIENCES`). */
    fun canPost(targets: StoryAudienceTargets): Boolean =
        (targets.serverIds.isNotEmpty() || targets.friends) && targets.serverIds.size <= 10

    /** Where the viewer starts in one author's stories: the first one not seen yet. */
    fun startIndex(stories: List<Story>): Int =
        stories.indexOfFirst { !it.viewer.seen }.takeIf { it >= 0 } ?: 0
}
