package gg.pqp.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerOrderLedgerTest {

    private fun server(id: String) = ServerSummary(id = id, name = id, ownerId = "u", createdAt = "2026-01-01T00:00:00Z")
    private val list = listOf(server("a"), server("b"), server("c"))
    private val remote = listOf("c", "b", "a")

    @Test
    fun `a failed save lets the ignored remote order win when everything settles`() {
        val ledger = ServerOrderLedger()
        ledger.ignored(remote)
        ledger.saveFailed()
        assertEquals(remote, ledger.settle(list)!!.map { it.id })
    }

    @Test
    fun `a later save that succeeded keeps this phone's order over the earlier remote one`() {
        val ledger = ServerOrderLedger()
        ledger.ignored(remote)
        ledger.saveFailed()
        ledger.saveSucceeded()
        assertNull(ledger.settle(list))
    }

    @Test
    fun `every save landing means the remote order is history`() {
        val ledger = ServerOrderLedger()
        ledger.ignored(remote)
        ledger.saveSucceeded()
        assertNull(ledger.settle(list))
    }

    @Test
    fun `a remote order that arrives after the last save that landed wins even when no save failed`() {
        val ledger = ServerOrderLedger()
        ledger.saveSucceeded()
        // A queued save then finds nothing to send (the order collapsed back): no failure,
        // no success, and a remote order arrived meanwhile.
        ledger.ignored(remote)
        assertEquals(remote, ledger.settle(list)!!.map { it.id })
    }

    @Test
    fun `settling starts the next burst clean`() {
        val ledger = ServerOrderLedger()
        ledger.ignored(remote)
        ledger.saveFailed()
        ledger.settle(list)
        assertNull(ledger.settle(list))
    }
}
