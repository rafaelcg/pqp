package gg.pqp.app.forum

import gg.pqp.app.core.PqpJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/*
 * Forum channels on the wire, as `packages/shared/src/forums.ts` spells them.
 *
 * The model, stated once: a forum is a channel that holds posts, and a post is
 * a thread channel under it. Its messages, read cursor, mentions and pushes are
 * an ordinary channel's, so the post screen is the chat screen pointed at the
 * post's id; what is here is what a chat thread does not have (title, tags,
 * pinned, locked, resolved, the accepted answer).
 *
 * Hand-copied like every other wire model in this app, and pinned field by
 * field against the zod schemas by `ForumContractTest`, so a rename on the
 * server fails a test instead of decoding to a default.
 */

/** `FORUM_*` caps from forums.ts. `ForumContractTest` pins each one. */
object ForumLimits {
    const val MAX_TAGS = 20
    const val MAX_TAGS_PER_POST = 5
    const val MAX_PINNED = 3
    const val TITLE_MAX = 100
    const val PAGE_SIZE = 25
    const val SEARCH_MAX = 100
    const val SIMILAR_MAX = 5
    const val UNREAD_CAP = 99
    const val BODY_MAX = 4000
}

/** `FORUM_ERRORS`: the `error` token of a forum refusal. */
object ForumErrors {
    const val OFF = "forum_channels_off"
    const val TAG_REQUIRED = "forum_tag_required"
    const val TAG_MODERATED = "forum_tag_moderated"
    const val TAG_UNKNOWN = "forum_tag_unknown"
    const val PIN_LIMIT = "forum_pin_limit"
    const val ANSWER_INVALID = "forum_answer_invalid"
    const val POST_REJECTED = "forum_post_rejected"
}

/** `forumSortSchema`. */
enum class ForumSort(val wire: String) {
    Activity("activity"),
    Created("created"),
    ;

    companion object {
        fun fromWire(token: String?): ForumSort? = entries.firstOrNull { it.wire == token }
    }
}

/** `forumStatusFilterSchema`; null on the request is "both". */
enum class ForumStatus(val wire: String) {
    Open("open"),
    Resolved("resolved"),
    ;

    companion object {
        fun fromWire(token: String?): ForumStatus? = entries.firstOrNull { it.wire == token }
    }
}

@Serializable
data class ForumTag(
    val id: String,
    val name: String,
    val emoji: String? = null,
    /** Staff-only ("Só staff"). Members never see it in the composer. */
    val moderated: Boolean = false,
    val position: Int = 0,
    val postCount: Int = 0,
)

@Serializable
data class ForumTagsResponse(val tags: List<ForumTag> = emptyList())

@Serializable
data class ForumSettings(
    val requireTag: Boolean = false,
    val defaultSort: String = ForumSort.Activity.wire,
)

@Serializable
data class ForumSettingsResponse(val settings: ForumSettings = ForumSettings())

/** `GET /api/forum/config?serverId=`. Off never hides a forum; it pauses new posts. */
@Serializable
data class ForumConfig(val enabled: Boolean = false)

@Serializable
data class ForumTopReaction(val emoji: String, val count: Int)

/**
 * One post as every viewer of the forum sees it. Shared, cached by the server
 * for page 1, and carried by `forum-post-upsert`, so nothing here is about the
 * reader: that is [ForumPostViewer].
 */
@Serializable
data class ForumPostSummary(
    /** The post's own thread channel id. */
    val id: String,
    val forumId: String,
    val title: String,
    /** Null once the account is gone ("Conta excluída"). */
    val authorId: String? = null,
    val authorName: String? = null,
    val authorAvatarUrl: String? = null,
    /** A feed post: the card shows `Feed`. */
    val authorIsWebhook: Boolean = false,
    val createdAt: String,
    /** The bump: creation, or the newest reply. Never moves backwards. */
    val lastActivityAt: String,
    val pinnedAt: String? = null,
    val lockedAt: String? = null,
    val resolvedAt: String? = null,
    val acceptedAnswerId: String? = null,
    val preview: String? = null,
    val openingDeleted: Boolean = false,
    /** `text`, `voice` or `attachment`; null with [openingDeleted]. */
    val openingKind: String? = null,
    val attachmentCount: Int = 0,
    val replyCount: Int = 0,
    val reactionCount: Int = 0,
    val topReaction: ForumTopReaction? = null,
    val thumbnailUrl: String? = null,
    val thumbnailAttachmentId: String? = null,
    val thumbnailWidth: Int? = null,
    val thumbnailHeight: Int? = null,
    /** In the forum's tag order. */
    val tagIds: List<String> = emptyList(),
) {
    val pinned: Boolean get() = pinnedAt != null
    val locked: Boolean get() = lockedAt != null
    val resolved: Boolean get() = resolvedAt != null
}

