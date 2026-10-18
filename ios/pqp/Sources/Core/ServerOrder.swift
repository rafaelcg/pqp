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

    /// `servers` in the order `ids` names. Ids the list does not hold are
    /// ignored; servers `ids` does not name keep their place after the named
    /// ones. Only the ORDER changes: every other field on the rows stays as it
    /// is now, which is what a rollback after a refused save needs.
    static func applying<T: Identifiable>(_ ids: [T.ID], to items: [T]) -> [T] {
        var byId: [T.ID: T] = [:]
        for item in items { byId[item.id] = item }
        var out: [T] = []
        for id in ids {
            if let item = byId.removeValue(forKey: id) { out.append(item) }
        }
        out.append(contentsOf: items.filter { byId[$0.id] != nil })
        return out
    }
}

extension ServerOrder {
    /// What to do with a `server-order-update` frame from another tab or device.
    enum RemoteAction: Equatable {
        /// The echo of this client's own save: it already shows that order, and
        /// applying it could undo a second move made while the first save was in
        /// the air.
        case ignore
        /// A save of ours is in the air: the frame cannot be ordered against it.
        /// Note it, and read the list again when the saves have drained, so the
        /// server's answer wins.
        case resyncAfterSave
        /// Follow it.
        case apply
    }

    /// The web's rule (`App.tsx`, `server-order-saver.ts`): own origin is
    /// ignored; a save in flight defers; otherwise the order is applied.
    static func remoteAction(origin: String?, ownOrigin: String, saving: Bool) -> RemoteAction {
        if let origin, !origin.isEmpty, origin == ownOrigin { return .ignore }
        return saving ? .resyncAfterSave : .apply
    }
}

extension APIClient {
    /// `PUT /api/servers/order`: save the order this person drew for their own
    /// list. Per person, nobody else's list moves. The server drops ids this
    /// account no longer holds rather than refusing, so a stale list is not an
    /// error. The answer (the order as stored) is not read: the caller already
    /// shows it.
    ///
    /// `origin` is this client's random id: the server echoes it on the
    /// `server-order-update` frame it sends to the account's other sockets, so
    /// this one can skip the frame about its own save.
    func saveServerOrder(_ serverIds: [String], origin: String? = nil) async throws {
        struct Body: Encodable { let serverIds: [String]; let origin: String? }
        let _: EmptyResponse = try await send(
            path: "/api/servers/order", method: "PUT", body: Body(serverIds: serverIds, origin: origin)
        )
    }
}
