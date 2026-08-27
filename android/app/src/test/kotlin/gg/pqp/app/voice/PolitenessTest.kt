package gg.pqp.app.voice

import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
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
 *
 * The rule used to be a one-line `isImpolite` in its own file, which a JVM test
 * could call directly. It is now written out three times inside [VoiceEngine],
 * whose every entry point needs the WebRTC native library, so this test reads
 * those three comparison sites off the source instead of calling them. That is
 * weaker than calling the function, and the reason is recorded here rather than
 * fixed here: putting the rule back in one callable place is a production
 * change, and this file may only touch tests.
 */
class PolitenessTest {

    private val webClient = "client/src/lib/peer-connection-manager.ts"

    private val engine: String
        get() = RepoSources.androidSources["VoiceEngine.kt"]
            ?: error("VoiceEngine.kt is gone from android/app/src/main/kotlin")

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
                "agree with the comparisons in VoiceEngine.kt; go and read what it became.",
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

    /**
     * The first offer. The higher id offers, exactly as the web client's
     * `isImpolite` gate at `peer-connection-manager.ts` does.
     */
    @Test
    fun `only the higher id sends the first offer`() {
        val addPeer = bodyOf("fun addPeer(")
        val gate = Regex("""if\s*\(local\s*([<>])\s*remotePeerId\)\s*\{([^}]*)""").find(addPeer)
            ?: error(
                "addPeer no longer gates the first offer on a peer-id comparison. Exactly one " +
                    "side of a pair must offer; both or neither is the bug.",
            )

        assertEquals(
            "addPeer offers from the wrong side of the pair. The web client offers when " +
                "local > remote, so an Android peer that offers when local < remote either " +
                "glares with it or waits for an offer nobody will send.",
            ">",
            gate.groupValues[1],
        )
        assertTrue(
            "The impolite branch in addPeer no longer negotiates",
            gate.groupValues[2].contains("negotiate("),
        )
    }

    /**
     * Glare. Exactly one side yields, and it is the *polite* one, which is the
     * lower id. This is the branch the web client spells
     * `!isImpolite(local, peer) && offerCollision`.
     */
    @Test
    fun `on a collision the lower id is the one that yields`() {
        val handleOffer = bodyOf("fun handleOffer(")
        val collision = Regex("""if\s*\(collision\)\s*\{""").find(handleOffer)
            ?: error("handleOffer no longer detects an offer collision at all")
        val yield_ = Regex("""if\s*\(local\s*([<>])\s*from\)\s*\{([^}]*)""")
            .find(handleOffer.substring(collision.range.last))
            ?: error(
                "The glare branch in handleOffer no longer compares the peer ids. Without it " +
                    "both sides roll back, or neither does.",
            )

        assertEquals(
            "The polite side of a collision is the LOWER id: it drops the incoming offer and " +
                "keeps its own. Flip this and both peers yield to each other forever.",
            "<",
            yield_.groupValues[1],
        )
        assertTrue(
            "The polite branch no longer drops the incoming offer",
            yield_.groupValues[2].contains("return@withLock"),
        )
        assertTrue(
            "The impolite side of a collision must roll its own offer back",
            handleOffer.contains("SessionDescription.Type.ROLLBACK"),
        )
    }

    /**
     * The ICE restart is glare wearing a different hat, so it is driven from
     * the same side as the first offer.
     */
    @Test
    fun `the ice restart is driven from the same side as the first offer`() {
        val gate = Regex("""restarts\s*<\s*MAX_ICE_RESTARTS\s*&&\s*local\s*([<>])\s*remotePeerId""")
            .find(engine)
            ?: error(
                "The ICE restart is no longer gated on the peer-id comparison. Two simultaneous " +
                    "restarts are glare under another name.",
            )

        assertEquals(
            "The ICE restart is driven from the wrong side. It must be the same side that " +
                "sends the first offer, the higher id.",
            ">",
            gate.groupValues[1],
        )
    }

    /**
     * The rule is hand-copied three times inside `VoiceEngine.kt` and must not
     * spread further. Every copy is another chance to invert one, and an
     * inverted copy is a silent deadlock.
     */
    @Test
    fun `the politeness comparison lives only in VoiceEngine`() {
        val comparison = Regex("""\blocal(PeerId)?\s*[<>]\s*(remotePeerId|from|peerId)\b""")
        val copies = RepoSources.androidSources
            .filterKeys { it != "VoiceEngine.kt" }
            .filterValues { comparison.containsMatchIn(it) }

        assertEquals(
            "The politeness comparison was copied out of VoiceEngine.kt into these files. " +
                "Give it one home instead; a second copy is a second chance to invert it.",
            emptySet<String>(),
            copies.keys,
        )
    }

    /** The body of a top-level-ish declaration, by brace matching. */
    private fun bodyOf(signature: String): String {
        val start = engine.indexOf(signature)
        check(start >= 0) { "VoiceEngine.kt no longer declares `$signature`" }
        val open = engine.indexOf('{', start)
        check(open >= 0) { "`$signature` has no body in VoiceEngine.kt" }
        var depth = 0
        for (index in open until engine.length) {
            when (engine[index]) {
                '{' -> depth += 1
                '}' -> {
                    depth -= 1
                    if (depth == 0) return engine.substring(open + 1, index)
                }
                else -> Unit
            }
        }
        error("Never found the end of `$signature` in VoiceEngine.kt")
    }
}
