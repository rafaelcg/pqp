package gg.pqp.app.voice

import gg.pqp.app.core.VoiceParticipant

/** The loudest a person can be turned up: twice what they send. */
const val PEER_VOLUME_MAX = 2.0

/** Untouched. Everybody starts here. */
const val PEER_VOLUME_DEFAULT = 1.0

/** The slider moves in fives of a percent, like the web's. */
const val PEER_VOLUME_STEP = 0.05

fun clampPeerVolume(volume: Double): Double =
    if (volume.isNaN()) PEER_VOLUME_DEFAULT else volume.coerceIn(0.0, PEER_VOLUME_MAX)

/**
 * How loud each other person is on this phone, kept by **user**.
 *
 * Per-person volume exists on the web (`peerVolumes`, 0 to 1) and on iOS
 * (`volumeByUser`, 0 to 2). Android follows iOS's range, because a phone
 * speaker is where "a bit louder than they sent it" is most often wanted, and
 * both agree on everything else:
 *
 * - **Keyed by user id, never by peer id.** The server mints a fresh peer id on
 *   every join, so a peer-keyed level would reset whenever somebody reconnected
 *   (a deploy, a network change). The controller maps roster entries to users.
 * - **Default 1 (100%), kept for the app session.** Nothing is written to disk,
 *   as on both other clients; it outlives a call and not the process.
 * - **Muting is the slider at zero**, and unmuting goes back to where it was
 *   rather than to 100%: somebody turned down to 40% and muted wants 40% back.
 *   That memory lives here so every surface that offers a mute button agrees.
 *
 * A moderator's server mute is a different switch and is not stored here: it
 * sits on top of this level without overwriting it (see [RemoteAudioGate]).
 *
 * Plain Kotlin so the rules run on the JVM; the controller owns one and pushes
 * the answers into the engine.
 */
class PeerVolumes {
    private val levels = HashMap<String, Double>()

    /** The last level above zero, which is where unmuting goes back to. */
    private val lastAudible = HashMap<String, Double>()

    fun volumeFor(userId: String): Double = levels[userId] ?: PEER_VOLUME_DEFAULT

    /** Sets the level, clamped, and returns what was stored. */
    fun set(userId: String, volume: Double): Double {
        val clamped = clampPeerVolume(volume)
        if (clamped > 0.0) lastAudible[userId] = clamped
        levels[userId] = clamped
        return clamped
    }

    /** The mute button: zero, or back to the last level above zero. */
    fun toggleMute(userId: String): Double =
        if (volumeFor(userId) > 0.0) {
            set(userId, 0.0)
        } else {
            set(userId, lastAudible[userId] ?: PEER_VOLUME_DEFAULT)
        }

    fun isMuted(userId: String): Boolean = volumeFor(userId) == 0.0
}

/**
 * Everybody on the roster but this device, one entry per account: the people a
 * volume control is for. One per user because the level is kept by user, so two
 * seats of the same account share one slider (and a list key stays unique).
 */
fun VoiceState.otherParticipants(): List<VoiceParticipant> =
    participants
        .filter { it.peerId != localPeerId }
        .distinctBy { it.userId }
