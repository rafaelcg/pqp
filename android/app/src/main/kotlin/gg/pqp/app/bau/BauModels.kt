package gg.pqp.app.bau

import gg.pqp.app.social.PublicUser
import java.net.URI
import kotlinx.serialization.Serializable

/*
 * The Baú (Community Home) on the wire: `packages/shared/src/community-home.ts`.
 *
 * Every field here is a hand-copy of that file, like the rest of `core`. The
 * shape lands on `main` with the Community Home branch (PR #176); until then
 * it is the staging API's, and `BauContractTest` pins these names against the
 * shared schema the moment the file exists in the checkout.
 *
 * What the phone reads is a deliberate subset: no drafts, no schedule, no
 * media minting. Staff post from the web. Liking and commenting are the only
 * verbs here, which is also what the product says the Baú is for.
 */

/**
 * `GET /api/community-home/config`.
 *
 * Defaulted to off in every field so an older server (no route at all, a 404)
 * and a response this client does not fully understand both read as "there is
 * no Baú here", which is the honest state of production until PR #176 lands.
 */
@Serializable
data class CommunityHomeConfig(
    val enabled: Boolean = false,
    val vipEnabled: Boolean = false,
    val mediaEnabled: Boolean = false,
)

/**
 * One post's media, as the viewer may see it. `url` is a presigned GET for
 * storage-backed kinds and null for YouTube; a locked viewer gets no media at
 * all (the whole object is null on the post), never a media with the URL
 * stripped, so nothing here has to guess at a lock.
 */
@Serializable
data class BauMedia(
    /** `image` / `video` / `youtube` / `file`. */
    val kind: String,
    val name: String = "",
    val contentType: String? = null,
    val byteSize: Long? = null,
    val url: String? = null,
    val youtubeUrl: String? = null,
) {
    val isImage: Boolean get() = kind == "image"
    val isVideo: Boolean get() = kind == "video"
    val isYoutube: Boolean get() = kind == "youtube"
    val isFile: Boolean get() = kind == "file"

    /** What a tap opens: the object for storage kinds, the watch page for YouTube. */
    val openUrl: String? get() = if (isYoutube) youtubeUrl else url
}

@Serializable
data class BauComment(
    val id: String,
    val author: PublicUser,
    val body: String,
    val createdAt: String,
)

@Serializable
data class BauPost(
    val id: String,
    val serverId: String,
    val author: PublicUser,
    /** `owner` / `staff`, or null. Never `vip` this pass. */
    val authorBadge: String? = null,
    val title: String? = null,
    /**
     * Null on a members-only post the viewer cannot unlock: the API strips it,
     * and this client must not rebuild a body from the teaser.
     */
    val body: String? = null,
    val teaser: String? = null,
    /** `free` / `members`. */
    val visibility: String = "free",
    val status: String = "published",
    val commentsEnabled: Boolean = true,
    val media: BauMedia? = null,
    /** True when body and media were stripped for this viewer. */
    val locked: Boolean = false,
    val likeCount: Int = 0,
    val likedByMe: Boolean = false,
    val commentCount: Int = 0,
    /** The two newest comments, or none at all on a locked post. */
    val commentTeaser: List<BauComment> = emptyList(),
    val publishedAt: String? = null,
    val createdAt: String,
) {
    val isMembersOnly: Boolean get() = visibility == "members"

    /** Ordering and the date on the card: when it went up, or when it was written. */
    val shownAt: String get() = publishedAt ?: createdAt
}

@Serializable
data class BauPostsResponse(val posts: List<BauPost> = emptyList())

@Serializable
data class BauCommentsResponse(val comments: List<BauComment> = emptyList())

@Serializable
data class BauCommentResponse(val comment: BauComment)

@Serializable
data class BauLikeResponse(val liked: Boolean, val likeCount: Int)

@Serializable
data class CreateBauCommentRequest(val body: String)

/**
 * YouTube links, the one media kind that is a URL rather than an object.
 *
 * `videoId` is a port of `parseYoutubeVideoId` in shared: watch, youtu.be,
 * shorts, embed and live, eleven characters of id, anything else null. The
 * thumbnail is the public one every video has; there is no API key involved
 * and no embed on the phone, a tap opens the watch page.
 */
object YoutubeLinks {

    private val ID = Regex("""^[\w-]{11}$""")

    fun videoId(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
        val host = uri.host?.lowercase()?.removePrefix("www.") ?: return null
        val parts = uri.path.orEmpty().split('/').filter { it.isNotEmpty() }

        if (host == "youtu.be") {
            return parts.firstOrNull()?.takeIf { ID.matches(it) }
        }
        if (host == "youtube.com" || host == "m.youtube.com" || host == "music.youtube.com") {
            if (uri.path == "/watch") {
                val id = uri.query.orEmpty()
                    .split('&')
                    .firstOrNull { it.startsWith("v=") }
                    ?.removePrefix("v=")
                return id?.takeIf { ID.matches(it) }
            }
            val head = parts.getOrNull(0)
            val id = parts.getOrNull(1)
            if ((head == "shorts" || head == "embed" || head == "live") && id != null && ID.matches(id)) {
                return id
            }
        }
        return null
    }

    fun thumbnailUrl(raw: String?): String? =
        videoId(raw)?.let { "https://i.ytimg.com/vi/$it/hqdefault.jpg" }
}
