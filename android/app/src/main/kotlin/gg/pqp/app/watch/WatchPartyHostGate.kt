package gg.pqp.app.watch

/**
 * What the host-facing UI on a `watch_party` channel may show, decided in
 * one pure place so "no START_WATCH_PARTY, no host UI" and "the server has
 * watch parties off, no host UI" are provable rather than hoped for.
 *
 * ## Where [canStartWatchParty] comes from, and why that is the honest answer
 *
 * Android models no general per-channel permission tree the way the web
 * does (`ChatViewModel.kt` says as much: "permissions... until permissions
 * reach Android"). One bit this client resolves is `welcome.canStream`,
 * which the server has already turned into START_WATCH_PARTY for a
 * `watch_party` channel type (`SpeakRule.kt`'s `canStreamFrom`,
 * `VoiceState.screenShareSupported`) -- but that bit is only known once this
 * phone has joined the channel's own voice room, and a watch party is a
 * broadcast, not a call: the product rule is that setting one up must never
 * require a seat first (`docs/WATCH_PARTY.md` "A watch party has no voice by
 * default"). So `canStartWatchParty` also has a seatless path in for exactly
 * the two moments the setup surface needs it, both server-confirmed and
 * neither requiring `welcome`: holding `START_WATCH_PARTY` with nothing
 * running yet, and being the confirmed host of the party that IS running
 * (`viewerRole == "host"` on every `watch-party-update`). See
 * [mayManageWatchPartyWithoutASeat], which the caller ORs into
 * [canStartWatchParty] rather than this file reaching for a permission
 * bitfield itself. The join-gated path stays alongside it rather than being
 * replaced: it is still what lets somebody who holds no bit at all, but was
 * handed the room's `canStream` by an ordinary join, run the show, and it is
 * still the same trade [mayJoinWatchPartyRoom]'s own doc makes for staff who
 * are neither host nor co-host of a running party.
 *
 * ## Where [serverWatchPartyEnabled] comes from
 *
 * `GET /api/live-hls/config?serverId=`.`enabled` -- the exact route and field
 * the web reads for the identical question (`docs/WATCH_PARTY.md`, "Widening
 * it is a click now"). Never inferred from a build flag: a self-host with no
 * `LIVE_HLS_*` configured must not draw a Criar watch party button that
 * cannot go anywhere.
 */
data class WatchPartyHostGate(
    /** "Criar watch party" belongs on the empty stage. */
    val canCreate: Boolean,
    /** This account is running [party] and its setup/live controls belong on the stage. */
    val canManage: Boolean,
)

fun watchPartyHostGate(
    isWatchPartyChannel: Boolean,
    serverWatchPartyEnabled: Boolean,
    canStartWatchParty: Boolean,
    party: WatchPartyPayload?,
): WatchPartyHostGate {
    val eligible = isWatchPartyChannel && serverWatchPartyEnabled && canStartWatchParty
    if (!eligible) {
        return WatchPartyHostGate(canCreate = false, canManage = false)
    }
    return WatchPartyHostGate(
        canCreate = party == null,
        canManage = party != null && party.isHost && party.state != "ended" && party.state != "cancelled",
    )
}

/**
 * Whether this phone may treat itself as able to start or manage this
 * channel's watch party WITHOUT a seat in its voice room -- see
 * [watchPartyHostGate]'s doc, "Where canStartWatchParty comes from".
 *
 * Two reasons, both server-confirmed and neither one a join:
 * [mayStartWatchParty] (the channel's `START_WATCH_PARTY` bit) with nothing
 * running yet -- the channel list's "Host a watch party" row, or landing on
 * an empty channel -- and being the confirmed host of the party that IS
 * running. The second is what actually closes the gap this function exists
 * for: without it, a host who already created a `draft` would lose the
 * seatless path the moment [party] stopped being `null`, and the setup
 * card's "Ir ao vivo" would go back to demanding a voice-room join to even
 * appear -- exactly the drop-into-a-call-to-set-up-a-broadcast this is
 * meant to prevent. A co-host is deliberately left out: Android tracks no
 * co-host promote/demote yet (`WatchPartyModels.kt`'s doc), so `viewerRole`
 * never reads `cohost` here today, and the day it can, this is the one place
 * that would need to widen.
 */
fun mayManageWatchPartyWithoutASeat(
    mayStartWatchParty: Boolean,
    party: WatchPartyPayload?,
): Boolean = (mayStartWatchParty && party == null) || party?.isHost == true

/** Whether "Ir ao vivo" belongs on this party's setup card. */
fun canGoLiveWith(party: WatchPartyPayload?): Boolean = party != null && party.isPreLive

/** Whether "Encerrar" belongs on this party's live card. */
fun canEndParty(party: WatchPartyPayload?): Boolean = party != null && party.isLive
