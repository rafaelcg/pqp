package gg.pqp.app.invites

import gg.pqp.app.core.Invite
import gg.pqp.app.push.DeepLink
import gg.pqp.app.push.DeepLinkTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The invite link, pinned from both ends.
 *
 * What this builds is what the web builds (`inviteLink` in
 * `client/src/components/layout/invite-panel.tsx`), what the manifest's App
 * Links filter claims (`/app/invite/`), and what `DeepLink` parses back on the
 * receiving phone. If any of the three drifts, a link shared from Android
 * either opens the browser or opens the app on the wrong screen.
 */
class InviteLinksTest {

    private fun invite(
        code: String = "aB3xY9",
        maxUses: Int? = null,
        uses: Int = 0,
        expiresAt: String? = null,
    ) = Invite(
        id = "inv-1",
        code = code,
        serverId = "srv-1",
        maxUses = maxUses,
        uses = uses,
        expiresAt = expiresAt,
    )

    @Test
    fun `the link is the web's link`() {
        assertEquals("https://pqp.gg/app/invite/aB3xY9", InviteLinks.link("aB3xY9", "https://pqp.gg"))
        assertEquals("https://pqp.gg/app/invite/aB3xY9", InviteLinks.link("aB3xY9", "https://pqp.gg/"))
    }

    @Test
    fun `a built link parses back to the same code`() {
        val link = InviteLinks.link("aB3-x_9", "https://pqp.gg")!!
        assertEquals(DeepLinkTarget.Invite("aB3-x_9"), DeepLink.target(link))
    }

    @Test
    fun `a code that would need escaping is not put in a link`() {
        assertNull(InviteLinks.link("has space", "https://pqp.gg"))
        assertNull(InviteLinks.link("../me", "https://pqp.gg"))
        assertNull(InviteLinks.link("", "https://pqp.gg"))
        assertNull(InviteLinks.link("A".repeat(65), "https://pqp.gg"))
    }

    @Test
    fun `unlimited and never expiring is live`() {
        assertTrue(InviteLinks.isLive(invite(), nowMillis = 0L))
        assertNull(InviteLinks.hoursLeft(invite(), nowMillis = 0L))
    }

    @Test
    fun `an exhausted invite is not live`() {
        assertFalse(InviteLinks.isLive(invite(maxUses = 2, uses = 2), nowMillis = 0L))
        assertTrue(InviteLinks.isLive(invite(maxUses = 2, uses = 1), nowMillis = 0L))
    }

    @Test
    fun `an expired invite is not live and a future one counts hours`() {
        val now = 1_700_000_000_000L
        val inTwoHours = java.time.Instant.ofEpochMilli(now + 2 * 60 * 60 * 1000L + 1).toString()
        val anHourAgo = java.time.Instant.ofEpochMilli(now - 60 * 60 * 1000L).toString()
        assertTrue(InviteLinks.isLive(invite(expiresAt = inTwoHours), now))
        assertEquals(2L, InviteLinks.hoursLeft(invite(expiresAt = inTwoHours), now))
        assertFalse(InviteLinks.isLive(invite(expiresAt = anHourAgo), now))
    }

    @Test
    fun `a timestamp the server did not write is treated as never`() {
        assertTrue(InviteLinks.isLive(invite(expiresAt = "soon"), nowMillis = 0L))
        assertNull(InviteLinks.hoursLeft(invite(expiresAt = "soon"), nowMillis = 0L))
    }
}
