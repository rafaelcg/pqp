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
/// THREE RULES KEEP THE SET HONEST.
///
/// 1. Optimistic, but never wrongly undone. `block` adds the id BEFORE the
///    request leaves. A definite refusal (the server answered with an error)
///    puts it back; an AMBIGUOUS failure (the connection dropped, or the answer
///    could not be read, so the server may well have committed) is reconciled
///    against the server's own list instead of guessed at, and if even that read
///    fails the screen keeps the safer answer (the person stays hidden) and a
///    retry loop settles it.
/// 2. A read can never overwrite a newer write. Every local mutation bumps
///    `generation`; a list read that began before one is thrown away, so a slow
///    `GET /api/blocks` cannot un-hide a person blocked a moment ago or hide one
///    just unblocked.
/// 3. Until the list has loaded once, a frame that arrived over the socket is not
///    drawn (`Message.arrivedLive`, `BlockRules.hides`): the server does not stamp
///    those per reader, so without the list a blocked person's live message
///    would show. The load retries with backoff until it lands.
@MainActor
@Observable
final class BlockedUsers {
    private(set) var ids: Set<String> = []
    /// Whether a read of the list has landed. Until then live frames from other
    /// people are held back (rule 3).
    private(set) var hasLoaded = false

    /// People unblocked during this session. A message fetched while they were
    /// blocked carries the server's `blocked: true` stamp for good; without this
    /// it would stay hidden after an unblock until it was refetched. Observed,
    /// so the transcript redraws on the unblock.
    private(set) var released: Set<String> = []

    /// Bumped at the start and the end of every local block or unblock.
    @ObservationIgnored private var generation = 0
    /// A mutation ended ambiguously and the server's list has not been read
    /// since: the retry loop owes a reconcile.
    @ObservationIgnored private var needsReconcile = false
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    func contains(_ userId: String) -> Bool { ids.contains(userId) }

    /// Read the list at `.ready` and keep trying, with backoff, until it lands
    /// (and, after an ambiguous write, until it has been reconciled). A second
    /// call while a loop runs does nothing.
    func startLoading(using api: APIClient) {
        guard loadTask == nil else { return }
        loadTask = Task { [weak self] in
            var delay = 1
            while !Task.isCancelled {
                guard let self else { return }
                if self.hasLoaded && !self.needsReconcile { break }
                if await self.refresh(using: api) { break }
                try? await Task.sleep(for: .seconds(delay))
                delay = min(delay * 2, 30)
            }
            self?.loadTask = nil
        }
    }

    /// The server's list, replacing what is held. Returns whether it was applied.
    /// A failed read keeps what is on screen, and so does one that raced a local
    /// mutation (rule 2): it is simply read again.
    @discardableResult
    func refresh(using api: APIClient) async -> Bool {
        let started = generation
        guard let list = try? await api.blocks() else { return false }
        guard started == generation else { return false }
        ids = Set(list.map(\.id))
        hasLoaded = true
        needsReconcile = false
        return true
    }

    /// Block, hiding first. `surface` tells the operators where in the app it
    /// happened (a short token, never content).
    func block(_ userId: String, surface: String, using api: APIClient) async throws {
        generation += 1
        let before = Snapshot(blocked: ids.contains(userId), released: released.contains(userId))
        ids.insert(userId)
        released.remove(userId)
        do {
            try await api.setBlocked(userId: userId, blocked: true, surface: surface)
            generation += 1
        } catch {
            generation += 1
            try await settle(error, userId: userId, wantBlocked: true, before: before, using: api)
        }
    }

    /// Unblock, showing first, same shape as `block`.
    func unblock(_ userId: String, using api: APIClient) async throws {
        generation += 1
        let before = Snapshot(blocked: ids.contains(userId), released: released.contains(userId))
        ids.remove(userId)
        released.insert(userId)
        do {
            try await api.setBlocked(userId: userId, blocked: false)
            generation += 1
        } catch {
            generation += 1
            try await settle(error, userId: userId, wantBlocked: false, before: before, using: api)
        }
    }

    /// One person's state before an attempt, so a refusal puts back EXACTLY what
    /// was there (including whether they were in `released`), not a guess.
    private struct Snapshot {
        let blocked: Bool
        let released: Bool
    }

