import Foundation

/// The communities wave, as endpoints: the directory, depoimentos, the profile
/// badges, and the handle claim.
///
/// Kept in its own file for the reason `SocialAPI.swift` is — the feature is
/// additive, and a file nobody else has to open is a file nobody else has to
/// merge.
extension APIClient {
    // MARK: - Directory

    /// Whether this deployment has the directory at all.
    ///
    /// MEMOISED, like `gifConfig`: a feature flag cannot change while the app is
    /// running, and this answer gates a button on the hub — asking again on every
    /// appearance would be a round trip per return to the home screen.
    ///
    /// FALSE ON ANY FAILURE, deliberately. The config route is the one route in
    /// the feature that is not flag-gated precisely so a client can tell "off"
    /// from "old server" from "network blip" — and all three of those have to
    /// render identically as "nothing here". A compass that appears on a
    /// deployment with no directory behind it is worse than no compass.
    func communitiesEnabled() async -> Bool {
        if let communityConfigCache { return communityConfigCache.enabled }
        guard let config: CommunityConfig = try? await get("/api/communities/config") else {
            return false
        }
        communityConfigCache = config
        return config.enabled
    }

    /// One page of the directory.
    ///
    /// `category` and `query` are both optional and independent: the server
    /// applies the member floor to browsing and exempts search from it, which is
    /// why a brand-new community is findable by exact name and invisible in the
    /// grid.
    func communities(
        category: String? = nil,
        query: String? = nil,
        limit: Int = CommunityDirectory.pageSize,
        offset: Int = 0
    ) async throws -> CommunityPage {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if offset > 0 { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        if let category { items.append(URLQueryItem(name: "category", value: category)) }
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        return try await get("/api/communities", query: items)
    }

    /// Join without an invite. Idempotent server-side, which is load-bearing:
    /// the app navigates the moment this resolves, so a double tap, a retry after
    /// a timeout and a card tapped twice all have to be the same join.
    @discardableResult
    func joinCommunity(serverId: String) async throws -> CommunityJoinResult {
        try await post("/api/communities/\(serverId)/join", body: EmptyBody())
    }

    /// Report a listing, from the card, without going in.
    ///
    /// A THIRD SUBJECT TYPE rather than a user report carrying a server id: the
    /// two go to different queues. `resolveServerSubject` sends this one to the
    /// INSTANCE moderators, never to the community's owner — a complaint about a
    /// room is not something its owner should be the judge of — and filing it
    /// requires no membership, which is the whole point of a report you can file
    /// from a directory you were only browsing.
    func reportCommunity(serverId: String, reason: String, details: String?) async throws {
        struct Body: Encodable {
            let subjectType = "server"
            let serverId: String
            let reason: String
            let details: String?
        }
        let _: EmptyResponse = try await post(
            "/api/reports",
            body: Body(serverId: serverId, reason: reason, details: details)
        )
    }

    // MARK: - Depoimentos

    /// A profile's published depoimentos, newest published first.
    ///
    /// Answers an EMPTY LIST rather than a refusal for somebody outside the
    /// audience, so "this person has none" and "you may not read this person's"
    /// are one state — which is exactly what the hide-when-empty rule needs.
    func depoimentos(userId: String) async throws -> [Depoimento] {
        let response: DepoimentoList = try await get("/api/users/\(userId)/depoimentos")
        return response.depoimentos
    }

    /// Your own queue — the only place a pending depoimento is readable by
    /// anybody, its author after sending very much included.
    func pendingDepoimentos() async throws -> [Depoimento] {
        let response: DepoimentoList = try await get("/api/me/depoimentos/pending")
        return response.depoimentos
    }

    /// Write one about somebody. It always lands PENDING, and the only person
    /// who will ever see it before publication is its subject.
    @discardableResult
    func writeDepoimento(userId: String, body: String) async throws -> Depoimento {
        struct Body: Encodable { let body: String }
        struct Response: Decodable { let depoimento: Depoimento }
        let response: Response = try await post(
            "/api/users/\(userId)/depoimentos", body: Body(body: body)
        )
        return response.depoimento
    }

    /// Publish one. Only the subject may, and the client makes it two deliberate
    /// taps over a preview of exactly what becomes public.
    func approveDepoimento(id: String) async throws {
        let _: EmptyResponse = try await post("/api/depoimentos/\(id)/approve", body: EmptyBody())
    }

    /// Refuse a pending one, take a published one down, or withdraw your own —
    /// whichever the caller is entitled to, silently, in one route.
    ///
    /// THE SILENCE IS THE MITIGATION. A notification on refusal would tell the
    /// author "they read it and said no", which is the single fact deleting the
    /// row exists to withhold.
    func deleteDepoimento(id: String) async throws {
        let _: EmptyResponse = try await delete("/api/depoimentos/\(id)")
    }

    /// The community chips on somebody's card. Not flag-gated on the server and
    /// deliberately so: with the directory off no server can be a community, so
    /// this answers an empty list by construction.
    func profileCommunities(userId: String) async throws -> ProfileCommunityList {
        try await get("/api/users/\(userId)/communities")
    }

    /// "Show this community on my profile", flipped by the member themselves.
    /// A separate route from the server PATCH, which is the owner's.
    func setProfileVisibility(serverId: String, showOnProfile: Bool) async throws {
        struct Body: Encodable { let showOnProfile: Bool }
        let _: EmptyResponse = try await patch(
            "/api/servers/\(serverId)/profile-visibility",
            body: Body(showOnProfile: showOnProfile)
        )
    }

    // MARK: - Handle

    /// Claim or move the public handle.
    ///
    /// Sent ON ITS OWN rather than folded into `updateProfile`, matching the
    /// order the server's own PATCH handler uses: a handle is the one field on
    /// that form that fails for a reason nothing else does — somebody else holds
    /// it — and a collision must not be retried. The server's sentence is what
    /// the field shows, verbatim; this client's mirror of the rules
    /// (`HandleRules`) only ever refuses *before* the request.
    func claimHandle(_ handle: String) async throws -> CurrentUser {
        struct Body: Encodable { let handle: String }
        return try await patch("/api/me", body: Body(handle: handle))
    }
}
