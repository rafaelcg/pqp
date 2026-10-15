package gg.pqp.app.forward

import gg.pqp.app.core.Message
import gg.pqp.app.core.MessagesResponse
import gg.pqp.app.core.PqpJson
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reading `forward` off a message, and the fallback line the server writes for
 * a client with no card. The Kotlin twin of `packages/shared/src/forward.test.ts`.
 */
class ForwardModelsTest {

    private val server = "11111111-1111-4111-8111-111111111111"
    private val source = "22222222-2222-4222-8222-222222222222"
    private val url = "https://pqp.gg/app/server/$server/bau/$source"

    private fun card(extra: String = ""): String = """
        {"v":1,"kind":"bau_post","sourceServerId":"$server","sourceServerName":"QG",
         "sourceServerIconUrl":"/api/servers/$server/icon?v=ab12","sourceId":"$source",
         "title":"Sessao 11","excerpt":"o clip inteiro","mediaKind":"youtube",
         "mediaThumbUrl":"https://i.ytimg.com/vi/x/hqdefault.jpg","url":"$url",
         "createdAt":"2026-10-15T12:00:00.000Z"$extra}
    """.trimIndent()

    private fun message(forward: String?, body: String = "olha isso"): String {
        val field = if (forward == null) "" else ""","forward":$forward"""
        return """
            {"id":"m1","channelId":"c1","authorId":"u1","authorName":"Ana",
             "body":${Json.encodeToString(kotlinx.serialization.serializer<String>(), body)},
             "createdAt":"2026-10-15T12:00:00.000Z"$field}
        """.trimIndent()
    }

    private fun decode(json: String): Message = PqpJson.decodeFromString(Message.serializer(), json)

    // ---- the contract shape

    @Test
    fun `a Bau post card decodes with every field`() {
        val forward = decode(message(card())).forward
        assertNotNull(forward)
        forward!!
        assertEquals(FORWARD_KIND_BAU_POST, forward.kind)
        assertTrue(forward.isBauPost)
        assertEquals("QG", forward.sourceServerName)
        assertEquals("/api/servers/$server/icon?v=ab12", forward.sourceServerIconUrl)
        assertEquals("Sessao 11", forward.title)
        assertEquals("youtube", forward.mediaKind)
        assertEquals(url, forward.url)
        assertFalse(forward.restricted)
    }

    @Test
    fun `a message card carries its channel and author and may be restricted`() {
        val json = """
            {"v":1,"kind":"message","sourceServerId":"$server","sourceServerName":"QG",
             "sourceChannelName":"geral","sourceId":"$source","authorDisplayName":"Rafa",
             "excerpt":"bora jogar","url":"https://pqp.gg/app/server/$server/channel/c/message/$source",
             "createdAt":"2026-10-15T12:00:00.000Z","restricted":true}
        """.trimIndent()
        val forward = decode(message(json)).forward!!
        assertTrue(forward.isMessage)
        assertEquals("geral", forward.sourceChannelName)
        assertEquals("Rafa", forward.authorDisplayName)
        assertTrue(forward.restricted)
        assertNull(forward.title)
        assertNull(forward.mediaThumbUrl)
    }

    @Test
    fun `a restricted card names the one server it may go to`() {
        val other = "33333333-3333-4333-8333-333333333333"
        val named = decode(message(card(",\"restricted\":true,\"restrictedToServerId\":\"$other\""))).forward!!
        assertEquals(other, named.restrictedToServerId)
        assertEquals(other, named.restrictedBoundary)
        // From an older build, restricted with no server named: the source's own.
        assertEquals(server, decode(message(card(",\"restricted\":true"))).forward!!.restrictedBoundary)
        // Not restricted: no boundary, whatever else it carries.
        assertNull(decode(message(card(",\"restrictedToServerId\":\"$other\""))).forward!!.restrictedBoundary)
        assertNull(decode(message(card())).forward!!.restrictedBoundary)
    }

