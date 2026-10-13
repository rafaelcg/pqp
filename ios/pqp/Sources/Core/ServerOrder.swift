import Foundation

/// The order of a person's own server list, and the one rule with an edge:
/// where a step up or down stops.
///
/// The list itself comes back from `GET /api/servers` already in the order
/// the person saved (on the web by dragging the rail, here by the menu), so
/// reading needs nothing. This is only the move.
enum ServerOrder {
    /// `items` with the one whose id is `id` moved `delta` places, or nil when
    /// nothing would change (an unknown id, or already at that end). Callers
    /// treat nil as "do not save anything".
    static func moved<T: Identifiable>(_ items: [T], id: T.ID, by delta: Int) -> [T]? {
        guard let from = items.firstIndex(where: { $0.id == id }) else { return nil }
        let to = min(max(from + delta, 0), items.count - 1)
        guard to != from else { return nil }
        var next = items
        next.insert(next.remove(at: from), at: to)
        return next
    }
}

extension APIClient {
    /// `PUT /api/servers/order`: save the order this person drew for their own
    /// list. Per person, nobody else's list moves. The server drops ids this
    /// account no longer holds rather than refusing, so a stale list is not an
    /// error. The answer (the order as stored) is not read: the caller already
    /// shows it.
    func saveServerOrder(_ serverIds: [String]) async throws {
        struct Body: Encodable { let serverIds: [String] }
        let _: EmptyResponse = try await send(
            path: "/api/servers/order", method: "PUT", body: Body(serverIds: serverIds)
        )
    }
}
