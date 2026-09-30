package gg.pqp.app.watch

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the host-facing UI may show, exhaustively. This is the test the
 * hosting review's own requirement points at: "no START_WATCH_PARTY, no
 * host UI" and "server watch parties off, no host UI" are assertions here,
 * not something read off a screenshot.
 */
class WatchPartyHostGateTest {

    private fun party(
        state: String = "draft",
        role: String = "host",
    ) = WatchPartyPayload(
        id = "p1",
        channelId = "c1",
        name = "Sessão",
        state = state,
        hostUserId = "u1",
        hostDisplayName = "Host",
        viewerRole = role,
    )

    // ------------------------------------------------------ no START_WATCH_PARTY

    @Test
    fun `no START_WATCH_PARTY means no host UI at all, even on a watch_party channel with hosting on`() {
        val gate = watchPartyHostGate(
            isWatchPartyChannel = true,
            serverWatchPartyEnabled = true,
            canStartWatchParty = false,
            party = null,
        )
        assertFalse(gate.canCreate)
        assertFalse(gate.canManage)
    }

    @Test
    fun `holding START_WATCH_PARTY but no active party offers Criar watch party`() {
        val gate = watchPartyHostGate(
            isWatchPartyChannel = true,
            serverWatchPartyEnabled = true,
            canStartWatchParty = true,
            party = null,
        )
        assertTrue(gate.canCreate)
        assertFalse(gate.canManage)
    }

    // -------------------------------------------------- server watch parties off

    @Test
    fun `the server has watch parties off means no host UI, whatever the channel permission says`() {
        val gate = watchPartyHostGate(
            isWatchPartyChannel = true,
            serverWatchPartyEnabled = false,
            canStartWatchParty = true,
            party = null,
        )
        assertFalse(gate.canCreate)
        assertFalse(gate.canManage)
    }

    // ------------------------------------------------------- not a watch_party channel

    @Test
    fun `an ordinary voice channel never gets host UI, whatever else is true`() {
        val gate = watchPartyHostGate(
            isWatchPartyChannel = false,
            serverWatchPartyEnabled = true,
            canStartWatchParty = true,
            party = null,
        )
        assertFalse(gate.canCreate)
        assertFalse(gate.canManage)
    }

    // ------------------------------------------------------------- managing a party

    @Test
    fun `the host of the running party may manage it, and is not offered Criar again`() {
        val gate = watchPartyHostGate(
            isWatchPartyChannel = true,
            serverWatchPartyEnabled = true,
            canStartWatchParty = true,
            party = party(state = "live", role = "host"),
        )
        assertFalse(gate.canCreate)
        assertTrue(gate.canManage)
    }

    @Test
    fun `somebody who may start a party but is not running this one gets neither control`() {
        val gate = watchPartyHostGate(
            isWatchPartyChannel = true,
            serverWatchPartyEnabled = true,
            canStartWatchParty = true,
            party = party(state = "live", role = "viewer"),
        )
        assertFalse(gate.canCreate)
        assertFalse(gate.canManage)
    }

    @Test
    fun `a co-host is not the host and does not manage the party's own lifecycle`() {
        val gate = watchPartyHostGate(
            isWatchPartyChannel = true,
            serverWatchPartyEnabled = true,
            canStartWatchParty = true,
            party = party(state = "live", role = "cohost"),
        )
        assertFalse(gate.canManage)
    }

    @Test
    fun `an ended party frees the host to create the next one`() {
        val gate = watchPartyHostGate(
            isWatchPartyChannel = true,
            serverWatchPartyEnabled = true,
            canStartWatchParty = true,
            party = party(state = "ended", role = "host"),
        )
        assertFalse(gate.canManage)
        // `party` on this channel is still the ended row until the next
        // `watch-party-update` clears it (`party: null`); this gate does not
        // second-guess that and simply stops offering to manage a party that
        // is over. `canCreate` stays false here on purpose: the frame that
        // clears the channel is what actually re-opens Criar watch party.
        assertFalse(gate.canCreate)
    }

    // ------------------------------------------------------------ the sub-gates

    @Test
    fun `Ir ao vivo is offered on a draft or a scheduled party and nothing else`() {
        assertTrue(canGoLiveWith(party(state = "draft")))
        assertTrue(canGoLiveWith(party(state = "scheduled")))
        assertFalse(canGoLiveWith(party(state = "live")))
        assertFalse(canGoLiveWith(party(state = "ended")))
        assertFalse(canGoLiveWith(null))
    }

    @Test
    fun `Encerrar is offered on a live party and nothing else`() {
        assertTrue(canEndParty(party(state = "live")))
        assertFalse(canEndParty(party(state = "draft")))
        assertFalse(canEndParty(party(state = "ended")))
        assertFalse(canEndParty(null))
    }

    // ----------------------------------- mayManageWatchPartyWithoutASeat

    /**
     * The product rule this whole change exists for: a watch party is a
     * broadcast, not a call, so the host must never be required to join the
     * voice room just to see the setup card. Both reasons this function
     * grants that are server-confirmed and neither is a seat.
     */
    @Test
    fun `holding START_WATCH_PARTY with nothing running yet needs no seat`() {
        assertTrue(mayManageWatchPartyWithoutASeat(mayStartWatchParty = true, party = null))
    }

    @Test
    fun `the confirmed host of the running party needs no seat either, whatever its state`() {
        assertTrue(mayManageWatchPartyWithoutASeat(mayStartWatchParty = false, party = party(state = "draft")))
        assertTrue(mayManageWatchPartyWithoutASeat(mayStartWatchParty = false, party = party(state = "live")))
    }

    @Test
    fun `START_WATCH_PARTY stops widening the instant somebody else's party exists`() {
        // The permission bit alone is "may start one", not "may run this
        // one" -- once a party is on the channel, only its own host reads
        // true, exactly like `watchPartyHostGate`'s `canManage`.
        assertFalse(
            mayManageWatchPartyWithoutASeat(mayStartWatchParty = true, party = party(state = "live", role = "viewer")),
        )
    }

    @Test
    fun `a co-host is not covered -- Android tracks no co-host promotion yet`() {
        assertFalse(
            mayManageWatchPartyWithoutASeat(mayStartWatchParty = false, party = party(state = "live", role = "cohost")),
        )
    }

    @Test
    fun `neither the bit nor the host role means no seatless path`() {
        assertFalse(mayManageWatchPartyWithoutASeat(mayStartWatchParty = false, party = null))
        assertFalse(
            mayManageWatchPartyWithoutASeat(mayStartWatchParty = false, party = party(state = "live", role = "viewer")),
        )
    }
}
