package gg.pqp.app.bau

import gg.pqp.app.core.PqpJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the Baú looks like on the wire, decoded the way the app decodes it.
 *
 * The locked case is the one worth pinning: the API strips body, media and
 * the comment words for a member without the cargo, and the card has to
 * render the lock from what is *absent* rather than from any flag it could
 * be tempted to trust on its own.
 */
class BauModelsTest {

    private val author = """
        {"id":"33333333-3333-3333-3333-333333333333","displayName":"Rafa",
         "username":"rafa","tag":"rafa#0001","avatarUrl":null}
    """.trimIndent()

    private fun post(extra: String) = """
        {
          "id": "11111111-1111-1111-1111-111111111111",
          "serverId": "22222222-2222-2222-2222-222222222222",
          "author": $author,
          "authorBadge": "owner",
          "title": "Clipe da sessão",
          "visibility": "members",
          "status": "published",
          "commentsEnabled": true,
          "likeCount": 3,
          "likedByMe": false,
          "commentCount": 5,
          "scheduledAt": null,
          "scheduleTimezone": null,
          "publishedAt": "2026-08-30T20:00:00.000Z",
          "createdAt": "2026-08-30T19:00:00.000Z",
          "updatedAt": "2026-08-30T19:00:00.000Z",
          $extra
        }
    """.trimIndent()

    @Test
    fun `a locked post arrives with no body, no media and no comment words`() {
        val locked = PqpJson.decodeFromString(
            BauPost.serializer(),
            post(""""body": null, "teaser": "Só pra VIP", "media": null, "locked": true, "commentTeaser": []"""),
        )
        assertTrue(locked.locked)
        assertNull(locked.body)
        assertNull(locked.media)
        assertEquals("Só pra VIP", locked.teaser)
        assertTrue(locked.isMembersOnly)
        // The count survives the lock; the words do not.
        assertEquals(5, locked.commentCount)
        assertTrue(locked.commentTeaser.isEmpty())
        assertEquals("2026-08-30T20:00:00.000Z", locked.shownAt)
    }

    @Test
    fun `an unlocked post carries its media and the two newest comments`() {
        val open = PqpJson.decodeFromString(
            BauPost.serializer(),
            post(
                """
                "body": "Olha isso",
                "teaser": null,
                "locked": false,
                "media": {"kind":"file","name":"regras.pdf","contentType":"application/pdf",
                          "byteSize":120000,"url":"https://storage.example/regras.pdf","youtubeUrl":null},
                "commentTeaser": [
                  {"id":"44444444-4444-4444-4444-444444444444","author":$author,"body":"top","createdAt":"2026-08-30T21:00:00.000Z"},
                  {"id":"55555555-5555-5555-5555-555555555555","author":$author,"body":"demais","createdAt":"2026-08-30T22:00:00.000Z"}
                ]
                """.trimIndent(),
            ),
        )
        assertFalse(open.locked)
        assertEquals("Olha isso", open.body)
        assertEquals(2, open.commentTeaser.size)
        val media = open.media!!
        assertTrue(media.isFile)
        assertEquals("https://storage.example/regras.pdf", media.openUrl)
        assertEquals(120000L, media.byteSize)
    }

    @Test
    fun `YouTube media opens the watch page rather than a storage URL`() {
        val media = PqpJson.decodeFromString(
            BauMedia.serializer(),
            """{"kind":"youtube","name":"","contentType":null,"byteSize":null,"url":null,
                "youtubeUrl":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}""",
        )
        assertTrue(media.isYoutube)
        assertEquals("https://www.youtube.com/watch?v=dQw4w9WgXcQ", media.openUrl)
        assertEquals("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", YoutubeLinks.thumbnailUrl(media.youtubeUrl))
    }

    @Test
    fun `a post the server has grown fields on still decodes`() {
        val grown = PqpJson.decodeFromString(
            BauPost.serializer(),
            post(""""body": "x", "locked": false, "media": null, "commentTeaser": [], "pollId": "abc""""),
        )
        assertEquals("x", grown.body)
    }

    @Test
    fun `the config reads as off when a field is missing`() {
        val config = PqpJson.decodeFromString(CommunityHomeConfig.serializer(), """{"enabled": true}""")
        assertTrue(config.enabled)
        assertFalse(config.vipEnabled)
        assertFalse(config.mediaEnabled)
        assertFalse(PqpJson.decodeFromString(CommunityHomeConfig.serializer(), "{}").enabled)
    }
}

/** A port of `parseYoutubeVideoId` in `packages/shared/src/community-home.ts`. */
class YoutubeLinksTest {

    @Test
    fun `every shape the shared parser accepts`() {
        val id = "dQw4w9WgXcQ"
        listOf(
            "https://www.youtube.com/watch?v=$id",
            "https://youtube.com/watch?v=$id&t=42",
            "https://m.youtube.com/watch?v=$id",
            "https://music.youtube.com/watch?v=$id",
            "https://youtu.be/$id",
            "https://youtu.be/$id?si=abc",
            "https://www.youtube.com/shorts/$id",
            "https://www.youtube.com/embed/$id",
            "https://www.youtube.com/live/$id",
            "  https://youtu.be/$id  ",
        ).forEach { url -> assertEquals(url, id, YoutubeLinks.videoId(url)) }
    }

    @Test
    fun `everything else is not a video`() {
        listOf(
            "",
            "   ",
            "not a url",
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/channel/dQw4w9WgXcQ",
            "https://youtu.be/",
            "https://www.youtube.com/watch",
        ).forEach { url -> assertNull(url, YoutubeLinks.videoId(url)) }
        assertNull(YoutubeLinks.videoId(null))
        assertNull(YoutubeLinks.thumbnailUrl("https://example.com"))
    }
}
