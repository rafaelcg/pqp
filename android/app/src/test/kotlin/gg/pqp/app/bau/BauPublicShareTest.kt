package gg.pqp.app.bau

import gg.pqp.app.core.PqpJson
import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Compartilhar on a public Baú post: the campaign on the link, who gets the
 * control, and `publicUrl` on the wire. The Kotlin twin of the `bauShareUrl`
 * cases in `packages/shared/src/community-home-public.test.ts`, for the
 * `native` source the phone's share sheet uses.
 */
class BauPublicShareTest {

    private val postId = "aa11bb22-cc33-4dd4-8ee5-ff6677889900"
    private val serverId = "0f5b7a3e-1c2d-4e8f-9a0b-1234567890ab"
    private val url = "https://pqp.gg/c/mesa-da-tues/p/$postId"

    private fun params(link: String): List<Pair<String, String>> =
        URI(link).rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }.map {
            it.substringBefore('=') to it.substringAfter('=', "")
        }

    // ---- withCampaign

    @Test
    fun `a bare link gets the native campaign`() {
        assertEquals(
            "$url?utm_source=native&utm_medium=share&utm_campaign=bau",
            BauPublicShare.withCampaign(url),
        )
    }

    @Test
    fun `an existing campaign is replaced, never stacked`() {
        val shared = BauPublicShare.withCampaign(
            "$url?utm_source=x&keep=1&utm_medium=social&utm_content=hero&utm_campaign=old",
        )
        val all = params(shared)
        assertEquals(listOf("native"), all.filter { it.first == "utm_source" }.map { it.second })
        assertEquals(listOf("share"), all.filter { it.first == "utm_medium" }.map { it.second })
        assertEquals(listOf("bau"), all.filter { it.first == "utm_campaign" }.map { it.second })
        // A stale utm_* from another campaign would misattribute the signup.
        assertEquals(emptyList<String>(), all.filter { it.first == "utm_content" }.map { it.second })
        assertEquals(listOf("1"), all.filter { it.first == "keep" }.map { it.second })
        assertEquals(url, shared.substringBefore('?'))
    }

    @Test
    fun `sharing twice yields the same link`() {
        val once = BauPublicShare.withCampaign(url)
        assertEquals(once, BauPublicShare.withCampaign(once))
    }

    @Test
    fun `a fragment and other parameters survive untouched`() {
        assertEquals(
            "$url?a=%20b&utm_source=native&utm_medium=share&utm_campaign=bau#comentarios",
            BauPublicShare.withCampaign("$url?a=%20b#comentarios"),
        )
        assertEquals(
            "$url?utm_source=native&utm_medium=share&utm_campaign=bau",
            BauPublicShare.withCampaign(" $url? "),
        )
    }

    @Test
    fun `parameter names are matched case-insensitively`() {
        val shared = BauPublicShare.withCampaign("$url?UTM_SOURCE=x")
        assertEquals(
            listOf("utm_source", "utm_medium", "utm_campaign"),
            params(shared).map { it.first },
        )
    }

    // ---- who gets the control

    private fun post(
        publicUrl: String?,
        locked: Boolean = false,
        status: String = "published",
    ) = BauPost(
        id = postId,
        serverId = serverId,
        author = PqpJson.decodeFromString(
            gg.pqp.app.social.PublicUser.serializer(),
            """{"id":"$serverId","displayName":"Rafa","username":"rafa","tag":"rafa#0001","avatarUrl":null}""",
        ),
        status = status,
        locked = locked,
        createdAt = "2026-10-15T10:00:00.000Z",
        publicUrl = publicUrl,
    )

    @Test
    fun `only a published, unlocked post with a public page is shareable`() {
        assertEquals(url, BauPublicShare.shareableUrl(post(url)))
        assertEquals(url, BauPublicShare.shareableUrl(post("  $url  ")))
        assertNull(BauPublicShare.shareableUrl(post(null)))
        assertNull(BauPublicShare.shareableUrl(post("   ")))
        assertNull(BauPublicShare.shareableUrl(post(url, locked = true)))
        assertNull(BauPublicShare.shareableUrl(post(url, status = "draft")))
        assertNull(BauPublicShare.shareableUrl(post(url, status = "scheduled")))
    }

    // ---- publicUrl on the wire

    private fun postJson(extra: String) = """
        {"id":"$postId","serverId":"$serverId",
         "author":{"id":"$serverId","displayName":"Rafa","username":"rafa","tag":"rafa#0001","avatarUrl":null},
         "title":"Patch","body":"texto","visibility":"free","status":"published","locked":false,
         "likeCount":0,"commentCount":0,"createdAt":"2026-10-15T10:00:00.000Z"$extra}
    """.trimIndent()

    @Test
    fun `a post decodes publicUrl when present, null, or absent`() {
        val present = PqpJson.decodeFromString(BauPost.serializer(), postJson(""","publicUrl":"$url""""))
        assertEquals(url, present.publicUrl)
        val explicitNull = PqpJson.decodeFromString(BauPost.serializer(), postJson(""","publicUrl":null"""))
        assertNull(explicitNull.publicUrl)
        // An older API never sends the field.
        val absent = PqpJson.decodeFromString(BauPost.serializer(), postJson(""))
        assertNull(absent.publicUrl)
        assertNull(BauPublicShare.shareableUrl(absent))
    }

    private fun cardJson(extra: String) = """
        {"card":{"postId":"$postId","serverId":"$serverId","serverName":"Mesa","title":"Patch",
         "visibility":"public","locked":false,"pinned":false,"likeCount":0,"commentCount":0,
         "publishedAt":null$extra}}
    """.trimIndent()

    @Test
    fun `a chat card decodes publicUrl when present, null, or absent`() {
        fun decode(extra: String) = PqpJson.decodeFromString(BauCardResponse.serializer(), cardJson(extra)).card
        assertEquals(url, decode(""","publicUrl":"$url"""").publicUrl)
        assertNull(decode(""","publicUrl":null""").publicUrl)
        assertNull(decode("").publicUrl)
    }
}
