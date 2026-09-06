package gg.pqp.app.voice

import gg.pqp.app.core.PqpJson
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The SPEAK rule, pinned against `applySpeakRule` in
 * `client/src/hooks/use-voice.ts`. The two clients meet in the same call, so
 * they must agree on what a listen-only seat does with its own media.
 */
class SpeakRuleTest {

    private fun frame(json: String): JsonObject =
        PqpJson.decodeFromString(JsonObject.serializer(), json)

    private val self = """"self":{"peerId":"p1","userId":"u1","displayName":"Ana","avatarUrl":null"""

    // --- where the bit is read from ---------------------------------------

    @Test
    fun `the top-level key wins over self`() {
        assertFalse(canSpeakFrom(frame("""{"type":"welcome","canSpeak":false,$self,"canSpeak":true}}""")))
        assertTrue(canSpeakFrom(frame("""{"type":"welcome","canSpeak":true,$self,"canSpeak":false}}""")))
    }

    @Test
    fun `self is the fallback`() {
        assertFalse(canSpeakFrom(frame("""{"type":"welcome",$self,"canSpeak":false}}""")))
        assertTrue(canSpeakFrom(frame("""{"type":"welcome",$self,"canSpeak":true}}""")))
    }

    /**
     * Absent on both is a server that predates SPEAK enforcement, where
     * everyone could speak. Refusing there would mute every self-host.
     */
    @Test
    fun `absent everywhere is allowed`() {
        assertTrue(canSpeakFrom(frame("""{"type":"welcome",$self}}""")))
        assertTrue(canSpeakFrom(frame("""{"type":"welcome"}""")))
    }

    // --- what a denial does -----------------------------------------------

    /** A listen-only welcome mutes, publishes nothing, and says so once. */
    @Test
    fun `denied on welcome mutes and explains`() {
        assertEquals(
            SpeakRuleOutcome(canSpeak = false, mute = true, stopPublishing = true, notice = SpeakNotice.ListenOnly),
            speakRule(canSpeak = false, was = true, source = SpeakRuleSource.Welcome),
        )
    }

    /** A revoke mid-call closes the mic and takes any share down with it. */
    @Test
    fun `revoked mid-call mutes and explains`() {
        val outcome = speakRule(canSpeak = false, was = true, source = SpeakRuleSource.Change)
        assertTrue(outcome.mute)
        assertTrue(outcome.stopPublishing)
        assertEquals(SpeakNotice.ListenOnly, outcome.notice)
    }

    /** The same bit again is not news; it is still enforced. */
    @Test
    fun `a repeated denial on change is quiet`() {
        val outcome = speakRule(canSpeak = false, was = false, source = SpeakRuleSource.Change)
        assertTrue(outcome.mute)
        assertNull(outcome.notice)
    }

    // --- what a grant does ------------------------------------------------

    /**
     * `true` after `false` unlocks the control and leaves the unmute to the
     * person. Never an automatic unmute: they were silent a moment ago.
     */
    @Test
    fun `granted mid-call unlocks without unmuting`() {
        assertEquals(
            SpeakRuleOutcome(canSpeak = true, mute = false, stopPublishing = false, notice = SpeakNotice.SpeakGranted),
            speakRule(canSpeak = true, was = false, source = SpeakRuleSource.Change),
        )
    }

    /** An ordinary welcome, which is every call today, says nothing at all. */
    @Test
    fun `allowed on welcome is silent`() {
        val outcome = speakRule(canSpeak = true, was = true, source = SpeakRuleSource.Welcome)
        assertFalse(outcome.mute)
        assertNull(outcome.notice)
    }
}
