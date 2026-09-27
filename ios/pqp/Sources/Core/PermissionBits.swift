import Foundation

/**
 A server or channel's RESOLVED permission bitfield, and the one bit this
 build currently checks.

 Swift cannot import `packages/shared`, so this is a narrow mirror rather
 than a port -- the same reasoning `Moderation.swift` gives for re-deriving
 the rank rule instead of trusting a client guess, applied to permission
 bits instead of rank. `PermissionBit` names follow that package's own
 comment: "Never do this math in JS `number`... always `bigint`". Swift has
 no arbitrary-precision integer either, so this uses `UInt64`, which is
 large enough for every bit defined today (`permissions.ts` runs 0-24) and
 fails closed rather than wrapping if that ever changes -- see
 `PermissionsSnapshot`'s own doc.

 Add a bit here only when iOS actually needs to check it. This is not meant
 to grow into a full mirror of `Permission`.
 */
enum PermissionBit {
    /// `Permission.START_WATCH_PARTY` = `1n << 23n` in
    /// `packages/shared/src/permissions.ts`: start the stream in a
    /// `watch_party` channel. Everyone else there is the audience.
    static let startWatchParty: UInt64 = 1 << 23
}

/**
 `{version, server, channels}` from `GET /api/servers/:serverId/permissions`
 -- this account's own resolved bitfields, server-wide and for every channel
 in this server it may see. Mirrors `fetchMemberPermissions` in
 `client/src/lib/api.ts` and the shape `use-permissions.ts` keeps in state.

 ALREADY RESOLVED, NOT RAW ROLE BITS. The route computes this with
 `computeMemberPermissions` (`server/src/services/permissions.ts`), which is
 `computePermissions` in `packages/shared`: the server owner gets every bit
 before roles are even read, and ADMINISTRATOR resolves to every bit too
 (step 1 and step 4 of that function's own doc). So there is nothing further
 to special-case for either on this client -- `can(_:)` against this
 snapshot already reads true for an owner or an ADMINISTRATOR role,
 the same as it would for a role that was individually granted the bit.

 FAILS CLOSED ON A BITFIELD THIS BUILD CANNOT READ. The wire value is a
 decimal string (Postgres `BIGINT`, and the shared package deliberately uses
 an arbitrary-precision `bigint` so growing past 64 bits is never a
 concern there); `UInt64(_:)` returns `nil` for a string that does not fit
 or is not a plain decimal, and that reads as holding NOTHING rather than
 crashing the decode or, worse, wrapping into some other bit pattern. The
 highest bit defined today is 24, so this should never actually trigger --
 it is the same margin `WatchPartyHostGate.swift`'s `.unknown` case keeps
 for "this has not resolved cleanly, so refuse rather than guess".
 */
struct PermissionsSnapshot: Decodable, Sendable {
    let version: Int
    let server: UInt64
    let channels: [String: UInt64]

    private enum CodingKeys: String, CodingKey {
        case version, server, channels
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        let serverRaw = try container.decode(String.self, forKey: .server)
        server = UInt64(serverRaw) ?? 0
        let channelsRaw = try container.decodeIfPresent(
            [String: String].self, forKey: .channels
        ) ?? [:]
        channels = channelsRaw.mapValues { UInt64($0) ?? 0 }
    }

    /// Whether `bit` is held. Mirrors `use-permissions.ts`'s own `can`: a
    /// known channel override for `channelId` wins outright, and the
    /// server-wide bits answer otherwise -- including when `channelId` is
    /// omitted entirely, which is how the web's own sidebar "may this
    /// account start a watch party here" reads a bit with no channel yet to
    /// check an override against (`perms.can(Permission.START_WATCH_PARTY)`,
    /// no second argument, `client/src/App.tsx`).
    func can(_ bit: UInt64, channelId: String? = nil) -> Bool {
        let mask: UInt64
        if let channelId, let channelBits = channels[channelId] {
            mask = channelBits
        } else {
            mask = server
        }
        return (mask & bit) == bit
    }
}

extension APIClient {
    /// `GET /api/servers/:serverId/permissions`. Mirrors `fetchMemberPermissions`
    /// in `client/src/lib/api.ts`.
    func fetchMemberPermissions(serverId: String) async throws -> PermissionsSnapshot {
        try await get("/api/servers/\(serverId)/permissions")
    }
}
