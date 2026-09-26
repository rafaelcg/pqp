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

 That is still what `VoiceView`'s controls pass. The stage above the
 transcript (`watchPartyStageHostCard`, below) passes the real bit instead,
 read from `GET /api/servers/:id/permissions` (`PermissionsSnapshot`), which
 is what lets a host set up and go live without a seat first.

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

/**
 What a channel's party looks like from this phone's own point of view, at
 this moment.

 A THIRD STATE, NOT AN OVERLOADED `nil`. Before `WatchPartyHostController`
 has resolved anything for a channel -- no fetch has landed, no
 `watch-party-update` frame has arrived -- there is a real difference
 between "the lookup has not answered yet" and "the lookup answered: there
 is nothing running", and collapsing both into `party == nil` was a Farol
 finding on the first cut of this feature: a failed initial fetch read as
 "no party", which offered a watch party's audience a Join button and hid
 Create from an eligible host until something else happened to correct it.
 `.unknown` must gate every caller the same conservative direction `.known(nil)`
 does NOT: no Create, no ordinary-audience Join, because neither can be
 answered honestly yet.
 */
enum WatchPartyKnowledge: Equatable {
    case unknown
    case known(WatchPartyPayload?)

    /// Whether a party is actually RUNNING, as far as this is resolved --
    /// `.unresolved` for `.unknown`, and a TERMINAL party (`ended`/`cancelled`)
    /// read the same as none at all. `fetchChannelWatchParty` is documented
    /// to return a party in any state, including a terminal one for a while
    /// after the fact, and every caller here asks "is a party actually
    /// running", not "does a row exist" -- a terminal row must not keep
    /// `canCreate` off or keep the room seatless (Farol finding: it was
    /// doing both).
    fileprivate enum ActiveParty {
        case unresolved
        case resolved(WatchPartyPayload?)
    }

    fileprivate var active: ActiveParty {
        switch self {
        case .unknown:
            return .unresolved
        case .known(let party):
            return .resolved(party.flatMap { $0.isTerminal ? nil : $0 })
        }
    }
}

func watchPartyHostGate(
    isWatchPartyChannel: Bool,
    serverWatchPartyEnabled: Bool,
    canStartWatchParty: Bool,
    party: WatchPartyKnowledge
) -> WatchPartyHostGate {
    let eligible = isWatchPartyChannel && serverWatchPartyEnabled && canStartWatchParty
    guard eligible else {
        return WatchPartyHostGate(canCreate: false, canManage: false)
    }
    // Unresolved: neither control is answerable yet, so both stay off until
    // it resolves -- see `WatchPartyKnowledge`'s doc.
    guard case .resolved(let active) = party.active else {
        return WatchPartyHostGate(canCreate: false, canManage: false)
    }
    return WatchPartyHostGate(canCreate: active == nil, canManage: active?.isHost ?? false)
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

 No active party (or a terminal one -- see `WatchPartyKnowledge.active`)
 still lets anybody in, exactly like an ordinary voice channel: that is the
 door a future host walks through to discover `canStartWatchParty` in the
 first place, and it costs a viewer who is not going to host anything
 nothing at all, since there is no audience to protect from a channel
 nobody is broadcasting to yet.

 UNKNOWN REFUSES, deliberately the opposite of the no-party case: a lookup
 that has not answered yet cannot tell a plain viewer apart from a party's
 own host, and the safe direction between "hide a seat from an eligible
 host for a moment" and "offer one to an ordinary viewer of a live party" is
 the first (Farol finding, same shape as `WatchPartyHostGate`'s own unknown
 case).
 */
func watchPartyMayJoinRoom(canStartWatchParty: Bool, party: WatchPartyKnowledge) -> Bool {
    if canStartWatchParty { return true }
    guard case .resolved(let active) = party.active else { return false }
    guard let active else { return true }
    return active.isHost || active.isCohost
}

// MARK: - The stage, before any seat

/**
 What the watch-party stage above the transcript offers this account as a
 host, while it holds no seat in the room.

 A WATCH PARTY IS A BROADCAST, NOT A CALL. Setting one up used to need a seat
 first, because `canStartWatchParty` was only knowable once `welcome` had
 answered, and a seat on iOS asked for the microphone and published it. That
 is how a host with voice off was told the "voice server" could not be
 reached over a microphone the party never needed. The bit is now read from
 `GET /api/servers/:id/permissions` (`PermissionsSnapshot`) and the party
 from `WatchPartyHostController`, so the setup card needs nothing from the
 room, the way the web's stage draws it. Going live is the moment a seat is
 taken, and only then.

 The same `watchPartyHostGate` decides it, so the stage and `VoiceView`'s
 controls cannot disagree about who hosts. Seated, this is `hidden`: the call
 screen owns the controls then, and two sets of the same buttons would be
 two answers to one question.
 */
enum WatchPartyStageHostCard: Equatable {
    case hidden
    /// "Create watch party": nothing is running, and this account may start one.
    case create
    /// The draft or scheduled party this account runs: its name and Go live.
    case setup(WatchPartyPayload)
    /// The live party this account runs, with no seat behind it (the app was
    /// closed, or the call was left): back into the room, or End.
    case live(WatchPartyPayload)

    /// Whether this card is the host's way into the room, which the
    /// toolbar's Join must then not also be: the host is seated by going
    /// live, never by a call button (the web's `mayEnterPalco` in
    /// `watch-party-panel.tsx`).
    var isTheWayIn: Bool {
        switch self {
        case .setup, .live: true
        case .hidden, .create: false
        }
    }
}

func watchPartyStageHostCard(
    isWatchPartyChannel: Bool,
    serverWatchPartyEnabled: Bool,
    canStartWatchParty: Bool,
    party: WatchPartyKnowledge,
    isSeated: Bool
) -> WatchPartyStageHostCard {
    guard !isSeated else { return .hidden }
    let gate = watchPartyHostGate(
        isWatchPartyChannel: isWatchPartyChannel,
        serverWatchPartyEnabled: serverWatchPartyEnabled,
        canStartWatchParty: canStartWatchParty,
        party: party
    )
    if gate.canCreate { return .create }
    guard gate.canManage, case .known(let known) = party, let known else { return .hidden }
    if canGoLiveWith(known) { return .setup(known) }
    if canEndParty(known) { return .live(known) }
    return .hidden
}
