import Foundation

/// CHAMAR A ATENÇÃO (the nudge), the iOS half of `packages/shared/src/nudge.ts`.
///
/// A one-tap "olha aqui" between two friends in a 1:1. On the wire it is an
/// ordinary message whose `systemKind` is `"nudge"` and whose body is
/// `NudgeRules.body` (an older build renders the bubble, which is readable).
/// The server enforces every rule (friends only, cooldown, unanswered cap,
/// Não perturbe, the two-way opt-out); this file holds the client's own rules:
/// when a received nudge is fresh enough to shake, and what each refusal says.
enum NudgeRules {
    /// The stored body. What an older client draws.
    static let body = "📳"

    /// One nudge per sender per conversation in this window (server side too).
    static let cooldown: TimeInterval = 10

    /// How old a nudge may be on receipt and still shake. Older is history (a
    /// reload, a reconnect backfill, a slow socket) and draws its line only.
    static let freshWindow: TimeInterval = 15

    /// Whether a nudge just received should shake the screen and buzz. Only a
    /// fresh one from somebody else: one read out of history, replayed after a
    /// reconnect, or sent by me is a line and nothing more. Port of
    /// `isFreshNudge`, with the same slack below zero for a server clock ahead
    /// of ours.
    static func isFresh(_ message: Message, viewerId: String?, now: Date = Date()) -> Bool {
        guard message.isNudge else { return false }
        if let viewerId, message.authorId == viewerId { return false }
        let age = now.timeIntervalSince(message.createdAt)
        return age >= -freshWindow && age < freshWindow
    }

    /// The two-way opt-out, with its default applied: on unless turned off.
    static func allowed(_ preferences: UserPreferences?) -> Bool {
        preferences?.allowNudges != false
    }

    /// The header button is offered in a 1:1 with a friend, while the flag is
    /// on and this account has not turned nudges off. The server checks all
    /// of it again; this only decides whether the button is drawn.
    static func offersButton(
        flagOn: Bool,
        conversationKind: String?,
        otherIsFriend: Bool,
        preferences: UserPreferences?
    ) -> Bool {
        flagOn && conversationKind == "dm" && otherIsFriend && allowed(preferences)
    }

    /// The short line a refusal leaves under the transcript. `name` is the
    /// other person. Unknown reasons read as `unavailable`, the catch-all the
    /// server uses on purpose (telling those apart would leak a block).
    static func refusalCopy(_ reason: String, name: String) -> String {
        switch reason {
        case "cooldown": String(localized: "Easy! Wait a few seconds to nudge again.")
        case "unanswered": String(localized: "\(name) hasn't answered yet. Send a message.")
        case "busy": String(localized: "\(name) is busy right now. Send a message.")
        case "self-off": String(localized: "You turned nudges off. Turn them back on in Settings.")
        default: String(localized: "Couldn't nudge right now.")
        }
    }

    /// The centred line in the transcript.
    static func lineText(mine: Bool, name: String) -> String {
        mine
            ? String(localized: "You nudged \(name).")
            : String(localized: "\(name) nudged you!")
    }
}

/// `nudge-refused`: the nudge did not land, and nothing was stored. Addressed
/// to the sender's sockets only.
struct NudgeRefusal: Hashable, Sendable {
    let channelId: String
    let nonce: String?
    let reason: String
    let retryAfterMs: Int?
}

/// `GET /api/fun/config`: the small, playful switches. Anything but an
/// explicit `true` is off, so an API older than the route (404) hides the
/// button.
struct FunConfig: Codable, Hashable, Sendable {
    var nudge: Bool

    static let off = FunConfig(nudge: false)

    init(nudge: Bool) { self.nudge = nudge }

    private enum CodingKeys: String, CodingKey { case nudge }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        nudge = ((try? c.decodeIfPresent(Bool.self, forKey: .nudge)) ?? nil) == true
    }
}

/// The two reads the nudge button needs, kept for a minute so walking
/// through DMs does not download the friend list once per conversation. A
/// minute late on a new friendship costs a button that appears on the next
/// open; the server checks friendship on every nudge anyway.
actor NudgeLookups {
    static let shared = NudgeLookups()
    static let ttl: TimeInterval = 60

    private var config: (value: FunConfig, at: Date)?
    private var friendIds: (value: Set<String>, at: Date)?

    func funConfig(api: APIClient, now: Date = Date()) async -> FunConfig {
        if let config, now.timeIntervalSince(config.at) < Self.ttl { return config.value }
        let fresh = await api.funConfig()
        config = (fresh, now)
        return fresh
    }

    func isFriend(_ userId: String, api: APIClient, now: Date = Date()) async -> Bool {
        if let friendIds, now.timeIntervalSince(friendIds.at) < Self.ttl {
            return friendIds.value.contains(userId)
        }
        guard let response = try? await api.friends() else {
            return friendIds?.value.contains(userId) ?? false
        }
        let ids = Set(response.friends.map(\.id))
        friendIds = (ids, now)
        return ids.contains(userId)
    }
}

extension Message {
    /// A chamar a atenção, written by the server rather than typed.
    var isNudge: Bool { systemKind == "nudge" }
}

extension APIClient {
    /// Not memoised: `nudge` is a runtime flag an operator flips live, and the
    /// server refuses the frame while it is off whatever this answered. Off on
    /// any failure, so a blip hides the button rather than offering a dead one.
    func funConfig() async -> FunConfig {
        (try? await get("/api/fun/config")) ?? .off
    }
}
