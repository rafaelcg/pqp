package gg.pqp.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The `@` picker, against the web's own rules
 * (`client/src/lib/mention-autocomplete.ts`).
 *
 * What lands in the text is a **username**, because that is what the server
 * resolves (`resolveMentions` in `server/src/services/messages.ts`). A picker
 * that inserted a display name would look like it worked and notify nobody,
 * which is the one failure mode worth a test here.
 */
class MentionAutocompleteTest {

    private val rafa = MentionCandidate(id = "1", displayName = "Rafael", username = "rafa")
    private val bob = MentionCandidate(id = "2", displayName = "Roberto", username = "bob", nickname = "Beto")
    private val nameless = MentionCandidate(id = "3", displayName = "Ghost", username = null)

    private val everyone = listOf(rafa, bob, nameless)

    @Test
    fun `an at sign at the caret opens an empty query`() {
        val query = MentionAutocomplete.find("hey @", 5)
        assertEquals(MentionQuery(start = 4, end = 5, query = ""), query)
    }

    @Test
    fun `the token under the caret is what is being typed`() {
        assertEquals(MentionQuery(4, 8, "raf"), MentionAutocomplete.find("hey @raf", 8))
    }

    @Test
    fun `the caret must be inside the token`() {
        // The caret sits before the `@`, so nothing is open.
        assertNull(MentionAutocomplete.find("hey @raf", 3))
    }

    @Test
    fun `an at sign in the middle of a word is an address, not a mention`() {
        assertNull(MentionAutocomplete.find("me@example", 10))
    }

    @Test
    fun `a space ends the token`() {
        assertNull(MentionAutocomplete.find("@raf said hi", 12))
    }

    @Test
    fun `a token longer than a username cannot be one`() {
        val long = "@" + "a".repeat(40)
        assertNull(MentionAutocomplete.find(long, long.length))
    }

    @Test
    fun `a member with no username is never offered`() {
        // There is nothing to insert for them: the wire format is `@username`.
        assertEquals(
            listOf(rafa, bob),
            MentionAutocomplete.filter(everyone, ""),
        )
        assertEquals(emptyList<MentionCandidate>(), MentionAutocomplete.filter(listOf(nameless), "gho"))
    }

    @Test
    fun `a username prefix beats a display name prefix`() {
        val bobby = MentionCandidate(id = "4", displayName = "Bob Ross", username = "ross")
        assertEquals(
            listOf(bob, bobby),
            MentionAutocomplete.filter(listOf(bobby, bob), "bo"),
        )
    }

    @Test
    fun `a nickname matches, because that is the name people see here`() {
        assertEquals(listOf(bob), MentionAutocomplete.filter(everyone, "bet"))
    }

    @Test
    fun `matching is case insensitive`() {
        assertEquals(listOf(rafa), MentionAutocomplete.filter(everyone, "RAF"))
    }

    @Test
    fun `a substring still matches, just later`() {
        assertEquals(listOf(rafa), MentionAutocomplete.filter(everyone, "afa"))
    }

    @Test
    fun `the list is bounded`() {
        val many = (1..30).map {
            MentionCandidate(id = "$it", displayName = "Person $it", username = "person$it")
        }
        assertEquals(MentionAutocomplete.MAX_SUGGESTIONS, MentionAutocomplete.filter(many, "person").size)
    }

    @Test
    fun `picking a name replaces the token and leaves the caret after it`() {
        val query = MentionAutocomplete.find("hey @raf", 8)!!
        val (value, caret) = MentionAutocomplete.apply("hey @raf", query, "rafa")
        assertEquals("hey @rafa ", value)
        assertEquals(value.length, caret)
    }

    @Test
    fun `picking keeps what was written after the token`() {
        val query = MentionAutocomplete.find("hey @raf, you there", 8)!!
        val (value, caret) = MentionAutocomplete.apply("hey @raf, you there", query, "rafa")
        assertEquals("hey @rafa , you there", value)
        assertEquals("hey @rafa ".length, caret)
    }
}
