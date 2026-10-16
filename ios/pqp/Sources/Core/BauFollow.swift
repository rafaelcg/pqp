import Foundation

// SEGUIR on iOS: following a Baú so its new free posts arrive as a card in a
// channel of another server.
//
// The contract is `packages/shared/src/bau-follow.ts` and the routes under
// "Seguir" in `server/src/api/index.ts`; `docs/COMMUNITY_HOME.md` has the
// rules (who may follow, what goes out, auto-pause). The web is
// `client/src/components/community-home/bau-follow.tsx`. Everything that
// DECIDES something (which servers and channels the picker offers, what a
// refusal says, what an optimistic removal looks like) lives here where a test
// can see it; the screens in `Home/BauFollowViews.swift` only draw it.
//
// The flag `bau_follow` is per SOURCE server and runtime. The state read says
// `enabled: false` and the button is simply not drawn; everything else is a
// 404 then, which this file treats as "this Baú no longer accepts follows".

// MARK: - Wire

struct BauFollow: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let sourceServerId: String
    let sourceServerName: String
    let sourceServerIconUrl: String?
    let targetServerId: String
    let targetServerName: String
    let targetChannelId: String
    let targetChannelName: String
    let rolePingId: String?
    let rolePingName: String?
    /// `active` or `paused`. A string, so a status a newer server invents reads
    /// as "not paused" instead of failing the whole list.
    let status: String
    /// `permissions`, `banned`, or nil.
    let pausedReason: String?
    /// Whether the person asking set this follow up.
    let mine: Bool

    var isPaused: Bool { status == "paused" }
    var isBanned: Bool { isPaused && pausedReason == "banned" }
}

struct BauFollowState: Decodable, Sendable, Equatable {
    /// The `bau_follow` flag for this source. False: no button.
    let enabled: Bool
    let maxPerServer: Int
    /// Follows of this Baú the viewer created, newest first.
    let mine: [BauFollow]

    static let off = BauFollowState(enabled: false, maxPerServer: 20, mine: [])
}

struct BauFollowChannelOption: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    /// An active or paused follow of this source already points here.
    let following: Bool
}

struct BauFollowRoleOption: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
}

struct BauFollowDestination: Decodable, Identifiable, Hashable, Sendable {
    let serverId: String
    let serverName: String
    let serverIconUrl: String?
    let channels: [BauFollowChannelOption]
    /// Roles the viewer may ping from this server.
    let roles: [BauFollowRoleOption]
    /// Follows this server already holds, against `maxPerServer`.
    let followCount: Int

    var id: String { serverId }
}

struct BauFollowDestinations: Decodable, Sendable {
    let maxPerServer: Int
    let servers: [BauFollowDestination]
}

struct BauFollower: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let targetServerId: String
    let targetServerName: String
    let targetServerIconUrl: String?
    let targetChannelName: String
    let status: String

    var isPaused: Bool { status == "paused" }
}

struct BauFollowBlock: Decodable, Identifiable, Hashable, Sendable {
    let serverId: String
    let serverName: String

    var id: String { serverId }
}

/// `GET .../home/followers` (Manage Server), and what the owner's switch
/// answers with.
struct BauFollowers: Decodable, Sendable, Equatable {
    /// Followable right now: the flag, the Baú and the owner's switch, all on.
    let enabled: Bool
    /// The `bau_follow` flag is on for this server at all. The switch is drawn
    /// only then.
    let flagOn: Bool
    /// The owner's own switch ("Permitir seguir"), off by default.
    let allowed: Bool
    let publicCommunity: Bool
    /// Followers across every destination channel (a server with two counts twice).
    var count: Int
    var followers: [BauFollower]
    var blocked: [BauFollowBlock]
}

private struct BauFollowAck: Decodable { let ok: Bool? }
private struct BauFollowCreated: Decodable { let follow: BauFollow }
private struct BauFollowChannelList: Decodable { let follows: [BauFollow] }

private struct CreateBauFollowBody: Encodable, Sendable {
    let channelId: String
    /// Sent as an explicit null when there is no role, like the web: the
    /// schema takes `null` and absent alike.
    let rolePingId: String?

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(channelId, forKey: .channelId)
        try container.encode(rolePingId, forKey: .rolePingId)
    }

    private enum CodingKeys: String, CodingKey { case channelId, rolePingId }
}

