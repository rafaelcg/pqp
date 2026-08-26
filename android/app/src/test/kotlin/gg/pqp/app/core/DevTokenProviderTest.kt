package gg.pqp.app.core

import gg.pqp.app.protocol.RepoSources
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The dev bypass, which is the only way two accounts get signed in on two
 * emulators without a Clerk inbox.
 *
 * The suffix alphabet is the server's, and an invalid one is a **rejected
 * token** rather than a fallback identity, so validating it here is the
 * difference between "that name has an underscore in it" and an unexplained
 * 401 on a second device.
 */
class DevTokenProviderTest {

    private val serverAlphabet = Regex("^[a-z0-9_-]{1,32}$")

    @Test
    fun `the base token is exactly the one shared declares`() = runTest {
        assertEquals(
            RepoSources.stringConstant("packages/shared/src/auth.ts", "DEV_AUTH_TOKEN"),
            DevTokenProvider().currentToken(),
        )
    }

    @Test
    fun `a suffix mints a separate identity`() = runTest {
        assertEquals("dev-local-token:bob", DevTokenProvider("bob").currentToken())
        assertEquals("dev-local-token:alice_2", DevTokenProvider("alice-2".replace('-', '_')).currentToken())
    }

    @Test
    fun `a suffix the server would reject falls back to the plain token`() = runTest {
        val rejected = listOf(
            "Bob",                      // uppercase
            "bob bob",                  // space
            "bob!",                     // punctuation
            "b".repeat(33),             // too long
            "",                         // empty
            "  ",                       // blank
        )
        rejected.forEach { suffix ->
            assertEquals(
                "\"$suffix\" is not a valid suffix and must not be appended",
                "dev-local-token",
                DevTokenProvider(suffix).currentToken(),
            )
        }
    }

    @Test
    fun `every suffix this client will append is one the server's alphabet accepts`() = runTest {
        val accepted = listOf("bob", "alice", "a", "b".repeat(32), "user_1", "user-1", "9")
        accepted.forEach { suffix ->
            val token = DevTokenProvider(suffix).currentToken()
            assertEquals("dev-local-token:$suffix", token)
            val appended = token.substringAfter(':')
            assert(serverAlphabet.matches(appended)) { "\"$appended\" is outside the server's alphabet" }
        }
    }

    @Test
    fun `a null suffix is the ordinary single-account case`() = runTest {
        assertEquals("dev-local-token", DevTokenProvider(null).currentToken())
    }
}
