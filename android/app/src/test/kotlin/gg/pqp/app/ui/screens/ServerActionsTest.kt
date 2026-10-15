package gg.pqp.app.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which action a server row offers, and when the destructive one lights up.
 *
 * The delete rule is the community twin of `AccountDeletionTest`: the name has
 * to be typed, but the requirement is deliberate intent rather than typing
 * accuracy, so it is trimmed and compared without case. Getting this wrong in
 * either direction is bad. Too strict and somebody cannot delete a community
 * whose name has an accent they cannot reproduce; too loose and a stray tap
 * destroys one.
 */
class ServerActionsTest {

    @Test
    fun `the owner is offered delete and everybody else leave`() {
        assertTrue(ServerActions.isOwner("owner"))
        assertFalse(ServerActions.isOwner("admin"))
        assertFalse(ServerActions.isOwner("member"))
    }

    @Test
    fun `a role the server did not send is not treated as ownership`() {
        assertFalse(ServerActions.isOwner(null))
        assertFalse(ServerActions.isOwner(""))
        assertFalse(ServerActions.isOwner("Owner"))
    }

    @Test
    fun `the typed name has to be the name`() {
        assertTrue(ServerActions.deleteConfirmationMatches("Owned With Others", "Owned With Others"))
        assertFalse(ServerActions.deleteConfirmationMatches("Owned With Other", "Owned With Others"))
        assertFalse(ServerActions.deleteConfirmationMatches("", "Owned With Others"))
    }

    private fun server(id: String) = gg.pqp.app.core.ServerSummary(
        id = id,
        name = id,
        ownerId = "u",
        createdAt = "2026-01-01T00:00:00Z",
    )

    @Test
    fun `a server moves one place up or down in the list`() {
        val list = listOf(server("a"), server("b"), server("c"))
        assertEquals(listOf("b", "a", "c"), ServerActions.reordered(list, "a", 1)!!.map { it.id })
        assertEquals(listOf("a", "c", "b"), ServerActions.reordered(list, "c", -1)!!.map { it.id })
    }

    @Test
    fun `applying an order changes only the order`() {
        val list = listOf(server("a"), server("b"), server("c"))
        assertEquals(listOf("c", "a", "b"), ServerActions.applyOrder(list, listOf("c", "a", "b")).map { it.id })
        // An id the list does not hold is ignored; one the order does not name
        // keeps its place after the named ones.
        assertEquals(listOf("b", "a", "c"), ServerActions.applyOrder(list, listOf("zzz", "b")).map { it.id })
    }

    @Test
    fun `moving past either end, or an unknown server, changes nothing`() {
        val list = listOf(server("a"), server("b"), server("c"))
        assertNull(ServerActions.reordered(list, "a", -1))
        assertNull(ServerActions.reordered(list, "c", 1))
        assertNull(ServerActions.reordered(list, "zzz", 1))
        assertNull(ServerActions.reordered(emptyList(), "a", 1))
    }

    @Test
    fun `another device's order is followed, this phone's own echo and a save in flight are not`() {
        val list = listOf(server("a"), server("b"), server("c"))
        val order = listOf("c", "a", "b")
        assertEquals(
            listOf("c", "a", "b"),
            ServerActions.followRemoteOrder(list, order, origin = "web-1", ownOrigin = "android-1", saving = false)!!
                .map { it.id },
        )
        // Its own echo.
        assertNull(ServerActions.followRemoteOrder(list, order, "android-1", "android-1", saving = false))
        // A frame with no origin is somebody else's.
        assertEquals(
            listOf("c", "a", "b"),
            ServerActions.followRemoteOrder(list, order, null, "android-1", saving = false)!!.map { it.id },
        )
        // A save of this phone's is in flight: the order on screen is the newer.
        assertNull(ServerActions.followRemoteOrder(list, order, "web-1", "android-1", saving = true))
        // Nothing would move.
        assertNull(ServerActions.followRemoteOrder(list, listOf("a", "b", "c"), "web-1", "android-1", saving = false))
        // A server joined a moment ago, not named yet, keeps its place after the named ones.
        assertEquals(
            listOf("b", "a", "c"),
            ServerActions.followRemoteOrder(list, listOf("b", "a"), "web-1", "android-1", saving = false)!!
                .map { it.id },
        )
    }

    @Test
    fun `surrounding space and case are forgiven`() {
        assertTrue(ServerActions.deleteConfirmationMatches("  owned with others ", "Owned With Others"))
        assertTrue(ServerActions.deleteConfirmationMatches("PQP", " pqp "))
    }
}
