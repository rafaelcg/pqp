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
 * reach Android"). The one bit this client DOES resolve is
 * `welcome.canStream`, which the server has already turned into
 * START_WATCH_PARTY for a `watch_party` channel type (`SpeakRule.kt`'s
 * `canStreamFrom`, `VoiceState.screenShareSupported`). That bit is only known
 * once this phone has joined the channel's own voice room -- which a channel
 * with no active party admits anyone to, exactly like an ordinary voice
 * channel (`WatchPartySeat.kt`'s null-party branch already returns true for
 * that case). So `canStartWatchParty` here means "joined this channel's room
 * AND the server told this seat it may stream", and it is `false` before
 * that join. The cost is one extra tap for the actual host -- who was always
 * going to join the room to speak anyway -- and nothing at all for anyone
 * else, which is the same trade [mayTakeWatchPartySeat]'s own doc already
 * makes for staff who are neither host nor co-host of a running party.
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

/** Whether "Ir ao vivo" belongs on this party's setup card. */
fun canGoLiveWith(party: WatchPartyPayload?): Boolean = party != null && party.isPreLive

/** Whether "Encerrar" belongs on this party's live card. */
fun canEndParty(party: WatchPartyPayload?): Boolean = party != null && party.isLive
