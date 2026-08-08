import Foundation

/// Friends and threads, as endpoints.
///
/// Kept beside the models rather than in APIClient.swift for the same reason
/// the server appended its friends routes as a self-contained section: the two
/// features are additive, and a file nobody else has to open is a file nobody
/// else has to merge.
extension APIClient {
    // MARK: - Friends

    /// The whole relationship surface in one read. Three lists, one round trip
    /// — the server assembles them from a single table read.
    func friends() async throws -> FriendsResponse {
        try await get("/api/friends")
    }

    /// Send a request by user id — the id comes from the exact `name#1234`
    /// lookup or the budgeted prefix search, which is why friends add no new
    /// discovery surface of their own.
    ///
    /// Every refusal answers with the same sentence on purpose ("cannot send a
    /// friend request to this user"): telling "you blocked them" apart from
    /// "they blocked you" would make this route an oracle for who has blocked
    /// you. Show the server's wording, never a guess.
    @discardableResult
    func sendFriendRequest(userId: String) async throws -> FriendRequestResult {
        struct Body: Encodable { let userId: String }
        return try await post("/api/friends", body: Body(userId: userId))
    }

    /// Accept a request somebody sent us. 404 when none is waiting — which is
    /// what a stale list looks like, so it is worth surfacing rather than
    /// swallowing.
    func acceptFriendRequest(userId: String) async throws {
        let _: EmptyResponse = try await post(
            "/api/friends/\(userId)/accept", body: EmptyBody()
        )
    }

    /// Decline, cancel, or unfriend. ONE call, because the server models all
    /// three as "make this row not exist" — their differences are entirely in
    /// who is looking. All three are silent to the other side, which is the
    /// whole social contract that makes declining cheap enough to actually do.
    func removeFriendship(userId: String) async throws {
        let _: EmptyResponse = try await delete("/api/friends/\(userId)")
    }

    // MARK: - Threads

    /// Start a thread from a message, or get back the one it already has —
    /// idempotent server-side (a unique index on the origin message), so two
    /// taps race to the same row rather than to two threads.
    ///
    /// `name` is optional; omitted, the server derives one from the origin
    /// message body (`ThreadRules.deriveName` computes the same string).
    func createThread(messageId: String, name: String? = nil) async throws -> ThreadSummary {
        struct Body: Encodable { let name: String? }
        struct Response: Decodable { let thread: ThreadSummary }
        let response: Response = try await post(
            "/api/messages/\(messageId)/threads", body: Body(name: name)
        )
        return response.thread
    }
}
