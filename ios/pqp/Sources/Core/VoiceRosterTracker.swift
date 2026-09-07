import Foundation

/**
 THE ROOM, REBUILT FROM WHAT CHANGED IN IT.

 A `voice-roster` carries every participant to everyone who can *see* the
 channel, because the occupancy badges are drawn for people standing outside
 the call. On 2026-09-05 that was ~99 kB a frame to every socket in a 508
 member community, and a phone on cellular pays for all of it whether or not
 it is in that call. So a socket that declares `voice-roster-delta` on `auth`
 is sent only what changed, and this is what turns that back into the whole
 room.

 Three lists, applied IN ORDER, each an absolute statement about one peer:

 - `joined`  this peer is in the room, with this state (replace by peerId)
 - `updated` this peer is in the room, with this state (replace by peerId)
 - `left`    this peer is not in the room (remove by peerId)

 Because every entry is absolute rather than relative, applying one twice is
 the same as applying it once, which is what makes a delta that overlaps a
 snapshot this client already holds harmless rather than corrupting.

 HOW IT KNOWS IT IS STILL RIGHT. Two independent checks, and failing either
 means this client stops patching and waits:

 - `seq` is monotonic per room, +1 per frame, and restarts at 1 whenever the
   room has been empty. A delta is applied only when it is the next one. A
   client holding nothing about a room holds 0, so the first delta of a fresh
   call is self-sufficient and needs no round trip.
 - `size` is how many participants the room has AFTER the delta. A client that
   applied all three lists and still disagrees has diverged for a reason `seq`
   cannot see, and is equally out of sync.

 On either failure `apply(delta:)` answers nil, nothing whatever is written,
 and the server's periodic full roster (every ~10s, `ROSTER_KEYFRAME_MS` in
 `server/src/ws/voice.ts`) replaces the state wholesale. That is the whole
 convergence argument: the worst a lost or reordered frame can cost is a
 bounded interval of staleness, never a peer who stays invisible until
 somebody rejoins.

 ORDER IS PRESERVED. This ends up backing a list of faces on a phone screen,
 and rebuilding it from an unordered dictionary would shuffle everybody every
 time one person muted. A replaced peer keeps its position and a new one is
 appended, which is what the web client's `Map` does.

 KEPT PER CHANNEL, not for the one room this device is in. The socket receives
 rosters for every voice channel its owner can see, and a baseline for a room
 costs a few kilobytes, so keeping them all means a delta that arrives the
 instant somebody joins a busy room is applied immediately instead of waiting
 out a keyframe. A room that empties is dropped, which is what bounds this to
 rooms that currently have somebody in them.

 Not thread safe by itself, and does not need to be: it is held as
 `RealtimeClient` actor state and only ever touched from `ingest`.
 */
struct VoiceRosterTracker {
    private struct Room {
        /// The sequence of the last frame applied to this room.
        var seq: Int
        /// Every participant, in the order the server first named them.
        var participants: [VoiceParticipant]
    }

    private var rooms: [String: Room] = [:]

    /// The sequence held for a channel. 0 when there is no baseline, which is
    /// also what an empty room restarts from. Exposed for tests.
    func sequence(for voiceChannelId: String) -> Int {
        rooms[voiceChannelId]?.seq ?? 0
    }

    /// How many rooms currently have a baseline. Exposed for tests, which is
    /// how "an emptied room is dropped rather than remembered" is checked.
    var trackedRoomCount: Int { rooms.count }

    /**
     Drop every baseline.

     Called when the socket is (re)opened. The sequences belong to a server
     process, which may have restarted its numbering at 1, and a room that
     emptied while this device was away sent its last frame to somebody else.
     Holding a number the server no longer shares is not merely stale: the
     danger is that it lines up by accident and a delta is applied to a room
     that has moved on. Everything live is re-baselined by the full rosters the
     server sends straight after `auth`.
     */
    mutating func forgetAll() {
        rooms.removeAll()
    }

    /**
     A full roster. Authoritative by definition: whatever the sequence said and
     whatever this client believed, the room is now exactly this.

     `seq` is absent on a server that predates deltas, and absent reads as 0.
     */
    mutating func apply(
        snapshot participants: [VoiceParticipant],
        voiceChannelId: String,
        seq: Int?
    ) {
        guard !participants.isEmpty else {
            // The server forgets an empty room's sequence so the next call in
            // this channel starts again at 1. A client that kept the old
            // number would read that first delta as a gap and sit out the
            // whole of the next call until a keyframe rescued it.
            rooms[voiceChannelId] = nil
            return
        }
        rooms[voiceChannelId] = Room(seq: seq ?? 0, participants: dedupe(participants))
    }

    /**
     A delta. Answers the whole room once it has been applied, or **nil** when
     it must not be applied at all: a sequence gap, or a size this client and
     the server disagree about.

     A refused delta changes nothing, not even the sequence. Advancing past one
     would turn a single missed frame into a permanently wrong room, because
     every later delta would then look like the next one in line while the
     baseline underneath it is missing whatever the skipped frame said.
     */
    mutating func apply(
        deltaFor voiceChannelId: String,
        seq: Int,
        size: Int,
        joined: [VoiceParticipant] = [],
        updated: [VoiceParticipant] = [],
        left: [String] = []
    ) -> [VoiceParticipant]? {
        // A room this tracker holds nothing about is judged as an empty room at
        // sequence 0, which is what it is. Not a special case bolted on: it is
        // the same rule, and it is what lets somebody who was not watching the
        // last call in this channel apply the very first delta of the next one.
        let held = rooms[voiceChannelId]?.seq ?? 0
        guard seq == held + 1 else { return nil }

        var order = rooms[voiceChannelId]?.participants ?? []
        var indexByPeerId: [String: Int] = [:]
        for (index, participant) in order.enumerated() {
            indexByPeerId[participant.peerId] = index
        }
        for participant in joined + updated {
            if let index = indexByPeerId[participant.peerId] {
                order[index] = participant
            } else {
                indexByPeerId[participant.peerId] = order.count
                order.append(participant)
            }
        }
        if !left.isEmpty {
            // Read off the array rather than off the index built above, so a
            // peer that both joins and leaves inside one window ends up out,
            // which is what the server saw happen.
            let departed = Set(left)
            order.removeAll { departed.contains($0.peerId) }
        }

        guard order.count == size else { return nil }

        if order.isEmpty {
            rooms[voiceChannelId] = nil
        } else {
            rooms[voiceChannelId] = Room(seq: seq, participants: order)
        }
        return order
    }

    /// A snapshot is trusted but not assumed: two entries with one peer id
    /// would put the size check permanently out of step with the server, which
    /// counts peers and not rows. Last one wins, position of the first kept.
    private func dedupe(_ participants: [VoiceParticipant]) -> [VoiceParticipant] {
        var order: [VoiceParticipant] = []
        var indexByPeerId: [String: Int] = [:]
        for participant in participants {
            if let index = indexByPeerId[participant.peerId] {
                order[index] = participant
            } else {
                indexByPeerId[participant.peerId] = order.count
                order.append(participant)
            }
        }
        return order
    }
}
