package gg.pqp.app.ui.screens

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The order rule for the channel list's fetches: a fetch may write unless a
 * newer one already has. The first cut let only the NEWEST write, so a
 * `channels-update` refetch that overtook the first load and then failed
 * through every retry threw the load's list away, and the screen had none.
 */
class ChannelListTicketsTest {

    @Test
    fun `the first load still writes when a refetch overtook it and failed`() {
        val tickets = ChannelListTickets()
        val load = tickets.takeFirst()
        tickets.take()
        // The refetch fails through every try and writes nothing; the load
        // answers with the list it got, though it is no longer the newest.
        assertFalse(tickets.isLatest(load))
        assertTrue(tickets.tryWrite(load))
    }

    @Test
    fun `a slow first load never lands on top of a newer refetch`() {
        val tickets = ChannelListTickets()
        val load = tickets.takeFirst()
        val refetch = tickets.take()
        assertTrue(tickets.tryWrite(refetch))
        assertFalse(tickets.tryWrite(load))
    }

    @Test
    fun `two refetches write in order`() {
        val tickets = ChannelListTickets()
        val load = tickets.takeFirst()
        assertTrue(tickets.tryWrite(load))
        val create = tickets.take()
        val rename = tickets.take()
        assertTrue(tickets.tryWrite(create))
        assertTrue(tickets.tryWrite(rename))
    }

    @Test
    fun `a fetch for the server this screen left is stale`() {
        val tickets = ChannelListTickets()
        val onA = tickets.takeFirst()
        val refetchOnA = tickets.take()
        val onB = tickets.takeFirst()
        assertFalse(tickets.tryWrite(refetchOnA))
        assertFalse(tickets.tryWrite(onA))
        assertTrue(tickets.tryWrite(onB))
    }
}
