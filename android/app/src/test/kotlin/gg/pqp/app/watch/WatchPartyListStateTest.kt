package gg.pqp.app.watch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The four states the channel list may draw for one `watch_party` channel,
 * and how a server's several channels collapse into one block. Exhaustive
 * the same way `WatchPartyHostGateTest` is exhaustive for the stage's own
 * gate -- this is the sibling decision for the list.
 */
class WatchPartyListStateTest {

    private fun party(
        state: String = "draft",
        role: String = "host",
        name: String = "Sessão",
        hostName: String = "Host",
    ) = WatchPartyPayload(
        id = "p1",
        channelId = "c1",
        name = name,
        state = state,
        hostUserId = "u1",
        hostDisplayName = hostName,
        viewerRole = role,
    )

    // ---------------------------------------------------------------- Live

    @Test
    fun `a live party is Live for anybody, watching or not`() {
        val entry = watchPartyListEntry(
            channelId = "c1",
            channelName = "cinema",
            party = party(state = "live", role = "viewer"),
            watching = 12,
            isOwner = false,
        )
        assertTrue(entry is WatchPartyListEntry.Live)
        entry as WatchPartyListEntry.Live
        assertEquals(12, entry.watching)
        assertEquals("Sessão", entry.partyName)
        assertEquals("Host", entry.hostDisplayName)
    }

    @Test
    fun `no watching signal yet shows no number rather than a guess`() {
        val entry = watchPartyListEntry(
            channelId = "c1",
            channelName = "cinema",
            party = party(state = "live"),
            watching = null,
            isOwner = false,
        )
        assertEquals(null, (entry as WatchPartyListEntry.Live).watching)
    }

    // ------------------------------------------------------------- Pending

    @Test
    fun `my own draft is Pending`() {
        val entry = watchPartyListEntry(
            channelId = "c1",
            channelName = "cinema",
            party = party(state = "draft", role = "host"),
            watching = null,
            isOwner = false,
        )
        assertTrue(entry is WatchPartyListEntry.Pending)
        assertEquals(false, (entry as WatchPartyListEntry.Pending).scheduled)
    }

    @Test
    fun `my own scheduled party is Pending and says so`() {
        val entry = watchPartyListEntry(
            channelId = "c1",
            channelName = "cinema",
            party = party(state = "scheduled", role = "host"),
            watching = null,
            isOwner = false,
        )
        assertTrue((entry as WatchPartyListEntry.Pending).scheduled)
    }

    @Test
    fun `a co-host also sees the pending card`() {
        val entry = watchPartyListEntry(
            channelId = "c1",
            channelName = "cinema",
            party = party(state = "draft", role = "cohost"),
            watching = null,
            isOwner = false,
        )
        assertTrue(entry is WatchPartyListEntry.Pending)
    }

    @Test
    fun `somebody else's draft is nobody's business here, even the owner's`() {
        // Mirrors the web: `pendingParty` is resolved per viewer, and an
        // owner overseeing another host's draft does not get a create
        // button drawn over it -- the create endpoint's own supersede rule
        // decides what happens if they still tap Host.
        val entry = watchPartyListEntry(
            channelId = "c1",
            channelName = "cinema",
            party = party(state = "draft", role = "viewer"),
            watching = null,
            isOwner = true,
        )
        assertNull(entry)
    }

    // ----------------------------------------------------------------- Host

    @Test
    fun `no party and this account owns the server offers Host`() {
        val entry = watchPartyListEntry(
            channelId = "c1",
            channelName = "cinema",
            party = null,
            watching = null,
            isOwner = true,
        )
        assertTrue(entry is WatchPartyListEntry.Host)
    }

    @Test
    fun `no party and no permission is NOTHING`() {
        val entry = watchPartyListEntry(
            channelId = "c1",
            channelName = "cinema",
            party = null,
            watching = null,
            isOwner = false,
        )
        assertNull(entry)
    }

    @Test
    fun `a terminal party is not offered as Host until the clearing frame arrives`() {
        // Same deliberate gap as `watchPartyHostGate`'s "an ended party
        // frees the host to create the next one" test: the row stays absent
        // until `watch-party-update` sends `party: null`, even for the owner
        // who just ended it.
        for (state in listOf("ended", "cancelled")) {
            val entry = watchPartyListEntry(
                channelId = "c1",
                channelName = "cinema",
                party = party(state = state, role = "host"),
                watching = null,
                isOwner = true,
            )
            assertNull("state=$state", entry)
        }
    }

    // ---------------------------------------------------------------- Block

    @Test
    fun `no watch_party channels on the server is None`() {
        assertEquals(WatchPartyListBlock.None, watchPartyListBlock(emptyList()))
    }

    @Test
    fun `live outranks a pending or host row on another channel`() {
        val live = WatchPartyListEntry.Live("c1", "live-room", "Show", "Host", 3)
        val pending = WatchPartyListEntry.Pending("c2", "other-room", "Draft", scheduled = false)
        val block = watchPartyListBlock(listOf(pending, live))
        assertEquals(WatchPartyListBlock.Live(listOf(live)), block)
    }

    @Test
    fun `several live parties are all drawn`() {
        val a = WatchPartyListEntry.Live("c1", "a", "Show A", "Host A", null)
        val b = WatchPartyListEntry.Live("c2", "b", "Show B", "Host B", 5)
        val block = watchPartyListBlock(listOf(a, b))
        assertEquals(WatchPartyListBlock.Live(listOf(a, b)), block)
    }

    @Test
    fun `pending outranks a host row when neither is live`() {
        val pending = WatchPartyListEntry.Pending("c1", "a", "Draft", scheduled = true)
        val host = WatchPartyListEntry.Host("c2", "b")
        val block = watchPartyListBlock(listOf(host, pending))
        assertEquals(WatchPartyListBlock.Pending(pending), block)
    }

    @Test
    fun `the first eligible channel's Host row wins when there is more than one`() {
        val first = WatchPartyListEntry.Host("c1", "a")
        val second = WatchPartyListEntry.Host("c2", "b")
        val block = watchPartyListBlock(listOf(first, second))
        assertEquals(WatchPartyListBlock.Host(first), block)
    }

    @Test
    fun `a server with nothing to show at all is None`() {
        val block = watchPartyListBlock(listOf(null, null))
        assertEquals(WatchPartyListBlock.None, block)
    }
}
