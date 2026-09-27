package gg.pqp.app.core

import java.util.UUID

/**
 * A per-attempt id for the `Idempotency-Key` header on a room-creating POST
 * ([ApiClient.createServer]). Generated once when an attempt starts and
 * reused on a retry of that same attempt, so a client that loses the
 * response to a create (network drop, timeout) and tries again gets the
 * room it already made instead of a second one. See
 * `server/src/services/idempotency-keys.ts` for the server half, and
 * `client/src/lib/idempotency.ts` for the same contract on the web client.
 */
fun createIdempotencyKey(): String = UUID.randomUUID().toString()

/**
 * Holds the key for one create attempt, keyed by the content being created
 * (a trimmed room name) so a retry with unchanged input reuses the key and
 * an edited input starts a fresh attempt rather than accidentally replaying
 * a stale one under new content.
 */
class IdempotencyAttempt {
    private var content: String? = null
    private var key: String? = null

    /** Returns the key for this content, generating a new one only when the
     * content has changed since the last call. */
    fun keyFor(content: String): String {
        val existing = key
        if (this.content != content || existing == null) {
            val fresh = createIdempotencyKey()
            this.content = content
            this.key = fresh
            return fresh
        }
        return existing
    }

    /** Call after a successful create: the attempt is over, and the next
     * call to [keyFor], even with the same content, starts a new one. */
    fun reset() {
        content = null
        key = null
    }
}
