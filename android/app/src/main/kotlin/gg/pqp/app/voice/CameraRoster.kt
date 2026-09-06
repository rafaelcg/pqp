package gg.pqp.app.voice

import gg.pqp.app.core.VoiceParticipant

/** One face in the strip under the call bar. */
data class CameraRailEntry(
    val peerId: String,
    /** The roster's name for them, or null when the roster has not said yet. */
    val displayName: String?,
)

/**
 * Who gets a tile in the camera strip, and in what order.
 *
 * Pure, and separate from the composable, because the interesting cases here
 * are the ones a Compose preview will never show anybody: a camera whose owner
 * the `/ws` roster has not named yet, and this device's own row.
 *
 * **Roster order, then the rest.** The roster is the order every other voice
 * surface uses, so the strip agrees with the head count above it and a tile
 * does not jump when somebody else's camera arrives.
 *
 * **A camera the roster has not named still gets a tile.** The two arrive over
 * different connections: LiveKit delivers the media and `/ws` delivers the
 * name, and on a busy join the media routinely wins. Dropping the tile until
 * the name lands would be a face that flickers into existence a second late,
 * and, in the case where the roster frame is lost entirely, a person who is on
 * camera and invisible on this phone with nothing anywhere saying why. The
 * name is what waits, not the picture. [CameraRailEntry.displayName] is null
 * for that beat and the caller prints a placeholder.
 *
 * **Never this device.** `localPeerId` is on the roster like everybody else,
 * and this client publishes no camera at all, so it can only ever appear here
 * through a bug. Excluded rather than trusted not to happen.
 *
 * **One tile per peer id, whatever the roster says.** The strip keys its tiles
 * by peer id and a `LazyRow` throws on a duplicate key, so a roster that listed
 * somebody twice would not be a wrong strip, it would be a crash in the call
 * bar, which is on screen everywhere.
 */
fun cameraRailEntries(
    participants: List<VoiceParticipant>,
    cameraPeerIds: Set<String>,
    localPeerId: String?,
): List<CameraRailEntry> {
    if (cameraPeerIds.isEmpty()) return emptyList()
    val named = participants
        .filter { it.peerId in cameraPeerIds && it.peerId != localPeerId }
        .distinctBy { it.peerId }
        .map { CameraRailEntry(it.peerId, it.displayName) }
    val onRoster = participants.mapTo(mutableSetOf()) { it.peerId }
    val unnamed = cameraPeerIds
        .filter { it !in onRoster && it != localPeerId }
        .sorted()
        .map { CameraRailEntry(it, null) }
    return named + unnamed
}
