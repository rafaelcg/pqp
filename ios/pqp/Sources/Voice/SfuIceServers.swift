import Foundation

/// Which ICE servers an SFU (LiveKit) connection is handed, if any.
///
/// The LiveKit server sends its own ICE list in the join response, and this
/// app used to connect with `ConnectOptions()` and take that list and nothing
/// else. On the hosted deployment that list is the media box's built-in TURN
/// (UDP on the box itself, plus a TLS relay on a port Caddy owns, so dead),
/// while `/api/ice-servers` carries the relays the product pays for. The mesh
/// path has used that list all along; the SFU path never saw it.
///
/// Handing the app's list to the SDK is a REPLACEMENT: `client-sdk-swift`
/// 2.16.0 overwrites the server's servers whenever `connectOptions.iceServers`
/// is non-empty (`Room+Engine.swift`, "Override with user provided
/// iceServers"). So a list without a relay would be strictly worse than today,
/// which is why this returns an empty list, meaning "pass nothing, keep the
/// server's list", unless the app's list carries at least one TURN entry. An
/// empty response and a STUN-only response both fall in that bucket. The web
/// client has the same rule in `sfu-ice-servers.ts`.
enum SfuIceServers {
    /// The servers to put in `ConnectOptions(iceServers:)`; empty means none.
    static func select(_ servers: [IceServerConfig]) -> [IceServerConfig] {
        let hasRelay = servers.contains { server in
            server.urlList.contains(where: isTurnUrl)
        }
        return hasRelay ? servers : []
    }

    static func isTurnUrl(_ url: String) -> Bool {
        let scheme = url.trimmingCharacters(in: .whitespaces).lowercased()
        return scheme.hasPrefix("turn:") || scheme.hasPrefix("turns:")
    }
}
