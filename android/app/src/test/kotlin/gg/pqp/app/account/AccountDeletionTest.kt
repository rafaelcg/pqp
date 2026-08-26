package gg.pqp.app.account

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rule that decides when the Delete button lights up, which has to be the
 * same rule the server refuses on.
 *
 * Every case here is one `deleteConfirmationMatches` in
 * `packages/shared/src/api.ts` decides the same way. If one of these ever fails
 * after a server change, the button did not stop working: it started offering
 * an action the server will refuse with a 400 the user can do nothing about.
 */
class AccountDeletionTest {

    @Test
    fun `an account with a tag types its tag`() {
        assertEquals("rafa#1234", AccountDeletion.expectedConfirmation("rafa#1234"))
        assertTrue(AccountDeletion.confirmationMatches("rafa#1234", "rafa#1234"))
    }

    @Test
    fun `an account with no tag types the English phrase`() {
        assertEquals(AccountDeletion.FALLBACK_PHRASE, AccountDeletion.expectedConfirmation(null))
        assertEquals(AccountDeletion.FALLBACK_PHRASE, AccountDeletion.expectedConfirmation(""))
        assertEquals(AccountDeletion.FALLBACK_PHRASE, AccountDeletion.expectedConfirmation("   "))
        assertTrue(AccountDeletion.confirmationMatches("delete my account", null))
    }

    @Test
    fun `the phrase is never translated`() {
        // The server compares against this exact English string, so a
        // Portuguese rendering would be a 400 nobody could act on.
        assertEquals("delete my account", AccountDeletion.FALLBACK_PHRASE)
        assertFalse(AccountDeletion.confirmationMatches("excluir minha conta", null))
    }

    @Test
    fun `intent is the requirement, not typing accuracy`() {
        assertTrue(AccountDeletion.confirmationMatches("  RAFA#1234 ", "rafa#1234"))
        assertTrue(AccountDeletion.confirmationMatches("Delete My Account", null))
    }

    @Test
    fun `something else does not count`() {
        assertFalse(AccountDeletion.confirmationMatches("", "rafa#1234"))
        assertFalse(AccountDeletion.confirmationMatches("rafa", "rafa#1234"))
        assertFalse(AccountDeletion.confirmationMatches("rafa#12345", "rafa#1234"))
        assertFalse(AccountDeletion.confirmationMatches("yes", null))
    }
}
