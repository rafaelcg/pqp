import Foundation

// A server's own public switches, from the owner's side: the address
// (`pqp.gg/c/<slug>`) and the directory. Wire shapes and the rules for who may
// move what, ported from `packages/shared/src/communities.ts`
// (`communitySettingsSchema`, `updateCommunitySchema`), the PATCH handler in
// `server/src/api/index.ts` and `CommunitySettingsSection` on the web.
//
// WHY THIS EXISTS. A server is public when `servers.is_community` is on, and a
// stranger can find it when `is_community_listed` is too. Until this file the
// phone had no way to see either, so an owner could have a room open to the
// whole directory and not know from the only screen in their pocket.

/// `GET`/`PATCH /api/servers/:id/community`: the two switches and the address.
///
/// Only what this screen reads. The tagline, category, links and the rest of
/// the pitch are the web's form and are left alone by a PATCH that does not
/// name them.
struct CommunitySettings: Decodable, Equatable, Sendable {
    /// The public ADDRESS. Whoever holds `pqp.gg/c/<slug>` joins with one tap.
    let isCommunity: Bool
    /// The DIRECTORY. Every signed-in account can find the room.
    let isListed: Bool
    /// Null until the first opt-in derives one or the owner picks it.
    let slug: String?
    /// Set by the instance operator only: the listing was pulled.
    let suspended: Bool

    private enum CodingKeys: String, CodingKey {
        case isCommunity, isListed, slug, suspended
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let address = try c.decodeIfPresent(Bool.self, forKey: .isCommunity) ?? false
        isCommunity = address
        // DEFAULTED TO THE ADDRESS, as the shared schema does: a server built
        // before the split answers with `isCommunity` alone, and there an
        // addressed community IS a listed one. Defaulting to false would show
        // "Public link" over a room that is in the directory.
        isListed = try c.decodeIfPresent(Bool.self, forKey: .isListed) ?? address
        slug = try c.decodeIfPresent(String.self, forKey: .slug)
        suspended = try c.decodeIfPresent(Bool.self, forKey: .suspended) ?? false
    }

    init(isCommunity: Bool, isListed: Bool, slug: String?, suspended: Bool = false) {
        self.isCommunity = isCommunity
        self.isListed = isListed
        self.slug = slug
        self.suspended = suspended
    }
}

/// `PATCH` answers `{ ok, community }`.
struct CommunitySettingsResponse: Decodable, Sendable {
    let community: CommunitySettings
}

/// What a save sends. Optionals encode as absent keys, so a PATCH that only
/// moves the directory cannot clobber the address, and the other way round.
struct CommunitySettingsPatch: Encodable, Equatable, Sendable {
    var isCommunity: Bool?
    var isListed: Bool?
    var slug: String?
}

extension APIClient {
    func communitySettings(serverId: String) async throws -> CommunitySettings {
        let response: CommunitySettingsResponse = try await get("/api/servers/\(serverId)/community")
        return response.community
    }

    func updateCommunitySettings(
        serverId: String,
        _ change: CommunitySettingsPatch
    ) async throws -> CommunitySettings {
        let response: CommunitySettingsResponse = try await patch(
            "/api/servers/\(serverId)/community", body: change
        )
        return response.community
    }
}

/// How public a server is, in the three words the screen uses.
enum CommunityVisibility: Equatable, Sendable {
    /// Nobody finds it or joins it without an invite.
    case `private`
    /// Anyone with the link joins with one tap. Not in the directory.
    case publicLink(slug: String?)
    /// In the directory: every signed-in account can find it.
    case listed(slug: String?)

    init(_ settings: CommunitySettings) {
        if settings.isListed && settings.isCommunity {
            self = .listed(slug: settings.slug)
        } else if settings.isCommunity {
            self = .publicLink(slug: settings.slug)
        } else {
            self = .private
        }
    }

    /// The header's flag: anything but private.
    var isPublic: Bool {
        if case .private = self { return false }
        return true
    }

    var slug: String? {
        switch self {
        case .private: nil
        case .publicLink(let slug), .listed(let slug): slug
        }
    }
}

/// Who may change what, and why a control is switched off.
///
/// The model is the web's, and the server enforces the same split on its own:
///
/// - the ADDRESS is Manage Server (the owner holds every bit, so it is the
///   owner or whoever a cargo grants it to);
/// - the DIRECTORY is the owner's alone;
/// - an admin cannot turn the address off while the room is listed, because
///   that write would take the listing down sideways and the server refuses it.
struct CommunityEditRules: Equatable, Sendable {
    let isOwner: Bool
    let holdsManageServer: Bool

    /// From the role the member list carries and the permissions snapshot the
    /// app already reads for the channel list. `role` covers an owner before
    /// the bits have loaded; the snapshot covers a cargo that grants the bit.
    init(role: String?, permissions: PermissionsSnapshot?) {
        let owner = role == "owner"
        isOwner = owner
        holdsManageServer = owner
            || (permissions?.can(PermissionBit.manageServer) ?? false)
    }

    init(isOwner: Bool, holdsManageServer: Bool) {
        self.isOwner = isOwner
        self.holdsManageServer = holdsManageServer || isOwner
    }

    /// Whether the section is drawn at all. The settings route answers 403 to
    /// anybody else, so there is no read-only view to show them.
    var canSee: Bool { holdsManageServer }

    /// Why a control is off, or `nil` when it is on.
    enum Lock: Equatable, Sendable {
        /// The directory is the owner's alone.
        case ownerOnlyListing
        /// The directory needs the address on first.
        case needsAddress
        /// An admin cannot end the address while the room is in the directory.
        case addressHeldByListing
    }

    func addressLock(_ settings: CommunitySettings) -> Lock? {
        if settings.isCommunity && settings.isListed && !isOwner { return .addressHeldByListing }
        return nil
    }

    func listingLock(_ settings: CommunitySettings) -> Lock? {
        if !isOwner { return .ownerOnlyListing }
        if !settings.isCommunity { return .needsAddress }
        return nil
    }
}

/// What a refused save means, so the screen can put the sentence on the right
/// control instead of at the bottom of the form.
///
/// `409` and `422` from this route are always the address. A `409` that names
/// the public address is the directory asked for before the address existed.
enum CommunitySaveFailure: Equatable, Sendable {
    case slugTaken
    case slugUnusable
    case needsAddress
    /// `403`: the server's own sentence says which of its two reasons applies.
    case forbidden(String)
    case other(String)

    static func classify(_ error: any Error) -> CommunitySaveFailure {
        guard case .server(let status, let message)? = error as? APIError else {
            return .other((error as? APIError)?.errorDescription ?? error.localizedDescription)
        }
        switch status {
        case 409:
            return message.localizedCaseInsensitiveContains("address on")
                ? .needsAddress : .slugTaken
        case 422:
            return .slugUnusable
        case 400 where message.localizedCaseInsensitiveContains("address cannot be used"):
            return .slugUnusable
        case 403:
            return .forbidden(message)
        default:
            return .other(message)
        }
    }

    /// Whether the address field is what has to change.
    var concernsAddress: Bool {
        self == .slugTaken || self == .slugUnusable
    }
}

/// The address as people read it: `pqp.gg/c/valorant-brasil`.
enum CommunityAddress {
    static let host = "pqp.gg"

    static func display(_ slug: String) -> String { "\(host)/c/\(slug)" }

    /// What gets copied: the full URL, which is what a group chat links.
    static func url(_ slug: String) -> String { "https://\(host)/c/\(slug)" }
}
