import Foundation

// Wire shapes for the two *social* features the server already ships: friends
// (`packages/shared/src/friends.ts`) and threads
// (`packages/shared/src/threads.ts`). Same rule as Models.swift — every `?`
// here mirrors a `.nullable()` there, and the pure helpers below are ports of
// the web client's `friends-model.ts` / `threads.ts` rather than reinventions,
// so the two clients cannot drift on what "online" or "archived" means.

// MARK: - Friends

/// An accepted friend. `status` is the ONE place presence crosses a server
/// boundary, and the server's type cannot carry `invisible` — an invisible
/// friend arrives as `offline` by construction, exactly like the members list.
struct Friend: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
    let username: String?
    let tag: String?
    let avatarUrl: String?
    /// `"online" | "idle" | "dnd" | "offline"`. Feeds `StatusDot` unchanged.
    let status: String
    let friendsSince: Date

    /// The same person as the shapes every other screen already takes.
    var asPublicUser: PublicUser {
        PublicUser(id: id, displayName: displayName, username: username,
                   tag: tag, avatarUrl: avatarUrl)
    }
}

/// A pending request, incoming or outgoing. Deliberately a public user plus a
/// timestamp and NOTHING more — above all no status: until you accept, the
/// other person is a stranger, and a stranger must not learn whether you are at
/// your keyboard by the act of asking.
struct FriendRequestEntry: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
    let username: String?
    let tag: String?
    let avatarUrl: String?
    let requestedAt: Date

    var asPublicUser: PublicUser {
        PublicUser(id: id, displayName: displayName, username: username,
                   tag: tag, avatarUrl: avatarUrl)
    }
}

/// `GET /api/friends` — the whole relationship surface in one read.
struct FriendsResponse: Codable, Hashable, Sendable {
    var friends: [Friend] = []
    var incoming: [FriendRequestEntry] = []
    var outgoing: [FriendRequestEntry] = []
}

/// `POST /api/friends`. `accepted` covers both the auto-accept (they had
/// already asked you) and "you were already friends" — the caller's next
/// question is only ever "may I show this person as a friend now".
struct FriendRequestResult: Codable, Hashable, Sendable {
    let state: String

    var isAccepted: Bool { state == "accepted" }
}

/// The friends view's pure logic, out of the view so it is testable without a
/// screen. Ported from `client/src/components/friends/friends-model.ts`.
enum FriendsDigest {
    /// Everyone the server did not resolve to `offline`. Idle and
    /// do-not-disturb both count as "around": the tab answers "who could I talk
    /// to", and someone who stepped away or asked not to be pinged is still
    /// here in the way that matters.
    static func online(_ friends: [Friend]) -> [Friend] {
        friends.filter { $0.status != "offline" }
    }

    /// Online first, then the rest; the server's alphabetical order is
    /// preserved inside each half.
    static func onlineFirst(_ friends: [Friend]) -> [Friend] {
        online(friends) + friends.filter { $0.status == "offline" }
    }

    /// What the badge counts: requests waiting on YOU. Outgoing ones are
    /// excluded on purpose — a badge is a call to action, and there is no
    /// action to take on a request you already sent.
    static func pendingActionCount(_ response: FriendsResponse) -> Int {
        response.incoming.count
    }

    /// Ids that must not be offered as "add a friend" results: yourself,
    /// existing friends, and anyone already mid-request in either direction.
    /// Offering the button to an existing friend adds nothing and reads as a bug.
    static func alreadyKnown(_ response: FriendsResponse, selfId: String?) -> Set<String> {
        var ids = Set<String>()
        if let selfId { ids.insert(selfId) }
        for friend in response.friends { ids.insert(friend.id) }
        for entry in response.incoming { ids.insert(entry.id) }
        for entry in response.outgoing { ids.insert(entry.id) }
        return ids
    }
}

// MARK: - Threads

/// A thread, as every consumer of "this message has a thread" gets it: enough
/// to draw the chip (count, freshness, archived state) and to open it
/// (`channelId`).
///
/// THE MODEL, STATED ONCE: a thread IS a channel. That is why opening one needs
/// no new machinery here — `ChatView`/`ChatModel` are keyed by channel id and a
/// thread id is a channel id, `join-channel` included.
///
/// `rootMessageId` is nullable because deleting the origin message keeps the
/// thread: the conversation that grew out of a message is not the message.
struct ThreadSummary: Codable, Identifiable, Hashable, Sendable {
    let channelId: String
    let parentChannelId: String
    let rootMessageId: String?
    let name: String
    /// Messages *in* the thread. The origin lives in the parent channel, so a
    /// fresh thread reads 0 — every message in the thread is a reply.
    let replyCount: Int
    let lastActivityAt: Date
    /// Computed server-side from `lastActivityAt`; recomputed locally by
    /// `ThreadRules.isArchived` when the summary has been sitting on screen.
    let archived: Bool

    var id: String { channelId }
}

/// The thread constants and derivations, shared with the server so the two
/// agree. Ported from `packages/shared/src/threads.ts`.
enum ThreadRules {
    /// A thread with no message for this long reads as archived. There is no
    /// sweeper and nothing to un-archive: saying something in an archived
    /// thread makes it active again by making the condition false.
    static let autoArchiveDays = 7
    static let nameMaxLength = 80

    static func isArchived(_ lastActivityAt: Date, now: Date = Date()) -> Bool {
        now.timeIntervalSince(lastActivityAt) > Double(autoArchiveDays) * 24 * 3600
    }

    /// The default name the server would derive, computed locally so the
    /// rename field can be seeded with the same text the server would store.
    /// Character-count based, like the shared helper — Swift's `String` is
    /// grapheme-indexed, so the surrogate-pair guard the TypeScript version
    /// needs has no analogue here.
    static func deriveName(from originBody: String) -> String {
        let flat = originBody
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if flat.isEmpty { return "thread" }
        if flat.count <= nameMaxLength { return flat }
        let cut = flat.prefix(nameMaxLength - 1)
            .trimmingCharacters(in: .whitespaces)
        return "\(cut)…"
    }
}

/// Which threads a page of messages knows about.
///
/// There is no `GET /api/channels/:id/threads` on the server — a thread rides
/// on its origin message (`hydrate` folds it into every history page), so the
/// channel's thread list is *derived* from the messages the client already has
/// rather than fetched. Pure, so the derivation is testable without a network.
enum ThreadDigest {
    /// Freshest first, deduplicated by channel id.
    static func threads(in messages: [Message]) -> [ThreadSummary] {
        var seen = Set<String>()
        var found: [ThreadSummary] = []
        for message in messages {
            guard let thread = message.thread, !seen.contains(thread.channelId) else { continue }
            seen.insert(thread.channelId)
            found.append(thread)
        }
        return found.sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    /// The origin message body for a thread, when the page that produced the
    /// list still has it — context for the list row, never fetched separately.
    static func origins(in messages: [Message]) -> [String: Message] {
        var byThread: [String: Message] = [:]
        for message in messages {
            if let thread = message.thread {
                byThread[thread.channelId] = message
            }
        }
        return byThread
    }
}
