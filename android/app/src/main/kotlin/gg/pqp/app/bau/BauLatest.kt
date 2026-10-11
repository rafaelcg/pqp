package gg.pqp.app.bau

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.getJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/**
 * One post in the channel list's Baú preview: the card chat already draws,
 * plus whether this person has seen it.
 */
data class BauLatestPost(val card: BauPostCard, val isNew: Boolean)

/**
 * `GET /api/servers/:id/home/latest?limit=3`.
 *
 * `{ unread, lastSeenAt, posts: Array<CommunityHomePostCard & { isNew }> }`,
 * newest first, published only. `isNew` uses the same rule as the unread
 * count, so the card and the number never disagree.
 */
data class BauLatest(
    val unread: Int,
    val lastSeenAt: String?,
    val posts: List<BauLatestPost>,
)

/**
 * Decoded by hand rather than with a generated serializer: each post is a
 * [BauPostCard] with one extra key, and reusing the card's own serializer is
 * what keeps the preview drawing exactly what chat draws. A post that does
 * not decode is skipped instead of failing the whole preview.
 */
fun parseBauLatest(body: JsonObject): BauLatest {
    val posts = runCatching { body["posts"]!!.jsonArray }.getOrNull().orEmpty().mapNotNull { element ->
        runCatching {
            val obj = element.jsonObject
            BauLatestPost(
                card = PqpJson.decodeFromJsonElement(BauPostCard.serializer(), obj),
                isNew = (obj["isNew"] as? JsonPrimitive)?.booleanOrNull ?: false,
            )
        }.getOrNull()
    }
    return BauLatest(
        unread = (body["unread"] as? JsonPrimitive)?.intOrNull?.coerceAtLeast(0) ?: 0,
        lastSeenAt = (body["lastSeenAt"] as? JsonPrimitive)?.contentOrNull,
        posts = posts,
    )
}

/**
 * The preview, or null when this API does not have the route (404: an older
 * deployment, or the `bau_latest_preview` flag off for this server). Null is
 * the caller's cue to fall back to `/home/unread` and the plain row. Any other
 * failure throws, so a dropped request is not mistaken for "no route".
 */
suspend fun ApiClient.bauLatest(serverId: String, limit: Int = 3, lang: String? = null): BauLatest? {
    val query = buildMap {
        put("limit", limit.toString())
        if (!lang.isNullOrBlank()) put("lang", lang)
    }
    val body = try {
        getJson<JsonElement>("/api/servers/$serverId/home/latest", query)
    } catch (failure: ApiException) {
        if (failure.status == 404) return null
        throw failure
    }
    return parseBauLatest(body.jsonObject)
}

/** What the Baú slot on the channel list draws. */
sealed interface BauPreviewState {
    /** Before the first answer: the slot keeps its height and says nothing. */
    data object Loading : BauPreviewState

    /**
     * An API without `/home/latest`: today's row with its unread badge,
     * exactly as before this preview existed.
     */
    data class Plain(val unread: Int) : BauPreviewState

    /**
     * Something new: the latest post as a card. [next] is the second-newest
     * post when it is also new, named in the card's footer, and [moreCount]
     * is how many new posts there are besides the one on the card.
     */
    data class Fresh(val post: BauPostCard, val next: BauPostCard?, val moreCount: Int) : BauPreviewState

    /** Seen: a slim row with the latest post's thumbnail and title. */
    data class Seen(val post: BauPostCard) : BauPreviewState

    /** Nothing posted yet. Staff get an invitation to post; members a quiet row. */
    data class Empty(val canPost: Boolean) : BauPreviewState
}

fun bauPreviewState(latest: BauLatest?, legacyUnread: Int, canPost: Boolean): BauPreviewState {
    if (latest == null) return BauPreviewState.Plain(legacyUnread)
    val first = latest.posts.firstOrNull()
        // Posts were sent but none decoded: say what the count says, never "empty".
        ?: return if (latest.unread > 0) BauPreviewState.Plain(latest.unread) else BauPreviewState.Empty(canPost)
    // The server counts something new that did not survive decoding (a newer
    // shape this build cannot read): the plain row with the count, rather
    // than a "seen" row that hides it.
    if (!first.isNew) {
        return if (latest.unread > 0) BauPreviewState.Plain(latest.unread) else BauPreviewState.Seen(first.card)
    }
    val newCount = maxOf(latest.unread, latest.posts.count { it.isNew })
    val second = latest.posts.getOrNull(1)?.takeIf { it.isNew }?.card
    return BauPreviewState.Fresh(
        post = first.card,
        next = second,
        moreCount = (newCount - 1).coerceAtLeast(0),
    )
}

/**
 * What fills the preview's thumbnail. Never a frame pulled out of a video:
 * that downloads video bytes just to draw a sidebar. An uploaded video,
 * Twitch, TikTok and Instagram get the server-coloured plate with a play mark.
 */
enum class BauThumb { Image, Plate, Text }

fun bauThumb(card: BauPostCard): BauThumb = when (card.poster) {
    BauCardPoster.Image -> if (card.locked) BauThumb.Plate else BauThumb.Image
    BauCardPoster.VideoFrame, BauCardPoster.Plate -> BauThumb.Plate
    BauCardPoster.None -> BauThumb.Text
}
