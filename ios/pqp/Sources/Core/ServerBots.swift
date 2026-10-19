import Foundation

// Server bots on the phone, native v1: the BOT and BETA tags, the limit
// notice a member gets when a bot did not answer them, and the "working" text
// a bot shows in place of "is typing". Cards and the animated face come later.
//
// The wire contract is in packages/shared/src/bots.ts (`botNoticeSchema`) and
// packages/shared/src/chat.ts (`activity` on `typing-broadcast`). The words are
// the web's (`chat.botNotice.*`, `chat.botActivity.*`).

/// How a server bot is recognised. There is no `isBot` on a message or a
/// member: a bot's avatar is its Breu face, served by the API at
/// `/api/bot-faces/<color>/<face>.png?v=1`, and no uploaded avatar can have
/// that address. The web reads the same fact in `parseBotFaceAvatar`.
enum ServerBot {
    private static let marker = "/api/bot-faces/"

    /// True for a root-relative face URL and for the same URL after the app
    /// resolved it against the API host. The shape is matched, not the colour
    /// and face lists, so a colour added on the server needs no app update.
    static func isFaceAvatar(_ url: String?) -> Bool {
        guard let url, let range = url.range(of: marker) else { return false }
        // What comes before the path must be nothing or an origin, so
        // `https://elsewhere/x?u=/api/bot-faces/...` and `/uploads/api/bot-faces/...`
        // are not bots.
        let head = url[url.startIndex..<range.lowerBound]
        if !head.isEmpty {
            guard head.hasPrefix("http://") || head.hasPrefix("https://") else { return false }
            let origin = head.drop(while: { $0 != "/" }).dropFirst(2)
            guard !origin.isEmpty, !origin.contains(where: { "/?#".contains($0) }) else { return false }
        }
        let tail = url[range.upperBound...]
        let path = tail.prefix(while: { $0 != "?" && $0 != "#" })
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[0].allSatisfy(isLowerAscii) else { return false }
        guard parts[1].hasSuffix(".png") else { return false }
        let face = parts[1].dropLast(4)
        return !face.isEmpty && face.allSatisfy(isLowerAscii)
    }

    private static func isLowerAscii(_ c: Character) -> Bool {
        c.isASCII && c.isLowercase
    }

    /// ISO 8601 with or without fractional seconds, the two shapes the server writes.
    static func parseDate(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }
}

extension Message {
    /// Written by a server bot. See `ServerBot`.
    var isServerBot: Bool { ServerBot.isFaceAvatar(authorAvatarUrl) }
}

extension ServerMember {
    var isServerBot: Bool { ServerBot.isFaceAvatar(avatarUrl) }
}

/// A `bot-notice` frame: sent only to the member the bot did not answer, on
/// their own sockets. Nothing is posted in the channel.
struct BotNotice: Equatable, Sendable {
    enum Reason: String, Sendable {
        case busy
        case memberHour = "member-hour"
        case serverDay = "server-day"
        case budget
    }

    let channelId: String
    let botUserId: String
    let botName: String
    let reason: Reason
    /// The limit that was reached, for `member-hour` and `server-day`.
    let limit: Int?
    /// When the bot will answer again, if the server knows.
    let retryAt: Date?

    /// The notice stops being true once the bot is due to answer again.
    func isExpired(at now: Date = Date()) -> Bool {
        guard let retryAt else { return false }
        return retryAt <= now
    }

    /// The sentence, in the web's words. The clock time is only said when the
    /// server named one.
    func text() -> String {
        let name = botName
        let limit = self.limit ?? 0
        let time = retryAt.map { $0.formatted(date: .omitted, time: .shortened) }
        switch reason {
        case .busy:
            return String(localized: "\(name) is still answering your earlier questions. Send this one again once it replies.")
        case .memberHour:
            if let time {
                return String(localized: "\(name) did not answer: you reached the limit of \(limit) questions an hour. It answers you again at \(time).")
            }
            return String(localized: "\(name) did not answer: you reached the limit of \(limit) questions an hour.")
        case .serverDay:
            if let time {
                return String(localized: "\(name) did not answer: this server used its \(limit) answers for today. It answers again at \(time).")
            }
            return String(localized: "\(name) did not answer: this server used its \(limit) answers for today.")
        case .budget:
            if let time {
                return String(localized: "\(name) is paused for today. It answers again at \(time).")
            }
            return String(localized: "\(name) is paused for today.")
        }
    }

