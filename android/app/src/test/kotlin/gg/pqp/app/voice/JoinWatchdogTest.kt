package gg.pqp.app.voice

import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The join deadline, which is what turns a silent refusal into a sentence.
 *
 * Every case here is a coroutine that woke up and has to decide whether the
 * thing it was waiting for is still happening. Each one was a real way to
 * break the call rather than fix it: refusing a join that had already
 * connected, refusing the rebuild after a socket drop, or refusing twice.
 */
class JoinWatchdogTest {

    @Test
    fun `an armed deadline is claimed once, and names its channel`() {
        val watchdog = JoinWatchdog()
        val ticket = watchdog.arm("general")
        assertEquals("general", watchdog.waitingFor)
        assertEquals("general", watchdog.claim(ticket))
    }

    /**
     * Two coroutines can reach a claim: the deadline, and anything that later
     * decides the join is over. A refusal delivered twice tears down a call
     * that the second delivery had nothing to do with.
     */
    @Test
    fun `the same ticket cannot be claimed twice`() {
        val watchdog = JoinWatchdog()
        val ticket = watchdog.arm("general")
        watchdog.claim(ticket)
        assertNull(watchdog.claim(ticket))
    }

    /**
     * `welcome` landed, or the person hung up. The coroutine sleeping on the
     * deadline still wakes up twelve seconds later and must do nothing.
     */
    @Test
    fun `a settled join cannot be refused by its own deadline`() {
        val watchdog = JoinWatchdog()
        val ticket = watchdog.arm("general")
        watchdog.settled()
        assertNull(watchdog.claim(ticket))
        assertNull(watchdog.waitingFor)
    }

    /**
     * THE SOCKET DROP. `followConnection` rebuilds the call from scratch, so a
     * second `enter` happens while the first attempt's deadline is still
     * asleep. Firing it would hang up the room that had just come back.
     */
    @Test
    fun `a stale ticket claims nothing and leaves the current attempt armed`() {
        val watchdog = JoinWatchdog()
        val first = watchdog.arm("general")
        val second = watchdog.arm("general")
        assertNull(watchdog.claim(first))
        assertEquals("general", watchdog.waitingFor)
        assertEquals("general", watchdog.claim(second))
    }

    /**
     * Somebody moved rooms mid-join. The deadline that fires belongs to the
     * room they are in now, and `onJoinTimedOut` checks the channel it is
     * handed against the state before it refuses anything.
     */
    @Test
    fun `re-arming for another channel names the new one`() {
        val watchdog = JoinWatchdog()
        watchdog.arm("general")
        val second = watchdog.arm("cinema")
        assertEquals("cinema", watchdog.claim(second))
    }

    @Test
    fun `nothing is waiting before the first join`() {
        assertNull(JoinWatchdog().waitingFor)
    }

    /**
     * The reason this class exists, asserted against the server rather than
     * against a comment.
     *
     * `refuseResume()` sends `voice-join-refused` **only** when the join
     * carried a `resumePeerId`. That is why a cold join that is refused gets
     * no frame at all and why a deadline is the only thing that can end it. If
     * the server ever starts answering a cold join, this fails and the
     * timeout can stop being the primary mechanism.
     */
    @Test
    fun `the server still answers only a resume, which is why a deadline is needed`() {
        val voice = RepoSources.read("server/src/ws/voice.ts")
        val guard = Regex(
            """const refuseResume = \(\) => \{\s*if \(payload\.resumePeerId\)""",
        )
        assertTrue(
            "server/src/ws/voice.ts no longer gates `voice-join-refused` on `resumePeerId`. " +
                "If a cold join is now answered, `VoiceController` should lean on that frame " +
                "and `JoinWatchdog` becomes the backstop rather than the mechanism.",
            guard.containsMatchIn(voice),
        )
    }

    @Test
    fun `the deadline is the same one the web client uses`() {
        val web = RepoSources.read("client/src/hooks/use-voice.ts")
        val declared = Regex("""const JOIN_TIMEOUT_MS = ([0-9_]+);""")
            .find(web)
            ?.groupValues
            ?.get(1)
            ?.replace("_", "")
            ?.toLong()
        assertEquals(
            "The web client changed its join deadline. A phone and a laptop asking the " +
                "same server for the same room should give up at the same moment.",
            declared,
            VOICE_JOIN_TIMEOUT_MS,
        )
    }
}
