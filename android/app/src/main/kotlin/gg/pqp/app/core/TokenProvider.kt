package gg.pqp.app.core

/**
 * How the app proves who it is, and the only seam anything above this file
 * knows about.
 *
 * The contract is deliberately "give me a token *now*", not "here is a token".
 * Clerk session tokens live about a minute, so anything that caches one (or
 * captures it at launch) works for sixty seconds and then 401s forever. That
 * exact bug has already shipped once on the web client and is called out in
 * `docs/IOS.md`; there is no reason to make it a third time.
 */
fun interface TokenProvider {
    suspend fun currentToken(): String?
}

/**
 * The fixed token the server accepts only when `DEV_AUTH_BYPASS=true` and
 * `NODE_ENV != production`. It cannot reach the hosted API at all, by design.
 *
 * A suffix mints a separate identity server-side (`dev-local-token:alice` is
 * `dev_local_user_alice`), which is how two accounts can be signed in on two
 * emulators without a Clerk inbox. The alphabet is `[a-z0-9_-]{1,32}`; anything
 * else is a rejected token rather than a fallback, so it is validated here
 * rather than discovered as a 401.
 */
class DevTokenProvider(suffix: String? = null) : TokenProvider {
    private val token: String = when {
        suffix.isNullOrBlank() -> DEV_AUTH_TOKEN
        SUFFIX.matches(suffix) -> "$DEV_AUTH_TOKEN:$suffix"
        else -> DEV_AUTH_TOKEN
    }

    override suspend fun currentToken(): String = token

    companion object {
        /** Mirrors `DEV_AUTH_TOKEN` in `packages/shared/src/auth.ts`. */
        const val DEV_AUTH_TOKEN = "dev-local-token"
        private val SUFFIX = Regex("^[a-z0-9_-]{1,32}$")
    }
}
