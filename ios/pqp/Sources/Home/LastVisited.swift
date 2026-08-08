import Foundation

/// Where the app was last reading, so a launch lands somewhere alive instead of
/// on a list.
///
/// Stored as ONE `UserDefaults` string rather than encoded JSON, for two
/// reasons. A launch argument can set a string (`-pqp.lastVisited ""`), which is
/// how the UI tests get a deterministic starting screen; and a value that
/// cannot be parsed is indistinguishable from no value, so a format change can
/// never strand someone on a screen the app can no longer build.
///
/// Only *readable* destinations are recorded. A voice channel is deliberately
/// excluded: restoring one would join a call on launch, which is not a thing an
/// app may do on someone's behalf.
enum LastVisited {
    enum Kind: String, Sendable {
        /// A text channel inside a server.
        case channel
        /// A DM or group conversation — a channel with no server.
        case conversation
    }

    struct Target: Equatable, Sendable {
        let kind: Kind
        let channelId: String
        /// Present for `.channel`, absent for `.conversation` — the same shape
        /// the wire uses, where `serverId` is null on a DM.
        let serverId: String?
    }

    static let defaultsKey = "pqp.lastVisited"

    /// The field separator. Ids are server-generated and alphanumeric; a value
    /// containing this is not encodable and is dropped rather than mangled.
    private static let separator = "|"

    // MARK: - Pure codec (the part worth testing)

    static func encode(_ target: Target) -> String? {
        var fields = [target.kind.rawValue, target.channelId]
        switch target.kind {
        case .channel:
            guard let serverId = target.serverId, !serverId.isEmpty else { return nil }
            fields.append(serverId)
        case .conversation:
            // A conversation has no server by definition; carrying one would
            // decode back into a channel target that points at nothing.
            guard target.serverId == nil else { return nil }
        }
        guard fields.allSatisfy({ !$0.isEmpty && !$0.contains(separator) }) else { return nil }
        return fields.joined(separator: separator)
    }

    static func decode(_ raw: String) -> Target? {
        let fields = raw.split(separator: Character(separator), omittingEmptySubsequences: false)
            .map(String.init)
        guard let kind = fields.first.flatMap(Kind.init(rawValue:)) else { return nil }
        switch kind {
        case .channel:
            guard fields.count == 3, !fields[1].isEmpty, !fields[2].isEmpty else { return nil }
            return Target(kind: .channel, channelId: fields[1], serverId: fields[2])
        case .conversation:
            guard fields.count == 2, !fields[1].isEmpty else { return nil }
            return Target(kind: .conversation, channelId: fields[1], serverId: nil)
        }
    }

    // MARK: - Storage

    static func load(from defaults: UserDefaults = .standard) -> Target? {
        guard let raw = defaults.string(forKey: defaultsKey), !raw.isEmpty else { return nil }
        return decode(raw)
    }

    static func save(_ target: Target, to defaults: UserDefaults = .standard) {
        guard let raw = encode(target) else { return }
        defaults.set(raw, forKey: defaultsKey)
    }

    static func clear(from defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey)
    }

    // MARK: - Call-site sugar

    /// Records a server text channel. Called where the channel is *opened*, not
    /// from inside the chat screen — the shell owns where you are.
    static func record(channelId: String, serverId: String) {
        save(Target(kind: .channel, channelId: channelId, serverId: serverId))
    }

    static func record(conversationId: String) {
        save(Target(kind: .conversation, channelId: conversationId, serverId: nil))
    }
}
