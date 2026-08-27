package gg.pqp.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The routing vocabulary, which is the server's and not this client's.
 *
 * Every `path` string asserted here is one `buildPushPayload` in
 * `server/src/services/push.ts` actually produces. If one of these fails after
 * a server change, the notification did not stop working loudly: it started
 * landing on the wrong screen.
 */
class DeepLinkTest {

    @Test
    fun `server channel path carries both ids`() {
        val target = DeepLink.target("/app/server/srv-1/channel/chan-2")
        assertEquals(DeepLinkTarget.Channel("srv-1", "chan-2"), target)
    }

    @Test
    fun `dm path is a conversation`() {
        assertEquals(
            DeepLinkTarget.Conversation("chan-9"),
            DeepLink.target("/app/dm/chan-9"),
        )
    }

    @Test
    fun `server without a channel is a server`() {
        assertEquals(DeepLinkTarget.Server("srv-1"), DeepLink.target("/app/server/srv-1"))
    }

    @Test
    fun `the fallback path a mention with no server produces is not a target`() {
        // buildPushPayload emits a bare "/app" when a server-kind channel has
        // somehow no server id. There is nowhere for that to land.
        assertNull(DeepLink.target("/app"))
    }

    @Test
    fun `absolute urls parse the same as paths`() {
        assertEquals(
            DeepLinkTarget.Channel("srv-1", "chan-2"),
            DeepLink.target("https://pqp.gg/app/server/srv-1/channel/chan-2"),
        )
    }

    @Test
    fun `query and fragment are ignored`() {
        assertEquals(
            DeepLinkTarget.Conversation("chan-9"),
            DeepLink.target("/app/dm/chan-9?from=push#top"),
        )
    }

    @Test
    fun `the pqp scheme keeps working for invites`() {
        assertEquals(DeepLinkTarget.Invite("ABC123"), DeepLink.target("pqp://invite/ABC123"))
    }

    @Test
    fun `nonsense is null rather than a guess`() {
        assertNull(DeepLink.target(null))
        assertNull(DeepLink.target(""))
        assertNull(DeepLink.target("   "))
        assertNull(DeepLink.target("/settings/notifications"))
        assertNull(DeepLink.target("/app/server"))
        assertNull(DeepLink.target("pqp://"))
    }

    @Test
    fun `channelId is exposed for channels and conversations only`() {
        assertEquals("chan-2", DeepLinkTarget.Channel("srv-1", "chan-2").channelId)
        assertEquals("chan-9", DeepLinkTarget.Conversation("chan-9").channelId)
        assertNull(DeepLinkTarget.Server("srv-1").channelId)
        assertNull(DeepLinkTarget.Invite("ABC123").channelId)
    }

    /**
     * The #79 property, stated as a test.
     *
     * The web client resolved a notification's server by looking the channel up
     * in a directory that only ever held the selected server's channels, so a
     * frame from anywhere else described to nulls and lost its route, its title
     * and its mute. Parsing cannot do that: there is no directory to miss.
     */
    @Test
    fun `routing needs no loaded app state`() {
        val target = DeepLink.target("/app/server/never-opened/channel/never-seen")
        assertEquals(DeepLinkTarget.Channel("never-opened", "never-seen"), target)
    }

    /**
     * Any app on the phone can fire a `pqp://` intent at `MainActivity`, and
     * the segment that arrives becomes a path in `POST /api/invites/…/join`.
     * A code with a slash or a `..` in it is refused here rather than sent.
     */
    @Test
    fun `an invite code that is not a code is refused`() {
        assertNull(DeepLink.target("pqp://invite/../../api/me"))
        assertNull(DeepLink.target("pqp://invite/" + "A".repeat(65)))
        assertNull(DeepLink.target("/app/invite/has space"))
    }

    @Test
    fun `an ordinary invite code still parses through both shapes`() {
        assertEquals(DeepLinkTarget.Invite("aB3-x_9"), DeepLink.target("pqp://invite/aB3-x_9"))
        assertEquals(DeepLinkTarget.Invite("aB3-x_9"), DeepLink.target("/invite/aB3-x_9"))
        assertEquals(
            DeepLinkTarget.Invite("aB3-x_9"),
            DeepLink.target("https://pqp.gg/invite/aB3-x_9"),
        )
    }
}
