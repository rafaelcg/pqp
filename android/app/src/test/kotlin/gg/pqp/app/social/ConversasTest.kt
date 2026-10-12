package gg.pqp.app.social

import com.sun.net.httpserver.HttpServer
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.TokenProvider
import gg.pqp.app.protocol.RepoSources
import java.net.InetSocketAddress
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.descriptors.elementNames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Conversas on Android: the list rules, list typing, and the config switch. */
class ConversasTest {

    private fun person(id: String, name: String, username: String? = null) =
        PublicUser(id = id, displayName = name, username = username)

    private fun dm(
        id: String,
        vararg people: PublicUser,
        unread: Int = 0,
        kind: String = if (people.size > 1) "group" else "dm",
    ) = DmSummary(channelId = id, kind = kind, participants = people.toList(), unread = UnreadCounts(unread))

    private val joao = person("u1", "João Pedro", "jp")
    private val gabi = person("u2", "Gabi")
    private val caio = person("u3", "Caio")

    private val list = listOf(
        dm("c1", joao, unread = 3),
        dm("c2", gabi),
        dm("c3", caio, gabi, unread = 1),
    )

    // --- landing ---

    @Test
    fun `an account that never chose opens on Servidores`() {
        assertEquals(PhoneTab.Servidores, ConversationList.landingTab(null))
        assertEquals(PhoneTab.Servidores, ConversationList.landingTab("Messages"))
    }

    @Test
    fun `the last tab used is where the app opens`() {
        assertEquals(PhoneTab.Conversas, ConversationList.landingTab("Conversas"))
        assertEquals(PhoneTab.Tu, ConversationList.landingTab("Tu"))
    }

    // --- search and chips ---

    @Test
    fun `search folds accents and case and reads usernames`() {
        assertEquals("joao pedro", ConversationList.foldForSearch("  João Pedro "))
        assertTrue(ConversationList.matches(list[0], "joao"))
        assertTrue(ConversationList.matches(list[0], "JP"))
        assertFalse(ConversationList.matches(list[1], "joao"))
        assertTrue(ConversationList.matches(list[1], ""))
    }

    @Test
    fun `the chips filter over the list in memory`() {
        assertEquals(listOf("c1", "c3"), ConversationList.filter(list, "", ConversationFilter.Unread).map { it.channelId })
        assertEquals(listOf("c3"), ConversationList.filter(list, "", ConversationFilter.Groups).map { it.channelId })
        assertEquals(listOf("c2", "c3"), ConversationList.filter(list, "gabi", ConversationFilter.All).map { it.channelId })
    }

    @Test
    fun `the tab badge counts conversations, not messages`() {
        assertEquals(2, ConversationList.waiting(list))
    }

    @Test
    fun `a count past 99 reads 99+, which the server's cap of 100 makes honest`() {
        assertNull(ConversationList.countLabel(0))
        assertEquals("7", ConversationList.countLabel(7))
        assertEquals("99", ConversationList.countLabel(99))
        assertEquals("99+", ConversationList.countLabel(100))
    }

    // --- preview line ---

    private val words = ConversationList.PreviewWords(
        you = { "tu: $it" },
        groupAuthor = { name, text -> "$name: $text" },
        voice = { "Mensagem de voz · $it" },
        gif = "Enviou um GIF",
        attachment = "Enviou um arquivo",
        nudgeSent = "Tu chamou a atenção 📳",
        nudgeReceived = "Chamou tua atenção! 📳",
    )

    private fun preview(
        author: String = "u1",
        name: String = "João Pedro",
        text: String = "bora jogar?",
        isAttachment: Boolean = false,
        isGif: Boolean = false,
        isVoice: Boolean? = null,
        voiceMs: Long? = null,
        systemKind: String? = null,
    ) = LastMessagePreview(author, name, text, isAttachment, isGif, isVoice, voiceMs, systemKind)

    @Test
    fun `a 1to1 from the other person has no prefix`() {
        assertEquals("bora jogar?", ConversationList.previewLine(preview(), "me", false, words))
    }

    @Test
    fun `my own message says tu`() {
        assertEquals("tu: bora jogar?", ConversationList.previewLine(preview(author = "me"), "me", false, words))
    }

    @Test
    fun `a group names the author by first name`() {
        assertEquals("João: bora jogar?", ConversationList.previewLine(preview(), "me", true, words))
    }

