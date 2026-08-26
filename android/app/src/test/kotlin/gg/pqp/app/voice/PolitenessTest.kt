package gg.pqp.app.voice

import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The politeness rule, against the web client that has to agree with it.
 *
 * This is the highest-consequence cross-language fact in the app and the one
 * with the worst failure mode: invert it and two peers either both offer
 * (glare) or neither does, which looks like everybody sitting in `connecting`
 * forever with nothing in any log saying why. It cannot be caught by testing
 * one client against itself, because one client is always consistent with
 * itself.
 */
class PolitenessTest {

    private val webClient = "client/src/lib/peer-connection-manager.ts"

    /**
     * The web client's rule, read off its source.
     *
     * If somebody changes `isImpolite` in `peer-connection-manager.ts`, this is
     * the test that fails, in the Android build, which is the only place the
     * disagreement is visible before two humans are in a call.
     */
    @Test
    fun `the web client still compares the ids the way this one does`() {
        val source = RepoSources.stripComments(RepoSources.read(webClient))
        val body = Regex(
            """function\s+isImpolite\(\s*(\w+)\s*:\s*string,\s*(\w+)\s*:\s*string\s*\)\s*:\s*boolean\s*\{([^}]*)}""",
        ).find(source) ?: error(
            "isImpolite is no longer a plain function in $webClient. The rule still has to " +
                "agree with gg.pqp.app.voice.isImpolite; go and read what it became.",
        )

        val local = body.groupValues[1]
        val remote = body.groupValues[2]
        val expression = body.groupValues[3].replace(Regex("\\s+"), " ").trim()

        assertEquals(
            "The web client's politeness rule changed direction. Android must follow it in " +
                "the same commit or the two clients deadlock in every mixed room.",
            "return $local > $remote;",
            expression,
        )
    }

    @Test
    fun `the higher id is the impolite one`() {
        assertTrue(isImpolite("b", "a"))
        assertFalse(isImpolite("a", "b"))
    }

    /** Exactly one side of any pair offers. Both or neither is the bug. */
    @Test
    fun `exactly one side of a pair is impolite`() {
        val ids = listOf(
            "0192f0c1-0000-7000-8000-000000000000",
            "0192f0c1-ffff-7000-8000-000000000000",
            "peer-1",
            "peer-10",
            "peer-2",
            "Z",
            "a",
            "ünicode",
        )
        for (left in ids) {
            for (right in ids) {
                if (left == right) continue
                assertEquals(
                    "Exactly one of $left / $right must offer",
                    1,
                    listOf(isImpolite(left, right), isImpolite(right, left)).count { it },
                )
            }
        }
    }

    /**
     * Kotlin's `String.compareTo` and JavaScript's `>` both compare UTF-16 code
     * units. This is the case where a "sensible" locale-aware comparison would
     * differ, and differing is a deadlock.
     */
    @Test
    fun `the comparison is by code unit and not locale-aware`() {
        // "Z" (0x5A) sorts before "a" (0x61) by code unit; a locale collation
        // would usually put "a" first.
        assertTrue(isImpolite("a", "Z"))
        assertFalse(isImpolite("Z", "a"))
        // Digits before letters, again by code unit.
        assertTrue(isImpolite("a", "9"))
    }

    @Test
    fun `a peer is never impolite towards itself`() {
        assertFalse(isImpolite("same", "same"))
    }

    /**
     * The rule is written once. It used to be written twice inside
     * `VoiceEngine`, and two copies of a rule are two chances to invert one.
     */
    @Test
    fun `the rule is not hand-copied anywhere else in the module`() {
        val copies = RepoSources.androidSources
            .filterKeys { it != "Politeness.kt" }
            .filterValues { source ->
                Regex("""local(PeerId)?\s*>\s*remotePeerId""").containsMatchIn(source)
            }
        assertEquals(
            "The politeness comparison was copied back out of Politeness.kt into these files",
            emptySet<String>(),
            copies.keys,
        )
    }
}
