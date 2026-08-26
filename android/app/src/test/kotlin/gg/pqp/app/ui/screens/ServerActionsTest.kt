package gg.pqp.app.ui.screens

import org.junit.Assert.assertFalse
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

    @Test
    fun `surrounding space and case are forgiven`() {
        assertTrue(ServerActions.deleteConfirmationMatches("  owned with others ", "Owned With Others"))
        assertTrue(ServerActions.deleteConfirmationMatches("PQP", " pqp "))
    }
}
