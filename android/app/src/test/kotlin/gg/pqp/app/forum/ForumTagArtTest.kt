package gg.pqp.app.forum

import gg.pqp.app.core.PqpJson
import gg.pqp.app.forum.ui.ForumTagIcons
import gg.pqp.app.forum.ui.forumTagPresetRes
import gg.pqp.app.protocol.RepoSources
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A forum tag's icon and its starter name on the phone. The wire shape is
 * `forumTagSchema` in `packages/shared/src/forums.ts`: `icon` and `preset` are
 * optional and nullable, a key the phone has never heard of must not break the
 * list, and the emoji stays the fallback.
 */
class ForumTagArtTest {

    private val forums = "packages/shared/src/forums.ts"
    private val base = """"id":"t1","name":"Question","emoji":"❓","moderated":false,"position":0,"postCount":3"""

    private fun tag(extra: String = ""): ForumTag =
        PqpJson.decodeFromString("""{$base$extra}""")

    @Test
    fun `a tag from an older server has no icon and no preset`() {
        val tag = tag()
        assertNull(tag.icon)
        assertNull(tag.preset)
        assertEquals("❓", tag.emoji)
    }

    @Test
    fun `null, a new key and an unknown key all decode`() {
        val nulls = tag(""","icon":null,"preset":null""")
        assertNull(nulls.icon)
        assertNull(nulls.preset)
        val known = tag(""","icon":"bug","preset":"bug","tint":"red"""")
        assertEquals("bug", known.icon)
        // A key from a newer server: kept as text, drawn as the emoji.
        val future = tag(""","icon":"hologram","preset":"brand-new"""")
        assertEquals("hologram", future.icon)
        assertNull(ForumTagIcons.vector(future.icon))
        assertNull(forumTagPresetRes(future.preset))
    }

    @Test
    fun `the phone draws exactly the icons the shared list names`() {
        val source = RepoSources.read(forums)
        val block = source.substringAfter("export const FORUM_TAG_ICONS = [").substringBefore("] as const;")
        val shared = Regex("""key:\s*"([a-z]+)"""").findAll(block).map { it.groupValues[1] }.toList()
        assertTrue("Parsed too few keys out of FORUM_TAG_ICONS: $shared", shared.size >= 24)
        assertEquals("keys the shared list has and the phone cannot draw", emptySet<String>(), shared.toSet() - ForumTagIcons.keys)
        assertEquals("keys the phone draws that the shared list no longer has", emptySet<String>(), ForumTagIcons.keys - shared.toSet())
        shared.forEach { key -> assertNotNull("no vector for $key", ForumTagIcons.vector(key)) }
    }

    @Test
    fun `every shared preset has a name in both languages`() {
        val source = RepoSources.read(forums)
        val block = source.substringAfter("export const FORUM_TAG_PRESETS = [").substringBefore("] as const;")
        val presets = Regex(""""([a-z]+)"""").findAll(block).map { it.groupValues[1] }.toList()
        assertEquals(listOf("question", "bug", "suggestion", "tutorial", "release", "wip", "discussion"), presets)
        val english = File(RepoSources.root, "android/app/src/main/res/values/strings.xml").readText()
        val portuguese = File(RepoSources.root, "android/app/src/main/res/values-pt-rBR/strings.xml").readText()
        presets.forEach { preset ->
            assertNotNull("no string resource for the $preset preset", forumTagPresetRes(preset))
            assertTrue(english.contains("""name="forum_tag_preset_$preset""""))
            assertTrue(portuguese.contains("""name="forum_tag_preset_$preset""""))
        }
        assertNull(forumTagPresetRes(null))
        assertNull(forumTagPresetRes("nope"))
    }

    @Test
    fun `the model names the same fields as the shared schema`() {
        val schemaKeys = RepoSources.objectKeys(forums, "forumTagSchema").toSet()
        assertTrue(schemaKeys.containsAll(setOf("icon", "preset")))
        assertEquals(
            schemaKeys,
            kotlinx.serialization.serializer<ForumTag>().descriptor.let { d ->
                (0 until d.elementsCount).map { d.getElementName(it) }.toSet()
            },
        )
    }

    @Test
    fun `the image and video preview lines carry no emoji, the card draws an icon`() {
        listOf("values/strings.xml", "values-pt-rBR/strings.xml").forEach { file ->
            val text = File(RepoSources.root, "android/app/src/main/res/$file").readText()
            listOf("forum_preview_image", "forum_preview_video").forEach { name ->
                val value = Regex("""name="$name">([^<]*)<""").find(text)?.groupValues?.get(1)
                assertNotNull("$name missing from $file", value)
                assertTrue("$name in $file still carries a glyph: $value", value!!.all { it.isLetter() })
            }
        }
        assertNotNull(ForumTagIcons.vector("video"))
    }
}
