package gg.pqp.app.stories

import gg.pqp.app.protocol.RepoSources
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * TalkBack reads a swatch by its colour ("Glow, Lime"), not by its place in the
 * row ("Glow, background 1"). Every background key the pickers draw needs a
 * name in both languages, or the label falls back to its position.
 */
class StoryBackgroundNamesTest {

    private val keys = StoriesRules.BACKGROUNDS + StoriesRules.BACKGROUNDS_SOLID + StoriesRules.BACKGROUNDS_GRADIENT

    private fun namesIn(path: String): Set<String> =
        Regex("""<string\s+name="stories_bg_([a-z]+)"""")
            .findAll(File(RepoSources.root, path).readText())
            .map { it.groupValues[1] }
            .toSet()

    @Test
    fun `every background key has a colour name in English`() {
        assertEquals(emptySet<String>(), keys.toSet() - namesIn("android/app/src/main/res/values/strings.xml"))
    }

    @Test
    fun `every background key has a colour name in Portuguese`() {
        assertEquals(emptySet<String>(), keys.toSet() - namesIn("android/app/src/main/res/values-pt-rBR/strings.xml"))
    }
}