/** The reader's half of a post, never cached and never framed. */
@Serializable
data class ForumPostViewer(
    val postId: String,
    /** Null: never opened ("Novo"). */
    val lastReadAt: String? = null,
    /** Replies by others after [lastReadAt], capped at 99. */
    val newReplyCount: Int = 0,
    val following: Boolean = false,
)

@Serializable
data class ForumCounts(val posts: Int = 0, val open: Int = 0)

@Serializable
data class ForumPostListResponse(
    val pinned: List<ForumPostSummary> = emptyList(),
    val posts: List<ForumPostSummary> = emptyList(),
    val viewer: List<ForumPostViewer> = emptyList(),
    val nextCursor: String? = null,
    /** The reader's forum cursor before this visit; "Novo" is measured against it. */
    val forumPreviousReadAt: String? = null,
    /** Page 1 only. */
    val counts: ForumCounts? = null,
)

@Serializable
data class SimilarForumPostsResponse(val posts: List<ForumPostSummary> = emptyList())

@Serializable
data class ForumAcceptedAnswer(
    val messageId: String,
    val deleted: Boolean = false,
    val authorId: String? = null,
    val authorName: String? = null,
    val excerpt: String? = null,
    val createdAt: String? = null,
)

/** `GET /api/forum-posts/:postId`. */
@Serializable
data class ForumPostDetailResponse(
    val post: ForumPostSummary,
    val viewer: ForumPostViewer,
    val acceptedAnswer: ForumAcceptedAnswer? = null,
    val participantCount: Int = 0,
)

@Serializable
data class ForumPostResponse(val post: ForumPostSummary)

/** 201 (or 200 on a nonce retry) from `POST /api/channels/:forumId/posts`. */
@Serializable
data class CreateForumPostResponse(val post: ForumPostSummary, val viewer: ForumPostViewer? = null)

@Serializable
data class CreateForumPostRequest(
    val title: String,
    val body: String,
    val tagIds: List<String>? = null,
    val attachmentIds: List<String>? = null,
    val nonce: String,
)

/**
 * `PATCH /api/forum-posts/:postId`. Every field optional and left off the wire
 * when null, except [acceptedAnswerId], whose explicit null means "unmark":
 * [clearAcceptedAnswer] sends it.
 */
@Serializable
data class UpdateForumPostRequest(
    val title: String? = null,
    val tagIds: List<String>? = null,
    val resolved: Boolean? = null,
    val pinned: Boolean? = null,
    val locked: Boolean? = null,
    val acceptedAnswerId: String? = null,
)

@Serializable
data class SetForumPostFollowRequest(val following: Boolean)

@Serializable
data class ForumPostViewerResponse(val viewer: ForumPostViewer)

/** The two live frames (`forum-post-upsert`, `forum-post-removed`), decoded. */
sealed interface ForumFrame {
    val forumId: String

    data class Upsert(override val forumId: String, val post: ForumPostSummary) : ForumFrame

    data class Removed(override val forumId: String, val postId: String) : ForumFrame

    companion object {
        /**
         * Null for any other frame, and for one of these two that does not
         * decode: a frame the list cannot read is a frame it waits out, never
         * a crash.
         */
        fun decode(frame: JsonObject): ForumFrame? {
            fun string(key: String) = runCatching { frame[key]?.jsonPrimitive?.contentOrNull }.getOrNull()
            val forumId = string("forumId") ?: return null
            return when (string("type")) {
                "forum-post-upsert" -> runCatching {
                    Upsert(
                        forumId,
                        PqpJson.decodeFromJsonElement(ForumPostSummary.serializer(), frame["post"]!!.jsonObject),
                    )
                }.getOrNull()
                "forum-post-removed" -> string("postId")?.let { Removed(forumId, it) }
                else -> null
            }
        }
    }
}
