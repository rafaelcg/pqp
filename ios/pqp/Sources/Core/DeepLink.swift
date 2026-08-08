import Foundation

/// Somewhere in the app a link or a notification is asking to go.
///
/// The same four cases serve three inputs — a universal link, a `pqp://` URL,
/// and the `path` a push payload carries — because all three are the *web
/// client's own routes*. `server/src/services/push.ts` builds that path with
/// `/app/dm/<id>` and `/app/server/<sid>/channel/<cid>`, the web SPA parses it
/// in `client/src/lib/app-route.ts`, and this parses the identical strings. One
/// routing vocabulary, three clients: a change on the server reaches the phone
/// and the browser or neither.
enum DeepLinkTarget: Equatable, Sendable {
    /// An invite code, not yet redeemed. What happens next depends on whether
    /// anybody is signed in — see `SessionStore.handle(_:)`.
    case invite(code: String)
    /// A DM or group conversation: a channel with no server.
    case conversation(channelId: String)
    case channel(serverId: String, channelId: String)
    /// A whole server, with no channel picked out. Where a redeemed invite
    /// lands, since joining tells us the server and nothing else.
    case server(id: String)
}

/// Turns links and notification paths into `DeepLinkTarget`s, and nothing else.
///
/// Deliberately free of any dependency on the session, the network or SwiftUI:
/// the parsing is where the bugs are (a code that arrives percent-encoded, a
/// `pqp://` URL whose first segment is the *host* rather than a path component)
/// and pure functions are the only way to see them before shipping.
enum DeepLink {
    /// The custom scheme, for the contexts where universal links do not fire:
    /// a link typed into Safari's bar, pasted into an app that does not resolve
    /// them, or opened on a device that has not yet fetched the AASA file.
    static let scheme = "pqp"

    /// Invite codes are 8 base64url characters as `generateInviteCode` makes
    /// them (server/src/services/invites.ts). The cap is generous rather than
    /// exact — the server is the authority on whether a code exists, and a
    /// client that refused a code the server would have accepted is a worse
    /// bug than one round trip. What it does is stop a pathological URL from
    /// becoming a pathological request path.
    static let maxInviteCodeLength = 64

    // MARK: - Paths

    /// Parses a web-client route.
    ///
    /// The leading `/app` is optional so the same function reads a push
    /// payload's `/app/dm/x` and a bare `pqp://dm/x`.
    static func target(path: String) -> DeepLinkTarget? {
        var segments = path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
            .compactMap(decode)
        if segments.first == "app" {
            segments.removeFirst()
        }
        // Matched on shape rather than with array patterns, which Swift does not
        // have: `case ["invite", let code]` is not a thing.
        switch segments.count {
        case 2 where segments[0] == "invite":
            let code = segments[1]
            return isUsableCode(code) ? .invite(code: code) : nil

        case 2 where segments[0] == "dm":
            let channelId = segments[1]
            return channelId.isEmpty ? nil : .conversation(channelId: channelId)

        case 2 where segments[0] == "server":
            let serverId = segments[1]
            return serverId.isEmpty ? nil : .server(id: serverId)

        case 4 where segments[0] == "server" && segments[2] == "channel":
            let serverId = segments[1]
            let channelId = segments[3]
            guard !serverId.isEmpty, !channelId.isEmpty else { return nil }
            return .channel(serverId: serverId, channelId: channelId)

        default:
            // `/app` on its own, and anything unrecognised. Both mean "the hub",
            // which is where the app already is — so nothing to navigate to,
            // rather than an error to show.
            return nil
        }
    }

    // MARK: - URLs

    /// Parses either an `https://…/app/invite/CODE` universal link or a
    /// `pqp://invite/CODE` custom-scheme one.
    ///
    /// THE HOST IS PART OF THE PATH UNDER A CUSTOM SCHEME. `pqp://invite/AB12`
    /// has host `invite` and path `/AB12`, so reading `url.path` alone finds
    /// only the code and reading `pathComponents` finds only `["/", "AB12"]`.
    /// Getting this wrong is the classic custom-scheme bug and it presents as
    /// "the link opens the app and then nothing happens".
    ///
    /// The https host is deliberately NOT checked. A universal link can only
    /// arrive from a domain named in the app's Associated Domains entitlement,
    /// so a second check there would be theatre; and for a *pasted* link,
    /// refusing an unfamiliar host would break a staging deploy while
    /// protecting nothing — the code is meaningless except to this app's own
    /// API, which is the thing that decides whether it is real.
    static func target(url: URL) -> DeepLinkTarget? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let isCustomScheme = components.scheme?.lowercased() == scheme
        let path = isCustomScheme
            ? "/\(components.host ?? "")\(components.path)"
            : components.path
        return target(path: path)
    }

    // MARK: - Pasted codes

    /// A pasted invite, reduced to the code the API wants — the Swift twin of
    /// `normalizeInviteCode` in `client/src/lib/onboarding.ts`, kept behaviourally
    /// identical because people paste the same links into both clients.
    ///
    /// People paste the whole link, because the whole link is what they were
    /// sent. The last path segment is the code in `/app/invite/<code>`, in
    /// `pqp://invite/<code>`, and in a bare code (which has no segments to drop).
    static func normalizeInviteCode(_ input: String) -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let withoutQuery = trimmed.split(separator: "?", maxSplits: 1).first
            .map(String.init) ?? ""
        let withoutFragment = withoutQuery.split(separator: "#", maxSplits: 1).first
            .map(String.init) ?? ""
        let last = withoutFragment
            .split(whereSeparator: { $0 == "/" || $0 == "\\" })
            .last
            .map(String.init) ?? ""
        return decode(last) ?? last
    }

    // MARK: - Helpers

    private static func decode(_ segment: String) -> String? {
        segment.removingPercentEncoding ?? segment
    }

    private static func isUsableCode(_ code: String) -> Bool {
        !code.isEmpty && code.count <= maxInviteCodeLength
    }
}
