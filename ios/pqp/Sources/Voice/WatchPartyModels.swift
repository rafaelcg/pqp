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
    /// The host's face for the channel list's live/pending card
    /// (`ChannelListWatchPartyCard.swift`). Nil for a host with no avatar, or
    /// when a test constructs a payload without it -- defaulted rather than
    /// required so `WatchPartyHostGateTests`'s and
    /// `WatchPartyHostControllerTests`'s existing memberwise calls, which
    /// predate the channel-list card, keep compiling unchanged.
    let hostAvatarUrl: String?
    /// ISO 8601, set once the party actually goes live; null for anything
    /// still `draft`/`scheduled`. Read only to sort more than one live party
    /// newest-first, mirroring `sortNewestFirst` in the web's
    /// `use-watch-parties.ts` -- this build still draws only the newest.
    let wentLiveAt: String?

    init(
        id: String, channelId: String, name: String, state: String,
        hostUserId: String, hostDisplayName: String, viewerRole: String,
        hostAvatarUrl: String? = nil, wentLiveAt: String? = nil
    ) {
        self.id = id
        self.channelId = channelId
        self.name = name
        self.state = state
        self.hostUserId = hostUserId
        self.hostDisplayName = hostDisplayName
        self.viewerRole = viewerRole
        self.hostAvatarUrl = hostAvatarUrl
        self.wentLiveAt = wentLiveAt
    }

    var isHost: Bool { viewerRole == "host" }
    var isCohost: Bool { viewerRole == "cohost" }
    var isLive: Bool { state == "live" }
    var isPreLive: Bool { state == "draft" || state == "scheduled" }
    /// The party is over and nothing may move it again (`ended`/`cancelled`
    /// in `WATCH_PARTY_PHASES` -- `TRANSITIONS` in `watch-party-session.ts`
    /// allows no move out of either). `fetchChannelWatchParty` can still
    /// return one of these for a while after the fact, and it must read the
    /// same as "no active party" everywhere a caller asks "is one running":
    /// see `WatchPartyHostGate.swift`.
    var isTerminal: Bool { state == "ended" || state == "cancelled" }
}

/// `{party: ...}`, the envelope every mutation route and the
/// `watch-party-update` frame answer with.
struct WatchPartyResponse: Decodable, Sendable {
    let party: WatchPartyPayload?
}

/// `{parties: [...]}`, `GET /api/servers/:serverId/watch-parties` -- every
/// party in the server this person may see (live, and any draft/scheduled
/// one they host or co-host), in one request. Mirrors
/// `fetchServerWatchParties` in `client/src/lib/watch-parties-api.ts`.
struct WatchPartyListResponse: Decodable, Sendable {
    let parties: [WatchPartyPayload]
}

/// `{party, channel}`, `POST /api/servers/:serverId/watch-parties` -- starts
/// a party with no channel picked ahead of time: the server finds or makes
/// the server's one hidden watch-party room and opens a draft in it
/// (`findOrCreateWatchPartyRoom`). `channel` is what makes that room
/// reachable from a client that has never seen it before this call.
struct WatchPartyCreatedResponse: Decodable, Sendable {
    let party: WatchPartyPayload?
    let channel: Channel?
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
