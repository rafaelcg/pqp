import Foundation
import Observation
import SwiftUI

/// Who this account has blocked, held in memory so a block takes effect on every
/// screen the moment it is made.
///
/// WHY THIS EXISTS. The server has always enforced a block where it can (no new
/// DMs, no badges, no pushes, no mentions, no stories), but it deliberately
/// keeps a blocked author's rows in a shared server channel so keyset paging
/// stays honest, and a frame that arrives over the socket is not stamped per
/// reader at all. Hiding is the client's job. Before this, iOS only honoured the
/// per-message `blocked` flag the server stamps on a history fetch, so:
/// blocking somebody left their messages on screen until the channel was
/// reopened, a message they posted a second later showed in full, and their
/// conversation, their story ring and their forum posts stayed where they were.
/// App Store guideline 1.2 asks that a block removes the content from the feed
/// instantly, so every list that can show somebody asks `contains` instead.
///
/// The set is optimistic. `block` adds the id BEFORE the request leaves, so the
/// screen is clean on the tap; a refusal puts it back and rethrows so the sheet
/// can say why. Observation tracks `ids`, so a view that reads it redraws.
@MainActor
@Observable
final class BlockedUsers {
    private(set) var ids: Set<String> = []
    /// Whether a read of the list has ever landed. Nothing waits on it: until
    /// then the per-message flag the server stamps is still honoured.
    private(set) var hasLoaded = false

    func contains(_ userId: String) -> Bool { ids.contains(userId) }

    /// The server's list, replacing what is held. A failed read keeps what is on
    /// screen: a blocked person must not reappear because the network blinked.
    func refresh(using api: APIClient) async {
        guard let list = try? await api.blocks() else { return }
        // A block made while the read was in flight is newer than it is.
        ids = Set(list.map(\.id)).union(pending)
        hasLoaded = true
    }

    /// Ids added optimistically whose request has not settled, so a refresh that
    /// raced it does not briefly un-hide them.
    @ObservationIgnored private var pending: Set<String> = []

    /// Block, hiding first. `surface` tells the operators where in the app it
    /// happened (a short token, never content).
    func block(_ userId: String, surface: String, using api: APIClient) async throws {
        ids.insert(userId)
        pending.insert(userId)
        defer { pending.remove(userId) }
        do {
            try await api.setBlocked(userId: userId, blocked: true, surface: surface)
        } catch {
            ids.remove(userId)
            throw error
        }
    }

    /// Unblock, showing first, same shape as `block`.
    func unblock(_ userId: String, using api: APIClient) async throws {
        let wasBlocked = ids.remove(userId) != nil
        do {
            try await api.setBlocked(userId: userId, blocked: false)
        } catch {
            if wasBlocked { ids.insert(userId) }
            throw error
        }
    }

    /// Sign-out: the next account must not inherit this one's list.
    func clear() {
        ids = []
        pending = []
        hasLoaded = false
    }

    /// Test seam.
    func seed(_ userIds: Set<String>) {
        ids = userIds
        hasLoaded = true
    }
}

/// The rules for what a block hides. Pure, so they are tested without a screen.
enum BlockRules {
    /// A message is drawn only when its author is somebody the reader has not
    /// blocked. The reader's own messages are never hidden: blocking yourself is
    /// not a thing, and a reader hiding their own words reads as data loss.
    /// The server's per-message flag is honoured too, for the window before the
    /// list has loaded.
    static func hides(_ message: Message, viewerId: String?, blocked: Set<String>) -> Bool {
        guard message.authorId != viewerId else { return false }
        return message.blocked || blocked.contains(message.authorId)
    }

    /// A conversation is hidden from the list when it is a 1:1 with somebody
    /// blocked. A group stays (the other members are not blocked), and its
    /// preview line is dropped when the newest message is the blocked person's.
    static func hides(_ conversation: DmSummary, blocked: Set<String>) -> Bool {
        guard conversation.kind == "dm", conversation.participants.count == 1 else { return false }
        return blocked.contains(conversation.participants[0].id)
    }

    /// The conversation as a row shows it: its preview removed when the newest
    /// message was written by somebody blocked.
    static func masked(_ conversation: DmSummary, blocked: Set<String>) -> DmSummary {
        guard let last = conversation.lastMessage, blocked.contains(last.authorId) else {
            return conversation
        }
        var next = conversation
        next.lastMessage = nil
        return next
    }

    /// The list a Conversas tab or a hub draws.
    static func visible(_ list: [DmSummary], blocked: Set<String>) -> [DmSummary] {
        guard !blocked.isEmpty else { return list }
        return list
            .filter { !hides($0, blocked: blocked) }
            .map { masked($0, blocked: blocked) }
    }
}

// MARK: - The confirmation, from a message's long-press menu

/// Asks once, then blocks through the shared store: the person disappears from
/// every list on the tap (`BlockedUsers`), and the operators are told. A
/// refusal is said in an alert, and the store has already put the person back.
private struct BlockAuthorConfirmation: ViewModifier {
    @Binding var target: Message?
    @Environment(SessionStore.self) private var session
    @State private var failure: String?

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                String(localized: "Block \(target?.authorName ?? "")?"),
                isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
                titleVisibility: .visible,
                presenting: target
            ) { message in
                Button("Block", role: .destructive) {
                    Task {
                        do {
                            try await session.blocked.block(
                                message.authorId, surface: "message", using: session.api
                            )
                        } catch {
                            failure = (error as? APIError)?.errorDescription ?? error.localizedDescription
                        }
                    }
                }
            } message: { _ in
                Text("Blocking also ends the friendship and hides their messages.")
            }
            .alert(
                "Could not block",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
    }
}

extension View {
    func blockAuthorConfirmation(_ target: Binding<Message?>) -> some View {
        modifier(BlockAuthorConfirmation(target: target))
    }
}
