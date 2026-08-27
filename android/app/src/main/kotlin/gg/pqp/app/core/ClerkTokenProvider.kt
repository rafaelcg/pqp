package gg.pqp.app.core

import com.clerk.api.Clerk
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.session.fetchToken

/**
 * Reads a **fresh** session token per request.
 *
 * `fetchToken` is served from Clerk's own short-lived cache, so calling it on
 * every request is cheap and correct; holding onto what it returns is neither.
 * A `PENDING` session cannot issue a token at all and answers null, which is
 * the right answer to hand upward rather than an exception to swallow.
 */
class ClerkTokenProvider : TokenProvider {
    override suspend fun currentToken(): String? {
        val session = Clerk.session ?: return null
        return when (val result = runCatching { session.fetchToken() }.getOrNull()) {
            is ClerkResult.Success -> result.value.jwt
            else -> null
        }
    }
}