    @Test
    fun `attachments, gifs and voice notes read as labels`() {
        assertEquals("Enviou um arquivo", ConversationList.previewLine(preview(text = "", isAttachment = true), "me", false, words))
        assertEquals("Enviou um GIF", ConversationList.previewLine(preview(text = "", isAttachment = true, isGif = true), "me", false, words))
        assertEquals(
            "tu: Mensagem de voz · 0:12",
            ConversationList.previewLine(
                preview(author = "me", text = "", isAttachment = true, isVoice = true, voiceMs = 12_300),
                "me",
                false,
                words,
            ),
        )
        // A live frame carries an empty preview for an attachment and no flags.
        assertEquals("Enviou um arquivo", ConversationList.previewLine(preview(text = ""), "me", false, words))
    }

    @Test
    fun `a nudge row says what happened, never the bare glyph`() {
        val theirs = preview(text = "📳", systemKind = "nudge")
        assertEquals("Chamou tua atenção! 📳", ConversationList.previewLine(theirs, "me", false, words))
        // Mine: the sentence says who, so no "tu:" in front of it.
        val mine = preview(author = "me", text = "📳", systemKind = "nudge")
        assertEquals("Tu chamou a atenção 📳", ConversationList.previewLine(mine, "me", false, words))
        // A row from a server older than nudges has no kind: the body is all there is.
        assertEquals("📳", ConversationList.previewLine(preview(text = "📳"), "me", false, words))
    }

    @Test
    fun `a live nudge frame keeps its kind on the row`() {
        assertEquals(
            "nudge",
            SocialRepository.livePreview(preview = "📳", authorId = "u1", authorName = "Gabi", systemKind = "nudge")?.systemKind,
        )
        assertNull(SocialRepository.livePreview(preview = "oi", authorId = "u1", authorName = "Gabi")?.systemKind)
        // A kind this build does not name is an ordinary message.
        assertNull(SocialRepository.livePreview(preview = "x", authorId = "u1", authorName = "Gabi", systemKind = "wink")?.systemKind)
    }

    @Test
    fun `a listed nudge decodes its kind and an old row has none`() {
        val nudge = PqpJson.decodeFromString(
            DmSummary.serializer(),
            """{"channelId":"c","kind":"dm","participants":[],"lastMessageAt":null,
               "unread":{"count":1,"mentions":0},
               "lastMessage":{"authorId":"a","authorName":"Gabi","preview":"📳","isAttachment":false,
               "isGif":false,"systemKind":"nudge"}}""",
        )
        assertEquals("nudge", nudge.lastMessage?.systemKind)
        val plain = PqpJson.decodeFromString(
            DmSummary.serializer(),
            """{"channelId":"c","kind":"dm","participants":[],"lastMessageAt":null,
               "unread":{"count":0,"mentions":0},
               "lastMessage":{"authorId":"a","preview":"oi","systemKind":null}}""",
        )
        assertNull(plain.lastMessage?.systemKind)
    }

    @Test
    fun `a live frame without a preview clears the row's line instead of keeping the old one`() {
        // Previews off: the server omits the text, and the stale line must not
        // stay on screen as if it were the latest message.
        assertNull(SocialRepository.livePreview(preview = null, authorId = "u1", authorName = "Gabi"))
        assertNull(SocialRepository.livePreview(preview = "oi", authorId = null, authorName = null))
        val live = SocialRepository.livePreview(preview = "oi", authorId = "u1", authorName = "Gabi")
        assertEquals("oi", live?.preview)
        assertFalse(live!!.isAttachment)
        assertTrue(SocialRepository.livePreview(preview = "", authorId = "u1", authorName = "Gabi")!!.isAttachment)
    }

    @Test
    fun `note durations read as minutes and seconds`() {
        assertEquals("0:00", ConversationList.noteDuration(0))
        assertEquals("1:05", ConversationList.noteDuration(65_000))
    }

    // --- time ---

    @Test
    fun `row time is the clock today, ontem, a weekday, then a date`() {
        val zone = ZoneId.of("America/Sao_Paulo")
        val now = ZonedDateTime.of(2026, 10, 12, 21, 0, 0, 0, zone) // a Monday
        val pt = Locale.forLanguageTag("pt-BR")
        fun at(day: Int, hour: Int) =
            ZonedDateTime.of(2026, 10, day, hour, 41, 0, 0, zone).toInstant().toString()
        assertEquals("20:41", ConversationList.listTime(at(12, 20), now, pt, "ontem"))
        assertEquals("ontem", ConversationList.listTime(at(11, 20), now, pt, "ontem"))
        assertEquals("sex", ConversationList.listTime(at(9, 20), now, pt, "ontem"))
        assertTrue(ConversationList.listTime(at(1, 20), now, pt, "ontem")!!.startsWith("1 out"))
        assertNull(ConversationList.listTime(null, now, pt, "ontem"))
    }

