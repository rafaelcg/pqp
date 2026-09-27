package gg.pqp.app.watch

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Whether a seat in a watch party's room is this phone's to take, and how this
 * phone finds out before it asks.
 *
 * ## The gap this closes
 *
 * A watch party's audience is seatless by construction: watching is a socket
 * reading an HLS playlist, and a seat is a LiveKit participant with forwarded
 * streams. That is the whole economy of the feature and
 * [WatchLiveStore] is where it is enforced on the way out.
 *
 * The way IN was still open. `chat.joinVoice` in the channel app bar is drawn
 * for any channel `Channel.isVoice` answers true for, and `watch_party` was
 * widened into that set when the player shipped, so an Android viewer was
 * offered a green button that puts them on the media box for something they
 * were about to watch for free. The web stopped offering that (#436); this
 * client had not followed.
 *
 * ## A conservative port, not the server's full rule
 *
 * The server's real authority is `mayGoOnAir` in
 * `packages/shared/src/watch-party-session.ts`, fed by
 * `fetchWatchPartySeatSnapshot`: the channel's `START_WATCH_PARTY` holder,
 * the party's host, its co-hosts, and any ACCEPTED Convidados guest. This
 * file used to port an older, now-`@deprecated` sibling of that function,
 * `mayTakeWatchPartySeat` (voice-on-at-all, host, co-host, or an invited-but-
 * not-yet-accepted guest), which `join-voice-room` no longer calls at all.
 * That mismatch was a real bug: an old party carries no `options.voiceEnabled`
 * key at all, the deprecated rule read a missing key as "voice on" for
 * backward compatibility, and an ordinary viewer of that party saw a join
 * button the server then refused.
 *
 * Convidados (guests) is out of scope for this fix on every platform (see
 * iOS's `watchPartyMayJoinRoom` in `WatchPartyHostGate.swift`, #835, which
 * this mirrors), and this build has no reliable signal for "an accepted
 * guest" without building that feature. So [mayJoinWatchPartyRoom] reads only
 * `viewerRole`: the host and any co-host may always rejoin the room (to
 * manage the party, or because the web or another client promoted them), and
 * everyone else, once a party is running, sees no seat to take. That is
 * NEVER WIDER than what the server actually allows, which is the property
 * that matters -- a host or co-host this build fails to recognise loses a
 * join button; a viewer this build wrongly admits reaches a room the server
 * refuses, which is the bug being fixed.
 */

/**
 * This account's standing in one channel's active party, as the party's own
 * row describes it.
 */
data class WatchPartySeatRule(
    val isHost: Boolean,
    val isCohost: Boolean,
    /**
     * `state` is one of `WATCH_PARTY_TERMINAL_PHASES` (`ended` or
     * `cancelled`). A terminal party reads the same as no active party at
     * all in [mayJoinWatchPartyRoom]: nothing is running any more, so the
     * channel is an ordinary voice room again, exactly as
     * `WatchPartyKnowledge.active` treats it on iOS.
     */
    val isTerminal: Boolean,
)

/**
 * Whether the channel's ordinary voice room ("Entrar" in the app bar) belongs
 * to this account right now.
 *
 * WHO IS ALWAYS LET IN: anyone who may start a watch party in this channel,
 * and the host and co-hosts of the party currently running, by name.
 *
 * A CHANNEL WITH NO ACTIVE PARTY IS NOT A CLOSED ROOM, and neither is one
 * whose party has ended or been cancelled. Both join like the ordinary voice
 * room the channel is, which is what a build with no watch party chrome at
 * all already promises, and it is the door a future host walks through to
 * discover `canStartWatchParty` in the first place.
 *
 * [canStartWatchParty] IS ALWAYS FALSE ON THIS CLIENT unless the caller has
 * already joined the channel's room and been told it may stream, because the
 * phone models no permission bits and cannot answer "may this person start a
 * party here" before a `welcome` tells it. The people this costs are staff
 * who hold START_WATCH_PARTY and are neither the host nor a co-host of the
 * party currently running: they see no join button while it runs, and a tap
 * they never get is a smaller failure than a seat sold to five hundred
 * viewers.
 */
fun mayJoinWatchPartyRoom(
    canStartWatchParty: Boolean,
    party: WatchPartySeatRule?,
): Boolean {
    if (canStartWatchParty) {
        return true
    }
    if (party == null || party.isTerminal) {
        return true
    }
    return party.isHost || party.isCohost
}

/**
 * Read a `watch-party-update` into the rule above.
 *
 * Null means "this channel has no party you are part of any more", which is
 * what `party: null` on the frame says and also what a frame this client
 * cannot make sense of has to mean: the safe direction here is the ordinary
 * voice room, because [mayJoinWatchPartyRoom] answers true for a null party
 * and the server is still the enforcement.
 *
 * Every field is read defensively and nothing throws, the same rule
 * [decodeLiveStream] follows: a server that grew a field must not turn into a
 * channel nobody can join.
 */
fun decodeWatchPartySeat(frame: JsonObject): WatchPartySeatRule? {
    val party = runCatching { frame["party"]?.jsonObject }.getOrNull() ?: return null
    val role = (party["viewerRole"] as? JsonPrimitive)?.contentOrNull
    val state = (party["state"] as? JsonPrimitive)?.contentOrNull
    return WatchPartySeatRule(
        isHost = role == "host",
        isCohost = role == "cohost",
        isTerminal = state == "ended" || state == "cancelled",
    )
}
