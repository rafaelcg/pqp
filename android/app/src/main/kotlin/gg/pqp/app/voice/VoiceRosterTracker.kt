package gg.pqp.app.voice

import gg.pqp.app.core.VoiceParticipant

/**
 * THE ROOM, REBUILT FROM WHAT CHANGED IN IT.
 *
 * A `voice-roster` carries every participant to everyone who can *see* the
 * channel, because the occupancy badges are drawn for people standing outside
 * the call. On 2026-09-05 that was ~99 kB a frame to every socket in a 508
 * member community, and a phone on mobile data pays for all of it whether or
 * not it is in the call. So a socket that says it understands
 * `voice-roster-delta` is sent only what changed, and this class is what turns
 * that back into the whole room the rest of [VoiceController] already reads.
 *
 * Three lists, applied IN ORDER, each an absolute statement about one peer:
 *
 *   joined   this peer is in the room, with this state (replace by peerId)
 *   updated  this peer is in the room, with this state (replace by peerId)
 *   left     this peer is not in the room (remove by peerId)
 *
 * Because every entry is absolute rather than relative, applying one twice is
 * the same as applying it once, which is what makes a delta that overlaps a
 * snapshot this client already holds harmless rather than corrupting.
 *
 * HOW IT KNOWS IT IS STILL RIGHT. Two independent checks, and failing either
 * one means this client stops patching and waits:
 *
 *   `seq`   monotonic per room, +1 per frame, restarted at 1 whenever the room
 *           has been empty. A delta is applied only when it is the next one.
 *           A client with no baseline holds 0, so the first delta of a fresh
 *           call is self-sufficient and needs no round trip.
 *   `size`  how many participants the room has AFTER the delta. A client that
 *           applied all three lists and still disagrees has diverged for some
 *           reason `seq` cannot see, and is equally out of sync.
 *
 * On either failure [delta] answers null, the caller leaves the participant
 * list exactly as it was, and the server's periodic full roster (every ~10s,
 * `ROSTER_KEYFRAME_MS` in `server/src/ws/voice.ts`) replaces the state
 * wholesale. That is the whole convergence argument: the worst a lost or
 * reordered frame can cost is a bounded interval of staleness, never a peer
 * who is invisible until somebody rejoins.
 *
 * ORDER IS PRESERVED, deliberately. This backs a list of tiles on a phone
 * screen, and rebuilding it from an unordered map would shuffle everybody's
 * face every time one person muted. A replaced peer keeps its position, a new
 * one is appended, which is exactly what the web client's `Map` does.
 *
 * NOTHING ELSE WRITES TO THE BASELINE. `peer-joined`, `peer-updated` and
 * `peer-left` still arrive for the room this device is in, and
 * [VoiceController] still applies them to the participant list directly; they
 * are deliberately NOT fed here. The server's roster sequence is complete on
 * its own, and every change those frames report is also reported by the delta
 * covering the same window, so mixing the two sources would double-count and
 * fail the size check for no reason.
 *
 * Not thread safe, and does not need to be: every caller is
 * `VoiceController.listen`, which is one coroutine collecting one flow.
 */
class VoiceRosterTracker {
    private var trackedChannelId: String? = null
    private var held: Int = 0
    private val byPeerId = LinkedHashMap<String, VoiceParticipant>()

    /** The sequence this tracker has applied up to. 0 means "no baseline". */
    val sequence: Int get() = held

    /** The channel the baseline describes, or null when there is none. */
    val channelId: String? get() = trackedChannelId

    /**
     * Drop the baseline.
     *
     * Called whenever this device's relationship to a room changes under it:
     * joining, leaving, and a socket drop. A sequence held across any of those
     * is a number the server no longer shares, and the danger is not that it
     * is stale but that it might accidentally line up, in which case a delta
     * would be applied to the wrong room's participants.
     */
    fun forget() {
        trackedChannelId = null
        held = 0
        byPeerId.clear()
    }

    /**
     * A full roster. Authoritative by definition: whatever the sequence said
     * and whatever this client believed, the room is now exactly this.
     *
     * `seq` is absent on a server that predates deltas, and absent reads as 0,
     * which is also what an empty room restarts from.
     */
    fun snapshot(
        channelId: String,
        participants: List<VoiceParticipant>,
        seq: Int?,
    ): List<VoiceParticipant> {
        trackedChannelId = channelId
        byPeerId.clear()
        participants.forEach { byPeerId[it.peerId] = it }
        // The server forgets an empty room's sequence so the next call in this
        // channel starts again at 1. A client that kept the old number would
        // read that first delta as a gap and sit out the whole next call until
        // a keyframe rescued it.
        held = if (participants.isEmpty()) 0 else (seq ?: 0)
        return byPeerId.values.toList()
    }

    /**
     * A delta. Returns the whole room once it has been applied, or **null**
     * when it must not be applied at all: a sequence gap, or a size the server
     * and this client disagree about.
     *
     * A refused delta changes nothing, not even the sequence. Advancing past
     * one would turn a single missed frame into a permanently wrong room,
     * because the next delta would then look like the next one in line while
     * the baseline underneath it is missing whatever the skipped frame said.
     */
    fun delta(
        channelId: String,
        seq: Int,
        size: Int,
        joined: List<VoiceParticipant> = emptyList(),
        updated: List<VoiceParticipant> = emptyList(),
        left: List<String> = emptyList(),
    ): List<VoiceParticipant>? {
        // A delta for a room this tracker holds nothing about is judged as if
        // the baseline were an empty room at sequence 0, which is what it is.
        // That is not a special case bolted on: it is the same rule, and it is
        // what lets somebody who was not watching the last call in this
        // channel apply the very first delta of the next one.
        val fresh = trackedChannelId != channelId
        val baseline = if (fresh) 0 else held
        if (seq != baseline + 1) return null

        val next = if (fresh) LinkedHashMap() else LinkedHashMap(byPeerId)
        joined.forEach { next[it.peerId] = it }
        updated.forEach { next[it.peerId] = it }
        left.forEach { next.remove(it) }
        if (next.size != size) return null

        trackedChannelId = channelId
        byPeerId.clear()
        byPeerId.putAll(next)
        held = if (next.isEmpty()) 0 else seq
        return next.values.toList()
    }
}
