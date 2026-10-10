import Foundation

/// What the lime Baú badge says.
///
/// A new Baú post used to be a quiet grey number on the Baú row and nothing at
/// all on the hub's server tiles, which made the feature the product leads
/// with look like the least eventful thing on the screen. It is lime now, the
/// brand signal, on the row and on the server's tile, and capped at "9+" on a
/// tile (the web rail does the same): a small badge has no room for a third
/// digit.
///
/// Nothing here knows about mentions. Neither list this app draws a server in
/// carries a mention count, so there is no corner to share and no ring variant.
enum BauBadge {
    /// The tile badge stops counting here.
    static let cap = 9

    /// The text on the badge, or nil when there is nothing to show.
    static func label(count: Int) -> String? {
        if count <= 0 { return nil }
        return count > cap ? "\(cap)+" : String(count)
    }

    /// One server's unread count out of the aggregate read; 0 when absent.
    static func unread(for serverId: String, in unread: [String: Int]) -> Int {
        max(0, unread[serverId] ?? 0)
    }
}
