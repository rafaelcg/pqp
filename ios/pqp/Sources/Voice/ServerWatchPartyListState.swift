import Foundation

/**
 What the channel list's watch-party slot draws, decided in one pure place --
 the same reason `WatchPartyHostGate.swift` exists as a function rather than
 inline `if`s scattered across the view.

 MIRRORS `client/src/components/watch-party/live-party-block.tsx`'s branch
 ladder, in particular the doc comment on its `parties.length === 0` branch:
 "NOTHING, OR ONE BUTTON". Four outcomes, checked in this order because each
 one is a stronger fact than the one after it:

 1. **A party is live.** Wins over everything, including this account's own
    pending draft elsewhere in the server (there is at most one active party
    per channel, but a server can run more than one `watch_party` room).
 2. **This account's own pending party.** A `draft`/`scheduled` row whose
    `viewerRole` is `host` or `cohost` -- never a stranger's, which
    `GET /api/servers/:serverId/watch-parties` never sends this account
    anyway (`presentWatchParty` resolves visibility server side, so an
    unrelated draft simply is not in `parties`). Shown even when `canHost`
    is false, matching the web: a co-host who lost `START_WATCH_PARTY`
    after being added still needs the way back into a party already
    running.
 3. **`canHost` alone.** One "Create watch party" row -- see `canHost`'s own
    doc for what it means on this build, and why it is coarser than the
    server's real rule.
 4. **Nothing.** No heading, no row, no placeholder -- exactly `live-party-
    block.tsx`'s "NOTHING, OR ONE BUTTON" comment, mirrored down to the
    absence.

 A server's waitlist teaser and the "Transmissões anteriores" history links
 (`historyChannels` on the web's `LivePartyBlock`) are deliberately not
 ported -- out of scope for this pass, see the PR description.
 */
enum ServerWatchPartyListState: Equatable {
    case none
    case live(WatchPartyPayload)
    case pending(WatchPartyPayload)
    case canHost
}

/**
 Decide the channel list's watch-party slot from this server's parties and
 whether this account may start one.

 - Parameters:
   - parties: Every party `GET /api/servers/:serverId/watch-parties`
     answered with for this server, in any state it returned (the route
     itself only ever returns active ones -- live, draft, scheduled -- so
     nothing here has to re-check for `ended`/`cancelled`).
   - canHost: Whether the "Create watch party" row belongs on this server at
     all.

     THE COARSE STAND-IN, NOT THE SERVER'S REAL RULE. The web's
     `canOfferWatchPartyCreate` is `START_WATCH_PARTY` (a genuine per-role
     permission bit) AND the server's own live-hls availability. iOS models
     no per-channel permission tree -- see `WatchPartyHostGate.swift`'s own
     doc for why `canStartWatchParty` there is only knowable once a seat is
     already taken -- so callers pass `Moderation.isManager(server.role)`
     (owner/admin) alongside the live-hls answer instead, the same
     approximation `ChannelListView` already uses for "New channel" and
     "Community settings". It is a narrower answer than the server's: a
     Moderator role holding `START_WATCH_PARTY` without being owner/admin
     sees no row here and has to reach hosting through an existing
     `watch_party` channel's own call screen instead, same as before this
     change. It is never a WIDER one -- the create call itself still asks
     the server, which is what actually enforces the bit, so a wrong `true`
     here costs a refusal alert, never an unauthorised party.
 */
func resolveServerWatchPartyListState(
    parties: [WatchPartyPayload],
    canHost: Bool
) -> ServerWatchPartyListState {
    if let live = newestLiveParty(in: parties) {
        return .live(live)
    }
    if let pending = parties.first(where: {
        $0.isPreLive && ($0.isHost || $0.isCohost)
    }) {
        return .pending(pending)
    }
    return canHost ? .canHost : .none
}

/// The newest live party, by `wentLiveAt` -- mirrors `sortNewestFirst` in
/// the web's `use-watch-parties.ts`. A party missing `wentLiveAt` (should
/// not happen for a `live` row, but the field is nullable on the wire) sorts
/// last rather than crashing a comparison.
private func newestLiveParty(in parties: [WatchPartyPayload]) -> WatchPartyPayload? {
    parties
        .filter(\.isLive)
        .max { ($0.wentLiveAt ?? "") < ($1.wentLiveAt ?? "") }
}
