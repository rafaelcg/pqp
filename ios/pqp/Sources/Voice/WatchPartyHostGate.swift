import Foundation

/**
 What the host-facing UI on a `watch_party` channel may show, decided in one
 pure place so "no START_WATCH_PARTY, no host UI" and "the server has watch
 parties off, no host UI" are provable rather than hoped for.

 Ported from `watchPartyHostGate` in Android's hosting PR (#834,
 `WatchPartyHostGate.kt`) -- same shape, same three inputs, same reasoning,
 because the underlying rule does not change with the platform: this is a
 straight read of what `join-voice-room` and `POST /api/channels/:id/watch-parties`
 already enforce server side, not a client invention.

 ## Where `canStartWatchParty` comes from, and why that is the honest answer

 iOS models no general per-channel permission tree the way the web does. The
 one bit this client resolves is `VoiceModel.canStream`, which the server has
 already turned into START_WATCH_PARTY for a `watch_party` channel (see
 `docs/voice-backends.md` and `server/src/voice/speak.ts`, "in a watch_party
 channel the stage is START_WATCH_PARTY instead of STREAM"). That bit is only
 known once this phone has joined the channel's own voice room -- `welcome`
 is what carries it. So `canStartWatchParty` here means "connected to this
 channel's room AND the server told this seat it may stream", and it is
 `false` before that join. The cost is one extra tap for the actual host, who
 was always going to join the room to speak/present anyway, and nothing at
 all for anyone else -- the same trade `watchPartyMayJoinRoom` makes for
 letting an idle channel's room be joined by anybody.

 ## Where `serverWatchPartyEnabled` comes from

 `GET /api/live-hls/config?serverId=`.`enabled` -- the exact route and field
 the web and Android read for the identical question
 (`docs/WATCH_PARTY.md`, "Widening it is a click now"). Never inferred from a
 build flag: a self-host with no `LIVE_HLS_*` configured must not draw a
 Criar watch party button that cannot go anywhere.
 */
struct WatchPartyHostGate: Equatable {
    /// "Criar watch party" belongs on the stage.
    let canCreate: Bool
    /// This account is running `party` and its setup/live controls belong on
    /// the stage.
    let canManage: Bool
}

func watchPartyHostGate(
    isWatchPartyChannel: Bool,
    serverWatchPartyEnabled: Bool,
    canStartWatchParty: Bool,
    party: WatchPartyPayload?
) -> WatchPartyHostGate {
    let eligible = isWatchPartyChannel && serverWatchPartyEnabled && canStartWatchParty
    guard eligible else {
        return WatchPartyHostGate(canCreate: false, canManage: false)
    }
    let canManage: Bool
    if let party {
        canManage = party.isHost && party.state != "ended" && party.state != "cancelled"
    } else {
        canManage = false
    }
    return WatchPartyHostGate(canCreate: party == nil, canManage: canManage)
}

/// Whether "Ir ao vivo" belongs on this party's setup card.
func canGoLiveWith(_ party: WatchPartyPayload?) -> Bool {
    guard let party else { return false }
    return party.isPreLive
}

/// Whether "Encerrar" belongs on this party's live card.
func canEndParty(_ party: WatchPartyPayload?) -> Bool {
    guard let party else { return false }
    return party.isLive
}

/**
 Whether the channel's ordinary voice room ("Join" in `ChatView`'s toolbar)
 belongs on a `watch_party` channel right now.

 A CONSERVATIVE PORT, not a full one. The server's real rule is `mayGoOnAir`
 in `packages/shared/src/watch-party-session.ts` (`canStartWatchParty`, plus
 the party's host, co-hosts, and any ACCEPTED Convidados guest); Android's
 hosting review ported an older, now-`@deprecated` sibling,
 `mayTakeWatchPartySeat` (voice-on-at-all, host, co-host, or invited), which
 `join-voice-room` no longer calls at all as of this repo's current `main`
 (`server/src/ws/voice.ts` calls `mayGoOnAir`). Convidados (guests) is out of
 scope for this PR on every platform, and this build has no reliable signal
 for "an accepted guest" without building that feature, so this reads only
 `viewerRole`, which this PR's own `WatchPartyPayload` already carries: the
 host and any co-host may always rejoin the room (to manage the party, or
 because the web/another client promoted them), and everyone else, once a
 party is running, sees no seat to take -- the safety property `#436` shipped
 stays intact, and it is never WIDENED beyond what this build actually knows.

 `party == nil` (no active party) still lets anybody in, exactly like an
 ordinary voice channel: that is the door a future host walks through to
 discover `canStartWatchParty` in the first place, and it costs a viewer who
 is not going to host anything nothing at all, since there is no audience to
 protect from a channel nobody is broadcasting to yet.
 */
func watchPartyMayJoinRoom(canStartWatchParty: Bool, party: WatchPartyPayload?) -> Bool {
    if canStartWatchParty { return true }
    guard let party else { return true }
    return party.isHost || party.isCohost
}
