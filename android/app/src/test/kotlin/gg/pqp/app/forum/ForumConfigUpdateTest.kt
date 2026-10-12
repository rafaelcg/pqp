package gg.pqp.app.forum

import gg.pqp.app.core.PqpJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.jsonObject

/**
 * `forum-config-update` (forum QA P11), "marcada por" on the Solução card (P9)
 * and the field AutoMod refused (P18), on the phone's side of each.
 */
class ForumConfigUpdateTest {

    private fun frame(json: String) = PqpJson.parseToJsonElement(json).jsonObject

    @Test
    fun `either half of the frame decodes`() {
        val both = ForumConfigUpdate.decode(
            frame(
                """{"type":"forum-config-update","forumId":"f",
                    "tags":[{"id":"t1","name":"Bug","position":0,"moderated":true}],
                    "settings":{"requireTag":true,"defaultSort":"created"}}""",
            ),
        )
        assertEquals("f", both?.forumId)
        assertEquals(listOf("Bug"), both?.tags?.map { it.name })
        assertEquals(true, both?.settings?.requireTag)

        val onlySettings = ForumConfigUpdate.decode(
            frame("""{"type":"forum-config-update","forumId":"f","settings":{"requireTag":false}}"""),
        )
        assertNull(onlySettings?.tags)
        assertEquals(false, onlySettings?.settings?.requireTag)
    }

    @Test
    fun `a frame the phone cannot read, or another type, is nothing`() {
        assertNull(ForumConfigUpdate.decode(frame("""{"type":"forum-config-update","settings":{}}""")))
        assertNull(ForumConfigUpdate.decode(frame("""{"type":"forum-post-removed","forumId":"f","postId":"p"}""")))
        assertNull(
            ForumConfigUpdate.decode(frame("""{"type":"forum-config-update","forumId":"f","tags":"nope"}""")),
        )
    }

    @Test
    fun `an open composer follows the tags and the require-tag rule, and drops a deleted pick`() {
        val before = ForumComposerState(
            tags = listOf(ForumTag("t1", "Bug", position = 0), ForumTag("t2", "Dica", position = 1)),
            tagIds = listOf("t1", "t2"),
            requireTag = false,
        )
        val update = ForumConfigUpdate(
            forumId = "f",
            tags = listOf(ForumTag("t2", "Dica", position = 0)),
            settings = ForumSettings(requireTag = true),
        )
        val after = ForumComposerViewModel.applyConfig(before, update)
        assertEquals(listOf("t2"), after.tags.map { it.id })
        assertEquals("the deleted tag leaves the pick", listOf("t2"), after.tagIds)
        assertTrue(after.requireTag)

        // Settings only: the pick and the tags are untouched.
        val settingsOnly = ForumComposerViewModel.applyConfig(before, ForumConfigUpdate("f", settings = ForumSettings(requireTag = true)))
        assertEquals(before.tagIds, settingsOnly.tagIds)
        assertEquals(before.tags, settingsOnly.tags)
        assertFalse(ForumComposerViewModel.applyConfig(after, ForumConfigUpdate("f", settings = ForumSettings(requireTag = false))).requireTag)
    }

    @Test
    fun `an automod refusal names the half it refused, when the server says`() {
        val title = ForumComposerViewModel.automodError(
            frame("""{"error":"forum_post_rejected","reason":"automod","automodMessage":"Sem links","field":"title"}"""),
        )
        assertEquals(ForumComposerError.Automod("Sem links", "title"), title)
        assertEquals("body", ForumComposerViewModel.automodError(frame("""{"reason":"automod","field":"body"}""")).field)
        // An older API, or a field this build does not know: the generic line.
        assertNull(ForumComposerViewModel.automodError(frame("""{"reason":"automod"}""")).field)
        assertNull(ForumComposerViewModel.automodError(frame("""{"reason":"automod","field":"tags"}""")).field)
        assertNull(ForumComposerViewModel.automodError(null).message)
    }

    @Test
    fun `the solution says who marked it, you, a name, or nobody`() {
        val named = ForumAcceptedAnswer(messageId = "m", markedById = "bia", markedByName = "Bia Souza")
        assertEquals(ForumMarker.Named("Bia Souza"), named.marker(viewerId = "rafa"))
        assertEquals(ForumMarker.You, named.marker(viewerId = "bia"))

        // Marked before the server kept it, or by an account deleted since.
        assertNull(ForumAcceptedAnswer(messageId = "m").marker(viewerId = "rafa"))
        assertNull(ForumAcceptedAnswer(messageId = "m", markedById = null, markedByName = null).marker(viewerId = "rafa"))
        assertNull(ForumAcceptedAnswer(messageId = "m", markedByName = "  ").marker(viewerId = "rafa"))
    }
}
