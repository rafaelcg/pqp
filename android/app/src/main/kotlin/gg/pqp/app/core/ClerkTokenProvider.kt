package gg.pqp.app.core

import com.clerk.api.Clerk
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.session.GetTokenOptions
import com.clerk.api.session.Session
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

    /**
     * Forces a round trip to Clerk instead of the cached token, and says why
     * when there is none. A session Clerk itself no longer holds as active
     * (replaced by a sign-in on another device under single session mode,
     * ended, expired, revoked) is [TokenRefresh.NoSession]; a refresh that
     * failed without Clerk saying so (offline, a 5xx) is
     * [TokenRefresh.Unavailable].
     */
    override suspend fun refreshedToken(): TokenRefresh {
        val session = Clerk.session ?: return TokenRefresh.NoSession
        // A sign-in waiting on a step is unfinished, not over: never a reason to sign anybody out.
        if (session.status == Session.SessionStatus.PENDING) return TokenRefresh.Unavailable
        if (SessionExpiry.isOver(session.status)) return TokenRefresh.NoSession
        val result = try {
            session.fetchToken(GetTokenOptions(skipCache = true))
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            return TokenRefresh.Unavailable
        }
        return when (result) {
            is ClerkResult.Success -> TokenRefresh.Token(result.value.jwt)
            is ClerkResult.Failure -> SessionExpiry.classifyRefreshFailure(result.code)
        }
    }
}
