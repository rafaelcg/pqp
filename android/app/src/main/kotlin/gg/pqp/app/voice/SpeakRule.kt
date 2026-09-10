package gg.pqp.app.voice

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject

/**
 * The server's SPEAK rule for this seat, and what the client does about it.
 *
 * Pure and free of Android imports, so the two things that go wrong silently
 * can be pinned by a JVM test: a `welcome` whose bit is read from the wrong
 * place (the top-level key and `self.canSpeak` carry the same value, and either
 * may be absent on an older server), and a revoke mid-call that leaves the
 * microphone open because the UI only ever consulted `muted`.
 *
 * Mirrors `applySpeakRule` in `client/src/hooks/use-voice.ts`. In a LiveKit
 * room the server has already withheld the publish grant, so this is the UI
 * catching up with a fact; in a mesh room this IS the enforcement, which
 * `docs/voice-backends.md` documents under "Speak permission".
 */

/** Where the bit came from. A `welcome` that says false explains itself once. */
enum class SpeakRuleSource { Welcome, Change }

/** The sentence to show, if any. The controller maps these onto string resources. */
enum class SpeakNotice { ListenOnly, SpeakGranted }

data class SpeakRuleOutcome(
    val canSpeak: Boolean,
    /**
     * Force the microphone off. Never the other way round: `true` after
     * `false` unlocks the control and leaves the unmute to the person.
     */
    val mute: Boolean,
    /** Drop an outgoing screen share; the roster no longer carries it. */
    val stopPublishing: Boolean,
    val notice: SpeakNotice?,
)

/**
 * `welcome.canSpeak` at the top level, then `self.canSpeak`, then true.
 *
 * Absent on both means a server that predates SPEAK enforcement, where
 * everyone resolved as allowed. Refusing there would mute every self-host.
 */
internal fun canSpeakFrom(welcome: JsonObject): Boolean {
    (welcome["canSpeak"] as? JsonPrimitive)?.booleanOrNull?.let { return it }
    val self = runCatching { welcome["self"]?.jsonObject }.getOrNull() ?: return true
    return (self["canSpeak"] as? JsonPrimitive)?.booleanOrNull ?: true
}

/**
 * `welcome.canStream`, then `self.canStream`, then `canSpeak`.
 *
 * The stage bit, which is STREAM in a plain voice channel and
 * START_WATCH_PARTY in a `watch_party` one; the server has already decided
 * which question it answered (`canStartWatchPartyStream`), so this client asks
 * one thing and never compares channel types.
 *
 * Falling back to `canSpeak` rather than to true is the shared schema's own
 * rule ("Absent reads as `canSpeak`"), and it is the safe direction: a
 * listen-only seat must not be offered a share button.
 */
internal fun canStreamFrom(welcome: JsonObject): Boolean {
    (welcome["canStream"] as? JsonPrimitive)?.booleanOrNull?.let { return it }
    val self = runCatching { welcome["self"]?.jsonObject }.getOrNull()
    (self?.get("canStream") as? JsonPrimitive)?.booleanOrNull?.let { return it }
    return canSpeakFrom(welcome)
}

/**
 * Whether the share button stands, after a `voice-speak-changed`.
 *
 * Three inputs and one rule, pulled out of the controller because it is the
 * whole of what decides whether a host can present and it is otherwise buried
 * in a frame handler with a `MediaProjection` on one side of it.
 *
 * - **SPEAK gone takes the stage with it.** A listen-only seat cannot publish
 *   anything, and the server has already stopped relaying it.
 * - **`canStream` absent leaves the answer alone.** The field is optional on
 *   the wire, so an older server sending only `canSpeak` must not be read as
 *   "and no stage either": that would silently retire the button for every
 *   self-host the moment a moderator touched anybody's microphone.
 * - **`canStream` present is the answer**, in both directions. Losing it
 *   mid-party is a moderator stopping a broadcast.
 */
internal fun streamRule(canSpeak: Boolean, next: Boolean?, was: Boolean): Boolean =
    canSpeak && (next ?: was)

internal fun speakRule(canSpeak: Boolean, was: Boolean, source: SpeakRuleSource): SpeakRuleOutcome {
    if (!canSpeak) {
        return SpeakRuleOutcome(
            canSpeak = false,
            mute = true,
            stopPublishing = true,
            notice = if (was || source == SpeakRuleSource.Welcome) SpeakNotice.ListenOnly else null,
        )
    }
    return SpeakRuleOutcome(
        canSpeak = true,
        mute = false,
        stopPublishing = false,
        notice = if (!was && source == SpeakRuleSource.Change) SpeakNotice.SpeakGranted else null,
    )
}
