package gg.pqp.app.stories

import gg.pqp.app.core.Permission
import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import gg.pqp.app.reports.ReportDraft
import gg.pqp.app.reports.ReportReason
import gg.pqp.app.reports.ReportTarget
import java.time.Instant
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Stories on Android against `packages/shared/src/stories.ts`: every field the
 * phone reads exists on the schema it comes from, the timings and limits are
 * the shared ones, and the rules with an edge (clocks, expiry, the audience
 * the composer opens with, what the picker refuses) behave.
 */
class StoriesTest {

    private val shared = "packages/shared/src/stories.ts"
    private val source by lazy { RepoSources.stripComments(RepoSources.read(shared)) }

    private fun assertSubset(serializer: KSerializer<*>, schema: String, knownExtras: Set<String> = emptySet()) {
        val keys = RepoSources.objectKeys(shared, schema).toSet()
        val orphans = serializer.descriptor.elementNames.toSet() - keys - knownExtras
        assertEquals("${serializer.descriptor.serialName} names fields $schema does not have", emptySet<String>(), orphans)
    }

    @Test
    fun `every field the phone reads is on the shared schema`() {
        assertSubset(StoriesConfig.serializer(), "storiesConfigSchema")
        assertSubset(StoryAuthor.serializer(), "storyAuthorSchema")
        assertSubset(StoryCallLive.serializer(), "storyCallLiveSchema")
        assertSubset(StoryMedia.serializer(), "storyMediaSchema")
        assertSubset(StoryViewerState.serializer(), "storyViewerStateSchema")
        assertSubset(StoryOwnState.serializer(), "storyOwnStateSchema")
        assertSubset(Story.serializer(), "storySchema")
        assertSubset(StoryStripItem.serializer(), "storyStripItemSchema")
        assertSubset(StoryStrip.serializer(), "storyStripSchema")
        assertSubset(StoryAudienceOptions.serializer(), "storyAudienceOptionsSchema")
        assertSubset(StoryMediaInput.serializer(), "storyMediaInputSchema")
        assertSubset(StoryUpload.serializer(), "storyUploadSchema")
        assertSubset(CreateStoryResponse.serializer(), "createStoryResponseSchema")
        assertSubset(StoryViewerRow.serializer(), "storyViewerRowSchema")
        assertSubset(StoryViewersPage.serializer(), "storyViewersPageSchema")
        assertSubset(StoryReplyResponse.serializer(), "storyReplyResponseSchema")
        assertSubset(StoryReplyRequest.serializer(), "storyReplySchema")
        assertSubset(StoryCard.serializer(), "storyCardSchema")
        assertSubset(StoryNotice.serializer(), "storyNoticeSchema")
        // The create body is a superRefine'd object; its keys are read by hand.
        CreateStoryRequest.serializer().descriptor.elementNames.forEach { key ->
            assertTrue("createStorySchema has no $key", Regex("""\b$key\s*:""").containsMatchIn(source.substringAfter("createStorySchema")))
        }
    }

    private fun constant(name: String): Long =
        Regex("""const\s+$name\s*=\s*([\d_]+)""").find(source)!!.groupValues[1].replace("_", "").toLong()

