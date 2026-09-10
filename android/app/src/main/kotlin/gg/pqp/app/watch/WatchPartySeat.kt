package gg.pqp.app.watch

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
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
 * ## Why this could not simply be deleted
 *
 * A blanket "no join button on a watch party" would also take it from the
 * host, and a host presenting from Android is the reason the screen-share work
 * exists at all. This client could not tell a host from a viewer before
 * joining, because `welcome.canStream` is the answer and `welcome` only
 * arrives once the seat is already taken.
 *
 * `watch-party-update` is the answer, and it was on the deliberately-ignored
 * list. It carries `viewerRole`, resolved per recipient by the server, and it
 * arrives at socket auth for every active party this account may see
 * (`catchUpWatchParties`) as well as on every change. So the role is known
 * before anybody taps anything.
 *
 * ## One rule, not a second implementation of it
 *
 * [mayTakeWatchPartySeat] is a port of the function of the same name in
 * `packages/shared/src/watch-party-session.ts`, which is what the server
 * refuses `join-voice-room` with and what the web panel draws from. Three
 * implementations of a permission rule is how they drift, so this one is a
 * transcription and is meant to read as one: same name, same terms, same
 * order.
 */

/**
 * This account's standing in one channel's active party, as the party's own
 * row describes it. Mirrors the `party` argument of the shared function.
 */
data class WatchPartySeatRule(
    /**
     * Whether the host turned voice on at all.
     *
     * ABSENT ON THE WIRE READS AS ON, which is [LEGACY_VOICE_ENABLED] below
     * and matters more than it looks. `voiceEnabled` is a new option; every
     * server that predates it ran watch parties as ordinary voice rooms and
     * will happily admit anybody who asks. Reading a missing key as `false`
     * would hide the button on exactly those servers, which is a control
     * withheld for a join that would have succeeded.
     */
    val voiceEnabled: Boolean,
    val isHost: Boolean,
    val isCohost: Boolean,
    val isInvited: Boolean,
)

/**
 * A party whose options carry no `voiceEnabled` key at all.
 *
 * The same reading as `withLegacyWatchPartyVoice` in the shared package, and
 * for the same reason: a row written before the option existed was set up when
 * every watch party was a voice room. Here it also covers the whole of an
 * older *server*, which sends no such key on any party.
 */
const val LEGACY_VOICE_ENABLED = true

/**
 * The rule, transcribed from `mayTakeWatchPartySeat` in
 * `packages/shared/src/watch-party-session.ts`.
 *
 * WHO IS ALWAYS LET IN: anyone who may start a watch party in this channel,
 * the host and co-hosts by name, anyone invited up to speak, and everybody
 * once a host turns voice on.
 *
 * A CHANNEL WITH NO ACTIVE PARTY IS NOT A CLOSED ROOM. It joins like the
 * ordinary voice room it is, which is what a build with no watch party chrome
 * at all already promises.
 *
 * [canStartWatchParty] IS ALWAYS FALSE ON THIS CLIENT, and that is stated
 * rather than hidden: the phone models no permission bits, so it cannot answer
 * "may this person start a party here" before a `welcome` tells it. The people
 * this costs are staff who hold START_WATCH_PARTY and are neither the host nor
 * a co-host of the party currently running: they see no join button while it
 * runs, and a tap they never get is a smaller failure than a seat sold to five
 * hundred viewers. The parameter is kept so the shape matches the shared
 * function exactly and wiring a real answer in later is one line.
 */
fun mayTakeWatchPartySeat(
    canStartWatchParty: Boolean,
    party: WatchPartySeatRule?,
): Boolean {
    if (canStartWatchParty) {
        return true
    }
    if (party == null) {
        return true
    }
    return party.voiceEnabled || party.isHost || party.isCohost || party.isInvited
}

/**
 * Read a `watch-party-update` into the rule above.
 *
 * Null means "this channel has no party you are part of any more", which is
 * what `party: null` on the frame says and also what a frame this client
 * cannot make sense of has to mean: the safe direction here is the ordinary
 * voice room, because [mayTakeWatchPartySeat] answers true for a null party
 * and the server is still the enforcement.
 *
 * Every field is read defensively and nothing throws, the same rule
 * [decodeLiveStream] follows: a server that grew a field must not turn into a
 * channel nobody can join.
 *
 * `stage.invited` is public on the wire (who is UP is public, who is ASKING is
 * not), so an invited guest recognises themselves here without a second
 * request. [selfUserId] null means the session has not resolved yet, and an
 * account that does not know its own id cannot be on that list.
 */
fun decodeWatchPartySeat(frame: JsonObject, selfUserId: String?): WatchPartySeatRule? {
    val party = runCatching { frame["party"]?.jsonObject }.getOrNull() ?: return null
    val role = (party["viewerRole"] as? JsonPrimitive)?.contentOrNull
    val options = runCatching { party["options"]?.jsonObject }.getOrNull()
    val voiceEnabled =
        (options?.get("voiceEnabled") as? JsonPrimitive)?.booleanOrNull ?: LEGACY_VOICE_ENABLED
    val invited = selfUserId != null && runCatching {
        val list = party["stage"]?.jsonObject?.get("invited")?.jsonArray ?: return@runCatching false
        list.any { entry ->
            (entry.jsonObject["userId"] as? JsonPrimitive)?.contentOrNull == selfUserId
        }
    }.getOrDefault(false)
    return WatchPartySeatRule(
        voiceEnabled = voiceEnabled,
        isHost = role == "host",
        isCohost = role == "cohost",
        isInvited = invited,
    )
}
