import Foundation
import SwiftUI

// UNREAD ON THE SERVER LIST.
//
// The hub drew a lime badge for new Baú posts and nothing at all for unread
// channel messages: a server with fifty waiting messages looked the same as a
// quiet one until it was opened. The web rail has lit them since #1211
// (`client/src/lib/unread-hydration.ts`, `railServerIndicator`); this is the
// phone's version. Everything that decides something is here, where a test can
// see it; `HomeModel` and `ChannelListView` only feed it.
//
// Where the numbers come from, in order of authority:
//  - `GET /api/servers/:id/unread`, one read per server, hydrated by the hub
//    (two at a time, muted servers skipped, fifteen at most, like the web);
//  - the open server's own channel list, which keeps its unread live and
//    reports the totals up while it is on screen;
//  - `channel-activity` frames, for servers that are not open.

/// One server's unread, as the tile draws it.
struct ServerUnreadTotals: Equatable, Sendable {
    var count: Int
    var mentions: Int

    static let none = ServerUnreadTotals(count: 0, mentions: 0)

    /// Anything to show at all: the pill.
    var isUnread: Bool { count > 0 || mentions > 0 }
}

enum ServerUnread {
    /// Servers hydrated per pass, in list order. Each is one request, so this
    /// bounds the cost for an account in many servers; the rest light from live
    /// frames and when opened.
    static let maxServersHydrated = 15

    /// Requests in flight at once: the list fills in over a second or two,
    /// quietly.
    static let concurrency = 2

    /// A pass newer than this is not repeated when the hub reappears. The hub
    /// re-reads on every return from a channel, and a thread of taps must not
    /// become a query per server per tap.
    static let minSecondsBetweenPasses: TimeInterval = 60

    /// The pause before the one retry of a server whose read failed.
    static let retryDelay: Duration = .seconds(4)

    /// The totals of one server's rows. A muted channel is left out, exactly as
    /// its own row shows nothing: muting is the person saying "not this one".
    static func totals(from entries: [UnreadEntry], isMuted: (String) -> Bool) -> ServerUnreadTotals {
        var totals = ServerUnreadTotals.none
        for entry in entries where !isMuted(entry.channelId) {
            totals.count += max(0, entry.count)
            totals.mentions += max(0, entry.mentions)
        }
        return totals
    }

    /// The servers to ask about, in list order: not the open one (its own
    /// channel list is the source), not a muted one (its tile says nothing and
    /// the answer could not change it), at most `maxServersHydrated`.
    static func serversToHydrate(
        _ servers: [Server], skipping openId: String?, isMuted: (Server) -> Bool
    ) -> [String] {
        var ids: [String] = []
        for server in servers where server.id != openId && !isMuted(server) {
            ids.append(server.id)
            if ids.count >= maxServersHydrated { break }
        }
        return ids
    }

    /// Whether a pass that last ran at `last` is worth repeating at `now`.
    /// Never ran: yes. `force` is a return from a long gap.
    static func needsPass(last: Date?, now: Date, force: Bool = false) -> Bool {
        guard let last else { return true }
        return force || now.timeIntervalSince(last) >= minSecondsBetweenPasses
    }

    /// A `channel-activity` frame for a server that is not open: one more
    /// unread, and one more mention when it names this account.
    static func applyingActivity(_ totals: ServerUnreadTotals?, mention: Bool) -> ServerUnreadTotals {
        let base = totals ?? .none
        return ServerUnreadTotals(count: base.count + 1, mentions: base.mentions + (mention ? 1 : 0))
    }

    /// Whether the server is muted by this account's own preferences.
    static func isServerMuted(_ serverId: String, preferences: UserPreferences) -> Bool {
        preferences.notifications?.servers?[serverId] == "none"
    }

    /// What a tile draws, from the totals and the mute: nothing for a muted
    /// server, a pill for any unread, and the lime "@N" (`MentionPill`, the channel
    /// rows' own) for mentions.
    struct Indicator: Equatable {
        let showsPill: Bool
        let mentions: Int

        static let none = Indicator(showsPill: false, mentions: 0)
    }

    /// What VoiceOver (and a UI test) reads off a tile: the mentions, else
    /// "Unread", else nothing.
    static func spokenValue(_ totals: ServerUnreadTotals?, muted: Bool) -> Text {
        let state = indicator(totals, muted: muted)
        if state.mentions > 0 { return Text("\(state.mentions) mentions") }
        if state.showsPill { return Text("Unread") }
        return Text(verbatim: "")
    }

    static func indicator(_ totals: ServerUnreadTotals?, muted: Bool) -> Indicator {
        guard !muted, let totals, totals.isUnread else { return .none }
        return Indicator(showsPill: true, mentions: max(0, totals.mentions))
    }
}

/// A screen of a server closes itself when a `server-removed` frame names it
/// (`SessionStore.removedServers`). Each screen of the server does this for
/// itself: `dismiss()` from the list does not reliably pop what is pushed above
/// it, so the chat closes first and the list after.
private struct DismissWhenServerRemoved: ViewModifier {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let serverId: String?

    func body(content: Content) -> some View {
        content.onChange(of: session.removedRevision) { _, _ in
            if let serverId, session.removedServers[serverId] != nil { dismiss() }
        }
    }
}

extension View {
    func dismissWhenServerRemoved(_ serverId: String?) -> some View {
        modifier(DismissWhenServerRemoved(serverId: serverId))
    }
}

/// The one sentence a removal says (`SERVER_REMOVED_COPY` on the web).
enum ServerRemovedCopy {
    static func sentence(_ reason: ServerRemovedReason, server: String) -> String {
        switch reason {
        case .kicked: String(localized: "You were removed from \(server). You can come back with a new invite.")
        case .banned: String(localized: "You were banned from \(server).")
        case .deleted: String(localized: "The community \(server) was deleted and no longer exists for anybody.")
        }
    }
}