    /// A write failed. A definite refusal restores the old state and rethrows;
    /// an ambiguous failure asks the server what is true. If the server says the
    /// write DID land, the failure is swallowed: the person is where the reader
    /// asked them to be.
    private func settle(
        _ error: Error, userId: String, wantBlocked: Bool, before: Snapshot, using api: APIClient
    ) async throws {
        guard Self.isAmbiguous(error) else {
            if before.blocked { ids.insert(userId) } else { ids.remove(userId) }
            if before.released { released.insert(userId) } else { released.remove(userId) }
            throw error
        }
        if await refresh(using: api) {
            // The list is authoritative now; a stale stamp on a message does
            // not need overriding for a person the server still has blocked.
            if ids.contains(userId) { released.remove(userId) }
            if ids.contains(userId) == wantBlocked { return }
            throw error
        }
        // Could not even ask. Hidden is the safe side for either direction;
        // the loop reads the list again and puts the truth right.
        ids.insert(userId)
        released.remove(userId)
        needsReconcile = true
        startLoading(using: api)
        throw error
    }

    /// Whether the server may have committed despite the error. Only a 4xx
    /// refusal is definite: a 5xx (a gateway timeout after the write, a crash
    /// after the commit) says nothing about whether the row landed, so it is
    /// reconciled against the server's list like a dropped connection.
    static func isAmbiguous(_ error: Error) -> Bool {
        guard let api = error as? APIError else { return true }
        switch api {
        case .transport, .decoding: return true
        case .server(let status, _): return status >= 500
        case .unauthorized, .notFound, .rateLimited: return false
        }
    }

    /// Sign-out: the next account must not inherit this one's list, and a load
    /// still retrying for it must not land on the next account's.
    func clear() {
        generation += 1
        loadTask?.cancel()
        loadTask = nil
        needsReconcile = false
        ids = []
        released = []
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
    /// The server's per-message flag is honoured too. `listLoaded` false means
    /// the block list has not been read yet: a frame that arrived over the
    /// socket carries no per-reader flag, so it is held back until it has.
    /// `released` is who was unblocked this session: their messages fetched
    /// while blocked still carry the stamp, which no longer applies.
    static func hides(
        _ message: Message, viewerId: String?, blocked: Set<String>,
        listLoaded: Bool = true, released: Set<String> = []
    ) -> Bool {
        guard message.authorId != viewerId else { return false }
        if !listLoaded && message.arrivedLive { return true }
        if blocked.contains(message.authorId) { return true }
        return message.blocked && !released.contains(message.authorId)
    }

    /// The reactions a message shows once the blocked person's are taken out.
    ///
    /// A chip that still reads "🎉 Demo Friend" after the block is the person
    /// still on screen. Each reaction loses the blocked users it lists and its
    /// count drops by exactly that many; a chip left with nobody goes. The
    /// reader's own reaction is never touched. The server lists who reacted
    /// (`users`), and where it does not (an older server) there is nothing to
    /// match a block against, so the reaction stays as it was.
    static func reactions(
        _ reactions: [MessageReaction], blocked: Set<String>
    ) -> [MessageReaction] {
        guard !blocked.isEmpty else { return reactions }
        return reactions.compactMap { reaction in
            let hidden = reaction.users.filter { blocked.contains($0.id) }.count
            guard hidden > 0 else { return reaction }
            var next = reaction
            next.users.removeAll { blocked.contains($0.id) }
            next.count = max(reaction.count - hidden, 0)
            return next.count > 0 ? next : nil
        }
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

/// Somebody about to be blocked from a menu that is not a profile: who, what to
/// call them in the question, and the `surface` token the operators' log line
/// carries.
struct BlockPersonTarget: Identifiable, Equatable {
    let userId: String
    let name: String
    let surface: String
    var id: String { userId }
}

/// Asks once, then blocks through the shared store: the person disappears from
/// every list on the tap (`BlockedUsers`), and the operators are told. A
/// refusal is said in an alert, and the store has already put the person back.
private struct BlockAuthorConfirmation: ViewModifier {
    @Binding var target: BlockPersonTarget?
    @Environment(SessionStore.self) private var session
    @State private var failure: String?

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                String(localized: "Block \(target?.name ?? "")?"),
                isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
                titleVisibility: .visible,
                presenting: target
            ) { person in
                Button("Block", role: .destructive) {
                    Task {
                        do {
                            try await session.blocked.block(
                                person.userId, surface: person.surface, using: session.api
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
    /// A message's author, from the long-press menu.
    func blockAuthorConfirmation(_ target: Binding<Message?>) -> some View {
        blockPersonConfirmation(Binding(
            get: {
                target.wrappedValue.map {
                    BlockPersonTarget(userId: $0.authorId, name: $0.authorName, surface: "message")
                }
            },
            set: { if $0 == nil { target.wrappedValue = nil } }
        ))
    }

    /// Anybody else, from a menu that is not a message's (a Baú post or comment).
    func blockPersonConfirmation(_ target: Binding<BlockPersonTarget?>) -> some View {
        modifier(BlockAuthorConfirmation(target: target))
    }
}
