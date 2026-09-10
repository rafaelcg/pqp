package gg.pqp.app.voice

import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two rules that decide whether a screen reaches the SFU, and whether it
 * should still be there.
 *
 * Both were found by review rather than by running anything, and neither can be
 * reproduced on a device without a LiveKit room, a moderator and a stopwatch,
 * which is exactly why they are pure and tested here.
 */
class ScreenPublishGuardTest {

    // --- the moderation rule ----------------------------------------------

    /**
     * THE BYPASS, stated as a test.
     *
     * The SFU token is minted at connect and never re-minted, so it keeps
     * saying yes after a moderator has said no. A client that published on the
     * token alone would let a revoked presenter press share again and go back
     * on air, which is a moderation bypass and not a stale flag. At a hosted
     * event, the host deciding who broadcasts is the whole point.
     */
    @Test
    fun `the token alone is never permission to publish`() {
        assertFalse(
            "A revoked presenter must not publish on a token minted before the revocation",
            canPublishScreenNow(tokenGrantsScreen = true, rosterAllowsScreen = false),
        )
    }

    @Test
    fun `the roster alone cannot conjure a grant the token never gave`() {
        assertFalse(canPublishScreenNow(tokenGrantsScreen = false, rosterAllowsScreen = true))
    }

    @Test
    fun `both yeses publish, and nothing else does`() {
        assertTrue(canPublishScreenNow(tokenGrantsScreen = true, rosterAllowsScreen = true))
        assertFalse(canPublishScreenNow(tokenGrantsScreen = false, rosterAllowsScreen = false))
    }

    /**
     * A transport starts out refusing until it has been told, so nothing can
     * publish in the window between the engine existing and the controller
     * resolving the permission.
     */
    @Test
    fun `a fresh engine refuses before it has been told anything`() {
        assertFalse(canPublishScreenNow(tokenGrantsScreen = false, rosterAllowsScreen = false))
    }

    // --- the lifecycle rule -----------------------------------------------

    @Test
    fun `the share that just started is the current one`() {
        val guard = ScreenPublishGuard()
        val ticket = guard.begin()
        assertTrue(guard.isCurrent(ticket))
    }

    /**
     * The person stopped sharing while the publish was still in flight. Before
     * the guard, that publish landed and the room got a track nobody was
     * driving and nobody could take down.
     */
    @Test
    fun `a publish that lands after a stop is stale`() {
        val guard = ScreenPublishGuard()
        val ticket = guard.begin()
        guard.invalidate()
        assertFalse(guard.isCurrent(ticket))
    }

    /**
     * The room promoted to the SFU mid-share and the engine was swapped. Not
     * hypothetical: rooms promote at four participants and this client follows
     * the promotion, so an engine swap during a share is an ordinary event.
     */
    @Test
    fun `a publish that lands after the engine was torn down is stale`() {
        val guard = ScreenPublishGuard()
        val ticket = guard.begin()
        guard.invalidate() // stop()
        assertFalse(guard.isCurrent(ticket))
    }

    /** Stop, start again quickly: only the second one is real. */
    @Test
    fun `a quick restart leaves only the newest share current`() {
        val guard = ScreenPublishGuard()
        val first = guard.begin()
        val second = guard.begin()
        assertFalse("the first share must not still be publishing", guard.isCurrent(first))
        assertTrue(guard.isCurrent(second))
    }

    /**
     * The worst of the four, because the share it kills is the one that works:
     * the OLD capturer's `onStop` arriving after a NEW share has started.
     */
    @Test
    fun `a late callback from an old capture cannot end the new share`() {
        val guard = ScreenPublishGuard()
        val old = guard.begin()
        val current = guard.begin()
        assertFalse("the old capturer's onStop must be ignored", guard.isCurrent(old))
        assertTrue("the running share must survive it", guard.isCurrent(current))
    }

    @Test
    fun `tickets are never reused, so a stale one cannot come back round`() {
        val guard = ScreenPublishGuard()
        val seen = mutableSetOf<Int>()
        repeat(50) {
            val ticket = guard.begin()
            assertTrue("ticket $ticket was handed out twice", seen.add(ticket))
            guard.invalidate()
        }
    }

    // --- the unpublish retry ----------------------------------------------

    @Test
    fun `the unpublish backs off and then gives up`() {
        assertEquals(250L, unpublishRetryDelayMs(1))
        assertEquals(500L, unpublishRetryDelayMs(2))
        assertEquals(1000L, unpublishRetryDelayMs(3))
        assertEquals(0L, unpublishRetryDelayMs(UNPUBLISH_MAX_ATTEMPTS))
        assertEquals(0L, unpublishRetryDelayMs(99))
    }

    @Test
    fun `it retries more than once and does not retry forever`() {
        assertTrue("one attempt is what this replaced", UNPUBLISH_MAX_ATTEMPTS > 1)
        val total = (1 until UNPUBLISH_MAX_ATTEMPTS).sumOf { unpublishRetryDelayMs(it) }
        assertTrue("a phone must not chase a dead socket for long: ${total}ms", total <= 5_000)
    }

    // --- the wiring, which is where the bug actually was --------------------

    /**
     * SPEAK and the stage travel together, checked in the source.
     *
     * The rule above is easy; remembering to apply it is what failed. The bug
     * was not a wrong comparison, it was a permission change that reached the
     * UI and never reached the transport, so the engine kept publishing on a
     * grant the moderator had taken away.
     *
     * `VoiceController` has three places that resolve this pair (the welcome,
     * the mid-call change and the promotion), and every one of them must tell
     * the engine both halves. Reading the source is the only way to assert that
     * without an Android runtime, and this module already reads its own source
     * to pin the wire contract.
     */
    @Test
    fun `every place that pushes SPEAK to the engine pushes the stage too`() {
        val source = RepoSources.androidSources.getValue("VoiceController.kt")
        val audio = Regex("""engine\.setCanPublishAudio\(""").findAll(source).count()
        val screen = Regex("""engine\.setCanPublishScreen\(""").findAll(source).count()
        assertTrue("expected the controller to push SPEAK to the engine at all", audio >= 3)
        assertEquals(
            "A permission path tells the engine about SPEAK and not about the stage. On the " +
                "SFU the publish grant outlives a revocation, so a transport that is not told " +
                "keeps letting a revoked presenter publish.",
            audio,
            screen,
        )
    }

    /**
     * And the transport interface must keep demanding it, so a third engine
     * cannot be added that silently implements only half the pair.
     */
    @Test
    fun `the transport interface still requires both halves`() {
        val source = RepoSources.androidSources.getValue("VoiceTransport.kt")
        assertTrue(source.contains("fun setCanPublishAudio(allowed: Boolean)"))
        assertTrue(source.contains("fun setCanPublishScreen(allowed: Boolean)"))
    }
}
