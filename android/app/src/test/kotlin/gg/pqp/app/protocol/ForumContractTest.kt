package gg.pqp.app.protocol

import gg.pqp.app.forum.CreateForumPostRequest
import gg.pqp.app.forum.ForumAcceptedAnswer
import gg.pqp.app.forum.ForumErrors
import gg.pqp.app.forum.ForumFrame
import gg.pqp.app.forum.ForumLimits
import gg.pqp.app.forum.ForumPostDetailResponse
import gg.pqp.app.forum.ForumPostListResponse
import gg.pqp.app.forum.ForumPostSummary
import gg.pqp.app.forum.ForumPostViewer
import gg.pqp.app.forum.ForumSettings
import gg.pqp.app.forum.ForumSort
import gg.pqp.app.forum.ForumStatus
import gg.pqp.app.forum.ForumTag
import gg.pqp.app.forum.UpdateForumPostRequest
import gg.pqp.app.core.PqpJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The forum models against `packages/shared/src/forums.ts`, field by field and
 * cap by cap, the way `ModelShapeTest` holds the core models: a rename on the
 * server must fail here, not decode to a default on a phone.
 */
class ForumContractTest {

    private val forums = "packages/shared/src/forums.ts"

    private fun assertSubset(serializer: KSerializer<*>, schema: String) {
        val schemaKeys = RepoSources.objectKeys(forums, schema).toSet()
        val kotlinKeys = serializer.descriptor.elementNames.toSet()
        assertEquals(
            "${serializer.descriptor.serialName} names fields $schema does not have",
            emptySet<String>(),
            kotlinKeys - schemaKeys,
        )
    }

    @Test
    fun `the models match the shared schemas`() {
        assertSubset(ForumPostSummary.serializer(), "forumPostSummarySchema")
        assertSubset(ForumPostViewer.serializer(), "forumPostViewerSchema")
        assertSubset(ForumPostListResponse.serializer(), "forumPostListResponseSchema")
        assertSubset(ForumTag.serializer(), "forumTagSchema")
        assertSubset(ForumSettings.serializer(), "forumSettingsSchema")
        assertSubset(ForumAcceptedAnswer.serializer(), "forumAcceptedAnswerSchema")
        assertSubset(ForumPostDetailResponse.serializer(), "forumPostDetailResponseSchema")
        assertSubset(CreateForumPostRequest.serializer(), "createForumPostSchema")
        assertSubset(UpdateForumPostRequest.serializer(), "updateForumPostSchema")
    }

    /**
     * The summary is the one model a frame carries, so it is held the other
     * way too: every field the server sends is read, because the card draws
     * all of them.
     */
    @Test
    fun `the summary reads every field the server sends`() {
        val schemaKeys = RepoSources.objectKeys(forums, "forumPostSummarySchema").toSet()
        assertEquals(schemaKeys, ForumPostSummary.serializer().descriptor.elementNames.toSet())
    }

    @Test
    fun `the caps match shared`() {
        assertEquals(RepoSources.numberConstant(forums, "FORUM_MAX_TAGS"), ForumLimits.MAX_TAGS)
        assertEquals(RepoSources.numberConstant(forums, "FORUM_MAX_TAGS_PER_POST"), ForumLimits.MAX_TAGS_PER_POST)
        assertEquals(RepoSources.numberConstant(forums, "FORUM_MAX_PINNED"), ForumLimits.MAX_PINNED)
        assertEquals(RepoSources.numberConstant(forums, "FORUM_TITLE_MAX"), ForumLimits.TITLE_MAX)
        assertEquals(RepoSources.numberConstant(forums, "FORUM_PAGE_SIZE"), ForumLimits.PAGE_SIZE)
        assertEquals(RepoSources.numberConstant(forums, "FORUM_SEARCH_MAX"), ForumLimits.SEARCH_MAX)
        assertEquals(RepoSources.numberConstant(forums, "FORUM_SIMILAR_MAX"), ForumLimits.SIMILAR_MAX)
        assertEquals(RepoSources.numberConstant(forums, "FORUM_UNREAD_CAP"), ForumLimits.UNREAD_CAP)
        assertEquals(RepoSources.numberConstant(forums, "FORUM_BODY_MAX"), ForumLimits.BODY_MAX)
    }

    @Test
    fun `the enums and error tokens match shared`() {
        assertEquals(RepoSources.enumValues(forums, "forumSortSchema"), ForumSort.entries.map { it.wire })
        assertEquals(RepoSources.enumValues(forums, "forumStatusFilterSchema"), ForumStatus.entries.map { it.wire })
        val source = RepoSources.read(forums)
        listOf(
            ForumErrors.OFF,
            ForumErrors.TAG_REQUIRED,
            ForumErrors.TAG_MODERATED,
            ForumErrors.TAG_UNKNOWN,
            ForumErrors.PIN_LIMIT,
            ForumErrors.ANSWER_INVALID,
            ForumErrors.POST_REJECTED,
        ).forEach { token ->
            assertTrue("forums.ts no longer names $token", source.contains("\"$token\""))
        }
    }

    @Test
    fun `both frames decode, and anything else is not a forum frame`() {
        val post = """{"id":"11111111-1111-4111-8111-111111111111","forumId":"22222222-2222-4222-8222-222222222222",
            "title":"Tela azul","authorId":null,"authorName":null,"authorAvatarUrl":null,"authorIsWebhook":false,
            "createdAt":"2026-10-11T20:00:00.000Z","lastActivityAt":"2026-10-11T20:00:00.000Z","pinnedAt":null,
            "lockedAt":null,"resolvedAt":null,"acceptedAnswerId":null,"preview":"oi","openingDeleted":false,
            "openingKind":"text","attachmentCount":0,"replyCount":0,"reactionCount":0,"topReaction":null,
            "thumbnailUrl":null,"thumbnailAttachmentId":null,"thumbnailWidth":null,"thumbnailHeight":null,
            "tagIds":[],"someFieldFromTheFuture":1}"""
        val upsert = PqpJson.parseToJsonElement(
            """{"type":"forum-post-upsert","forumId":"22222222-2222-4222-8222-222222222222","post":$post}""",
        ).jsonObject
        val decoded = ForumFrame.decode(upsert) as ForumFrame.Upsert
        assertEquals("Tela azul", decoded.post.title)

        val removed = PqpJson.parseToJsonElement(
            """{"type":"forum-post-removed","forumId":"f","postId":"p"}""",
        ).jsonObject
        assertEquals(ForumFrame.Removed("f", "p"), ForumFrame.decode(removed))

        val other = PqpJson.parseToJsonElement("""{"type":"message-broadcast","forumId":"f"}""").jsonObject
        assertEquals(null, ForumFrame.decode(other))
        val broken = PqpJson.parseToJsonElement("""{"type":"forum-post-upsert","forumId":"f","post":{}}""").jsonObject
        assertEquals(null, ForumFrame.decode(broken))
    }
}
