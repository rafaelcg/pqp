import Foundation
import Observation

/**
 WHO IS IN EVERY VOICE ROOM THIS ACCOUNT CAN SEE, for the channel list.

 The socket already sends a `voice-roster` (or a delta, which
 `VoiceRosterTracker` turns back into the whole room) for every voice channel
 its owner can see, because the occupancy under a room is drawn for people
 standing outside the call. Until this store, only `VoiceModel` and
 `CallModel` listened, and only for the room this phone was in, so the list
 showed every room as empty.

 OWNED BY THE SESSION, NOT BY THE SCREEN. The full rosters arrive straight
 after `auth`, long before anybody opens a server, and the next keyframe for a
 quiet room can be a while away. A store that only existed while the channel
 list was on screen would draw empty rooms for the first seconds of every
 visit. Registered once in `SessionStore.startRealtime`.

 FORGETS EVERYTHING ON `ready`. A new socket gets fresh rosters for every room
 that has somebody in it, and nothing at all for a room that emptied while the
 phone was away, so a room held over from the old socket could only ever be a
 ghost.

 What is deliberately not here: who is speaking. The roster leaves `speaking`
 out on purpose (it changes several times a sentence and the roster goes to
 every member), so the list draws a speaking ring only in the call this phone
 is in, from `VoiceModel`'s own audio levels.
 */
@MainActor
@Observable
final class VoiceOccupancyStore {
    /// Participants by voice channel id, in the order the server named them.
    /// A room nobody is in is absent rather than an empty array.
    private(set) var rooms: [String: [VoiceParticipant]] = [:]

    func participants(in channelId: String) -> [VoiceParticipant] {
        rooms[channelId] ?? []
    }

    /// People in any of `channelIds`: the "8 em call" on the server header.
    func headcount(in channelIds: some Sequence<String>) -> Int {
        channelIds.reduce(0) { $0 + (rooms[$1]?.count ?? 0) }
    }

    func apply(_ event: RealtimeEvent) {
        switch event {
        case .ready:
            rooms.removeAll()
        case .voiceRoster(let voiceChannelId, let participants):
            if participants.isEmpty {
                rooms.removeValue(forKey: voiceChannelId)
            } else {
                rooms[voiceChannelId] = participants
            }
        default:
            return
        }
    }

    func clear() {
        rooms.removeAll()
    }
}

/// How a room's occupants are drawn under it: up to three people by name, and
/// past three, two by name and a "+N pessoas" line with the rest's faces. Pure
/// so the cut-off is tested rather than eyeballed.
struct VoiceOccupantSummary: Equatable {
    /// Drawn one per line, with name and state icons.
    let listed: [VoiceParticipant]
    /// How many people the "+N" line stands for.
    let overflowCount: Int
    /// Up to three of them, for the faces on that line. Only these are
    /// copied: a room of two hundred costs the same to draw as a room of six.
    let overflowFaces: [VoiceParticipant]

    static let maxListed = 3
    static let maxFaces = 3

    init(_ participants: [VoiceParticipant], maxListed: Int = VoiceOccupantSummary.maxListed) {
        if participants.count <= maxListed {
            listed = participants
            overflowCount = 0
            overflowFaces = []
        } else {
            // One line goes to the "+N" row, so a full room never grows past
            // `maxListed` lines under its name.
            let shown = max(0, maxListed - 1)
            listed = Array(participants.prefix(shown))
            overflowCount = participants.count - shown
            overflowFaces = Array(participants.dropFirst(shown).prefix(Self.maxFaces))
        }
    }
}
