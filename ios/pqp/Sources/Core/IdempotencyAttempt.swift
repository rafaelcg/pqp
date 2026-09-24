import Foundation

/// A per-attempt id for the `Idempotency-Key` header on a room-creating POST
/// (`APIClient.createServer`). Generated once when an attempt starts and
/// reused on a retry of that same attempt, so a client that loses the
/// response to a create (network drop, timeout) and tries again gets the
/// room it already made instead of a second one. See
/// `server/src/services/idempotency-keys.ts` for the server half and
/// `client/src/lib/idempotency.ts` for the web equivalent this mirrors.
func createIdempotencyKey() -> String {
    UUID().uuidString
}

/// Holds the key for one create attempt, keyed by the content being created
/// (a trimmed room name today) so a retry with unchanged input reuses the
/// key and an edited input starts a fresh attempt rather than accidentally
/// replaying a stale one under new content.
final class IdempotencyAttempt {
    private var content: String?
    private var key: String?

    init() {}

    /// Returns the key for this content, generating a new one only when the
    /// content has changed since the last call.
    func keyFor(_ content: String) -> String {
        if self.content != content || key == nil {
            self.content = content
            key = createIdempotencyKey()
        }
        return key!
    }

    /// Call after a successful create: the attempt is over, and the next
    /// call to `keyFor` (even with the same content) starts a new one.
    func reset() {
        content = nil
        key = nil
    }
}