private struct ResumeBauFollowBody: Encodable, Sendable { let resume = true }
private struct BauFollowConfigBody: Encodable, Sendable { let allowed: Bool }

// MARK: - Failures

/// What a refused Seguir call says. The status alone cannot tell two refusals
/// apart (403 is "not allowed in that channel" and "that Baú does not take
/// your server"; 409 is "already follows" and "that server holds the most it
/// can"), so the server's own sentence is read, the way the web does.
enum BauFollowFailure: Error, Equatable, Sendable {
    case slow
    case forbidden
    case blocked
    case limit
    case exists
    case invalid
    /// A 404: the Baú stopped accepting follows (its owner switched it off, or
    /// the flag went), or the channel or follow is gone.
    case unavailable
    case generic

    var message: String {
        switch self {
        case .slow: String(localized: "Slow down a little and try again.")
        case .forbidden: String(localized: "You need to manage webhooks or channels in that channel.")
        case .blocked: String(localized: "This community does not accept that server.")
        case .limit: String(localized: "That server already follows as many Baús as it can.")
        case .exists: String(localized: "That channel already follows this Baú.")
        case .invalid: String(localized: "That role cannot be mentioned.")
        case .unavailable: String(localized: "This Baú no longer accepts follows.")
        case .generic: String(localized: "Could not follow right now. Try again.")
        }
    }

    static func from(_ error: any Error) -> BauFollowFailure {
        guard let api = error as? APIError else { return .generic }
        switch api {
        case .rateLimited:
            return .slow
        case .notFound:
            return .unavailable
        case .server(let status, let message):
            switch status {
            case 403: return message.range(of: "accept", options: .caseInsensitive) != nil ? .blocked : .forbidden
            case 409: return message.range(of: "most", options: .caseInsensitive) != nil ? .limit : .exists
            case 400: return .invalid
            default: return .generic
            }
        default:
            return .generic
        }
    }
}

// MARK: - Endpoints

extension APIClient {
    func bauFollowState(serverId: String) async throws -> BauFollowState {
        try await get("/api/servers/\(serverId)/home/follow")
    }

    func bauFollowDestinations(serverId: String) async throws -> BauFollowDestinations {
        try await get("/api/servers/\(serverId)/home/follow/destinations")
    }

    func createBauFollow(serverId: String, channelId: String, rolePingId: String?) async throws -> BauFollow {
        let created: BauFollowCreated = try await post(
            "/api/servers/\(serverId)/home/follow",
            body: CreateBauFollowBody(channelId: channelId, rolePingId: rolePingId)
        )
        return created.follow
    }

    func channelBauFollows(channelId: String) async throws -> [BauFollow] {
        let list: BauFollowChannelList = try await get("/api/channels/\(channelId)/bau-follows")
        return list.follows
    }

    func resumeBauFollow(id: String) async throws -> BauFollow {
        let updated: BauFollowCreated = try await patch("/api/bau-follows/\(id)", body: ResumeBauFollowBody())
        return updated.follow
    }

    func deleteBauFollow(id: String) async throws {
        let _: BauFollowAck = try await delete("/api/bau-follows/\(id)")
    }

    func bauFollowers(serverId: String) async throws -> BauFollowers {
        try await get("/api/servers/\(serverId)/home/followers")
    }

    func setBauFollowAllowed(serverId: String, allowed: Bool) async throws -> BauFollowers {
        try await patch("/api/servers/\(serverId)/home/follow-config", body: BauFollowConfigBody(allowed: allowed))
    }

    func removeBauFollower(serverId: String, followId: String, block: Bool) async throws {
        // The flag is a query item: a `?` inside the path would be escaped.
        let _: BauFollowAck = try await delete(
            "/api/servers/\(serverId)/home/followers/\(followId)",
            query: block ? [URLQueryItem(name: "block", value: "1")] : []
        )
    }

    func unblockBauFollower(serverId: String, blockedServerId: String) async throws {
        let _: BauFollowAck = try await delete("/api/servers/\(serverId)/home/follow-blocks/\(blockedServerId)")
    }
}

// MARK: - The rules the screens follow

enum BauFollowRules {
    /// Follower rows drawn at a time; the API caps the list at 500.
    static let followersPage = 50

    /// What the toolbar button says: the viewer follows this Baú somewhere or
    /// does not. Absent while the flag is off for this source.
    static func buttonVisible(_ state: BauFollowState?) -> Bool { state?.enabled == true }

