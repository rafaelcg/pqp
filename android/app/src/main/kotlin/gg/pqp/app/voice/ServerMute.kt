package gg.pqp.app.voice

import gg.pqp.app.core.VoiceParticipant

/**
 * What a roster says about a moderator having muted *this* device.
 *
 * Pulled out of [VoiceController] so it can run on the JVM: the controller
 * needs a `Context` and an engine that needs libwebrtc, and the rule below is
 * the one piece of the server-mute contract about the local person rather than
 * about a peer, so it deserves a test that does not need either.
 *
 * The rule: find ourselves on the roster by peer id, copy the flag, and while it
 * is set force the local mute on. The server rejects `set-voice-state` with
 * `muted: false` from a server-muted peer and snaps the roster back, so a client
 * that kept showing a live microphone would be lying for a round trip and then
 * flickering. Clearing the flag does **not** unmute: the person was muted by
 * somebody else, and handing their microphone back without asking is the one
 * thing a mute control must never do. They unmute themselves, as on the web.
 */
internal fun VoiceState.absorbServerMute(
    participants: List<VoiceParticipant>,
    localPeerId: String?,
): VoiceState {
    val self = participants.firstOrNull { it.peerId == localPeerId }
    val serverMuted = self?.serverMuted ?: this.serverMuted
    return copy(
        serverMuted = serverMuted,
        muted = muted || serverMuted,
    )
}

/**
 * Whether the mute button does anything right now.
 *
 * One expression, named, so the controller and the call bar cannot disagree
 * about it: the button is drawn inert for exactly the state in which a tap is
 * ignored, and the test pins both to the same fact.
 */
internal val VoiceState.muteControlEnabled: Boolean
    get() = !serverMuted

/**
 * Everybody on the roster a moderator has muted, other than this device.
 *
 * The local person is left out because their case is drawn differently (the
 * mute control itself, and the status line), not because the flag means
 * something else for them.
 */
internal fun VoiceState.serverMutedPeers(): List<VoiceParticipant> =
    participants.filter { it.serverMuted && it.peerId != localPeerId }