    /// Parses a frame's JSON. Anything missing, or a reason this build has
    /// never heard of, is dropped rather than guessed at.
    static func parse(_ data: Data) -> BotNotice? {
        guard let frame = try? JSONDecoder().decode(Frame.self, from: data),
              let reason = Reason(rawValue: frame.reason) else { return nil }
        let name = (frame.botName?.isEmpty == false ? frame.botName : nil) ?? String(localized: "The bot")
        return BotNotice(
            channelId: frame.channelId,
            botUserId: frame.botUserId,
            botName: name,
            reason: reason,
            limit: frame.limit,
            retryAt: frame.retryAt.flatMap(ServerBot.parseDate)
        )
    }

    private struct Frame: Decodable {
        let channelId: String
        let botUserId: String
        let botName: String?
        let reason: String
        let limit: Int?
        let retryAt: String?
    }
}

/// A `typing-broadcast` frame's optional `activity`. Present only when the
/// typist is a server bot working on a request.
struct BotTypingActivity: Decodable, Sendable {
    /// The tool it is running, or nil while it is thinking.
    let tool: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tool = (try? c.decodeIfPresent(String.self, forKey: .tool)) ?? nil
    }

    private enum CodingKeys: String, CodingKey { case tool }
}

/// Decodes to nil instead of throwing, so a shape this build cannot read costs
/// the bot's row and never the typing frame around it.
struct Lossy<Value: Decodable & Sendable>: Decodable, Sendable {
    let value: Value?
    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

/// A server bot at work in the channel on screen, as its typing frames say.
struct BotWork: Equatable, Sendable {
    let userId: String
    let name: String
    /// The tool it is running, or nil while it is thinking.
    let tool: String?
    /// When the last frame came. A bot's frames stop when it posts or fails.
    let updatedAt: Date

    /// A bot that goes quiet without posting (a failed run) must not keep its
    /// row for ever. The web waits the same 30 seconds.
    static let lifetime: TimeInterval = 30

    /// What the row says under the bot's name: "Thinking…" while it has no
    /// tool, else the tool's phrase.
    var line: String { BotActivityText.line(tool: tool, name: name) }
}

enum BotActivityText {
    static func line(tool: String?, name: String) -> String {
        guard let tool else { return String(localized: "Thinking…") }
        switch tool {
        case "list_channels": return String(localized: "\(name) is checking the channels")
        case "list_members": return String(localized: "\(name) is looking up members")
        case "create_channel": return String(localized: "\(name) is creating a channel")
        case "edit_channel": return String(localized: "\(name) is editing a channel")
        case "move_channel": return String(localized: "\(name) is moving a channel")
        case "delete_channel": return String(localized: "\(name) is deleting a channel")
        case "post_message": return String(localized: "\(name) is posting a message")
        case "pin_message": return String(localized: "\(name) is pinning a message")
        case "create_thread": return String(localized: "\(name) is opening a thread")
        case "create_forum_post": return String(localized: "\(name) is posting in the forum")
        case "create_bau_post": return String(localized: "\(name) is posting on the Baú")
        case "delete_message": return String(localized: "\(name) is deleting a message")
        case "timeout_member": return String(localized: "\(name) is timing out a member")
        case "kick_member": return String(localized: "\(name) is kicking a member")
        case "ban_member": return String(localized: "\(name) is banning a member")
        case "read_channel": return String(localized: "\(name) is reading a channel")
        case "list_bans": return String(localized: "\(name) is looking up bans")
        case "create_invite": return String(localized: "\(name) is creating an invite")
        case "remove_timeout": return String(localized: "\(name) is lifting a timeout")
        case "unban_member": return String(localized: "\(name) is unbanning a member")
        case "ask_member": return String(localized: "\(name) is writing a question")
        case "list_forum_posts": return String(localized: "\(name) is looking at a forum")
        case "reply_forum_post": return String(localized: "\(name) is replying in a forum post")
        case "create_poll": return String(localized: "\(name) is creating a poll")
        case "read_poll": return String(localized: "\(name) is reading a poll")
        case "vote_poll": return String(localized: "\(name) is voting")
        default: return String(localized: "\(name) is working")
        }
    }
}