    @Test
    fun `mediaKind can be set with no thumbnail`() {
        val forward = decode(message(card().replace(Regex(""",\s*"mediaThumbUrl":"[^"]*""""), ""))).forward!!
        assertEquals("youtube", forward.mediaKind)
        assertNull(forward.mediaThumbUrl)
    }

    // ---- .catch(null): a bad snapshot is an ordinary message, never a failed page

    @Test
    fun `an ordinary message has no forward`() {
        assertNull(decode(message(null)).forward)
    }

    @Test
    fun `a json null is no forward`() {
        assertNull(decode(message("null")).forward)
    }

    @Test
    fun `a version this build does not know reads as an ordinary message`() {
        val message = decode(message(card().replace("\"v\":1", "\"v\":2")))
        assertNull(message.forward)
        assertEquals("olha isso", message.body)
    }

    @Test
    fun `a kind this build does not know reads as an ordinary message`() {
        assertNull(decode(message(card().replace("bau_post", "story"))).forward)
    }

    @Test
    fun `a snapshot missing a required key reads as an ordinary message`() {
        assertNull(decode(message(card().replace(Regex("\"url\":\"[^\"]*\","), ""))).forward)
        assertNull(decode(message(card().replace(Regex("\"sourceServerId\":\"[^\"]*\","), ""))).forward)
    }

    @Test
    fun `a value of the wrong type reads as an ordinary message`() {
        assertNull(decode(message("\"nope\"")).forward)
        assertNull(decode(message("[1,2]")).forward)
        assertNull(decode(message(card().replace("\"v\":1", "\"v\":\"one\""))).forward)
    }

    @Test
    fun `one bad snapshot never fails the page around it`() {
        val page = """
            {"messages":[${message(card())},${message("{\"v\":9}")},${message(null)}],"hasMore":false}
        """.trimIndent()
        val decoded = PqpJson.decodeFromString(MessagesResponse.serializer(), page)
        assertEquals(3, decoded.messages.size)
        assertNotNull(decoded.messages[0].forward)
        assertNull(decoded.messages[1].forward)
        assertNull(decoded.messages[2].forward)
    }

    @Test
    fun `an unknown extra key inside the snapshot is ignored`() {
        val forward = decode(message(card(",\"somethingNew\":{\"a\":1}"))).forward
        assertNotNull(forward)
    }

    // ---- the fallback body, byte for byte what the server stores

    private fun snapshot(title: String? = "Sessao 11", excerpt: String = "o clip", name: String = "QG") =
        MessageForward(
            v = 1, kind = FORWARD_KIND_BAU_POST, sourceServerId = server, sourceServerName = name,
            sourceId = source, title = title, excerpt = excerpt, url = url,
        )

    @Test
    fun `the fallback is Encaminhado, the title and the url`() {
        assertEquals("Encaminhado: Sessao 11 $url", forwardFallbackBody(snapshot()))
    }

    @Test
    fun `the fallback falls back to the excerpt and then the server name`() {
        assertEquals("Encaminhado: o clip inteiro $url", forwardFallbackBody(snapshot(title = null, excerpt = " o clip\ninteiro ")))
        assertEquals("Encaminhado: o clip $url", forwardFallbackBody(snapshot(title = "   ")))
        assertEquals("Encaminhado: QG $url", forwardFallbackBody(snapshot(title = null, excerpt = "   ")))
    }

    @Test
    fun `the fallback collapses every kind of whitespace the server collapses`() {
        assertEquals(
            "Encaminhado: Sessao 11 final $url",
            forwardFallbackBody(snapshot(title = "  Sessao \n\n  11 final  ")),
        )
    }

    @Test
    fun `the fallback is cut at 140 characters with three dots`() {
        val expected = "Encaminhado: " + "a".repeat(137) + "... " + url
        assertEquals(expected, forwardFallbackBody(snapshot(title = "a".repeat(300))))
        // Exactly 140 is not cut.
        assertEquals("Encaminhado: " + "a".repeat(140) + " " + url, forwardFallbackBody(snapshot(title = "a".repeat(140))))
    }

    @Test
    fun `the cut drops a space it lands on before the dots`() {
        val title = "b".repeat(136) + "   " + "c".repeat(20)
        assertEquals("Encaminhado: " + "b".repeat(136) + "... " + url, forwardFallbackBody(snapshot(title = title)))
    }

    @Test
    fun `the cut counts characters the way the server does`() {
        val expected = "Encaminhado: " + "ç".repeat(137) + "... " + url
        assertEquals(expected, forwardFallbackBody(snapshot(title = "ç".repeat(150))))
    }

    @Test
    fun `the fallback is recognised, but a comment that merely resembles it is not`() {
        val forward = snapshot()
        assertTrue(isFallbackBody(forwardFallbackBody(forward), forward))
        assertFalse(isFallbackBody("Encaminhado: Sessao 11", forward))
        assertFalse(isFallbackBody("Encaminhado: Sessao 11 $url e mais", forward))
        assertFalse(isFallbackBody("olha isso", forward))
        assertFalse(isFallbackBody("", forward))
    }

    @Test
    fun `the comment above a card is the body unless it is the fallback`() {
        val forward = snapshot()
        assertEquals("", forwarderComment(forwardFallbackBody(forward), forward))
        assertEquals("olha isso", forwarderComment("olha isso", forward))
        assertEquals("Encaminhado: coisa minha", forwarderComment("Encaminhado: coisa minha", forward))
        // No forward: the body is the body.
        assertEquals("oi", forwarderComment("oi", null))
    }

    // ---- the request

    @Test
    fun `a request leaves out what is not set`() {
        val request = CreateForwardRequest(
            source = ForwardSource(FORWARD_KIND_BAU_POST, source, serverId = server),
            targets = listOf(ForwardTargetRef(channelId = "c1"), ForwardTargetRef(userId = "u1")),
            comment = null,
            nonce = "n1",
        )
        val json = PqpJson.encodeToString(CreateForwardRequest.serializer(), request)
        assertEquals(
            """{"source":{"kind":"bau_post","id":"$source","serverId":"$server"},""" +
                """"targets":[{"channelId":"c1"},{"userId":"u1"}],"nonce":"n1"}""",
            json,
        )
        assertFalse(json.contains("null"))
    }

    @Test
    fun `a message source carries no server id`() {
        val json = PqpJson.encodeToString(
            CreateForwardRequest.serializer(),
            CreateForwardRequest(
                source = ForwardSource(FORWARD_KIND_MESSAGE, source),
                targets = listOf(ForwardTargetRef(channelId = "c1")),
                comment = "olha",
            ),
        )
        assertFalse(json.contains("serverId"))
        assertTrue(json.contains("\"comment\":\"olha\""))
    }

    @Test
    fun `a response keeps who took it and why the rest did not`() {
        val response = PqpJson.decodeFromString(
            CreateForwardResponse.serializer(),
            """
            {"results":[
              {"ok":true,"target":{"channelId":"c1"},"channelId":"c1","serverId":"$server","message":{"id":"m"}},
              {"ok":true,"target":{"userId":"u1"},"channelId":"dm1","serverId":null,"message":{"id":"m2"}},
              {"ok":false,"target":{"channelId":"c2"},"reason":"slow_mode","retryAfterMs":1200}
            ]}
            """.trimIndent(),
        )
        assertEquals(3, response.results.size)
        assertTrue(response.results[0].ok)
        assertNull(response.results[1].serverId)
        assertEquals("dm1", response.results[1].channelId)
        assertEquals("slow_mode", response.results[2].reason)
        assertEquals(1200L, response.results[2].retryAfterMs)
    }
}
