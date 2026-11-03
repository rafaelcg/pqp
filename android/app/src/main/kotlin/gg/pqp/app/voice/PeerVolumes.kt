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

/**
 * The SFU side of per-person volume: a level per peer, applied to the peer's
 * audio tracks both when the level changes and when a track arrives later.
 *
 * Held apart from [LiveKitEngine] so the two orders that matter can be tested
 * without the SDK: the slider moving after the track is already subscribed
 * (the common case in a call that has been up a while) and a track subscribing
 * after the slider moved (a reconnect hands back fresh tracks). [apply] is
 * `RemoteAudioTrack.setVolume` in the engine. Not thread safe; the engine
 * confines it to its peer lock.
 */
class PeerAudioLevels<T : Any>(private val apply: (track: T, volume: Double) -> Unit) {
    private val levels = HashMap<String, Double>()

    /**
     * Stores the level and applies it to the peer's tracks as [tracks] reports
     * them. Returns false, and never calls [tracks], on a repeat: roster frames
     * resend every level, so the scan must cost nothing when nothing changed.
     *
     * The caller holds the lock that [trackSubscribed] also takes, so a track
     * subscribing at the same moment either is already in the list or runs
     * afterwards and finds the new level, never the old one.
     */
    fun setLevel(peerId: String, volume: Double, tracks: () -> Collection<T>): Boolean {
        val before = levels[peerId] ?: PEER_VOLUME_DEFAULT
        if (before == volume) return false
        // Stored only once every track has taken it: if the scan or an apply
        // throws, the next roster frame resends this level and must find it
        // still unapplied rather than skip it as a repeat.
        tracks().forEach { apply(it, volume) }
        levels[peerId] = volume
        return true
    }

    /** A track subscribed: bring it to the level already chosen for its peer. */
    fun trackSubscribed(peerId: String, track: T) {
        apply(track, levels[peerId] ?: PEER_VOLUME_DEFAULT)
    }

    fun levelFor(peerId: String): Double = levels[peerId] ?: PEER_VOLUME_DEFAULT

    fun forget(peerId: String) {
        levels.remove(peerId)
    }

    fun clear() {
        levels.clear()
    }
}
