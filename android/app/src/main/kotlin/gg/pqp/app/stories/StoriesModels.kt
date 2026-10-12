package gg.pqp.app.stories

import kotlinx.serialization.Serializable

/**
 * Stories on the wire: `packages/shared/src/stories.ts`, the subset this
 * client reads. Every field defaults, so a server that grows the schema (or
 * one mid-deploy that has not yet) still decodes; `StoriesTest` checks every
 * name here against the zod schema it comes from.
 *
 * A story is what somebody is up to for 24 hours: a photo, a video of up to
 * 30 s, a text card, optionally a live "chama pra call" sticker. It goes to
 * one or more servers the author is in, to their friends, or to both.
 */

@Serializable
data class StoriesConfig(
    val enabled: Boolean = false,
    val friendsEnabled: Boolean = false,
    val mediaEnabled: Boolean = false,
    val videoEnabled: Boolean = false,
    val maxVideoMs: Long = 30_000,
    val maxBytes: Long = 25L * 1024 * 1024,
    val ttlHours: Int = 24,
)

@Serializable
data class StoryAuthor(
    val id: String,
    val displayName: String = "",
    val avatarUrl: String? = null,
    val handle: String? = null,
)

/** `storyStickerSchema`: only `call` today. An unknown type decodes as no sticker. */
@Serializable
data class StorySticker(
    val type: String,
    val serverId: String? = null,
    val channelId: String? = null,
)

/** The call sticker, live: who is in the room right now. */
@Serializable
data class StoryCallLive(
    val serverId: String,
    val channelId: String,
    val channelName: String = "",
    val participants: List<StoryAuthor> = emptyList(),
    val count: Int = 0,
    /** `live` / `ended` / `full`. */
    val state: String = "ended",
    val joinable: Boolean = false,
)

/** `{kind:"server", serverId, serverName}` or `{kind:"friends"}`. */
@Serializable
data class StoryAudience(
    val kind: String,
    val serverId: String? = null,
    val serverName: String? = null,
)

@Serializable
data class StoryMedia(
    val url: String,
    val posterUrl: String? = null,
    val contentType: String = "",
    val width: Int = 0,
    val height: Int = 0,
    val durationMs: Long? = null,
)

@Serializable
data class StoryViewerState(
    val seen: Boolean = false,
    val reaction: String? = null,
    val canReply: Boolean = false,
    /** `replies_off` / `dm_closed`, when [canReply] is false for a reason worth saying. */
    val replyBlockedReason: String? = null,
    /** Server ids where this viewer may take the story down. */
    val canModerate: List<String> = emptyList(),
    val canSaveToBau: List<String> = emptyList(),
)

@Serializable
data class StoryOwnState(
    /** `pending` / `processing` / `live`. */
    val status: String = "live",
    val viewCount: Int = 0,
    val reactionCount: Int = 0,
    val replyCount: Int = 0,
    val repliesEnabled: Boolean = true,
)

@Serializable
data class Story(
    val id: String,
    val author: StoryAuthor,
    /** `image` / `video` / `text`. */
    val kind: String,
    val caption: String? = null,
    val text: String? = null,
    val background: String? = null,
    val media: StoryMedia? = null,
    val sticker: StorySticker? = null,
    val call: StoryCallLive? = null,
    val publishedAt: String? = null,
    val expiresAt: String? = null,
    val audiences: List<StoryAudience> = emptyList(),
    val viewer: StoryViewerState = StoryViewerState(),
    /** Present only on the viewer's own story. */
    val own: StoryOwnState? = null,
)

@Serializable
data class StoryStripItem(
    val author: StoryAuthor,
    val storyIds: List<String> = emptyList(),
    val latestAt: String = "",
    val expiresAt: String = "",
    val unseen: Boolean = false,
    val hasCall: Boolean = false,
)

@Serializable
data class StoryStrip(
    val enabled: Boolean = false,
    val canPost: Boolean = false,
    val own: StoryStripItem? = null,
    val items: List<StoryStripItem> = emptyList(),
    val firstRunHint: Boolean = false,
)

@Serializable
data class StoryAudienceServer(
    val serverId: String,
    val serverName: String = "",
    val iconUrl: String? = null,
    val memberCount: Int = 0,
    val canPost: Boolean = false,
    /** `no_permission` / `timed_out` / `account_too_new`. */
    val blockedReason: String? = null,
)

@Serializable
data class StoryAudienceFriends(val enabled: Boolean = false, val canPost: Boolean = false)

@Serializable
data class StoryAudienceOptions(
    val servers: List<StoryAudienceServer> = emptyList(),
    val friends: StoryAudienceFriends = StoryAudienceFriends(),
)

// --- writes ---

@Serializable
data class StoryMediaInput(
    val contentType: String,
    val byteSize: Long,
    val width: Int,
    val height: Int,
    val durationMs: Long? = null,
)

@Serializable
data class StoryAudienceTargets(
    val serverIds: List<String> = emptyList(),
    val friends: Boolean = false,
)

@Serializable
data class CreateStoryRequest(
    val kind: String,
    val caption: String? = null,
    val text: String? = null,
    val background: String? = null,
    val sticker: StorySticker? = null,
    val repliesEnabled: Boolean = true,
    val audiences: StoryAudienceTargets,
    val media: StoryMediaInput? = null,
    /**
     * Made once per story the person means to post and resent on a retry: a
     * second create with the same id answers the first story instead of
     * posting a second one.
     */
    val requestId: String? = null,
)

@Serializable
data class StoryUpload(
    val url: String,
    val method: String = "PUT",
    val headers: Map<String, String> = emptyMap(),
    val expiresAt: String? = null,
)

@Serializable
data class CreateStoryResponse(val story: Story, val upload: StoryUpload? = null)

@Serializable
data class PublishStoryResponse(val story: Story)

@Serializable
data class StoriesResponse(val stories: List<Story> = emptyList())

@Serializable
data class StoryViewsBatch(val storyIds: List<String>)

@Serializable
data class StoryReactionRequest(val reaction: String?)

@Serializable
data class StoryReplyRequest(
    val text: String,
    /** Same idempotency as a chat send: a retry answers the reply that already landed. */
    val nonce: String? = null,
)

@Serializable
data class StoryReplyResponse(val conversationId: String, val messageId: String)

@Serializable
data class StoryViewerRow(
    val user: StoryAuthor,
    val viewedAt: String = "",
    val reaction: String? = null,
    val replied: Boolean = false,
)

@Serializable
data class StoryViewersPage(
    val viewers: List<StoryViewerRow> = emptyList(),
    val nextCursor: String? = null,
    val viewCount: Int = 0,
    val reactionCount: Int = 0,
)

@Serializable
data class StoryModRemoveRequest(val reason: String? = null)

/** The DM quote: thumbnail and caption only while the story lives. */
@Serializable
data class StoryCard(
    val storyId: String,
    /** `live` / `expired` / `removed`. */
    val state: String = "expired",
    val authorId: String = "",
    val kind: String? = null,
    val posterUrl: String? = null,
    val caption: String? = null,
    val text: String? = null,
    val background: String? = null,
    val expiresAt: String? = null,
)

@Serializable
data class StoryNotice(
    val id: String,
    val kind: String = "removed",
    val storyId: String? = null,
    val serverId: String? = null,
    val serverName: String? = null,
    val reason: String? = null,
    val createdAt: String = "",
)

@Serializable
data class StoryNoticesResponse(val notices: List<StoryNotice> = emptyList())
