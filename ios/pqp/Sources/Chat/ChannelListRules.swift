import Foundation

// The decisions behind the live channel list (direction A1), kept free of
// SwiftUI so they are tested rather than eyeballed: what a row says about
// unread messages, whether a channel is muted, what a collapsed section
// summarises, and which sections are folded on this device.

/// What a channel row shows about unread messages.
struct ChannelUnreadMark: Equatable {
    /// Semibold name and the tick on the left edge.
    let isUnread: Bool
    /// The lime "@N" pill. Zero draws nothing.
    let mentions: Int

    static let none = ChannelUnreadMark(isUnread: false, mentions: 0)

    /// A muted channel is never bold and never ticked, whatever arrived in it,
    /// and that includes mentions: muting is the person saying "not this one".
    static func resolve(unread: UnreadEntry?, isMuted: Bool) -> ChannelUnreadMark {
        guard !isMuted, let unread, unread.count > 0 || unread.mentions > 0 else { return .none }
        return ChannelUnreadMark(isUnread: true, mentions: max(0, unread.mentions))
    }
}

/// Whether the account silenced a channel, from its notification preferences.
///
/// The web's rule (`resolveNotificationLevel`): the channel's own level wins,
/// then the server's. "none" is muted. The account-wide default is not read
/// here: a default of "none" is somebody turning notifications off, not
/// somebody asking for every row in every server to fade.
enum ChannelMute {
    static func isMuted(channelId: String, serverId: String, preferences: UserPreferences) -> Bool {
        let notifications = preferences.notifications
        if let level = notifications?.channels?[channelId] {
            return level == "none"
        }
        return notifications?.servers?[serverId] == "none"
    }
}

/// One section of the list (TEXT, a category, VOICE), for its header.
struct ChannelSectionSummary: Equatable {
    let channelCount: Int
    /// Something unread and not muted inside: the white dot on a folded header.
    let hasUnread: Bool

    static func make(
        channels: [Channel],
        unread: [String: UnreadEntry],
        isMuted: (Channel) -> Bool
    ) -> ChannelSectionSummary {
        let hasUnread = channels.contains { channel in
            ChannelUnreadMark.resolve(unread: unread[channel.id], isMuted: isMuted(channel)).isUnread
        }
        return ChannelSectionSummary(channelCount: channels.count, hasUnread: hasUnread)
    }
}

/// Which sections are folded, remembered per server on this device.
///
/// Section keys: a category's id, or `text` / `voice` for the loose sections.
/// UserDefaults rather than the account: folding is about this screen's size,
/// and a phone and a desktop want different things folded.
struct CollapsedSections {
    static let textKey = "text"
    static let voiceKey = "voice"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func storageKey(serverId: String) -> String { "pqp.channelList.collapsed.\(serverId)" }

    func load(serverId: String) -> Set<String> {
        Set(defaults.stringArray(forKey: storageKey(serverId: serverId)) ?? [])
    }

    /// Writes the new set and returns it. An empty set removes the key, so a
    /// server you never folded anything in leaves nothing behind.
    @discardableResult
    func toggle(_ section: String, serverId: String) -> Set<String> {
        var current = load(serverId: serverId)
        if current.contains(section) {
            current.remove(section)
        } else {
            current.insert(section)
        }
        if current.isEmpty {
            defaults.removeObject(forKey: storageKey(serverId: serverId))
        } else {
            defaults.set(current.sorted(), forKey: storageKey(serverId: serverId))
        }
        return current
    }
}

/// The line under the server's name: "8 em call · 1 ao vivo". Both halves come
/// from data the list already has; a zero half is left out.
struct ServerActivity: Equatable {
    let inCall: Int
    let live: Int

    var isEmpty: Bool { inCall == 0 && live == 0 }
}