    /// The staff menu (the follower list and the owner's switch) is offered to
    /// whoever may manage the server, while the feature is on for it at all.
    static func followersMenuVisible(canManageServer: Bool, followers: BauFollowers?) -> Bool {
        canManageServer && followers?.flagOn == true
    }

    /// Whoever holds the right to set a follow up in a channel, as the server
    /// asks it: Manage Webhooks or Manage Channels there.
    static func mayManageFollows(_ permissions: PermissionsSnapshot?, channelId: String) -> Bool {
        guard let permissions else { return false }
        return permissions.can(PermissionBit.manageWebhooks, channelId: channelId)
            || permissions.can(PermissionBit.manageChannels, channelId: channelId)
    }

    /// The followers list after `follower` was removed, drawn at once so a
    /// reload that fails afterwards cannot leave a removed server on show.
    static func removing(_ follower: BauFollower, from current: BauFollowers) -> BauFollowers {
        var next = current
        next.count = max(0, current.count - 1)
        next.followers.removeAll { $0.id == follower.id }
        return next
    }

    /// Blocking removes every follow of that server and lists the server under
    /// the blocked ones.
    static func blocking(_ follower: BauFollower, from current: BauFollowers) -> BauFollowers {
        var next = current
        let gone = current.followers.filter { $0.targetServerId == follower.targetServerId }.count
        next.count = max(0, current.count - max(1, gone))
        next.followers.removeAll { $0.targetServerId == follower.targetServerId }
        next.blocked.insert(
            BauFollowBlock(serverId: follower.targetServerId, serverName: follower.targetServerName),
            at: 0
        )
        return next
    }

    static func unblocking(_ block: BauFollowBlock, from current: BauFollowers) -> BauFollowers {
        var next = current
        next.blocked.removeAll { $0.serverId == block.serverId }
        return next
    }
}

// MARK: - The destination picker

/// Server, channel and role, and what each one offers. A value type so the
/// rules (a channel that already follows is not offered, a full server offers
/// nothing, a role that is not on the chosen server is dropped) are testable
/// without a screen.
struct BauFollowPicker: Equatable, Sendable {
    var destinations: [BauFollowDestination]
    var maxPerServer: Int
    private(set) var serverId: String
    private(set) var channelId: String
    private(set) var roleId: String

    init(destinations: [BauFollowDestination], maxPerServer: Int) {
        self.destinations = destinations
        self.maxPerServer = maxPerServer
        serverId = destinations.first?.serverId ?? ""
        channelId = ""
        roleId = ""
        normalize()
    }

    var destination: BauFollowDestination? {
        destinations.first { $0.serverId == serverId }
    }

    /// Channels of the chosen server that do not follow this Baú yet.
    var freeChannels: [BauFollowChannelOption] {
        destination?.channels.filter { !$0.following } ?? []
    }

    /// The chosen server already holds the most follows it may.
    var isFull: Bool {
        guard let destination else { return false }
        return destination.followCount >= maxPerServer
    }

    var roles: [BauFollowRoleOption] { destination?.roles ?? [] }

    var canSubmit: Bool { destination != nil && !channelId.isEmpty && !isFull }

    var selectedChannelId: String { channelId }
    var selectedRoleId: String { roleId }

    mutating func selectServer(_ id: String) {
        serverId = id
        normalize()
    }

    mutating func selectChannel(_ id: String) {
        if freeChannels.contains(where: { $0.id == id }) { channelId = id }
    }

    mutating func selectRole(_ id: String) {
        roleId = roles.contains(where: { $0.id == id }) ? id : ""
    }

    /// Fresh lists from the server (after a follow or an unfollow): keep the
    /// server on show when it is still there, and re-validate the picks.
    mutating func replace(destinations: [BauFollowDestination], maxPerServer: Int) {
        self.destinations = destinations
        self.maxPerServer = maxPerServer
        if !destinations.contains(where: { $0.serverId == serverId }) {
            serverId = destinations.first?.serverId ?? ""
        }
        normalize()
    }

    /// The channel and role picks stay valid for the server on show.
    private mutating func normalize() {
        if !freeChannels.contains(where: { $0.id == channelId }) {
            channelId = freeChannels.first?.id ?? ""
        }
        if !roles.contains(where: { $0.id == roleId }) {
            roleId = ""
        }
    }
}
