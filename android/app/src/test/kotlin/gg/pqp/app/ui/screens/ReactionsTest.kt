package gg.pqp.app.ui.screens

import gg.pqp.app.core.Reaction
import gg.pqp.app.core.ReactionUser
import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reaction delta, and the quick set, against the web client that shares
 * both.
 *
 * `reaction-broadcast` says "this person added or removed this emoji" and
 * nothing else. Everything the pill shows is the client's own running total, so
 * this is the one path in the transcript where a count can be wrong forever
 * with nothing erroring anywhere: the server only re-sends the true list on the
 * next page load. Two clients folding the same frame differently is exactly the
 * shape of bug that a single client, watching itself, cannot see.
 */
class ReactionsTest {

    private val ME = "11111111-1111-1111-1111-111111111111"
    private val THEM = "22222222-2222-2222-2222-222222222222"

    private fun reaction(
        emoji: String = "👍",
        count: Int = 1,
        me: Boolean = false,
        users: List<ReactionUser> = emptyList(),
    ) = Reaction(emoji = emoji, count = count, me = me, users = users)

    // --- the quick set ---

    /**
     * Read off `client/src/lib/emoji-shortcodes.ts`. A channel with two clients
     * in it must not have two different vocabularies, and a divergence here is
     * not a compile error on either side.
     */
    @Test
    fun `the quick set matches the web client's, in order`() {
        val source = RepoSources.stripComments(
            RepoSources.read("client/src/lib/emoji-shortcodes.ts"),
        )
        val block = Regex("""QUICK_REACTIONS\s*=\s*\[(.*?)]""", RegexOption.DOT_MATCHES_ALL)
            .find(source)
            ?: error("No QUICK_REACTIONS in client/src/lib/emoji-shortcodes.ts")
        val web = Regex(""""([^"]+)"""")
            .findAll(block.groupValues[1])
            .map { it.groupValues[1] }
            .toList()

        assertTrue("Parsed no emoji out of QUICK_REACTIONS", web.size > 3)
        assertEquals(web, QUICK_REACTIONS)
    }

    // --- adding ---

    @Test
    fun `a first reaction creates the pill`() {
        val next = applyReactionBroadcast(emptyList(), "👍", THEM, "Bruno", true, ME)
        assertEquals(1, next.size)
        assertEquals("👍", next[0].emoji)
        assertEquals(1, next[0].count)
        assertFalse(next[0].me)
        assertEquals(listOf(ReactionUser(THEM, "Bruno")), next[0].users)
    }

    @Test
    fun `our own reaction marks the pill as ours`() {
        val next = applyReactionBroadcast(emptyList(), "👍", ME, "Ana", true, ME)
        assertTrue(next[0].me)
    }

    @Test
    fun `a second person raises the count and keeps ours set`() {
        val before = listOf(reaction(count = 1, me = true, users = listOf(ReactionUser(ME, "Ana"))))
        val next = applyReactionBroadcast(before, "👍", THEM, "Bruno", true, ME)
        assertEquals(2, next[0].count)
        assertTrue(next[0].me)
        assertEquals(2, next[0].users.size)
    }

    /**
     * The same frame twice must not raise the count.
     *
     * A socket that reconnects mid-fanout, or a broadcast that races the
     * optimistic toggle that caused it, both deliver this. Without the guard
     * everybody's screen says two people liked something one person liked, and
     * nothing ever recomputes it.
     */
    @Test
    fun `an add for somebody already there is idempotent`() {
        val before = listOf(reaction(count = 1, users = listOf(ReactionUser(THEM, "Bruno"))))
        val next = applyReactionBroadcast(before, "👍", THEM, "Bruno", true, ME)
        assertEquals(1, next[0].count)
        assertEquals(1, next[0].users.size)
    }

    @Test
    fun `a different emoji is a different pill`() {
        val before = listOf(reaction("👍"))
        val next = applyReactionBroadcast(before, "🔥", THEM, "Bruno", true, ME)
        assertEquals(listOf("👍", "🔥"), next.map { it.emoji })
    }

    // --- removing ---

    @Test
    fun `the last removal drops the pill rather than leaving a zero`() {
        val before = listOf(reaction(count = 1, users = listOf(ReactionUser(THEM, "Bruno"))))
        assertTrue(applyReactionBroadcast(before, "👍", THEM, "Bruno", false, ME).isEmpty())
    }

    @Test
    fun `a removal lowers the count and takes the person out`() {
        val before = listOf(
            reaction(
                count = 2,
                me = true,
                users = listOf(ReactionUser(ME, "Ana"), ReactionUser(THEM, "Bruno")),
            ),
        )
        val next = applyReactionBroadcast(before, "👍", THEM, "Bruno", false, ME)
        assertEquals(1, next[0].count)
        assertTrue("ours must survive somebody else leaving", next[0].me)
        assertEquals(listOf(ReactionUser(ME, "Ana")), next[0].users)
    }

    @Test
    fun `our own removal clears the mark`() {
        val before = listOf(
            reaction(
                count = 2,
                me = true,
                users = listOf(ReactionUser(ME, "Ana"), ReactionUser(THEM, "Bruno")),
            ),
        )
        val next = applyReactionBroadcast(before, "👍", ME, "Ana", false, ME)
        assertFalse(next[0].me)
        assertEquals(1, next[0].count)
    }

    @Test
    fun `a removal for an emoji nobody used changes nothing`() {
        val before = listOf(reaction("👍", count = 3))
        assertEquals(before, applyReactionBroadcast(before, "🔥", THEM, "Bruno", false, ME))
    }

    /**
     * Signed out, or before the session is known. A broadcast must still fold
     * correctly; it just cannot be ours.
     */
    @Test
    fun `an unknown local user never marks a pill as ours`() {
        val next = applyReactionBroadcast(emptyList(), "👍", THEM, "Bruno", true, null)
        assertFalse(next[0].me)
    }

    // --- the local toggle ---

    @Test
    fun `tapping an empty slot adds ours`() {
        val next = toggleOwnReaction(emptyList(), "👍", ME, "Ana")
        assertEquals(1, next[0].count)
        assertTrue(next[0].me)
    }

    @Test
    fun `tapping somebody else's pill joins it`() {
        val before = listOf(reaction(count = 1, users = listOf(ReactionUser(THEM, "Bruno"))))
        val next = toggleOwnReaction(before, "👍", ME, "Ana")
        assertEquals(2, next[0].count)
        assertTrue(next[0].me)
    }

    @Test
    fun `tapping our own pill takes it back`() {
        val before = listOf(reaction(count = 1, me = true, users = listOf(ReactionUser(ME, "Ana"))))
        assertTrue(toggleOwnReaction(before, "👍", ME, "Ana").isEmpty())
    }

    /**
     * The optimistic toggle and the broadcast it causes must agree, because
     * both run. If they did not, every reaction would be counted twice on the
     * device that made it and once everywhere else.
     */
    @Test
    fun `the broadcast for our own toggle is a no-op on top of it`() {
        val optimistic = toggleOwnReaction(emptyList(), "👍", ME, "Ana")
        val afterBroadcast = applyReactionBroadcast(optimistic, "👍", ME, "Ana", true, ME)
        assertEquals(optimistic, afterBroadcast)
    }

    @Test
    fun `the broadcast for our own untoggle is a no-op on top of it`() {
        val before = listOf(reaction(count = 1, me = true, users = listOf(ReactionUser(ME, "Ana"))))
        val optimistic = toggleOwnReaction(before, "👍", ME, "Ana")
        val afterBroadcast = applyReactionBroadcast(optimistic, "👍", ME, "Ana", false, ME)
        assertEquals(optimistic, afterBroadcast)
    }

    /**
     * The bug two emulators found and the unit tests did not.
     *
     * Taking your reaction back off a message two people liked: the optimistic
     * toggle took the count from 2 to 1, then the echo of your own frame ran
     * the reducer again, saw `count <= 1`, and **deleted the pill** on that
     * device alone. The other person's reaction disappeared from your screen
     * until the next page load, and nothing anywhere errored.
     *
     * The earlier version of the idempotence test missed it because it only
     * covered the case where the count was already 1, where dropping the pill
     * is the right answer either way.
     */
    @Test
    fun `taking ours back off a shared pill leaves the other person's`() {
        val before = listOf(
            reaction(
                count = 2,
                me = true,
                users = listOf(ReactionUser(ME, "Ana"), ReactionUser(THEM, "Bruno")),
            ),
        )
        val optimistic = toggleOwnReaction(before, "👍", ME, "Ana")
        assertEquals(1, optimistic[0].count)
        assertFalse(optimistic[0].me)

        val afterBroadcast = applyReactionBroadcast(optimistic, "👍", ME, "Ana", false, ME)
        assertEquals("the echo of our own frame must not fold twice", optimistic, afterBroadcast)
        assertEquals(1, afterBroadcast[0].count)
    }

    @Test
    fun `joining a shared pill is not folded twice either`() {
        val before = listOf(reaction(count = 1, users = listOf(ReactionUser(THEM, "Bruno"))))
        val optimistic = toggleOwnReaction(before, "👍", ME, "Ana")
        assertEquals(2, optimistic[0].count)

        val afterBroadcast = applyReactionBroadcast(optimistic, "👍", ME, "Ana", true, ME)
        assertEquals(optimistic, afterBroadcast)
        assertEquals(2, afterBroadcast[0].count)
    }

    /**
     * The guard keys on `me`, not on "we have seen this frame", so a reaction
     * this account made on another device still lands.
     */
    @Test
    fun `our own reaction from elsewhere still applies`() {
        val next = applyReactionBroadcast(emptyList(), "👍", ME, "Ana", true, ME)
        assertEquals(1, next[0].count)
        assertTrue(next[0].me)

        val removed = applyReactionBroadcast(next, "👍", ME, "Ana", false, ME)
        assertTrue(removed.isEmpty())
    }

    @Test
    fun `a toggle with no signed-in user does nothing`() {
        val before = listOf(reaction())
        assertEquals(before, toggleOwnReaction(before, "👍", null, null))
    }

    @Test
    fun `an unnamed reactor is still counted`() {
        // `displayName` is optional on the broadcast schema. A missing name is
        // an empty label, never a dropped reaction.
        val next = applyReactionBroadcast(emptyList(), "👍", THEM, null, true, ME)
        assertEquals(1, next[0].count)
        assertEquals("", next[0].users[0].displayName)
        assertNull(null)
    }
}
