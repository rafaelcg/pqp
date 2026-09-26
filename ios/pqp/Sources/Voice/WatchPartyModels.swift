import Foundation

/**
 The wire shapes hosting a watch party from this phone needs, and nothing more.

 `watchPartySchema` in `packages/shared/src/watch-party-session.ts` carries
 cohosts, the stage, guests and scheduling -- everything the web's setup
 surface and options dialog draw. This build draws none of that: per the
 hosting review (`~/.config/pqp/mobile/SCREEN_SHARE_AND_HOSTING_REVIEW.md`)
 and Android's own first cut (#834), co-host promote/demote, Convidados and
 scheduling are out of scope for a first PR on either phone. So
 `WatchPartyPayload` reads only the fields this client's host flow actually
 uses; every other key on the object is decoded and discarded silently by
 `JSONDecoder`, which only looks up the keys a type declares.
 */
struct WatchPartyPayload: Codable, Equatable, Sendable {
    let id: String
    let channelId: String
    let name: String
    /// `draft` | `scheduled` | `live` | `ended` | `cancelled` (`WATCH_PARTY_PHASES`).
    let state: String
    let hostUserId: String
    let hostDisplayName: String
    /// This account's own standing, resolved server side: `host`, `cohost`,
    /// `manager` or `viewer`.
    let viewerRole: String

    var isHost: Bool { viewerRole == "host" }
    var isCohost: Bool { viewerRole == "cohost" }
    var isLive: Bool { state == "live" }
    var isPreLive: Bool { state == "draft" || state == "scheduled" }
}

/// `{party: ...}`, the envelope every mutation route and the
/// `watch-party-update` frame answer with.
struct WatchPartyResponse: Decodable, Sendable {
    let party: WatchPartyPayload?
}

/**
 `GET /api/live-hls/config`, trimmed to what the host flow reads: whether
 this server may broadcast at all, and whether "Baixa latencia" is on offer.
 Mirrors `LiveHlsConfig` in `server/src/voice/hls-egress.ts`.
 */
struct LiveHlsConfigPayload: Decodable, Sendable {
    let enabled: Bool
    let lowLatency: LowLatency

    struct LowLatency: Decodable, Sendable {
        let available: Bool
    }

    /// What a server this build cannot reach (offline, self-hosted with no
    /// `LIVE_HLS_*` configured, a decode this build does not understand)
    /// has to read as: no button worth drawing. Mirrors
    /// `communityHomeConfig`'s "off on any failure" in `CommunityHomeAPI.swift`.
    static let off = LiveHlsConfigPayload(enabled: false, lowLatency: LowLatency(available: false))
}

/// `GET`/`POST /api/voice/hls-host-ack/:serverId`.
struct HlsHostAckPayload: Decodable, Sendable {
    let acknowledged: Bool
}
