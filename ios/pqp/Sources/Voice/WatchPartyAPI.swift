import Foundation

/**
 Watch party hosting, as endpoints. Mirrors `client/src/lib/watch-parties-api.ts`,
 `client/src/hooks/use-hls-host-ack.ts`, and Android's `WatchPartyApi.kt`
 (hosting PR #834): extensions on `APIClient` rather than methods inside it,
 the same reasoning `CommunityHomeAPI.swift` states for its own routes --
 the plumbing these need (a fresh token, `APIError`) is already public on
 `APIClient`, and this keeps a whole feature out of a file every other
 branch is also editing.

 Every mutation here is a WRITE the server also broadcasts over
 `watch-party-update`, so this client does not apply its own optimistic
 answer: the caller reads the party back off `WatchPartyHostController.party`
 once the frame lands. The returned value exists for the create call, which
 needs the id before any frame can name it.

 Out of scope for this PR (see the hosting review): co-host promote/demote,
 the stage/guests routes, and `PATCH` for renaming or the options a party
 carries. Those reuse this file's plumbing when built.
 */
extension APIClient {
    /// `POST /api/channels/:channelId/watch-parties`. No `startsAt`: this
    /// build always creates an immediate `draft`, never a `scheduled` party
    /// -- one less screen for a first cut, and a host who wants to announce
    /// ahead of time still can from the web.
    @discardableResult
    func createWatchParty(channelId: String, name: String) async throws -> WatchPartyPayload? {
        struct Body: Encodable { let name: String }
        let response: WatchPartyResponse = try await post(
            "/api/channels/\(channelId)/watch-parties", body: Body(name: name)
        )
        return response.party
    }

    /// `GET /api/channels/:channelId/watch-party`, this channel's current
    /// party (any state), or `nil`. Used to disambiguate an unclear
    /// `setWatchPartyState` response: a thrown/lost response does not say
    /// whether the server committed the transition before it was lost, and
    /// this is the re-read that answers it directly rather than guessing.
    func fetchChannelWatchParty(channelId: String) async throws -> WatchPartyPayload? {
        let response: WatchPartyResponse = try await get("/api/channels/\(channelId)/watch-party")
        return response.party
    }

    /// `POST /api/watch-parties/:id/state`. The target state, never a verb
    /// -- the server owns the transition table and refuses a move that is
    /// not in it. `lowLatency` only means anything alongside `state = "live"`.
    @discardableResult
    func setWatchPartyState(
        partyId: String, state: String, lowLatency: Bool? = nil
    ) async throws -> WatchPartyPayload? {
        struct Body: Encodable { let state: String; let lowLatency: Bool? }
        let response: WatchPartyResponse = try await post(
            "/api/watch-parties/\(partyId)/state", body: Body(state: state, lowLatency: lowLatency)
        )
        return response.party
    }

    /// `GET /api/live-hls/config?serverId=`, the same route and field the
    /// web and Android read for "may this server broadcast at all" and "is
    /// low latency on offer here" (`docs/WATCH_PARTY.md`, "Widening it is a
    /// click now"). Never inferred from a build flag on any platform.
    ///
    /// OFF ON ANY FAILURE, deliberately, matching `communityHomeConfig()`'s
    /// posture in `CommunityHomeAPI.swift`: a 404 (the feature off), a
    /// decode this build does not understand, and a network blip must all
    /// render identically as "nothing here", never as a button that opens
    /// onto a refusal.
    func liveHlsConfig(serverId: String) async -> LiveHlsConfigPayload {
        let query = [URLQueryItem(name: "serverId", value: serverId)]
        return (try? await get("/api/live-hls/config", query: query)) ?? .off
    }

    /// The one-time "you're responsible for what you stream" gate
    /// (`hls_host_acks`), per user and per server. `true` means it has not
    /// been shown and confirmed yet for this server. See
    /// `hostAckNeedsShowing` for how a throw from this call is handled --
    /// this function itself throws, and fails CLOSED at the call site.
    func needsHlsHostAck(serverId: String) async throws -> Bool {
        let response: HlsHostAckPayload = try await get("/api/voice/hls-host-ack/\(serverId)")
        return !response.acknowledged
    }

    /// Persist the ack so it never shows again for this user+server pair.
    func confirmHlsHostAck(serverId: String) async throws {
        let _: HlsHostAckPayload = try await post("/api/voice/hls-host-ack/\(serverId)", body: EmptyBody())
    }
}