    // --- typing in the list ---

    @Test
    fun `a typist shows, then expires after five seconds`() {
        val typing = ListTyping()
        assertTrue(typing.note("c1", "u1", "Gabi", now = 1_000))
        assertEquals(mapOf("c1" to listOf("Gabi")), typing.snapshot(1_000))
        assertEquals(6_000L, typing.nextExpiry())
        assertEquals(emptyMap<String, List<String>>(), typing.snapshot(6_000))
        assertNull(typing.nextExpiry())
    }

    @Test
    fun `a typist who keeps typing only pushes their expiry out`() {
        val typing = ListTyping()
        typing.note("c1", "u1", "Gabi", now = 1_000)
        assertFalse(typing.note("c1", "u1", "Gabi", now = 3_000))
        assertEquals(8_000L, typing.nextExpiry())
        assertEquals(mapOf("c1" to listOf("Gabi")), typing.snapshot(7_000))
    }

    @Test
    fun `their next message clears them at once`() {
        val typing = ListTyping()
        typing.note("c1", "u1", "Gabi", now = 1_000)
        typing.note("c1", "u2", "Caio", now = 1_000)
        assertTrue(typing.clear("c1", "u1"))
        assertFalse(typing.clear("c1", "u1"))
        assertEquals(mapOf("c1" to listOf("Caio")), typing.snapshot(1_500))
    }

    // --- config ---

    @Test
    fun `phone tabs without home is never drawn`() {
        assertEquals(DmsConfig(), ConversasHome.normalized(DmsConfig(home = false, phoneTabs = true)))
        assertEquals(DmsConfig(true, true), ConversasHome.normalized(DmsConfig(true, true)))
    }

    private fun withServer(status: Int, body: String, block: suspend (ApiClient) -> Unit) = runTest {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val api = ApiClient(
                TokenProvider { "t" },
                ApiClient.defaultHttpClient(),
                PqpJson,
                "http://127.0.0.1:${server.address.port}",
            )
            block(api)
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `the config route answers both switches`() = withServer(200, """{"home":true,"phoneTabs":true}""") { api ->
        assertEquals(DmsConfig(true, true), ConversasHome.fetch(api))
    }

    @Test
    fun `a server that predates the route is the old app`() = withServer(404, """{"error":"Not found"}""") { api ->
        assertEquals(DmsConfig(), ConversasHome.fetch(api))
    }

    @Test
    fun `a failed read keeps what is on screen`() = withServer(500, """{"error":"boom"}""") { api ->
        assertNull(ConversasHome.fetch(api))
    }

    // --- wire shapes ---

    @Test
    fun `a summary decodes with and without the preview`() {
        val with = PqpJson.decodeFromString(
            DmSummary.serializer(),
            """{"channelId":"c","kind":"dm","participants":[],"lastMessageAt":null,
               "unread":{"count":100,"mentions":0},
               "lastMessage":{"authorId":"a","authorName":"Gabi","preview":"oi","isAttachment":false,
               "isGif":false,"isVoice":false,"voiceDurationMs":null}}""",
        )
        assertEquals("oi", with.lastMessage?.preview)
        assertEquals(100, with.unread.count)
        val without = PqpJson.decodeFromString(
            DmSummary.serializer(),
            """{"channelId":"c","kind":"dm","participants":[],"lastMessageAt":null,"unread":{"count":0,"mentions":0}}""",
        )
        assertNull(without.lastMessage)
    }

    @Test
    fun `every field this client reads is on the shared dm summary`() {
        val schema = RepoSources.objectKeys("packages/shared/src/dm.ts", "dmSummarySchema").toSet()
        assertEquals(emptySet<String>(), DmSummary.serializer().descriptor.elementNames.toSet() - schema)
        val source = RepoSources.stripComments(RepoSources.read("packages/shared/src/dm.ts"))
        LastMessagePreview.serializer().descriptor.elementNames.forEach { key ->
            assertTrue("lastMessage.$key is not in dm.ts", Regex("""\b$key\s*:""").containsMatchIn(source))
        }
    }

    @Test
    fun `the config route still answers home and phoneTabs`() {
        val source = RepoSources.read("server/src/api/index.ts")
        val route = source.substringAfter("router.get(\"/api/dms/config\"").substringBefore("});")
        DmsConfig.serializer().descriptor.elementNames.forEach { key ->
            assertTrue("GET /api/dms/config no longer sends $key", route.contains(key))
        }
    }
}