    private fun list(name: String): List<String> {
        val body = Regex("""const\s+$name\s*=\s*\[([^\]]*)]""").find(source)!!.groupValues[1]
        return Regex(""""([^"]+)"""").findAll(body).map { it.groupValues[1] }.toList()
    }

    @Test
    fun `timings and limits are the shared ones`() {
        assertEquals(constant("STORY_PHOTO_DISPLAY_MS"), StoriesRules.PHOTO_DISPLAY_MS)
        assertEquals(constant("STORY_CALL_DISPLAY_MS"), StoriesRules.CALL_DISPLAY_MS)
        assertEquals(constant("STORY_MAX_VIDEO_MS"), StoriesRules.MAX_VIDEO_MS)
        assertEquals(constant("STORY_CAPTION_MAX"), StoriesRules.CAPTION_MAX.toLong())
        assertEquals(constant("STORY_TEXT_MAX"), StoriesRules.TEXT_MAX.toLong())
        assertEquals(constant("STORY_REPLY_MAX"), StoriesRules.REPLY_MAX.toLong())
        assertEquals(constant("STORY_IMAGE_MAX_EDGE"), StoriesRules.IMAGE_MAX_EDGE.toLong())
        assertEquals(list("STORY_REACTIONS"), StoriesRules.REACTIONS)
        assertEquals(list("STORY_BACKGROUNDS"), StoriesRules.BACKGROUNDS)
        assertEquals(list("STORY_IMAGE_TYPES"), StoriesRules.IMAGE_TYPES)
    }

    @Test
    fun `POST_STORIES is bit 25, the shared one`() {
        val permissions = RepoSources.read("packages/shared/src/permissions.ts")
        assertTrue(permissions.contains("POST_STORIES: 1n << 25n"))
        assertEquals(1L shl 25, Permission.POST_STORIES)
    }

    // --- clocks ---

    private fun story(kind: String, text: String? = null, duration: Long? = null, sticker: Boolean = false, seen: Boolean = false) =
        Story(
            id = "s",
            author = StoryAuthor("a", "Bia"),
            kind = kind,
            text = text,
            media = if (kind == "text") null else StoryMedia(url = "u", durationMs = duration),
            sticker = if (sticker) StorySticker("call", "srv", "ch") else null,
            viewer = StoryViewerState(seen = seen),
        )

    @Test
    fun `a text card reads 5 s plus 50 ms a character, at most 10 s`() {
        assertEquals(5_000L, StoriesRules.textDisplayMs(""))
        assertEquals(5_500L, StoriesRules.textDisplayMs("1234567890"))
        assertEquals(10_000L, StoriesRules.textDisplayMs("x".repeat(280)))
        // Characters, not UTF-16 units: an emoji is one.
        assertEquals(5_050L, StoriesRules.textDisplayMs("🔥"))
    }

    @Test
    fun `each kind gets its own clock`() {
        assertEquals(5_000L, StoriesRules.displayMs(story("image")))
        assertEquals(12_000L, StoriesRules.displayMs(story("video", duration = 12_000)))
        assertEquals(8_000L, StoriesRules.displayMs(story("text", text = "bora", sticker = true)))
        assertEquals(5_200L, StoriesRules.displayMs(story("text", text = "bora")))
    }

    @Test
    fun `the viewer starts at the first story not seen yet`() {
        assertEquals(1, StoriesRules.startIndex(listOf(story("image", seen = true), story("image"), story("image"))))
        assertEquals(0, StoriesRules.startIndex(listOf(story("image", seen = true), story("image", seen = true))))
    }

    // --- expiry ---

    private val now = Instant.parse("2026-10-12T21:00:00.000Z").toEpochMilli()

    private fun item(id: String, expiresAt: String) =
        StoryStripItem(author = StoryAuthor(id), storyIds = listOf("s-$id"), expiresAt = expiresAt, unseen = true)

    @Test
    fun `an expired ring leaves the strip with no frame, and the timer knows when`() {
        val strip = StoryStrip(
            enabled = true,
            own = item("me", "2026-10-12T20:59:00.000Z"),
            items = listOf(item("a", "2026-10-12T22:00:00.000Z"), item("b", "2026-10-12T20:00:00.000Z")),
        )
        val live = StoriesRules.live(strip, now)
        assertNull(live.own)
        assertEquals(listOf("a"), live.items.map { it.author.id })
        assertEquals(Instant.parse("2026-10-12T22:00:00.000Z").toEpochMilli(), StoriesRules.nextExpiry(strip, now))
    }

    @Test
    fun `ages and what is left read in minutes, then hours`() {
        assertEquals("12 min", StoriesRules.age("2026-10-12T20:48:00.000Z", now))
        assertEquals("2 h", StoriesRules.age("2026-10-12T18:30:00.000Z", now))
        assertEquals("21 h", StoriesRules.left("2026-10-13T18:00:00.000Z", now))
        assertNull(StoriesRules.age(null, now))
    }

    // --- media ---

    @Test
    fun `a photo's long side is capped at 1440 and the aspect kept`() {
        assertEquals(1440 to 1080, StoriesRules.scaledSize(4032, 3024))
        assertEquals(810 to 1440, StoriesRules.scaledSize(2160, 3840))
        assertEquals(800 to 600, StoriesRules.scaledSize(800, 600))
    }

    @Test
    fun `the picker refuses before any byte is uploaded`() {
        assertNull(StoriesRules.checkMedia("image/jpeg", 1_000, null))
        assertNull(StoriesRules.checkMedia("video/mp4", 10_000_000, 30_000))
        assertEquals(StoriesRules.MediaRefusal.TooLong, StoriesRules.checkMedia("video/mp4", 1_000, 30_001))
        assertEquals(StoriesRules.MediaRefusal.TooLong, StoriesRules.checkMedia("video/mp4", 1_000, null))
        assertEquals(StoriesRules.MediaRefusal.TooBig, StoriesRules.checkMedia("video/mp4", 26L * 1024 * 1024, 10_000))
        assertEquals(StoriesRules.MediaRefusal.WrongType, StoriesRules.checkMedia("video/quicktime", 1_000, 10_000))
        assertEquals(StoriesRules.MediaRefusal.WrongType, StoriesRules.checkMedia("image/gif", 1_000, null))
    }

    // --- audience ---

    private val options = StoryAudienceOptions(
        servers = listOf(
            StoryAudienceServer("qg", "QG do pqp", canPost = true),
            StoryAudienceServer("val", "Valorant BR", canPost = false, blockedReason = "no_permission"),
        ),
        friends = StoryAudienceFriends(enabled = true, canPost = true),
    )

    @Test
    fun `the composer starts ticked where the person was`() {
        assertEquals(StoryAudienceTargets(listOf("qg"), friends = false), StoriesRules.defaultAudience(options, "qg", fromFriends = false))
        assertEquals(StoryAudienceTargets(emptyList(), friends = true), StoriesRules.defaultAudience(options, null, fromFriends = true))
    }

    @Test
    fun `a server the person may not post to is never pre-ticked`() {
        assertEquals(StoryAudienceTargets(emptyList(), friends = true), StoriesRules.defaultAudience(options, "val", fromFriends = false))
    }

    @Test
    fun `a call sticker's server is ticked where the person can see it, and locked`() {
        val friendsOnly = StoryAudienceTargets(friends = true)
        // Picking a room in "qg" ticks "qg"; the sheet then shows exactly this.
        assertEquals(
            StoryAudienceTargets(serverIds = listOf("qg"), friends = true),
            StoriesRules.withSticker(friendsOnly, "qg"),
        )
        // Already ticked: nothing changes, no duplicate.
        val ticked = StoryAudienceTargets(serverIds = listOf("qg"))
        assertEquals(ticked, StoriesRules.withSticker(ticked, "qg"))
        // No sticker: the audience is exactly what the person ticked.
        assertEquals(friendsOnly, StoriesRules.withSticker(friendsOnly, null))
        // The call's server cannot be unticked; every other row can.
        assertFalse(StoriesRules.canUntick("qg", stickerServerId = "qg"))
        assertTrue(StoriesRules.canUntick("val", stickerServerId = "qg"))
        assertTrue(StoriesRules.canUntick("qg", stickerServerId = null))
    }

    @Test
    fun `old phones decode a big photo sampled down, and turn it upright`() {
        assertEquals(1, StoriesRules.sampleSize(1080, 1920))
        // A 12 MP phone photo is under twice the story size halved: decoded whole.
        assertEquals(1, StoriesRules.sampleSize(4032, 3024))
        assertEquals(2, StoriesRules.sampleSize(8000, 6000))
        assertEquals(4, StoriesRules.sampleSize(12000, 9000))
        // Never sampled below twice the story size.
        listOf(4032, 8000, 12000).forEach { long ->
            assertTrue(long / StoriesRules.sampleSize(long, long * 3 / 4) >= StoriesRules.IMAGE_MAX_EDGE * 2)
        }
        assertEquals(90, StoriesRules.rotationDegrees(6))
        assertEquals(180, StoriesRules.rotationDegrees(3))
        assertEquals(270, StoriesRules.rotationDegrees(8))
        assertEquals(0, StoriesRules.rotationDegrees(1))
    }

    @Test
    fun `a failed view batch is retried, a few times, then let go`() {
        val views = ViewBatcher(maxBatch = 2, maxAttempts = 3)
        listOf("a", "b", "c").forEach(views::add)
        val first = views.take()
        assertEquals(listOf("a", "b"), first)
        assertEquals(1, views.size)
        // The network ate it: back in the queue, behind what was already there.
        views.failed(first)
        assertEquals(listOf("c", "a"), views.take())
        assertEquals(listOf("b"), views.take())
        // "a" and "b" fail twice more; on the third failure they are dropped.
        views.failed(listOf("a", "b"))
        assertEquals(listOf("a", "b"), views.take())
        views.failed(listOf("a", "b"))
        assertTrue(views.isEmpty)
    }

    @Test
    fun `a success clears the attempt count, and the retry waits a little longer each time`() {
        val views = ViewBatcher(maxBatch = 10, maxAttempts = 2)
        views.add("a")
        views.failed(views.take())
        views.succeeded(views.take())
        // Fresh again: one failure no longer drops it.
        views.add("a")
        views.failed(views.take())
        assertEquals(listOf("a"), views.take())
        assertEquals(2_000L, ViewBatcher.backoffMs(1))
        assertEquals(4_000L, ViewBatcher.backoffMs(2))
        assertEquals(30_000L, ViewBatcher.backoffMs(9))
    }

    @Test
    fun `posting needs an audience, and at most ten servers`() {
        assertFalse(StoriesRules.canPost(StoryAudienceTargets()))
        assertTrue(StoriesRules.canPost(StoryAudienceTargets(friends = true)))
        assertFalse(StoriesRules.canPost(StoryAudienceTargets(serverIds = (1..11).map { "s$it" })))
    }

    // --- wire ---

    @Test
    fun `a story decodes from the server's shape, and an unknown sticker is not a crash`() {
        val story = PqpJson.decodeFromString(
            Story.serializer(),
            """{"id":"6c1e","author":{"id":"a","displayName":"Fê","avatarUrl":null,"handle":null},
               "kind":"text","caption":null,"text":"bora de cs hoje?","background":"night","media":null,
               "sticker":{"type":"call","serverId":"s","channelId":"c"},
               "call":{"serverId":"s","channelId":"c","channelName":"broderagi","participants":[],"count":3,
                       "state":"live","joinable":true},
               "publishedAt":"2026-10-12T20:48:00.000Z","expiresAt":"2026-10-13T20:48:00.000Z",
               "audiences":[{"kind":"server","serverId":"s","serverName":"QG"},{"kind":"friends"}],
               "viewer":{"seen":false,"reaction":null,"canReply":true,"replyBlockedReason":null,
                         "canModerate":[],"canSaveToBau":[]},"own":null}""",
        )
        assertEquals("broderagi", story.call?.channelName)
        assertEquals("friends", story.audiences[1].kind)
        assertTrue(story.viewer.canReply)
    }

    @Test
    fun `a strip whose hasCall arrives as null still decodes, as no call`() {
        // Seen live from the stories server branch: `hasCall: null` where the
        // schema says boolean. Coerced to the default rather than failing the
        // whole strip.
        val strip = PqpJson.decodeFromString(
            StoryStrip.serializer(),
            """{"enabled":true,"canPost":true,"own":null,"items":[{"author":{"id":"a","displayName":"Gabi",
               "avatarUrl":null,"handle":null},"storyIds":["s"],"latestAt":"x","expiresAt":"y",
               "unseen":true,"hasCall":null}],"firstRunHint":false}""",
        )
        assertFalse(strip.items.single().hasCall)
        assertTrue(strip.items.single().unseen)
    }

    @Test
    fun `a story report is the story subject with its server context`() {
        val body = ReportDraft.body(ReportTarget.Story("st", "Bia", "qg"), ReportReason.MinorSexual, "  ")
        assertEquals("story", body.subjectType)
        assertEquals("st", body.storyId)
        assertEquals("qg", body.serverId)
        assertEquals("minor_sexual", body.reason)
        assertNull(body.details)
        val reports = RepoSources.read("packages/shared/src/reports.ts")
        assertTrue(reports.contains("subjectType: z.literal(\"story\")"))
        assertTrue(reports.contains("\"minor_sexual\""))
    }

    @Test
    fun `the phone's story routes still exist on the server`() {
        val api = RepoSources.read("server/src/api/index.ts")
        listOf(
            "\"/api/stories/config\"",
            "\"/api/servers/:serverId/stories\"",
            "\"/api/stories/friends\"",
            "\"/api/stories\"",
            "\"/api/stories/audiences\"",
            "\"/api/stories/:storyId/publish\"",
            "\"/api/stories/views\"",
            "\"/api/stories/:storyId/reaction\"",
            "\"/api/stories/:storyId/reply\"",
            "\"/api/stories/:storyId/viewers\"",
            "\"/api/stories/:storyId/card\"",
            "\"/api/stories/mutes/:userId\"",
            "\"/api/stories/notices\"",
            "\"/api/servers/:serverId/stories/:storyId\"",
        ).forEach { route -> assertTrue("missing $route", api.contains(route)) }
    }

    @Test
    fun `a notice is asked again only after the spacing`() {
        assertTrue(StoriesRules.noticeAskDue(0L, 1_000_000L))
        assertFalse(StoriesRules.noticeAskDue(1_000_000L, 1_000_000L + StoriesRules.NOTICE_REASK_MS - 1))
        assertTrue(StoriesRules.noticeAskDue(1_000_000L, 1_000_000L + StoriesRules.NOTICE_REASK_MS))
    }

    @Test
    fun `the story clock runs in real time whatever the animator scale says`() {
        val viewer = RepoSources.stripComments(
            RepoSources.read("android/app/src/main/kotlin/gg/pqp/app/stories/ui/StoryViewer.kt"),
        )
        assertTrue(
            "The progress clock must not be scaled by Remove animations (spec 15)",
            viewer.contains("withContext(RealTimeClock) { progress.animateTo(1f"),
        )
    }
}
