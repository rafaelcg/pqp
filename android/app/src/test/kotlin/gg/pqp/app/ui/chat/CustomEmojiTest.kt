package gg.pqp.app.ui.chat

import gg.pqp.app.core.CustomEmoji
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.ServerEmoji
import gg.pqp.app.core.ServerEmojiList
import gg.pqp.app.core.ServerEmojiStore
import gg.pqp.app.protocol.RepoSources
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun emoji(vararg names: String) =
    ServerEmojiList(names.mapIndexed { index, name -> ServerEmoji("id$index", "s", name, "/api/emoji/id$index?v=1") })

/**
 * Custom server emoji: the token grammar (pinned to `packages/shared/src/server-emoji.ts`), how a body
 * reads it, and the per-server list a picture is looked up in.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CustomEmojiTest {

    private val id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    private val other = "11111111-2222-4333-8444-555555555555"

    // --- grammar ---

    @Test
    fun `the token pattern is the shared one`() {
        val shared = RepoSources.read("packages/shared/src/server-emoji.ts")
        // `<:name:id>`, a 2 to 32 character lowercase name and a lowercase uuid.
        assertTrue(shared.contains("""<:([a-z0-9_]{2,32}):(${'$'}{UUID})>"""))
        assertTrue(shared.contains("""const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}""""))
        assertEquals("<:([a-z0-9_]{2,32}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>", CustomEmoji.TOKEN.pattern)
    }

    @Test
    fun `a token reads as the name it was typed as on a line of plain text`() {
        assertEquals("oi :pog: e :kek:", CustomEmoji.asText("oi <:pog:$id> e <:kek:$other>"))
        assertEquals("sem emoji", CustomEmoji.asText("sem emoji"))
        // Not tokens: an uppercase name, a one character name, a bad id, no closing bracket.
        for (literal in listOf("<:POG:$id>", "<:p:$id>", "<:pog:not-a-uuid>", "<:pog:$id")) {
            assertEquals(literal, CustomEmoji.asText(literal))
        }
    }

    // --- markdown ---

    @Test
    fun `a token is a span that draws as its name until a picture is found for it`() {
        val spans = ChatMarkdown.inline("oi <:pog:$id>!")
        assertEquals(listOf("oi ", ":pog:", "!"), spans.map { it.text })
        assertNull(spans[0].emoji)
        assertEquals(CustomEmojiRef("pog", id), spans[1].emoji)
        assertNull(spans[2].emoji)
    }

    @Test
    fun `two of the same emoji in a row stay two`() {
        val spans = ChatMarkdown.inline("<:pog:$id><:pog:$id>")
        assertEquals(2, spans.size)
        assertTrue(spans.all { it.emoji?.id == id })
    }

    @Test
    fun `an emoji keeps the emphasis it sits in`() {
        val spans = ChatMarkdown.inline("**forte <:pog:$id> mesmo**")
        assertEquals(listOf("forte ", ":pog:", " mesmo"), spans.map { it.text })
        assertTrue(spans.all { it.bold })
        assertEquals(id, spans[1].emoji?.id)
    }

    @Test
    fun `nothing inside code is an emoji`() {
        val inline = ChatMarkdown.inline("`<:pog:$id>`")
        assertEquals("<:pog:$id>", inline.single().text)
        assertNull(inline.single().emoji)
        val fenced = ChatMarkdown.parse("```\n<:pog:$id>\n```").single() as ChatBlock.Code
        assertEquals("<:pog:$id>", fenced.text)
    }

    @Test
    fun `a malformed token stays the characters that were typed`() {
        val spans = ChatMarkdown.inline("<:pog:nope> <:x:$id> <3")
        assertEquals("<:pog:nope> <:x:$id> <3", spans.joinToString("") { it.text })
        assertTrue(spans.all { it.emoji == null })
    }

    @Test
    fun `a mention and a link around an emoji are untouched`() {
        val spans = ChatMarkdown.inline("@ana <:pog:$id> https://pqp.gg")
        assertEquals("ana", spans.first { it.mention != null }.mention)
        assertEquals(id, spans.first { it.emoji != null }.emoji?.id)
        assertEquals("https://pqp.gg", spans.first { it.link != null }.link)
    }

    // --- the list ---

    @Test
    fun `a list decodes the shape the server sends, extra fields ignored`() {
        val list = PqpJson.decodeFromString(
            ServerEmojiList.serializer(),
            """{"emoji":[{"id":"$id","serverId":"s","name":"pog","url":"/api/emoji/$id?v=ab12cd34","createdBy":null,"createdByName":null,"createdAt":"2026-10-01T00:00:00Z"}],"limit":50,"uploadEnabled":true,"maxBytes":262144,"size":128}""",
        )
        assertEquals("pog", list.emoji.single().name)
        assertEquals("/api/emoji/$id?v=ab12cd34", list.emoji.single().url)
    }

    private class Rig(var fail: Boolean = false) {
        val scope = TestScope()
        var clock = 1_000_000L
        val asked = mutableListOf<String>()
        var answer = emoji("b", "a")
        val store = ServerEmojiStore(
            scope = scope,
            fetch = { serverId ->
                asked += serverId
                if (fail) throw java.io.IOException("offline")
                answer
            },
            now = { clock },
        )
    }

    @Test
    fun `a server is read once, however many messages ask, and a conversation never`() {
        val rig = Rig()
        repeat(5) { rig.store.load("s") }
        rig.store.load(null)
        rig.scope.runCurrent()
        assertEquals(listOf("s"), rig.asked)
        assertEquals(listOf("a", "b"), rig.store.lists.value["s"]?.map { it.name })
        rig.store.load("s")
        rig.scope.runCurrent()
        assertEquals(1, rig.asked.size)
    }

    @Test
    fun `a failed read leaves nothing cached, so tokens read as their names and the next use tries again`() {
        val rig = Rig(fail = true)
        rig.store.load("s")
        rig.scope.runCurrent()
        assertFalse("s" in rig.store.lists.value)
        rig.fail = false
        rig.store.load("s")
        rig.scope.runCurrent()
        assertEquals(2, rig.asked.size)
        assertTrue("s" in rig.store.lists.value)
    }

    @Test
    fun `an id nobody knows refreshes the list, at most every thirty seconds`() {
        val rig = Rig()
        rig.store.load("s")
        rig.scope.runCurrent()
        rig.store.noteUnknown("s")
        rig.scope.runCurrent()
        assertEquals(2, rig.asked.size)
        // Asked again at once: refused.
        rig.store.noteUnknown("s")
        rig.scope.runCurrent()
        assertEquals(2, rig.asked.size)
        rig.clock += ServerEmojiStore.MISS_REFRESH_MS - 1
        rig.store.noteUnknown("s")
        rig.scope.runCurrent()
        assertEquals(2, rig.asked.size)
        rig.clock += 1
        rig.store.noteUnknown("s")
        rig.scope.runCurrent()
        assertEquals(3, rig.asked.size)
        // And a conversation has nothing to refresh.
        rig.store.noteUnknown(null)
        rig.scope.runCurrent()
        assertEquals(3, rig.asked.size)
    }
}
