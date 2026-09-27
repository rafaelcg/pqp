import Foundation

/**
 What the channel list's watch-party slot draws, decided in one pure place --
 the same reason `WatchPartyHostGate.swift` exists as a function rather than
 inline `if`s scattered across the view.

 MIRRORS `client/src/components/watch-party/live-party-block.tsx`'s branch
 ladder, in particular the doc comment on its `parties.length === 0` branch:
 "NOTHING, OR ONE BUTTON". Five outcomes now, checked in this order because
 each one is a stronger fact than the one after it:

 1. **Unknown.** `parties` is `nil`: `GET /api/servers/:serverId/watch-parties`
    has never answered cleanly for this screen. Reads the same as "nothing" --
    no Create row (a party might already exist and this screen simply does
    not know it yet), and no card either. NOT the same state as "asked, and
    the answer was zero parties" -- see `parties`'s own doc below for why a
    FAILED refetch must never collapse the two.
 2. **A party is live.** Wins over everything, including this account's own
    pending draft elsewhere in the server (there is at most one active party
    per channel, but a server can run more than one `watch_party` room).
 3. **This account's own pending party.** A `draft`/`scheduled` row whose
    `viewerRole` is `host` or `cohost` -- never a stranger's, which
    `GET /api/servers/:serverId/watch-parties` never sends this account
    anyway (`presentWatchParty` resolves visibility server side, so an
    unrelated draft simply is not in `parties`). Shown even when `canHost`
    is false, matching the web: a co-host who lost `START_WATCH_PARTY`
    after being added still needs the way back into a party already
    running.
 4. **`canHost` alone.** One "Create watch party" row -- see `canHost`'s own
    doc for exactly what fact it is.
 5. **Nothing.** No heading, no row, no placeholder -- exactly `live-party-
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

     `nil` MEANS UNKNOWN, NOT "ASKED, GOT ZERO". A fetch that has never
     landed a clean answer (or a REFETCH that failed after an earlier one
     had) must never be read as "no parties running" -- the Farol finding
     this closes: a transient failure used to clear the slot to `[]`, which
     could drop a live card a manager was mid-broadcast on, or silently open
     the Create row on top of a party the caller simply could not see any
     more. The caller (`ChannelListView`) keeps the last successfully
     fetched array on a failed refetch rather than assigning `nil` or `[]`
     over it, so this case is reached only before the very first successful
     fetch.
   - canHost: Whether the "Create watch party" row belongs on this server at
     all.

     THE SAME FACT THE WEB CHECKS, not an approximation of it.
     `canOfferWatchPartyCreate` (`client/src/lib/watch-party-channels.ts`) is
     `hlsEnabled === true && hasPermission`, where `hasPermission` is
     `perms.can(Permission.START_WATCH_PARTY)` with NO channel id
     (`client/src/App.tsx`'s sidebar wiring) -- the server-wide bits alone,
     because the create button may be making a channel that does not exist
     yet, so there is nothing to check a channel override against. Callers
     here pass exactly that: `PermissionsSnapshot.can(PermissionBit.
     startWatchParty)`, no `channelId`, ANDed with the live-hls answer --
     see `PermissionBits.swift` for where the snapshot comes from and why
     an owner or an ADMINISTRATOR role already reads as holding the bit
     with no special-casing (the server resolves both to every bit before
     this ever reaches the wire). `ChatView`'s own `canHostWatchParty`,
     which only ever names a channel that already exists, passes a
     `channelId` and gets the more precise, channel-overridden answer this
     function's `canHost` intentionally does not ask for.
 */
func resolveServerWatchPartyListState(
    parties: [WatchPartyPayload]?,
    canHost: Bool
) -> ServerWatchPartyListState {
    guard let parties else {
        return .none
    }
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

/// What tapping a watch-party card in the channel list does.
enum WatchPartyCardTap: Equatable {
    /// Open the channel and watch, with no seat: the audience's path.
    case watch
    /// Open the channel too, with no seat: the stage above the transcript
    /// draws the host's setup card there (`WatchPartyStageHostView`). If
    /// this phone already holds a seat in that room, the call screen comes
    /// back instead, where the live controls are.
    case host
}

/**
 Decide what a watch-party card tap does, from the party the card draws.

 NEITHER PATH TAKES A SEAT. The host's setup card used to exist only on the
 call screen, so a host tap joined the room to reach it, and a seat asked for
 the microphone and published it (TestFlight 1.0.5 then blamed the "voice
 server" for a microphone the party never needed). The card is on the stage
 now and going live is the moment a seat is taken, so the two paths differ
 only in what an existing seat does: brought back for a host, irrelevant for
 the audience, whose seat would cost a participant on the media box and buy
 them nothing on the default `hosts_only` stage (see `ChatView`'s toolbar for
 the same rule).

 Keyed on `viewerRole` alone, not on the card's state: a pending card is
 always the host's or a co-host's (`resolveServerWatchPartyListState` never
 builds one otherwise), and a live card that belongs to this account is
 where its End control is.
 */
func watchPartyCardTap(for party: WatchPartyPayload) -> WatchPartyCardTap {
    party.isHost || party.isCohost ? .host : .watch
}
